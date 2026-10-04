// Analisi e taglio di file AAC in formato ADTS (quello del registratore Nothing).
//
// Un file ADTS è una sequenza di "frame" indipendenti, ognuno con un'intestazione
// di 7 byte che dice quanto è lungo e quanti campioni audio contiene.
// Quindi si può tagliare il file al confine di un frame e ottenere due file
// AAC validi, senza decodificare né ricodificare nulla.

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function headerAt(b, i) {
  if (i + 7 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null; // sync 0xFFF + layer 00
  const sfi = (b[i + 2] >> 2) & 0x0f;
  if (sfi > 12) return null;
  const len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  if (len < 7) return null;
  const blocks = (b[i + 6] & 0x03) + 1;
  return { sfi, len, blocks };
}

function skipId3(b) {
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size + ((b[5] & 0x10) ? 10 : 0);
  }
  return 0;
}

/**
 * Alcuni registratori Android (tra cui quello Nothing) scrivono come primo "frame" ADTS
 * la configurazione del codec (AudioSpecificConfig, 2 byte) invece di audio: un frame
 * finto da 9 byte. ffmpeg lo scarta con un errore, il decoder del browser e quello di
 * Google si bloccano. Lo riconosciamo e lo escludiamo da tutto ciò che inviamo.
 */
function isConfigFrame(b, i, len) {
  const headerLen = (b[i + 1] & 0x01) ? 7 : 9;
  const payload = len - headerLen;
  if (payload < 2 || payload > 5) return false;
  const p = i + headerLen;
  const objectType = b[p] >> 3;
  const sfi = ((b[p] & 0x07) << 1) | (b[p + 1] >> 7);
  const channels = (b[p + 1] >> 3) & 0x0f;
  const hProfile = (b[i + 2] >> 6) & 0x03;
  const hSfi = (b[i + 2] >> 2) & 0x0f;
  const hChannels = ((b[i + 2] & 0x01) << 2) | (b[i + 3] >> 6);
  return objectType === hProfile + 1 && sfi === hSfi && channels === hChannels;
}

// Un'intestazione è "credibile" se dopo di lei ne parte un'altra (o finisce il file).
function confirmed(b, i) {
  const h = headerAt(b, i);
  if (!h) return null;
  const next = i + h.len;
  if (next === b.length) return h;
  const h2 = headerAt(b, next);
  return h2 && h2.sfi === h.sfi ? h : null;
}

/** Restituisce l'indice dei frame, oppure null se il file non è ADTS. */
export function analyzeAdts(bytes) {
  const b = bytes;
  const start = skipId3(b);
  let first = -1;
  const limit = Math.min(b.length - 7, start + 65536);
  for (let i = start; i < limit; i++) {
    if (confirmed(b, i)) { first = i; break; }
  }
  if (first < 0) return null;

  const sampleRate = RATES[headerAt(b, first).sfi];
  let cap = Math.max(1024, Math.ceil(b.length / 200));
  let offsets = new Uint32Array(cap);
  let sizes = new Uint32Array(cap);
  let startSamples = new Float64Array(cap);
  let n = 0;
  let samples = 0;
  let i = first;
  let skipped = 0;
  const junk = []; // [inizio, fine) in byte dei frame finti da escludere

  while (i <= b.length - 7) {
    const h = headerAt(b, i);
    if (!h || i + h.len > b.length) {
      // Dati corrotti: cerca il prossimo frame credibile.
      let j = i + 1;
      while (j <= b.length - 7 && !confirmed(b, j)) j++;
      if (j > b.length - 7) break;
      skipped += j - i;
      i = j;
      continue;
    }
    if (isConfigFrame(b, i, h.len)) {
      junk.push([i, i + h.len]);
      i += h.len;
      continue;
    }
    if (n === cap) {
      cap *= 2;
      const o = new Uint32Array(cap); o.set(offsets); offsets = o;
      const s = new Uint32Array(cap); s.set(sizes); sizes = s;
      const t = new Float64Array(cap); t.set(startSamples); startSamples = t;
    }
    offsets[n] = i;
    sizes[n] = h.len;
    startSamples[n] = samples;
    n++;
    samples += 1024 * h.blocks;
    i += h.len;
  }
  if (n < 2) return null;

  return {
    sampleRate,
    frameCount: n,
    offsets: offsets.subarray(0, n),
    sizes: sizes.subarray(0, n),
    startSamples: startSamples.subarray(0, n),
    totalSamples: samples,
    duration: samples / sampleRate,
    dataEnd: offsets[n - 1] + sizes[n - 1],
    skippedBytes: skipped,
    junk,
  };
}

/** Intervalli di byte da inviare per [startByte, endByte), esclusi i frame finti. */
export function byteParts(info, startByte, endByte) {
  const parts = [];
  let cur = startByte;
  for (const [a, z] of info.junk || []) {
    if (z <= cur || a >= endByte) continue;
    if (a > cur) parts.push([cur, a]);
    cur = Math.max(cur, z);
  }
  if (cur < endByte) parts.push([cur, endByte]);
  return parts;
}

/** Ricompone un blocco di audio a partire dagli intervalli di byte. */
export function sliceParts(blob, parts, type = 'audio/aac') {
  return new Blob(parts.map(([a, z]) => blob.slice(a, z)), { type });
}

/**
 * Versione "pulita" di un file ADTS per il lettore audio: toglie l'eventuale frame finto
 * iniziale leggendo solo l'inizio del file. Gli altri formati restano invariati.
 */
export async function cleanForPlayback(blob) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const start = skipId3(head);
  const h = confirmed(head, start);
  if (h && isConfigFrame(head, start, h.len)) return blob.slice(start + h.len, blob.size, blob.type || 'audio/aac');
  return blob;
}

/** Indice del frame che contiene l'istante t (secondi). */
export function frameAt(info, t) {
  const target = t * info.sampleRate;
  let lo = 0, hi = info.frameCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (info.startSamples[mid] <= target) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export const frameTime = (info, f) =>
  f >= info.frameCount ? info.duration : info.startSamples[f] / info.sampleRate;

const byteStart = (info, f) => info.offsets[f];
const byteEnd = (info, f) => (f >= info.frameCount ? info.dataEnd : info.offsets[f]);

/**
 * Trova il punto più silenzioso tra a e b (secondi) e restituisce il frame dove tagliare.
 * Metodo principale: decodifica quel minuto di audio e misura l'energia (RMS) su
 * finestre da 0,5 s. Ripiego: i frame AAC di silenzio sono più piccoli in byte.
 */
export async function findQuietFrame(info, bytes, a, b, decode = defaultDecode) {
  const f0 = frameAt(info, Math.max(0, a));
  const f1 = Math.min(info.frameCount, frameAt(info, Math.min(info.duration, b)) + 1);
  if (f1 - f0 < 8) return f0;

  try {
    const ranges = byteParts(info, byteStart(info, f0), byteEnd(info, f1));
    const slice = new Uint8Array(ranges.reduce((a, [x, y]) => a + (y - x), 0));
    let o = 0;
    for (const [x, y] of ranges) { slice.set(bytes.subarray(x, y), o); o += y - x; }
    const pcm = await decode(slice.buffer);
    if (pcm && pcm.data.length > pcm.sampleRate) {
      const hop = Math.round(pcm.sampleRate * 0.05);
      const nHops = Math.floor(pcm.data.length / hop);
      const energy = new Float64Array(nHops);
      for (let h = 0; h < nHops; h++) {
        let s = 0;
        for (let k = h * hop; k < (h + 1) * hop; k++) s += pcm.data[k] * pcm.data[k];
        energy[h] = s;
      }
      const win = 10; // 10 × 50 ms = 0,5 s
      let best = 0, bestVal = Infinity, acc = 0;
      for (let h = 0; h < nHops; h++) {
        acc += energy[h];
        if (h >= win) acc -= energy[h - win];
        if (h >= win - 1 && acc < bestVal) { bestVal = acc; best = h - win + 1; }
      }
      const tQuiet = frameTime(info, f0) + (best + win / 2) * hop / pcm.sampleRate;
      return Math.min(f1 - 1, Math.max(f0 + 1, frameAt(info, tQuiet)));
    }
  } catch (_) { /* si passa al ripiego */ }

  const win = 12;
  let best = f0, bestVal = Infinity, acc = 0;
  for (let f = f0; f < f1; f++) {
    acc += info.sizes[f];
    if (f - f0 >= win) acc -= info.sizes[f - win];
    if (f - f0 >= win - 1 && acc < bestVal) { bestVal = acc; best = f - win + 1; }
  }
  return Math.min(f1 - 1, best + (win >> 1));
}

async function defaultDecode(arrayBuffer) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx(1, 1, 16000);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  return { data: buf.getChannelData(0), sampleRate: buf.sampleRate };
}

/**
 * Divide la lezione in blocchi di durata uguale, il più vicini possibile a targetSec,
 * tagliando nelle pause. Restituisce [{startFrame, endFrame, start, end, startByte, endByte}].
 */
export async function planChunks(info, bytes, targetSec = 1200, opts = {}) {
  const D = info.duration;
  const maxSec = opts.maxSec || 54 * 60; // il modello di trascrizione accetta al massimo 1 ora per richiesta
  const n = Math.max(1, Math.round(D / targetSec) || 1, Math.ceil(D / maxSec));
  const len = D / n;
  const searchHalf = Math.min(30, len / 4);
  const cuts = [0];
  for (let k = 1; k < n; k++) {
    const t = k * len;
    cuts.push(await findQuietFrame(info, bytes, t - searchHalf, t + searchHalf, opts.decode));
  }
  cuts.push(info.frameCount);
  const chunks = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const s = cuts[k], e = cuts[k + 1];
    if (e <= s) continue;
    chunks.push({
      startFrame: s, endFrame: e,
      start: frameTime(info, s), end: frameTime(info, e),
      startByte: byteStart(info, s), endByte: byteEnd(info, e),
      parts: byteParts(info, byteStart(info, s), byteEnd(info, e)),
    });
  }
  return chunks;
}

/** Durata di un file audio qualsiasi, letta dal browser. */
export function probeDuration(blob, timeoutMs = 20000) {
  return new Promise(resolve => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = v => {
      if (done) return; done = true;
      URL.revokeObjectURL(url); a.removeAttribute('src'); a.load();
      resolve(v);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) return finish(a.duration);
      a.ondurationchange = () => { if (Number.isFinite(a.duration)) finish(a.duration); };
      a.currentTime = 1e7; // trucco per i file senza durata nell'intestazione
    };
    a.onerror = () => finish(null);
    setTimeout(() => finish(null), timeoutMs);
    a.src = url;
  });
}

/** Tipo MIME accettato da Gemini, dedotto da tipo e nome del file. */
export function guessMime(file) {
  const t = (file.type || '').toLowerCase();
  const ext = (file.name || '').toLowerCase().split('.').pop();
  const map = {
    'audio/x-aac': 'audio/aac', 'audio/aacp': 'audio/aac', 'audio/mp4': 'audio/m4a',
    'audio/x-m4a': 'audio/m4a', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
    'audio/mp3': 'audio/mp3', 'audio/mpeg': 'audio/mpeg', 'audio/ogg': 'audio/ogg',
    'audio/opus': 'audio/opus', 'audio/webm': 'audio/webm', 'audio/flac': 'audio/flac',
    'audio/x-flac': 'audio/flac', 'audio/aac': 'audio/aac', 'audio/wav': 'audio/wav',
    'audio/m4a': 'audio/m4a',
  };
  if (map[t]) return map[t];
  const byExt = { aac: 'audio/aac', m4a: 'audio/m4a', mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg',
    oga: 'audio/ogg', opus: 'audio/opus', webm: 'audio/webm', flac: 'audio/flac', mp4: 'audio/m4a' };
  return byExt[ext] || t || 'audio/aac';
}
