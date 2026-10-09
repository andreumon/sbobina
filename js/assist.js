// Funzioni su richiesta, a lezione già elaborata:
//  - indice degli argomenti (solo testo, con i modelli "lite": non tocca le quote delle revisioni);
//  - nuova revisione di un singolo paragrafo, riascoltando solo il suo tratto di audio
//    (solo con i modelli avanzati, come la revisione normale);
//  - confronto parola per parola tra due versioni di un paragrafo;
//  - ricerca di un termine nelle lezioni.

import { Gemini, ApiError, blobToBase64 } from './gemini.js';
import { analyzeAdts, frameAt } from './aac.js';
import { makeLight } from './light.js';
import { loadStrategy } from './strategy.js';
import { langOf } from './prompts.js';
import * as quota from './quota.js';
import { fmtTime, fmtMMSS, parseTime, lectureParagraphs, paragraphsFromRaw, glossaryTerms, countWords } from './text.js';
import { FALLBACK_MODELS, STRONG_MODELS, REDO_MAX_MS } from './pipeline.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Interrotto', 'AbortError')); }, { once: true });
});
const transient = e => e instanceof ApiError && [429, 500, 502, 503, 504].includes(e.status);

/** Modelli per una revisione chiesta a mano: 'best' = i migliori disponibili in ordine; 'strong' = solo 3.8 e 3.7. */
export function reviewModels(settings, mode = 'best') {
  const pool = mode === 'strong' ? STRONG_MODELS : FALLBACK_MODELS;
  return [...(pool.includes(settings.reviseModel) || mode !== 'strong' ? [settings.reviseModel] : []), ...pool.filter(m => m !== settings.reviseModel)];
}

export const INDEX_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

const stripFences = t => String(t || '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

/** Prova i modelli in ordine, saltando quelli senza quota o sovraccarichi; registra l'uso. */
async function tryModels(models, tokens, fn) {
  let lastErr = null;
  const missing = new Set();
  for (const model of models) {
    if (missing.has(model) || !quota.usable(model)) continue;
    try {
      const text = await fn(model);
      quota.record(model, tokens);
      return { text, model };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      if (e instanceof ApiError && [403, 404].includes(e.status)) { missing.add(model); continue; }
      if (e instanceof ApiError && [429, 500, 502, 503, 504].includes(e.status)) { quota.onError(model, e); continue; }
      throw e;
    }
  }
  throw lastErr || new ApiError('Nessun modello disponibile adesso: quota finita o Google sovraccarico. Riprova più tardi.', 503);
}

const courseOf = (job, settings) => (settings.courses || []).find(c => c.name === job.course);

// ---------------------------------------------------------------- Indice

/** Testo della lezione con il tempo di ogni paragrafo, per l'indice. */
function timedText(job) {
  let last = 0;
  return lectureParagraphs(job, 'revised')
    .map(p => { last = p.t ?? last; return `[${fmtTime(last, true)}] ${p.text}`; })
    .join('\n\n');
}

export function indexPrompt(job, settings) {
  const course = courseOf(job, settings);
  const lang = langOf(course?.lang || job.lang || settings.defaultLang || 'it');
  return [
    `Ecco la trascrizione di una lezione universitaria${job.course ? ` del corso "${job.course}"` : ''}, con il tempo di inizio di ogni paragrafo tra parentesi quadre.`,
    'Scrivi l\'indice degli argomenti della lezione: da 4 a 12 voci, una per ogni cambio di argomento importante, nell\'ordine in cui compaiono.',
    'Ogni voce su una riga: il tempo del paragrafo in cui l\'argomento comincia, copiato esattamente tra parentesi quadre, poi un titolo breve e concreto (al massimo 8 parole) che dica di cosa si parla.',
    lang.prompt ? `I titoli vanno scritti nella lingua della lezione (la lezione è ${lang.prompt}).` : 'I titoli vanno scritti nella lingua della lezione.',
    'Rispondi solo con le righe dell\'indice: niente numeri, punti elenco, introduzioni o commenti.',
    '',
    'TRASCRIZIONE:',
    '<<<',
    timedText(job),
    '>>>',
  ].join('\n');
}

/** Righe "[0:12:40] Titolo" → voci agganciate al paragrafo più vicino, in ordine e senza doppioni. */
export function parseIndex(text, job) {
  let last = 0;
  const times = lectureParagraphs(job, 'revised').map(p => (last = p.t ?? last));
  const snap = t => times.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), times[0] ?? 0);
  const items = [];
  for (const line of stripFences(text).split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])?\s*\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?\s*[-–—:.]?\s*(.+?)\s*$/);
    if (!m) continue;
    const t = parseTime(m[1]);
    if (t === null || (job.duration && t > job.duration + 5)) continue;
    const title = m[2].replace(/^\*\*|\*\*$/g, '').trim();
    if (title) items.push({ t: snap(t), title });
  }
  items.sort((a, b) => a.t - b.t);
  return items.filter((x, k) => !k || x.t !== items[k - 1].t);
}

export async function makeIndex(job, settings, { signal } = {}) {
  const gemini = new Gemini(settings.apiKey, { signal });
  const prompt = indexPrompt(job, settings);
  const { endpoint } = loadStrategy().revise;
  const { text, model } = await tryModels(INDEX_MODELS, quota.estimateTokens(0, prompt.length),
    m => gemini.generate({ model: m, prompt, endpoint, label: 'Indice', config: { maxOutputTokens: 2048 }, overloadRetries: 0 }));
  const items = parseIndex(text, job);
  if (items.length < 2) throw new Error('Il modello non ha restituito un indice leggibile. Riprova.');
  return { items, model, at: Date.now() };
}

// ---------------------------------------------------------------- Nuova revisione di un paragrafo

/** Tratto [a, b] di audio: ADTS tagliato ai frame e, se possibile, reso leggero. null se non tagliabile. */
async function audioClip(blob, a, b) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info = analyzeAdts(bytes);
  if (!info) return null;
  const f0 = frameAt(info, Math.max(0, a));
  const f1 = Math.min(info.frameCount, frameAt(info, Math.min(info.duration, b)) + 1);
  const end = f1 >= info.frameCount ? info.dataEnd : info.offsets[f1];
  const clip = new Blob([bytes.slice(info.offsets[f0], end)], { type: 'audio/aac' });
  const light = await makeLight(clip).catch(() => null);
  return light ? { blob: light, mime: 'audio/ogg' } : { blob: clip, mime: 'audio/aac' };
}

export function rereviewPrompt({ job, settings, para, prev, next, raw, start, len, withAudio }) {
  const course = courseOf(job, settings);
  const lang = langOf(course?.lang || job.lang || settings.defaultLang || 'it');
  const glossary = glossaryTerms(course ? course.glossary : job.glossary).join(', ');
  return [
    `Sei un revisore di trascrizioni di lezioni universitarie${job.course ? ` (corso: "${job.course}")` : ''}.`,
    withAudio
      ? `Ricevi l'audio di un tratto di lezione (dura ${fmtMMSS(len)}, dal minuto ${fmtTime(start, true)}) e la trascrizione rivista del paragrafo pronunciato in quel tratto${raw ? ', insieme alla trascrizione automatica grezza dello stesso tratto' : ''}.`
      : `Ricevi la trascrizione rivista di un paragrafo di lezione${raw ? ' e la trascrizione automatica grezza dello stesso tratto' : ''}.`,
    `Restituisci il paragrafo corretto${withAudio ? ', riascoltando l\'audio' : ''}. Regole:`,
    `- ${lang.prompt ? `La lezione è ${lang.prompt}. ` : ''}NON tradurre: ogni frase resta nella lingua in cui è detta.`,
    '- Trascrizione letterale e completa del solo paragrafo: niente riassunti, niente aggiunte. L\'audio può contenere anche la fine del paragrafo precedente o l\'inizio del successivo: non trascriverli.',
    '- Correggi le parole sbagliate (storpiature, omofoni, termini tecnici) e la punteggiatura.',
    '- Quando cambi il significato rispetto al testo attuale (una negazione, un numero, un nome, una parola diversa) o non sei sicuro, scrivi la tua versione seguita da [?]. Un passaggio che non si capisce diventa [incomprensibile].',
    '- Elimina intercalari ed esitazioni ripetute. Mantieni le etichette "Studente:" e "Docente:" se presenti. Formule in LaTeX tra $…$.',
    '- Niente tempo all\'inizio, niente commenti: rispondi solo con il testo del paragrafo.',
    glossary ? `Termini tecnici del corso che possono comparire: ${glossary}.` : '',
    prev ? `\nParagrafo precedente (solo contesto, NON riscriverlo): «${prev}»` : '',
    next ? `Paragrafo successivo (solo contesto, NON riscriverlo): «${next}»` : '',
    raw ? `\nTRASCRIZIONE GREZZA DEL TRATTO:\n<<<\n${raw}\n>>>` : '',
    `\nPARAGRAFO DA RIVEDERE:\n<<<\n${para}\n>>>`,
  ].filter(Boolean).join('\n');
}

/**
 * Nuova revisione del paragrafo i (indice nella versione rivista della lezione).
 * audio: Blob dell'audio della lezione (null = revisione solo sul testo).
 * @returns {Promise<{text: string, model: string, withAudio: boolean, from: number, to: number}>}
 */
export async function rereviewParagraph(job, i, settings, audio, { signal, text: current, mode = 'best', onWait = () => {} } = {}) {
  const paras = lectureParagraphs(job, 'revised');
  let last = 0;
  const times = paras.map(p => (last = p.t ?? last));
  const t0 = times[i] ?? 0;
  const chunk = (job.chunks || []).find(c => t0 >= c.start && t0 < c.end) || (job.chunks || []).at(-1);
  let t1 = times.slice(i + 1).find(t => t > t0);
  if (t1 === undefined) t1 = chunk?.end ?? job.duration ?? t0 + 60;
  t1 = Math.min(t1, t0 + Math.max(60, countWords(current ?? paras[i].text) / 1.5)); // al massimo il tempo per dirlo, con margine
  const a = Math.max(0, t0 - 3), b = Math.min(job.duration || Infinity, t1 + 3);

  // Grezzo dello stesso tratto, se ha i tempi (Whisper)
  let raw = '';
  if (chunk?.raw) {
    const rp = paragraphsFromRaw(chunk.raw, chunk.start);
    if (rp.filter(p => p.t !== null).length >= 2) {
      let lt = chunk.start;
      raw = rp.map(p => ({ ...p, t: (lt = p.t ?? lt) })).filter(p => p.t >= a - 20 && p.t <= b).map(p => p.text).join(' ');
    }
  }

  const clip = audio ? await audioClip(audio, a, b) : null;
  const prompt = rereviewPrompt({
    job, settings, para: current ?? paras[i].text, prev: paras[i - 1]?.text, next: paras[i + 1]?.text,
    raw, start: a, len: b - a, withAudio: !!clip,
  });
  const gemini = new Gemini(settings.apiKey, { signal });
  const { endpoint } = loadStrategy().revise;
  const models = reviewModels(settings, mode);
  let audioRef = clip ? { data: await blobToBase64(clip.blob), mimeType: clip.mime } : null;
  const attempt = () => tryModels(models, quota.estimateTokens(clip ? b - a : 0, prompt.length), async m => {
    try {
      return await gemini.generate({ model: m, prompt, audio: audioRef, endpoint, label: 'Nuova revisione', config: { maxOutputTokens: 4096, thinkingLevel: 'low' }, overloadRetries: 0 });
    } catch (e) {
      // Audio inviato direttamente rifiutato: si riprova caricandolo con la Files API
      if (!(clip && audioRef?.data && e instanceof ApiError && e.status === 400)) throw e;
      const f = await gemini.upload(clip.blob, clip.mime, `${job.title} - paragrafo`);
      audioRef = { uri: f.uri, mimeType: clip.mime };
      return gemini.generate({ model: m, prompt, audio: audioRef, endpoint, label: 'Nuova revisione', config: { maxOutputTokens: 4096, thinkingLevel: 'low' }, overloadRetries: 0 });
    }
  });
  // "Solo 3.8 e 3.7": se sono occupati o senza quota si aspetta e si riprova, per al massimo 30 minuti.
  const deadline = Date.now() + REDO_MAX_MS;
  let result;
  for (;;) {
    try { result = await attempt(); break; } catch (e) {
      if (mode !== 'strong' || !transient(e)) throw e;
      const next = Math.max(Date.now() + 30_000, Math.min(...models.map(m => quota.availableAt(m))));
      if (next > deadline) throw new Error('gemini-3.8-flash e 3.7-flash non sono stati disponibili per 30 minuti: riprova più tardi.');
      onWait(next, deadline);
      await sleep(next - Date.now(), signal);
    }
  }
  const { text, model } = result;
  const out = stripFences(text).replace(/^\s*\[\d{1,3}:\d{2}(?::\d{2})?\]\s*/, '').replace(/^«|»$/g, '').trim();
  if (!out) throw new Error('La nuova revisione è tornata vuota.');
  return { text: out, model, withAudio: !!clip, from: a, to: b };
}

// ---------------------------------------------------------------- Differenze parola per parola

/** [{type: 'same'|'del'|'ins', text}] tra due testi, per parole (LCS). */
export function wordDiff(a, b) {
  const A = String(a).split(/(\s+)/).filter(Boolean), B = String(b).split(/(\s+)/).filter(Boolean);
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return [{ type: 'del', text: a }, { type: 'ins', text: b }];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  const push = (type, text) => { const l = out.at(-1); if (l && l.type === type) l.text += text; else out.push({ type, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out;
}

// ---------------------------------------------------------------- Ricerca

/** Minuscole e senza accenti, carattere per carattere (stessa lunghezza dell'originale). */
export const foldChar = c => (c.normalize('NFD')[0] || c).toLowerCase().charAt(0);
export const fold = s => Array.from(String(s), foldChar).join('');

/**
 * Cerca q nei paragrafi rivisti delle lezioni date.
 * @returns {{job, hits: {t:number, i:number, snippet:string}[]}[]} solo le lezioni con risultati
 */
export function searchLectures(jobs, q) {
  const fq = fold(q.trim());
  if (fq.length < 2) return [];
  const out = [];
  for (const job of jobs) {
    let last = 0;
    const hits = [];
    lectureParagraphs(job, 'revised').forEach((p, i) => {
      last = p.t ?? last;
      const ft = fold(p.text);
      let k = ft.indexOf(fq);
      while (k >= 0) {
        const s = Math.max(0, k - 50), e = Math.min(p.text.length, k + fq.length + 50);
        hits.push({ t: last, i, at: k, len: fq.length, snippet: p.text.slice(s, e), pre: s > 0, post: e < p.text.length, off: k - s });
        k = ft.indexOf(fq, k + fq.length);
      }
    });
    if (hits.length) out.push({ job, hits });
  }
  return out;
}
