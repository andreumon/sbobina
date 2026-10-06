// Elaborazione di una lezione: pianificazione dei blocchi, invio a Gemini,
// trascrizione letterale, revisione. Ogni passo salva il risultato, quindi se
// l'app si chiude o manca la rete si riparte dal punto esatto in cui ci si era fermati.
//
// Se Google rifiuta la richiesta (errore 400), parte un'autodiagnosi su pochi secondi
// della lezione (vedi strategy.js) e l'elaborazione riprende con la variante che funziona.
import * as store from './store.js';
import { analyzeAdts, planChunks, probeDuration, sliceParts } from './aac.js';
import { Gemini, ApiError, blobToBase64, isKeyError } from './gemini.js';
import { transcriptionPrompt, revisionPrompt, continuationPrompt, langOf } from './prompts.js';
import * as quota from './quota.js';
import { paragraphsFromChunk, paragraphsFromRaw, completenessCheck, glossaryTerms, fmtTime, countWords, coverageWarnings } from './text.js';
import { makeLight, canMakeLight } from './light.js';
import { Groq, GROQ_MODEL, GROQ_MAX_BYTES, rawFromSegments, whisperLanguage, whisperPrompt, recordGroq, explainGroq } from './groq.js';
import {
  loadStrategy, saveStrategy, diagnose, describeStrategy, maxChunkSec, toWav16k, isRequestShapeError, INLINE_MAX_BYTES,
} from './strategy.js';

const GEMINI_FILE_TTL = 46 * 3600 * 1000; // Google li tiene 48 ore
const MAX_REQUEST_SEC = 54 * 60;           // limite del modello di trascrizione: 1 ora
const PLAN_VERSION = 2;                    // 2: esclude il frame finto iniziale del registratore
// Modelli gratuiti, provati in ordine quando quello scelto è sovraccarico o ha finito la quota.
// I "lite" hanno quote giornaliere molto più alte: sono l'ultima riserva.
export const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const GEN_CONFIG = { maxOutputTokens: 32768, thinkingLevel: 'low' };
const MAX_INLINE_WAIT = 6 * 60_000;        // oltre questa attesa la lezione va "in attesa" e libera la coda
const SWITCH_IF_WAIT = 2 * 60_000;         // se un modello va atteso più di così, si preferisce un altro libero
const KEY_OFFLINE_PAUSE = 2 * 60_000;      // una chiave che non risponde (rete) si salta per 2 minuti

/** Nessun modello disponibile adesso: la lezione si rimette in coda all'ora indicata. */
export class BusyError extends Error {
  constructor(message, retryAt, daily = false) {
    super(message);
    this.retryAt = retryAt;
    this.daily = daily;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Interrotto', 'AbortError')); }, { once: true });
});

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
  // ---- Chiavi API: la principale e, se impostata, quella di riserva.
  // Ogni chiave (di un progetto Google diverso) ha quote proprie: quando la principale è
  // satura su un modello, non risponde o viene rifiutata, si passa alla riserva.
  const k1 = (settings.apiKey || '').trim();
  const k2 = (settings.apiKey2 || '').trim();
  const keys = [
    // Con una riserva disponibile, la principale che non risponde si abbandona dopo 2 tentativi (~10 s) invece di 5 (~1,5 min)
    k1 && { tag: '', name: 'chiave principale', gemini: new Gemini(k1, { log, signal, netRetries: k2 && k2 !== k1 ? 2 : 5 }) },
    k2 && k2 !== k1 && { tag: 'k2', name: 'chiave di riserva', gemini: new Gemini(k2, { log, signal }) },
  ].filter(Boolean);
  if (!keys.length) throw new Error('Manca la chiave API Gemini: inseriscila nelle impostazioni.');
  const deadKeys = new Set();     // chiavi rifiutate da Google in questa esecuzione
  const offlineUntil = new Map(); // chiavi che non rispondono, saltate per qualche minuto
  const keyOf = tag => keys.find(k => k.tag === tag);
  const keyUp = k => !deadKeys.has(k.tag) && !((offlineUntil.get(k.tag) || 0) > Date.now());
  const liveKeys = () => keys.filter(k => !deadKeys.has(k.tag));
  let gemini = keys[0].gemini;    // client dell'ultima richiesta riuscita (per gemini.last)
  let lastKeyTag = keys[0].tag;
  // I file caricati su Google appartengono al progetto della chiave: si cancellano con la stessa chiave.
  const dropRef = (refKey, g) => keyOf(quota.keyTagOf(refKey))?.gemini.deleteFile(g.name);
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
    let chunkSec = Math.min(54, Math.max(10, Number(settings.chunkMin) || 45)) * 60;
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
    for (const [k, g] of [...Object.entries(job.grefs || {}), ...job.chunks.flatMap(c => Object.entries(c.grefs || {}))]) dropRef(k, g);
    job = await patch(j => { j.chunks = []; delete j.grefs; });
  }
  if (!job.chunks?.length) await plan();

  // Parole chiave aggiornate del corso (se modificate dopo il caricamento), altrimenti quelle salvate.
  const courseCfg = (settings.courses || []).find(c => c.name === job.course);
  const vocabulary = glossaryTerms(courseCfg ? courseCfg.glossary : job.glossary);
  const glossaryText = vocabulary.join(', ');
  const lang = langOf(courseCfg?.lang || job.lang || settings.defaultLang || 'it');

  // ---- Audio leggero (Opus mono 16 kHz, circa 8 volte più piccolo dell'AAC del registratore):
  // serve a Groq (file fino a 25 MB) e, se Google lo accetta, rende più veloci anche gli invii a Gemini.
  const mb = n => `${(n / 1e6).toFixed(1).replace('.', ',')} MB`;
  const sourceOf = i => {
    const c = job.chunks[i];
    return c.mode === 'slice' ? sliceParts(audio, c.parts || [[c.startByte, c.endByte]]) : audio;
  };
  const lightCache = new Map();
  const lightOk = settings.lightAudio !== false && await canMakeLight();
  let lightForGemini = lightOk && !store.device.get('lightRejected', false);
  const lightFor = async i => {
    if (!lightOk || job.chunks[i].mode === 'range') return null;
    if (lightCache.has(i)) return lightCache.get(i);
    const src = sourceOf(i);
    const t0 = Date.now();
    const out = await makeLight(src, { signal, onProgress: p => progress({ step: 'convert', chunk: i, total: job.chunks.length, progress: p }) });
    await log(out
      ? `Blocco ${i + 1}: audio leggero ${mb(src.size)} → ${mb(out.size)} in ${Math.round((Date.now() - t0) / 1000)} s`
      : `Blocco ${i + 1}: conversione in audio leggero non riuscita, uso l'audio originale`);
    lightCache.set(i, out);
    return out;
  };

  // ---- Audio da inviare per un blocco, nella forma richiesta dalla strategia
  const wavCache = new Map();
  const audioFor = async (i, step, k = keys[0]) => {
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
    let kind = format;
    if (format === 'wav') {
      if (!wavCache.has(i)) wavCache.set(i, await toWav16k(blob));
      blob = wavCache.get(i);
      mime = 'audio/wav';
    } else if (lightForGemini && chunk.mode !== 'range') {
      const light = await lightFor(i);
      if (light) { blob = light; mime = 'audio/ogg'; kind = 'ogg'; }
    }
    if (transport === 'inline') {
      if (blob.size > INLINE_MAX_BYTES) throw new ApiError('Blocco troppo grande per l\'invio diretto: va ripianificato.', 413);
      return { data: await blobToBase64(blob), mimeType: mime };
    }
    // Caricamento con la Files API, riusato finché il file non scade (un file per chiave:
    // un file caricato con una chiave non è visibile dal progetto dell'altra)
    const key = quota.scoped(kind, k.tag);
    const holder = chunk.mode === 'slice' ? chunk : job;
    const cached = holder.grefs?.[key];
    if (cached?.uri && Date.now() - (cached.at || 0) < GEMINI_FILE_TTL) return { uri: cached.uri, mimeType: mime };
    const f = await k.gemini.upload(blob, mime, chunk.mode === 'slice' ? `${job.title} - parte ${i + 1}` : job.title,
      p => progress({ step: 'upload', chunk: i, total: job.chunks.length, progress: p }));
    const refData = { name: f.name, uri: f.uri, at: Date.now() };
    job = await patch(j => {
      const h = chunk.mode === 'slice' ? j.chunks[i] : j;
      h.grefs = { ...(h.grefs || {}), [key]: refData };
    });
    return { uri: f.uri, mimeType: mime }; // tipo canonico, non quello restituito dal server
  };

  /**
   * Richiesta a Gemini con l'audio leggero: se Google rifiuta la forma della richiesta, si riprova
   * con l'audio originale; se così funziona, il rifiuto era dell'audio leggero e non lo si usa più per Gemini.
   */
  const withLightFallback = async fn => {
    try {
      return await fn();
    } catch (e) {
      if (!(lightForGemini && isRequestShapeError(e))) throw e;
      lightForGemini = false;
      const r = await fn();
      store.device.set('lightRejected', true);
      await log('Gemini non accetta l\'audio leggero: d\'ora in poi gli invio l\'audio originale');
      return r;
    }
  };

  // ---- Groq (facoltativo): trascrizione letterale con Whisper large-v3
  const groq = (settings.groqKey || '').trim() ? new Groq(settings.groqKey, { signal, log }) : null;
  let groqOff = null; // motivo per cui Groq non si usa più in questa esecuzione
  const GROQ_TYPES = /ogg|opus|wav|mpeg|mp3|mp4|m4a|webm|flac/;
  const viaGroq = async (i, secs, info) => {
    let blob = await lightFor(i);
    if (!blob) {
      const src = sourceOf(i);
      const type = src.type || job.mime || '';
      if (src.size > GROQ_MAX_BYTES || !GROQ_TYPES.test(type) || job.chunks[i].mode === 'slice') {
        groqOff = 'per Groq l\'audio va convertito, e questo browser non ci riesce (servono Chrome, Edge o Firefox recenti)';
        await log(`Groq: ${groqOff}. Trascrivo con Gemini.`);
        return null;
      }
      blob = src;
    }
    for (let attempt = 0; ; attempt++) {
      progress({ step: 'transcribe', ...info, model: 'Whisper (Groq)' });
      try {
        const r = await groq.transcribe({ blob, language: whisperLanguage(lang), prompt: whisperPrompt(vocabulary, lang) });
        recordGroq(secs);
        const segments = Array.isArray(r.segments) ? r.segments : [{ start: 0, end: secs, text: r.text || '' }];
        const { raw, dropped } = rawFromSegments(segments);
        if (dropped) await log(`Blocco ${i + 1}: scartati ${dropped} pezzi che Whisper aveva probabilmente inventato nei silenzi`);
        return { raw, engine: `${GROQ_MODEL} (Groq)` };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.status === 429 && Number.isFinite(e.retryMs) && e.retryMs <= MAX_INLINE_WAIT && attempt < 2) {
          await log(`Groq: limite al minuto, riprovo tra ${Math.ceil(e.retryMs / 1000)} s`);
          await waitFor(e.retryMs + 1000, info);
          continue;
        }
        if ((e.status === 0 || e.status >= 500) && attempt < 1) { await sleep(5000, signal); continue; }
        // Chiave rifiutata, quota finita o servizio irraggiungibile: per il resto della lezione si usa Gemini.
        if ([0, 401, 403, 429].includes(e.status)) groqOff = explainGroq(e);
        await log(`Blocco ${i + 1}: ${explainGroq(e)} Trascrivo con Gemini.`);
        return null;
      }
    }
  };

  // ---- Dosatore: sceglie il modello, rispetta le quote, ricorda chi è esaurito o sovraccarico
  const chain = [settings.reviseModel, ...FALLBACK_MODELS.filter(m => m !== settings.reviseModel)];
  const missing = new Set(); // modello@chiave che non esistono per quella chiave (404)
  const waitFor = async (ms, info) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      progress({ ...info, step: 'quota', until });
      await sleep(Math.min(5000, until - Date.now()), signal);
    }
  };
  /**
   * candidates: [{ model, kind: 'transcribe' | 'generate' }], in ordine di preferenza.
   * call(candidate) esegue la richiesta. Ritorna { text, model }.
   */
  const runStep = async ({ label, candidates, tokens, call, info }) => {
    const minuteHits = new Map();
    // Ogni modello si prova prima con la chiave principale, poi con quella di riserva:
    // così si cambia chiave prima di ripiegare su un modello peggiore.
    const pairs = candidates.flatMap(c => keys.map(k => ({ ...c, key: k, qid: quota.scoped(c.model, k.tag) })));
    const who = c => (keys.length > 1 ? `${c.model} (${c.key.name})` : c.model);
    for (;;) {
      if (signal?.aborted) throw new DOMException('Interrotto', 'AbortError');
      const alive = pairs.filter(c => !deadKeys.has(c.key.tag) && !missing.has(c.qid) && (minuteHits.get(c.qid) || 0) < 2);
      if (!alive.length) throw new ApiError(`${label}: nessun modello utilizzabile.`, 503);
      const ready = alive.filter(c => keyUp(c.key) && quota.usable(c.qid));
      if (!ready.length) {
        const at = Math.min(...alive.map(c => Math.max(quota.availableAt(c.qid), offlineUntil.get(c.key.tag) || 0)));
        const wait = at - Date.now();
        if (wait <= MAX_INLINE_WAIT) {
          await log(`${label}: tutti i modelli in pausa, riprovo tra ${Math.ceil(wait / 1000)} s`);
          await waitFor(wait, info);
          continue;
        }
        // "Quota finita" se tutti i modelli/chiavi in fila hanno esaurito la quota giornaliera, non solo una pausa
        const daily = alive.every(c => quota.isExhausted(c.qid));
        throw new BusyError(daily
          ? 'Quota gratuita giornaliera esaurita su tutti i modelli disponibili.'
          : 'Google è sovraccarico su tutti i modelli disponibili.', at, daily);
      }
      let pick = ready[0];
      let wait = quota.waitBefore(pick.qid, tokens);
      if (wait > SWITCH_IF_WAIT) {
        for (const c of ready.slice(1)) {
          const w = quota.waitBefore(c.qid, tokens);
          if (w < wait) { pick = c; wait = w; }
          if (w === 0) break;
        }
      }
      if (wait > 0) {
        await log(`${label}: attendo ${Math.ceil(wait / 1000)} s per restare nel limite al minuto di ${who(pick)}`);
        await waitFor(wait, info);
      }
      try {
        const text = await call(pick);
        quota.record(pick.qid, tokens);
        offlineUntil.delete(pick.key.tag);
        gemini = pick.key.gemini;
        if (pick.key.tag !== lastKeyTag) {
          lastKeyTag = pick.key.tag;
          await log(`${label}: ora uso la ${pick.key.name}`);
        }
        return { text, model: pick.model };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        const others = liveKeys().filter(k => k !== pick.key);
        // Chiave rifiutata (non valida, revocata, progetto disattivato): si passa all'altra.
        if (isKeyError(e) && others.length) {
          deadKeys.add(pick.key.tag);
          await log(`${label}: Google rifiuta la ${pick.key.name} (${e.message}), passo alla ${others[0].name}`);
          continue;
        }
        // Chiave che non risponde (errore di rete dopo i tentativi): si prova l'altra,
        // ma solo se il dispositivo è online: senza rete cambiare chiave non serve.
        const deviceOffline = globalThis.navigator?.onLine === false;
        if (e instanceof ApiError && e.status === 0 && !deviceOffline && others.some(keyUp)) {
          offlineUntil.set(pick.key.tag, Date.now() + KEY_OFFLINE_PAUSE);
          await log(`${label}: la ${pick.key.name} non risponde, passo alla ${others.find(keyUp).name}`);
          continue;
        }
        const c = quota.onError(pick.qid, e);
        const next = () => (others.some(keyUp) && pick.key.tag === '' ? `; provo ${pick.model} con la chiave di riserva` : '');
        if (c.kind === 'daily') {
          const at = new Date(quota.availableAt(pick.qid)).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
          await log(`${label}: ${who(pick)} ha finito la quota gratuita (torna disponibile alle ${at})${next()}`);
          continue;
        }
        if (c.kind === 'minute') {
          minuteHits.set(pick.qid, (minuteHits.get(pick.qid) || 0) + 1);
          await log(`${label}: ${who(pick)} al limite al minuto (libero tra ${Math.ceil(c.waitMs / 1000)} s)${next()}`);
          continue;
        }
        if (c.kind === 'overload') { await log(`${label}: ${who(pick)} sovraccarico, lo salto per qualche minuto`); continue; }
        if (e instanceof ApiError && [403, 404].includes(e.status) && pick.model !== candidates[0].model) {
          missing.add(pick.qid);
          continue;
        }
        if (e instanceof ApiError && [403, 404].includes(e.status) && pick.kind === 'transcribe') {
          await log(`Modello di trascrizione non disponibile (${e.message}); uso i modelli generali`);
          for (const k of keys) missing.add(quota.scoped(pick.model, k.tag));
          strategy = { ...strategy, transcribe: { ...strategy.transcribe, use: false } };
          saveStrategy(strategy);
          continue;
        }
        throw e;
      }
    }
  };

  // ---- Autodiagnosi (una volta per esecuzione)
  let diagnosed = false;
  const runDiagnosis = async cause => {
    diagnosed = true;
    await log(`Google ha rifiutato la richiesta: ${cause.message}${cause.detail ? ` (${cause.detail})` : ''}. Avvio l'autodiagnosi.`);
    progress({ step: 'diagnose' });
    const clients = [...liveKeys().filter(keyUp), ...liveKeys().filter(k => !keyUp(k))].map(k => k.gemini);
    const { strategy: found, results, quotaBlocked } = await diagnose(clients.length ? clients : [keys[0].gemini], {
      audio: job.chunks[0]?.mode === 'slice' ? audio : null, settings, vocabulary, current: strategy,
      onTransient: (g, model, e) => quota.onError(quota.scoped(model, keys.find(k => k.gemini === g)?.tag), e),
      onStep: label => progress({ step: 'diagnose', label }),
    });
    for (const r of results) await log(`Diagnosi: ${r.ok ? 'OK' : r.skipped ? '??' : 'NO'}, ${r.label}${r.ok ? '' : `: ${r.error}`}`);
    if (!found && quotaBlocked) {
      // Non è un rifiuto: la quota è finita durante la diagnosi. La lezione aspetta e riprova.
      diagnosed = false;
      const at = Math.min(...keys.map(k => quota.availableAt(quota.scoped(settings.reviseModel, k.tag))));
      throw new BusyError('Quota esaurita durante l\'autodiagnosi: riprovo più tardi.', Math.max(at, Date.now() + 60_000), true);
    }
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
        const secs = chunk.end - chunk.start;
        const info = { chunk: i, total };
        const range = chunk.mode === 'range' ? [chunk.start, chunk.end] : null;
        const candidates = [
          ...(chunk.mode !== 'range' && strategy.transcribe.use ? [{ model: settings.transcribeModel, kind: 'transcribe' }] : []),
          ...chain.map(model => ({ model, kind: 'generate' })),
        ];
        progress({ step: 'transcribe', ...info });
        let raw, engine;
        if (groq && !groqOff && chunk.mode !== 'range') {
          const r = await viaGroq(i, secs, info);
          if (r) ({ raw, engine } = r);
        }
        if (raw === undefined) {
          ({ text: raw, model: engine } = await runStep({
            label: 'Trascrizione', candidates, tokens: quota.estimateTokens(secs), info,
            call: async c => {
              progress({ step: 'transcribe', ...info, model: c.model, reserve: c.key.tag !== '' });
              if (c.kind === 'transcribe') {
                return withLightFallback(async () => c.key.gemini.transcribe({ model: c.model, audio: await audioFor(i, strategy.transcribe, c.key), language: lang.codes, vocabulary: strategy.transcribe.vocab ? vocabulary : [], maxOutputTokens: 32768 }));
              }
              return withLightFallback(async () => c.key.gemini.generate({ model: c.model, audio: await audioFor(i, strategy.revise, c.key), endpoint: strategy.revise.endpoint, label: 'Trascrizione', config: GEN_CONFIG,
                prompt: transcriptionPrompt({ course: job.course, glossary: glossaryText, range, lang }) }));
            },
          }));
          raw = stripFences(raw);
          // Risposta interrotta prima della fine dell'audio: si chiede il seguito.
          for (let k = 0; gemini.last?.truncated && raw && k < 4; k++) {
            await log(`Blocco ${i + 1}: trascrizione interrotta dopo ${countWords(raw)} parole, chiedo il seguito`);
            const tail = raw.replace(/\s+/g, ' ').slice(-300);
            const { text: more } = await runStep({
              label: 'Trascrizione', candidates: chain.map(model => ({ model, kind: 'generate' })), tokens: quota.estimateTokens(secs), info,
              call: async c => withLightFallback(async () => c.key.gemini.generate({ model: c.model, audio: await audioFor(i, strategy.revise, c.key), endpoint: strategy.revise.endpoint,
                label: 'Trascrizione', config: GEN_CONFIG, prompt: continuationPrompt({ course: job.course, glossary: glossaryText, tail, lang }) })),
            });
            if (!stripFences(more)) break;
            raw = `${raw}\n\n${stripFences(more)}`;
          }
        }
        const words = countWords(raw);
        await log(`Blocco ${i + 1}: trascritte ${words} parole in ${fmtTime(secs)} (${Math.round(words / Math.max(0.1, secs / 60))} al minuto) con ${engine}${lastKeyTag && !/Groq/.test(engine) ? ' (chiave di riserva)' : ''}`);
        if (!raw) await log(`Blocco ${i + 1}: nessun parlato riconosciuto`);
        job = await patch(j => { Object.assign(j.chunks[i], { raw, engine }); });
        chunk = job.chunks[i];
      }

      // Revisione
      if (settings.revise && chunk.raw) {
        const info = { chunk: i, total };
        const withAudio = !!settings.relisten;
        progress({ step: 'revise', ...info });
        const prompt = revisionPrompt({
          raw: chunk.raw, course: job.course, glossary: glossaryText, index: i, total, lang,
          start: chunk.start, end: chunk.end, prevTail: i > 0 ? tailOf(job.chunks[i - 1]) : '',
          withAudio, range: chunk.mode === 'range' ? [chunk.start, chunk.end] : null,
        });
        const { text, model } = await runStep({
          label: 'Revisione', candidates: chain.map(m => ({ model: m, kind: 'generate' })),
          tokens: quota.estimateTokens(withAudio ? chunk.end - chunk.start : 0, prompt.length), info,
          call: async c => {
            progress({ step: 'revise', ...info, model: c.model, reserve: c.key.tag !== '' });
            return withLightFallback(async () => c.key.gemini.generate({ model: c.model, prompt, endpoint: strategy.revise.endpoint, label: 'Revisione', config: GEN_CONFIG,
              audio: withAudio ? await audioFor(i, strategy.revise, c.key) : null }));
          },
        });
        const revised = stripFences(text);
        if (!revised) throw new ApiError('La revisione è tornata vuota.', 500);
        const truncated = !!gemini.last?.truncated;
        const paragraphs = paragraphsFromChunk(revised, chunk.start, chunk.end);
        const check = completenessCheck(chunk.raw, revised);
        const warns = [];
        if (truncated) warns.push('La revisione si è interrotta prima della fine del blocco: la parte finale è solo nella versione grezza.');
        else if (check.warn) warns.push(check.warn);
        if (withAudio) warns.push(...coverageWarnings(paragraphs, chunk.start, chunk.end, job.duration));
        const warn = warns.join(' ') || null;
        if (warn) await log(`Blocco ${i + 1}: ${warn}`);
        if (model !== settings.reviseModel || lastKeyTag) await log(`Blocco ${i + 1}: rivisto con ${model}${lastKeyTag ? ' (chiave di riserva)' : ''}`);
        job = await patch(j => { Object.assign(j.chunks[i], { revised, paragraphs, ratio: check.ratio, warn, reviseEngine: model }); });
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
      for (const [k, g] of Object.entries(job.chunks[i].grefs)) await dropRef(k, g);
      job = await patch(j => { delete j.chunks[i].grefs; delete j.chunks[i].gfile; });
    }
    wavCache.delete(i);
    lightCache.delete(i);
    ctx.onChunkDone?.(job, i);
  }

  for (const [k, g] of Object.entries(job.grefs || {})) await dropRef(k, g);
  job = await patch(j => {
    j.status = 'done'; j.finishedAt = Date.now(); j.error = null; delete j.grefs; delete j.gfile; delete j.runner;
  });
  progress({ step: 'done' });
  return job;
}
