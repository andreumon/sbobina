// Autodiagnosi della Gemini API.
// Se Google risponde "Request contains an invalid argument" (o simili), Sbobina prova
// alcune varianti della stessa richiesta su un frammento di pochi secondi della lezione
// e si ricorda quella che funziona:
//   - formato:   audio originale (AAC) | convertito in WAV 16 kHz mono
//   - trasporto: file caricato con la Files API (uri) | audio dentro la richiesta (inline)
//   - endpoint:  Interactions API | generateContent
//   - vocabolario personalizzato sì/no (solo per il modello di trascrizione)
import { analyzeAdts, byteParts, sliceParts } from './aac.js';
import { blobToBase64, ApiError, isTransient } from './gemini.js';
import { device } from './store.js';

export const INLINE_MAX_BYTES = 12_000_000; // la richiesta intera deve stare sotto i 20 MB, base64 incluso
export const WAV_BYTES_PER_SEC = 32_000;    // 16 kHz, mono, 16 bit

export const DEFAULT_STRATEGY = {
  transcribe: { use: true, transport: 'uri', format: 'native', vocab: true },
  revise: { endpoint: 'interactions', transport: 'uri', format: 'native' },
  testedAt: 0,
};

// 'apiStrategy2': le strategie salvate dalla versione precedente erano falsate dal frame finto.
export const loadStrategy = () => ({ ...DEFAULT_STRATEGY, ...device.get('apiStrategy2', {}) });
export const saveStrategy = s => device.set('apiStrategy2', s);
export const resetStrategy = () => device.set('apiStrategy2', {});

/** Secondi massimi per blocco, dati i vincoli della strategia (null = nessun vincolo). */
export function maxChunkSec(strategy, nativeBytesPerSec) {
  const limits = [];
  for (const step of [strategy.transcribe, strategy.revise]) {
    if (!step || step.transport !== 'inline') continue;
    const bps = step.format === 'wav' ? WAV_BYTES_PER_SEC : nativeBytesPerSec;
    if (bps) limits.push(INLINE_MAX_BYTES / bps);
  }
  return limits.length ? Math.min(...limits) : null;
}

// ---------------------------------------------------------------- Audio

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Converte un audio qualsiasi in WAV 16 kHz mono (decodifica del browser). */
export async function toWav16k(blob) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  let data = buf.getChannelData(0);
  if (buf.numberOfChannels > 1) {
    const mix = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mix[i] += ch[i] / buf.numberOfChannels;
    }
    data = mix;
  }
  return encodeWav(data, buf.sampleRate);
}

/** Due secondi di tono: serve solo a verificare la forma della richiesta. */
function toneWav() {
  const sr = 16000, n = sr * 2, s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return encodeWav(s, sr);
}

/** Pochi secondi dell'audio della lezione, tagliati su un confine di frame AAC. */
export async function probeSlice(audio) {
  const head = new Uint8Array(await audio.slice(0, 450_000).arrayBuffer());
  const info = analyzeAdts(head);
  if (!info) return null;
  return sliceParts(audio, byteParts(info, info.offsets[0], info.dataEnd));
}

// ---------------------------------------------------------------- Diagnosi

/**
 * gemini: un client o un elenco di client (chiave principale, poi riserva).
 * Un errore di quota o sovraccarico (429/5xx) NON dice nulla sulla forma della richiesta:
 * si ripete la stessa prova con la chiave successiva; se nessuna può rispondere, la prova
 * resta "non verificata" e per quel passo si tiene la variante attuale (current).
 * @returns {Promise<{strategy: object|null, results: {label, ok, error?, skipped?}[], quotaBlocked: boolean}>}
 */
export async function diagnose(gemini, { audio, settings, vocabulary = [], onStep = () => {}, current = DEFAULT_STRATEGY, onTransient = () => {} }) {
  const clients = (Array.isArray(gemini) ? gemini : [gemini]).filter(Boolean);
  let ci = 0;
  let quotaBlocked = false;
  const results = [];
  const native = audio ? await probeSlice(audio) : null;
  const formats = [];
  if (native) formats.push({ format: 'native', blob: native, mime: 'audio/aac' });
  // La variante WAV si prova solo se questo dispositivo sa davvero convertire l'audio:
  // un tono di prova direbbe "funziona" anche quando poi la conversione fallisce.
  let wav = null;
  if (native) {
    try { wav = await toWav16k(native); } catch { results.push({ label: 'Conversione in WAV su questo dispositivo', ok: false, error: 'il browser non riesce a decodificare questo audio' }); }
  } else wav = toneWav();
  if (wav) formats.push({ format: 'wav', blob: wav, mime: 'audio/wav' });

  // I file caricati appartengono al progetto della chiave: uno per chiave e formato.
  const uploaded = {};
  const ref = async (g, f, transport) => {
    if (transport === 'inline') return { data: await blobToBase64(f.blob), mimeType: f.mime };
    const k = `${clients.indexOf(g)}:${f.format}`;
    if (!uploaded[k]) {
      const file = await g.upload(f.blob, f.mime, `sbobina-diagnosi-${f.format}`);
      uploaded[k] = { uri: file.uri, mimeType: f.mime, name: file.name, g };
    }
    return uploaded[k];
  };
  const errText = e => `${e.status ? `HTTP ${e.status}: ` : ''}${e.message}${e.detail ? ` (${e.detail})` : ''}`;
  /** true = accettata, false = rifiutata, null = non verificabile (quota/sovraccarico su tutte le chiavi). */
  const attempt = async (label, model, fn) => {
    onStep(label);
    for (;;) {
      try {
        await fn(clients[ci]);
        results.push({ label: clients.length > 1 && ci > 0 ? `${label} [chiave di riserva]` : label, ok: true });
        return true;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (isTransient(e)) {
          onTransient(clients[ci], model, e); // così il dosatore delle quote sa che quel modello è esaurito
          if (ci + 1 < clients.length) { ci++; continue; } // stessa prova con la chiave successiva
          quotaBlocked = true;
          results.push({ label, ok: false, skipped: true, error: `non verificabile adesso: ${e.status === 429 ? 'quota esaurita' : 'Google sovraccarico'} (${e.message.split('. ')[0]})` });
          return null;
        }
        results.push({ label, ok: false, error: errText(e) });
        return false;
      }
    }
  };

  // undefined = da provare, null = non verificabile adesso (quota), oggetto = variante trovata
  let transcribe, revise;
  for (const f of formats) {
    for (const transport of ['uri', 'inline']) {
      if (transcribe === undefined) {
        const ok = await attempt(`${settings.transcribeModel}, ${f.format === 'wav' ? 'WAV' : 'AAC'}, ${transport === 'uri' ? 'file caricato' : 'inline'}`, settings.transcribeModel,
          async g => g.transcribe({ model: settings.transcribeModel, audio: await ref(g, f, transport), language: settings.language }));
        if (ok === null) transcribe = null;
        if (ok) {
          transcribe = { use: true, transport, format: f.format, vocab: true };
          if (vocabulary.length) {
            const okVocab = await attempt('  …con il vocabolario del corso', settings.transcribeModel,
              async g => g.transcribe({ model: settings.transcribeModel, audio: await ref(g, f, transport), language: settings.language, vocabulary }));
            transcribe.vocab = okVocab !== false;
          }
        }
      }
      for (const endpoint of ['interactions', 'generate']) {
        if (revise !== undefined) break;
        const ok = await attempt(`${settings.reviseModel}, ${endpoint === 'generate' ? 'generateContent' : 'Interactions'}, ${f.format === 'wav' ? 'WAV' : 'AAC'}, ${transport === 'uri' ? 'file caricato' : 'inline'}`, settings.reviseModel,
          async g => g.generate({ model: settings.reviseModel, endpoint, label: 'Diagnosi', audio: await ref(g, f, transport), prompt: 'Trascrivi questo audio.' }));
        if (ok === null) revise = null;
        if (ok) revise = { endpoint, transport, format: f.format };
      }
      if (transcribe !== undefined && revise !== undefined) break;
    }
    if (transcribe !== undefined && revise !== undefined) break;
  }
  for (const u of Object.values(uploaded)) u.g.deleteFile(u.name);

  // Passi non verificabili per quota: si tiene la variante attuale invece di "bocciarla".
  if (revise === null) revise = current.revise;
  if (transcribe === null) transcribe = current.transcribe;
  if (!revise) return { strategy: null, results, quotaBlocked };
  if (!transcribe) transcribe = { use: false, transport: revise.transport, format: revise.format, vocab: false };
  // Nulla di nuovo verificato (tutto bloccato dalla quota): nessuna strategia da salvare.
  if (quotaBlocked && !results.some(r => r.ok)) return { strategy: null, results, quotaBlocked };
  return { strategy: { transcribe, revise, testedAt: Date.now() }, results, quotaBlocked };
}

export function describeStrategy(s) {
  const fmt = x => `${x.format === 'wav' ? 'WAV' : 'audio originale'}, ${x.transport === 'uri' ? 'file caricato' : 'inline'}`;
  const t = s.transcribe.use ? `modello di trascrizione (${fmt(s.transcribe)}${s.transcribe.vocab ? '' : ', senza vocabolario'})` : `modello di revisione (${fmt(s.transcribe)})`;
  return `trascrizione con ${t}; revisione via ${s.revise.endpoint === 'generate' ? 'generateContent' : 'Interactions'} (${fmt(s.revise)})`;
}

export const isRequestShapeError = e => e instanceof ApiError && e.status === 400;
