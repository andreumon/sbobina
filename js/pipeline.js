// Elaborazione di una lezione: pianificazione dei blocchi, caricamento su Gemini,
// trascrizione letterale, revisione. Ogni passo salva il risultato, quindi se
// l'app si chiude o manca la rete si riparte dal punto esatto in cui ci si era fermati.
import * as store from './store.js';
import { analyzeAdts, planChunks, probeDuration } from './aac.js';
import { Gemini, ApiError } from './gemini.js';
import { transcriptionPrompt, revisionPrompt } from './prompts.js';
import { paragraphsFromChunk, paragraphsFromRaw, completenessCheck, glossaryTerms, fmtTime } from './text.js';

const GEMINI_FILE_TTL = 46 * 3600 * 1000; // Google li tiene 48 ore
const MAX_REQUEST_SEC = 55 * 60;           // limite del modello di trascrizione: 1 ora

function stripFences(t) {
  return String(t || '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

function tailOf(chunk, chars = 450) {
  const text = (chunk?.paragraphs?.map(p => p.text).join(' ') || chunk?.raw || '').replace(/\s+/g, ' ').trim();
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  return '…' + cut.slice(cut.indexOf(' ') + 1);
}

/**
 * @param {string} id  lezione
 * @param {object} ctx { settings, getAudio(job), log(msg), signal, onProgress(info) }
 */
export async function processJob(id, ctx) {
  const { settings, signal } = ctx;
  const log = msg => {
    ctx.log?.(msg);
    store.updateJob(id, j => { j.log = [...(j.log || []).slice(-60), `${new Date().toLocaleTimeString('it-IT')} ${msg}`]; }, { touch: false });
  };
  const gemini = new Gemini(settings.apiKey, { log, signal });
  const patch = fn => store.updateJob(id, fn);
  const progress = info => ctx.onProgress?.({ id, ...info });

  let job = await patch(j => {
    j.status = 'running'; j.error = null; j.runner = store.deviceId; j.heartbeat = Date.now();
  });
  const audio = await ctx.getAudio(job);
  if (!audio) throw new Error('L\'audio di questa lezione non è disponibile su questo dispositivo.');

  // 1. Pianificazione dei blocchi
  if (!job.chunks?.length) {
    progress({ step: 'plan' });
    const chunkSec = Math.min(40, Math.max(10, Number(settings.chunkMin) || 20)) * 60;
    let chunks, duration;
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const info = analyzeAdts(bytes);
    if (info) {
      duration = info.duration;
      chunks = (await planChunks(info, bytes, chunkSec)).map(c => ({
        mode: 'slice', start: c.start, end: c.end, startByte: c.startByte, endByte: c.endByte,
      }));
      log(`Audio AAC di ${fmtTime(duration)}: ${chunks.length} blocchi tagliati nelle pause`);
    } else {
      duration = await probeDuration(audio);
      if (!duration || duration <= MAX_REQUEST_SEC) {
        chunks = [{ mode: 'whole', start: 0, end: duration || 0 }];
      } else {
        const n = Math.max(2, Math.round(duration / chunkSec));
        chunks = Array.from({ length: n }, (_, k) => ({ mode: 'range', start: (k * duration) / n, end: ((k + 1) * duration) / n }));
      }
      log(`Formato non tagliabile: ${chunks.length} ${chunks.length > 1 ? 'tratti' : 'blocco'}`);
    }
    job = await patch(j => { j.duration = duration; j.chunks = chunks; });
  }

  const vocabulary = glossaryTerms(job.glossary);
  const glossaryText = vocabulary.join(', ');
  const total = job.chunks.length;

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Interrotto', 'AbortError');
    let chunk = job.chunks[i];
    const done = chunk.paragraphs && (chunk.revised || !settings.revise || !chunk.raw);
    if (done) continue;
    await patch(j => { j.heartbeat = Date.now(); });

    // 2. Caricamento su Gemini (riusato finché non scade)
    const ref = await ensureUploaded(job, i, audio, gemini, p => progress({ step: 'upload', chunk: i, total, progress: p }));
    job = await store.getJob(id);
    chunk = job.chunks[i];

    // 3. Trascrizione letterale
    if (typeof chunk.raw !== 'string') {
      progress({ step: 'transcribe', chunk: i, total });
      let raw, engine;
      if (chunk.mode !== 'range') {
        try {
          raw = await gemini.transcribe({ model: settings.transcribeModel, audio: ref, language: settings.language, vocabulary });
          engine = settings.transcribeModel;
        } catch (e) {
          if (e.name === 'AbortError' || !(e instanceof ApiError) || ![400, 403, 404].includes(e.status)) throw e;
          log(`Modello di trascrizione non utilizzabile (${e.message}); uso ${settings.reviseModel}`);
          raw = await gemini.generate({ model: settings.reviseModel, audio: ref, label: 'Trascrizione',
            prompt: transcriptionPrompt({ course: job.course, glossary: glossaryText }) });
          engine = settings.reviseModel;
        }
      } else {
        raw = await gemini.generate({ model: settings.reviseModel, audio: ref, label: 'Trascrizione',
          prompt: transcriptionPrompt({ course: job.course, glossary: glossaryText, range: [chunk.start, chunk.end] }) });
        engine = settings.reviseModel;
      }
      raw = stripFences(raw);
      if (!raw) log(`Blocco ${i + 1}: nessun parlato riconosciuto`);
      job = await patch(j => { Object.assign(j.chunks[i], { raw, engine }); });
      chunk = job.chunks[i];
    }

    // 4. Revisione
    if (settings.revise && chunk.raw) {
      progress({ step: 'revise', chunk: i, total });
      const prompt = revisionPrompt({
        raw: chunk.raw, course: job.course, glossary: glossaryText, index: i, total,
        start: chunk.start, end: chunk.end, prevTail: i > 0 ? tailOf(job.chunks[i - 1]) : '',
        withAudio: !!settings.relisten, range: chunk.mode === 'range' ? [chunk.start, chunk.end] : null,
      });
      const revised = stripFences(await gemini.generate({
        model: settings.reviseModel, prompt, audio: settings.relisten ? ref : null, label: 'Revisione',
      }));
      if (!revised) throw new ApiError('La revisione è tornata vuota.', 500);
      const paragraphs = paragraphsFromChunk(revised, chunk.start, chunk.end);
      const check = completenessCheck(chunk.raw, revised);
      if (check.warn) log(`Blocco ${i + 1}: ${check.warn}`);
      job = await patch(j => { Object.assign(j.chunks[i], { revised, paragraphs, ratio: check.ratio, warn: check.warn }); });
    } else {
      job = await patch(j => {
        const c = j.chunks[i];
        c.paragraphs = paragraphsFromRaw(c.raw || '', c.start);
      });
    }

    if (chunk.mode === 'slice' && job.chunks[i].gfile) {
      await gemini.deleteFile(job.chunks[i].gfile.name);
      job = await patch(j => { delete j.chunks[i].gfile; });
    }
    ctx.onChunkDone?.(job, i);
  }

  if (job.gfile) await gemini.deleteFile(job.gfile.name);
  job = await patch(j => {
    j.status = 'done'; j.finishedAt = Date.now(); j.error = null; delete j.gfile; delete j.runner;
  });
  progress({ step: 'done' });
  return job;
}

async function ensureUploaded(job, i, audio, gemini, onProgress) {
  const chunk = job.chunks[i];
  const fresh = f => f && f.uri && Date.now() - (f.at || 0) < GEMINI_FILE_TTL;
  if (chunk.mode === 'slice') {
    if (fresh(chunk.gfile)) return chunk.gfile;
    const part = audio.slice(chunk.startByte, chunk.endByte, 'audio/aac');
    const f = await gemini.upload(part, 'audio/aac', `${job.title} - parte ${i + 1}`, onProgress);
    const ref = { name: f.name, uri: f.uri, mimeType: f.mimeType || 'audio/aac', at: Date.now() };
    await store.updateJob(job.id, j => { j.chunks[i].gfile = ref; });
    return ref;
  }
  if (fresh(job.gfile)) return job.gfile;
  const f = await gemini.upload(audio, job.mime, job.title, onProgress);
  const ref = { name: f.name, uri: f.uri, mimeType: f.mimeType || job.mime, at: Date.now() };
  await store.updateJob(job.id, j => { j.gfile = ref; });
  return ref;
}
