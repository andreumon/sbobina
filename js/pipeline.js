// Elaborazione di una lezione: pianificazione dei blocchi, invio a Gemini,
// trascrizione letterale, revisione. Ogni passo salva il risultato, quindi se
// l'app si chiude o manca la rete si riparte dal punto esatto in cui ci si era fermati.
//
// Se Google rifiuta la richiesta (errore 400), parte un'autodiagnosi su pochi secondi
// della lezione (vedi strategy.js) e l'elaborazione riprende con la variante che funziona.
import * as store from './store.js';
import { analyzeAdts, planChunks, probeDuration, sliceParts } from './aac.js';
import { Gemini, ApiError, blobToBase64 } from './gemini.js';
import { transcriptionPrompt, revisionPrompt } from './prompts.js';
import { paragraphsFromChunk, paragraphsFromRaw, completenessCheck, glossaryTerms, fmtTime } from './text.js';
import {
  loadStrategy, saveStrategy, diagnose, describeStrategy, maxChunkSec, toWav16k, isRequestShapeError, INLINE_MAX_BYTES,
} from './strategy.js';

const GEMINI_FILE_TTL = 46 * 3600 * 1000; // Google li tiene 48 ore
const MAX_REQUEST_SEC = 54 * 60;           // limite del modello di trascrizione: 1 ora
const PLAN_VERSION = 2;                    // 2: esclude il frame finto iniziale del registratore

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
 * @param {object} ctx { settings, getAudio(job), log(msg), signal, onProgress(info), onChunkDone(job, i) }
 */
export async function processJob(id, ctx) {
  const { settings, signal } = ctx;
  const log = msg => {
    ctx.log?.(msg);
    return store.updateJob(id, j => { j.log = [...(j.log || []).slice(-80), `${new Date().toLocaleTimeString('it-IT')} ${msg}`]; }, { touch: false });
  };
  const gemini = new Gemini(settings.apiKey, { log, signal });
  const patch = fn => store.updateJob(id, fn);
  const progress = info => ctx.onProgress?.({ id, ...info });
  let strategy = loadStrategy();

  let job = await patch(j => {
    j.status = 'running'; j.error = null; j.runner = store.deviceId; j.heartbeat = Date.now();
  });
  const audio = await ctx.getAudio(job);
  if (!audio) throw new Error('L\'audio di questa lezione non è disponibile su questo dispositivo.');

  // ---- 1. Pianificazione dei blocchi
  const plan = async () => {
    progress({ step: 'plan' });
    let chunkSec = Math.min(40, Math.max(10, Number(settings.chunkMin) || 20)) * 60;
    let chunks, duration;
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const info = analyzeAdts(bytes);
    if (info) {
      duration = info.duration;
      const limit = maxChunkSec(strategy, audio.size / duration);
      const maxSec = limit ? Math.max(60, limit - 60) : undefined;
      if (maxSec) chunkSec = Math.min(chunkSec, maxSec);
      chunks = (await planChunks(info, bytes, chunkSec, { maxSec })).map(c => ({
        mode: 'slice', start: c.start, end: c.end, startByte: c.startByte, endByte: c.endByte, parts: c.parts,
      }));
      await log(`Audio AAC di ${fmtTime(duration)}: ${chunks.length === 1 ? 'un blocco unico' : `${chunks.length} blocchi tagliati nelle pause`}`);
      if (info.junk.length) await log(`Esclusi ${info.junk.length === 1 ? 'un frame' : `${info.junk.length} frame`} non audio scritti dal registratore`);
    } else {
      duration = await probeDuration(audio);
      if (!duration || duration <= MAX_REQUEST_SEC) {
        chunks = [{ mode: 'whole', start: 0, end: duration || 0 }];
      } else {
        const n = Math.max(2, Math.round(duration / chunkSec));
        chunks = Array.from({ length: n }, (_, k) => ({ mode: 'range', start: (k * duration) / n, end: ((k + 1) * duration) / n }));
      }
      await log(`Formato non tagliabile: ${chunks.length} ${chunks.length > 1 ? 'tratti' : 'blocco'}`);
    }
    job = await patch(j => { j.duration = duration; j.chunks = chunks; j.planVersion = PLAN_VERSION; });
  };
  // Lezioni tagliate da una versione precedente: se nulla è ancora trascritto, si ripianifica.
  const stale = job.chunks?.length && (job.planVersion || 1) < PLAN_VERSION && !job.chunks.some(c => typeof c.raw === 'string');
  if (stale) {
    await log('Ripianifico i blocchi con la versione aggiornata del taglio');
    for (const g of [...Object.values(job.grefs || {}), ...job.chunks.flatMap(c => Object.values(c.grefs || {}))]) gemini.deleteFile(g.name);
    job = await patch(j => { j.chunks = []; delete j.grefs; });
  }
  if (!job.chunks?.length) await plan();

  // Parole chiave aggiornate del corso (se modificate dopo il caricamento), altrimenti quelle salvate.
  const courseCfg = (settings.courses || []).find(c => c.name === job.course);
  const vocabulary = glossaryTerms(courseCfg ? courseCfg.glossary : job.glossary);
  const glossaryText = vocabulary.join(', ');

  // ---- Audio da inviare per un blocco, nella forma richiesta dalla strategia
  const wavCache = new Map();
  const audioFor = async (i, step) => {
    const chunk = job.chunks[i];
    const { format, transport } = step;
    let blob, mime;
    if (chunk.mode === 'slice') {
      blob = sliceParts(audio, chunk.parts || [[chunk.startByte, chunk.endByte]]);
      mime = 'audio/aac';
    } else {
      if (format === 'wav' && chunk.mode === 'range') {
        throw new ApiError('Questo formato audio, oltre i 55 minuti, non è compatibile con la variante richiesta da Google. Converti il file in .aac o .mp3 e riprova.', 400);
      }
      blob = audio;
      mime = job.mime;
    }
    if (format === 'wav') {
      if (!wavCache.has(i)) wavCache.set(i, await toWav16k(blob));
      blob = wavCache.get(i);
      mime = 'audio/wav';
    }
    if (transport === 'inline') {
      if (blob.size > INLINE_MAX_BYTES) throw new ApiError('Blocco troppo grande per l\'invio diretto: va ripianificato.', 413);
      return { data: await blobToBase64(blob), mimeType: mime };
    }
    // Caricamento con la Files API, riusato finché il file non scade
    const key = `${format}`;
    const holder = chunk.mode === 'slice' ? chunk : job;
    const cached = holder.grefs?.[key];
    if (cached?.uri && Date.now() - (cached.at || 0) < GEMINI_FILE_TTL) return { uri: cached.uri, mimeType: mime };
    const f = await gemini.upload(blob, mime, chunk.mode === 'slice' ? `${job.title} - parte ${i + 1}` : job.title,
      p => progress({ step: 'upload', chunk: i, total: job.chunks.length, progress: p }));
    const refData = { name: f.name, uri: f.uri, at: Date.now() };
    job = await patch(j => {
      const h = chunk.mode === 'slice' ? j.chunks[i] : j;
      h.grefs = { ...(h.grefs || {}), [key]: refData };
    });
    return { uri: f.uri, mimeType: mime }; // tipo canonico, non quello restituito dal server
  };

  // ---- Autodiagnosi (una volta per esecuzione)
  let diagnosed = false;
  const runDiagnosis = async cause => {
    diagnosed = true;
    await log(`Google ha rifiutato la richiesta: ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}. Avvio l'autodiagnosi.`);
    progress({ step: 'diagnose' });
    const { strategy: found, results } = await diagnose(gemini, {
      audio: job.chunks[0]?.mode === 'slice' ? audio : null, settings, vocabulary, onStep: label => progress({ step: 'diagnose', label }),
    });
    for (const r of results) await log(`Diagnosi: ${r.ok ? 'OK' : 'NO'}, ${r.label}${r.ok ? '' : `: ${r.error}`}`);
    if (!found) {
      const first = results.find(r => !r.ok);
      throw new ApiError(`Nessuna variante della richiesta è stata accettata da Google. Primo errore: ${first?.error || cause.message}`, 400);
    }
    strategy = found;
    saveStrategy(found);
    await log(`Variante scelta: ${describeStrategy(found)}`);
    // Se ora servono blocchi più piccoli e nulla è ancora trascritto, si ripianifica.
    const limit = maxChunkSec(strategy, audio.size / (job.duration || 1));
    const tooBig = limit && job.chunks.some(c => c.end - c.start > limit);
    if (tooBig) {
      if (job.chunks.some(c => typeof c.raw === 'string')) {
        throw new ApiError('La variante che funziona richiede blocchi più corti, ma parte della lezione è già trascritta. Elimina la lezione e ricaricala.', 400);
      }
      job = await patch(j => { j.chunks = []; });
      await plan();
    }
  };

  // ---- 2-4. Blocco per blocco
  for (let i = 0; i < job.chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Interrotto', 'AbortError');
    const total = job.chunks.length;
    let chunk = job.chunks[i];
    const done = chunk.paragraphs && (chunk.revised || !settings.revise || !chunk.raw);
    if (done) continue;
    await patch(j => { j.heartbeat = Date.now(); });

    try {
      // Trascrizione letterale
      if (typeof chunk.raw !== 'string') {
        let raw, engine;
        const t = strategy.transcribe;
        if (chunk.mode !== 'range' && t.use) {
          const a = await audioFor(i, t);
          progress({ step: 'transcribe', chunk: i, total });
          try {
            raw = await gemini.transcribe({ model: settings.transcribeModel, audio: a, language: settings.language, vocabulary: t.vocab ? vocabulary : [] });
            engine = settings.transcribeModel;
          } catch (e) {
            if (e.name === 'AbortError' || !(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e;
            await log(`Modello di trascrizione non disponibile (${e.message}); uso ${settings.reviseModel}`);
            strategy = { ...strategy, transcribe: { ...t, use: false } };
            saveStrategy(strategy);
          }
        }
        if (raw === undefined) {
          const r = strategy.revise;
          const a = await audioFor(i, r);
          progress({ step: 'transcribe', chunk: i, total });
          raw = await gemini.generate({
            model: settings.reviseModel, audio: a, endpoint: r.endpoint, label: 'Trascrizione',
            prompt: transcriptionPrompt({ course: job.course, glossary: glossaryText, range: chunk.mode === 'range' ? [chunk.start, chunk.end] : null }),
          });
          engine = settings.reviseModel;
        }
        raw = stripFences(raw);
        if (!raw) await log(`Blocco ${i + 1}: nessun parlato riconosciuto`);
        job = await patch(j => { Object.assign(j.chunks[i], { raw, engine }); });
        chunk = job.chunks[i];
      }

      // Revisione
      if (settings.revise && chunk.raw) {
        const r = strategy.revise;
        const a = settings.relisten ? await audioFor(i, r) : null;
        progress({ step: 'revise', chunk: i, total });
        const prompt = revisionPrompt({
          raw: chunk.raw, course: job.course, glossary: glossaryText, index: i, total,
          start: chunk.start, end: chunk.end, prevTail: i > 0 ? tailOf(job.chunks[i - 1]) : '',
          withAudio: !!a, range: chunk.mode === 'range' ? [chunk.start, chunk.end] : null,
        });
        const revised = stripFences(await gemini.generate({ model: settings.reviseModel, prompt, audio: a, endpoint: r.endpoint, label: 'Revisione' }));
        if (!revised) throw new ApiError('La revisione è tornata vuota.', 500);
        const paragraphs = paragraphsFromChunk(revised, chunk.start, chunk.end);
        const check = completenessCheck(chunk.raw, revised);
        if (check.warn) await log(`Blocco ${i + 1}: ${check.warn}`);
        job = await patch(j => { Object.assign(j.chunks[i], { revised, paragraphs, ratio: check.ratio, warn: check.warn }); });
      } else {
        job = await patch(j => { const c = j.chunks[i]; c.paragraphs = paragraphsFromRaw(c.raw || '', c.start); });
      }
    } catch (e) {
      if (!diagnosed && (isRequestShapeError(e) || e.status === 413)) {
        await runDiagnosis(e);
        i = -1; // ricomincia dal primo blocco non completato (con l'eventuale nuova pianificazione)
        continue;
      }
      throw e;
    }

    // Pulizia dei file temporanei su Google per questo blocco
    if (chunk.mode === 'slice' && job.chunks[i].grefs) {
      for (const g of Object.values(job.chunks[i].grefs)) await gemini.deleteFile(g.name);
      job = await patch(j => { delete j.chunks[i].grefs; delete j.chunks[i].gfile; });
    }
    wavCache.delete(i);
    ctx.onChunkDone?.(job, i);
  }

  for (const g of Object.values(job.grefs || {})) await gemini.deleteFile(g.name);
  job = await patch(j => {
    j.status = 'done'; j.finishedAt = Date.now(); j.error = null; delete j.grefs; delete j.gfile; delete j.runner;
  });
  progress({ step: 'done' });
  return job;
}
