// Audio "leggero" da inviare ai servizi di trascrizione.
//
// Il registratore Nothing salva in AAC stereo a 192 kbps: 45 minuti pesano circa 65 MB.
// Per riconoscere il parlato bastano 16 kHz mono (è quello che Whisper e Gemini usano
// comunque al loro interno), e in Opus a 24 kbps gli stessi 45 minuti pesano circa 8 MB.
//
// Come funziona:
//  1. il blocco AAC si decodifica a pezzi di qualche minuto (decodificarlo tutto insieme
//     occuperebbe centinaia di MB di memoria sul telefono), già ricampionato a 16 kHz;
//  2. i due canali si mediano in uno solo;
//  3. il codificatore Opus del browser (WebCodecs) comprime;
//  4. i pacchetti si mettono in un contenitore Ogg, il formato standard per Opus.
// Se il browser non ha il codificatore Opus, si torna all'invio dell'AAC originale.

import { analyzeAdts } from './aac.js';

const RATE = 16000;
const BITRATE = 24000;
const PIECE_SEC = 120; // decodifica a pezzi di 2 minuti (poca memoria anche sul telefono)

let support;
/** Il browser sa codificare Opus? (Chrome, Edge, Firefox recenti; non Safari) */
export function canMakeLight() {
  if (support !== undefined) return support;
  if (typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined' || typeof AudioData === 'undefined') {
    support = Promise.resolve(false);
  } else {
    support = AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE })
      .then(r => !!r.supported).catch(() => false);
  }
  return support;
}

async function decodePiece(buf, expectedFrames) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const ab = await ctx.decodeAudioData(buf);
  const n = ab.length;
  const out = new Float32Array(expectedFrames ?? n);
  const chans = ab.numberOfChannels;
  const len = Math.min(n, out.length);
  if (chans === 1) out.set(ab.getChannelData(0).subarray(0, len));
  else {
    const data = Array.from({ length: chans }, (_, c) => ab.getChannelData(c));
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += data[c][i];
      out[i] = s / chans;
    }
  }
  return out; // più corto del previsto: il resto resta silenzio (mantiene i tempi allineati)
}

/**
 * Converte un blob audio in Opus mono 16 kHz dentro Ogg.
 * decode(buffer, campioniAttesi) → Float32Array mono a 16 kHz (sostituibile nei test).
 * @returns {Promise<Blob|null>} null se il browser non lo permette o il file non si decodifica
 */
export async function makeLight(blob, { onProgress = () => {}, signal, decode = decodePiece } = {}) {
  if (!(await canMakeLight())) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info = analyzeAdts(bytes);

  const packets = [];
  let head = null;
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      packets.push({ data: d, dur: chunk.duration });
      const desc = meta?.decoderConfig?.description;
      if (desc && !head) head = new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
    },
    error: e => { failure = e; },
  });
  enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE });

  let written = 0; // campioni a 16 kHz già inviati al codificatore
  const feed = async pcm => {
    // A pezzi da 1 s, aspettando se il codificatore è indietro (memoria costante)
    for (let o = 0; o < pcm.length; o += RATE) {
      if (signal?.aborted) throw new DOMException('Interrotto', 'AbortError');
      if (failure) throw failure;
      const part = pcm.subarray(o, Math.min(pcm.length, o + RATE));
      enc.encode(new AudioData({
        format: 'f32-planar', sampleRate: RATE, numberOfChannels: 1, numberOfFrames: part.length,
        timestamp: Math.round((written / RATE) * 1e6), data: part,
      }));
      written += part.length;
      while (enc.encodeQueueSize > 20) await new Promise(r => setTimeout(r, 5));
    }
  };

  try {
    if (info) {
      // ADTS: pezzi tagliati al confine dei frame, ognuno decodificato da solo.
      const framesPerPiece = Math.max(1, Math.round((PIECE_SEC * info.sampleRate) / 1024));
      for (let f = 0; f < info.frameCount; f += framesPerPiece) {
        const g = Math.min(info.frameCount, f + framesPerPiece);
        const a = info.offsets[f];
        const z = g >= info.frameCount ? info.dataEnd : info.offsets[g];
        const samples = (g >= info.frameCount ? info.totalSamples : info.startSamples[g]) - info.startSamples[f];
        const expected = Math.round((samples / info.sampleRate) * RATE);
        const pcm = await decode(bytes.slice(a, z).buffer, expected);
        await feed(pcm);
        onProgress(g / info.frameCount);
      }
    } else {
      // Altri formati (mp3, m4a…): tutto in una volta, solo se non troppo lunghi.
      if (blob.size > 60_000_000) return null;
      await feed(await decode(bytes.buffer));
      onProgress(1);
    }
    await enc.flush();
    if (failure) throw failure;
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    console.warn('Audio leggero non riuscito', e);
    return null;
  } finally {
    try { enc.close(); } catch { /* già chiuso */ }
  }
  if (!packets.length) return null;
  return oggOpus(packets, head);
}

// ---------------------------------------------------------------- Contenitore Ogg

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

function oggPage({ type, granule, serial, seq, packets }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0;
  page[5] = type;
  v.setBigUint64(6, BigInt(granule), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  v.setUint32(22, crc32(page), true);
  return page;
}

function opusHead(preSkip = 312) {
  const h = new Uint8Array(19);
  const v = new DataView(h.buffer);
  h.set(new TextEncoder().encode('OpusHead'), 0);
  h[8] = 1; h[9] = 1; // versione, canali
  v.setUint16(10, preSkip, true);
  v.setUint32(12, RATE, true);
  v.setInt16(16, 0, true);
  h[18] = 0;
  return h;
}

function opusTags() {
  const vendor = new TextEncoder().encode('Sbobina');
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  const v = new DataView(t.buffer);
  t.set(new TextEncoder().encode('OpusTags'), 0);
  v.setUint32(8, vendor.length, true);
  t.set(vendor, 12);
  v.setUint32(12 + vendor.length, 0, true);
  return t;
}

/** Impacchetta i pacchetti Opus in un file Ogg (RFC 7845). */
export function oggOpus(packets, head = null) {
  const isHead = head && head.length >= 19 && new TextDecoder().decode(head.subarray(0, 8)) === 'OpusHead';
  const headBytes = isHead ? head : opusHead();
  const preSkip = new DataView(headBytes.buffer, headBytes.byteOffset).getUint16(10, true);
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages = [];
  let seq = 0;
  pages.push(oggPage({ type: 0x02, granule: 0, serial, seq: seq++, packets: [headBytes] }));
  pages.push(oggPage({ type: 0, granule: 0, serial, seq: seq++, packets: [opusTags()] }));
  let granule = preSkip;
  let batch = [], segs = 0;
  const flush = last => {
    pages.push(oggPage({ type: last ? 0x04 : 0, granule, serial, seq: seq++, packets: batch }));
    batch = []; segs = 0;
  };
  packets.forEach((p, i) => {
    const need = Math.floor(p.data.length / 255) + 1;
    if (segs + need > 255 || batch.length >= 50) flush(false);
    batch.push(p.data);
    segs += need;
    granule += Math.round(((p.dur || 20000) * 48000) / 1e6); // la posizione Ogg di Opus è sempre a 48 kHz
    if (i === packets.length - 1) flush(true);
  });
  return new Blob(pages, { type: 'audio/ogg' });
}
