// Trascrizione con Whisper large-v3 su Groq (piano gratuito: circa 8 ore di audio al giorno,
// 2 ore all'ora, file fino a 25 MB). Whisper fa solo la trascrizione letterale; la revisione
// (punteggiatura, paragrafi, correzioni riascoltando l'audio) resta a Gemini.

import { fmtMMSS } from './text.js';

export const GROQ_BASE = 'https://api.groq.com/openai/v1';
export const GROQ_MODEL = 'whisper-large-v3';
export const GROQ_MAX_BYTES = 24_500_000; // limite del piano gratuito: 25 MB
export const GROQ_DAILY_SEC = 28_800;
const USAGE_KEY = 'sbobina.groq';

export class GroqError extends Error {
  constructor(message, status, { retryMs = NaN, body } = {}) {
    super(message);
    this.status = status;
    this.retryMs = retryMs;
    this.body = body;
  }
}

/** "Please try again in 7m12.5s" | "in 2h3m" | "in 850ms" → millisecondi (NaN se assente). */
export function retryFromGroq(msg) {
  const m = /try again in\s+((?:\d+(?:\.\d+)?(?:h|ms|m|s))+)/i.exec(String(msg || ''));
  if (!m) return NaN;
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) ms += parseFloat(n) * { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[u];
  return ms;
}

/** Spiegazione per l'utente. */
export function explainGroq(e) {
  if (e?.name === 'AbortError') return 'Elaborazione interrotta.';
  const s = e?.status;
  if (s === 401) return 'Groq ha rifiutato la chiave: controllala nelle impostazioni.';
  if (s === 429) return `Groq: limite gratuito raggiunto${Number.isFinite(e.retryMs) ? `, di nuovo disponibile tra ${Math.ceil(e.retryMs / 60000)} min` : ''}.`;
  if (s === 413) return 'Groq: file troppo grande.';
  if (s === 0) return 'Groq non raggiungibile (rete assente, o il browser blocca la richiesta).';
  return `Groq: ${e?.message || e}`;
}

export class Groq {
  constructor(key, { signal, log = () => {} } = {}) {
    this.key = String(key || '').trim();
    this.signal = signal;
    this.log = log;
  }

  async request(path, init = {}) {
    let res;
    try {
      res = await fetch(GROQ_BASE + path, { ...init, signal: this.signal, headers: { Authorization: `Bearer ${this.key}`, ...(init.headers || {}) } });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new GroqError(`rete (${e.message})`, 0);
    }
    if (res.ok) return res.json();
    let body = null;
    try { body = await res.json(); } catch { /* corpo non JSON */ }
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const header = parseFloat(res.headers.get('retry-after'));
    const retryMs = Number.isFinite(header) ? header * 1000 : retryFromGroq(msg);
    throw new GroqError(msg, res.status, { retryMs, body });
  }

  /** Verifica della chiave: elenco modelli. */
  async check() {
    const r = await this.request('/models');
    return (r.data || []).some(m => m.id === GROQ_MODEL);
  }

  /**
   * @param {{blob: Blob, language?: string, prompt?: string}} p
   * @returns {Promise<{text: string, segments: {start:number,end:number,text:string,no_speech_prob?:number,avg_logprob?:number,compression_ratio?:number}[], duration?: number}>}
   */
  async transcribe({ blob, language, prompt }) {
    if (blob.size > GROQ_MAX_BYTES) throw new GroqError('file oltre i 25 MB', 413);
    const ext = /ogg/.test(blob.type) ? 'ogg' : /wav/.test(blob.type) ? 'wav' : /mpeg|mp3/.test(blob.type) ? 'mp3' : /mp4|m4a/.test(blob.type) ? 'm4a' : 'ogg';
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    return this.request('/audio/transcriptions', { method: 'POST', body: form });
  }
}

// ---------------------------------------------------------------- Consumo di oggi

const today = () => new Date().toISOString().slice(0, 10); // Groq azzera i limiti giornalieri in UTC
export function groqUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    return u.day === today() ? u : { day: today(), sec: 0, calls: 0 };
  } catch { return { day: today(), sec: 0, calls: 0 }; }
}
export function recordGroq(sec) {
  const u = groqUsage();
  u.sec += sec; u.calls += 1;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch { /* pieno */ }
}

// ---------------------------------------------------------------- Dal risultato al testo grezzo

// Frasi che Whisper "inventa" nei silenzi (imparate dai sottotitoli dei video).
const PHANTOM = /^(?:sottotitoli (?:creati|a cura|e revisione)|.*amara\.org|grazie (?:a tutti )?per (?:la visione|aver guardato)|iscriviti al canale|thanks? for watching|subtitles by|please subscribe|ciao a tutti e benvenuti sul mio canale)/i;

/**
 * Segmenti Whisper → testo grezzo a paragrafi, ognuno con il tempo [MM:SS] dall'inizio del blocco.
 * Scarta i segmenti quasi certamente inventati (silenzio + bassa confidenza, ripetizioni, frasi da sottotitoli).
 * @returns {{raw: string, dropped: number, droppedItems: {start:number,text:string,why:string}[]}}
 */
export function rawFromSegments(segments) {
  const kept = [];
  const droppedItems = [];
  let prev = '';
  let repeats = 0;
  for (const s of segments || []) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    const silent = (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.9;
    const looping = (s.compression_ratio ?? 0) > 2.6;
    const phantom = PHANTOM.test(text) && ((s.no_speech_prob ?? 0) > 0.2 || text.length < 60);
    repeats = text.toLowerCase() === prev ? repeats + 1 : 0;
    prev = text.toLowerCase();
    if (silent || looping || phantom || repeats >= 2) {
      droppedItems.push({ start: Number(s.start) || 0, text, why: phantom ? 'frase tipica dei sottotitoli' : looping ? 'ripetizione in loop' : repeats >= 2 ? 'ripetuta' : 'silenzio' });
      continue;
    }
    kept.push({ start: Number(s.start) || 0, end: Number(s.end) || 0, text });
  }
  // Paragrafi: si va a capo dopo una pausa lunga, dopo una pausa breve se il paragrafo è già
  // abbastanza lungo, o comunque dopo ~900 caratteri (così i tempi restano fitti).
  const paras = [];
  let cur = null;
  for (const s of kept) {
    const gap = cur ? s.start - cur.end : 0;
    if (!cur || gap > 8 || (gap > 1.2 && cur.text.length > 350) || cur.text.length > 900) {
      cur = { start: s.start, end: s.end, text: s.text };
      paras.push(cur);
    } else {
      cur.text += (/[\s-]$/.test(cur.text) ? '' : ' ') + s.text;
      cur.end = s.end;
    }
  }
  return { raw: paras.map(p => `[${fmtMMSS(p.start)}] ${p.text}`).join('\n\n'), dropped: droppedItems.length, droppedItems };
}

/** Lingua per Whisper: solo se la lezione è in una lingua sola (con due lingue meglio il riconoscimento automatico). */
export function whisperLanguage(lang) {
  const codes = lang?.codes || [];
  return codes.length === 1 ? codes[0].slice(0, 2) : undefined;
}

/** Suggerimento per Whisper (massimo ~224 token): parole chiave del corso, in una frase ben punteggiata. */
export function whisperPrompt(vocabulary, lang) {
  let terms = '';
  for (const t of vocabulary || []) {
    const next = terms ? `${terms}, ${t}` : t;
    if (next.length > 600) break;
    terms = next;
  }
  const it = !lang?.codes?.length || /^it/.test(lang.codes[0]);
  const intro = it ? 'Lezione universitaria.' : 'University lecture.';
  return terms ? `${intro} ${it ? 'Termini' : 'Terms'}: ${terms}.` : intro;
}
