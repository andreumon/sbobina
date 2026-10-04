// Utilità sul testo: tempi, paragrafi con timestamp, controllo di completezza, Markdown.

const pad = n => String(n).padStart(2, '0');

/** 83.4 → "01:23"; 3725 → "1:02:05" */
export function fmtTime(sec, forceHours = false) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h || forceHours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Minuti totali anche oltre l'ora: 3725 → "62:05" (formato MM:SS chiesto da Gemini). */
export const fmtMMSS = sec => {
  sec = Math.max(0, Math.round(sec || 0));
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
};

/** "1:02:05" | "62:05" | "02:05" → secondi, oppure null. */
export function parseTime(str) {
  const p = String(str).trim().split(':').map(Number);
  if (p.some(x => !Number.isFinite(x) || x < 0)) return null;
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return null;
}

const TS_RE = /^\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*/;

/**
 * Converte il testo rivisto di un blocco (timestamp relativi all'inizio del blocco)
 * in paragrafi con tempo assoluto. Scarta timestamp impossibili o non crescenti.
 */
export function paragraphsFromChunk(text, chunkStart, chunkEnd) {
  const len = chunkEnd - chunkStart;
  const paras = String(text || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
  const out = [];
  let last = -1;
  for (const p of paras) {
    let t = null;
    let body = p;
    const m = p.match(TS_RE);
    if (m) {
      body = p.slice(m[0].length).trim();
      const rel = parseTime(m[1]);
      if (rel !== null) {
        // Accetta sia tempi relativi al blocco (atteso) sia, per robustezza, assoluti.
        let abs = rel <= len + 5 ? chunkStart + rel : (rel >= chunkStart - 5 && rel <= chunkEnd + 5 ? rel : null);
        if (abs !== null && abs >= last) { t = Math.min(abs, chunkEnd); last = t; }
      }
    }
    if (!body) continue;
    if (!out.length && t === null) t = chunkStart;
    out.push({ t, text: body });
  }
  return out;
}

/** Testo grezzo → paragrafi (senza timestamp tranne l'inizio del blocco). */
export function paragraphsFromRaw(text, chunkStart) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
  return paras.map((p, i) => ({ t: i === 0 ? chunkStart : null, text: p }));
}

const FILLERS = new Set(['ehm', 'eh', 'ehh', 'uhm', 'um', 'mh', 'mmh', 'mm', 'mmm', 'ah', 'uh']);

export function countWords(text, skipFillers = false) {
  const words = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\$[^$]*\$/g, ' x ')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
  return skipFillers ? words.filter(w => !FILLERS.has(w)).length : words.length;
}

/**
 * Confronta parole grezze e riviste. Un calo forte indica che il modello ha
 * riassunto o tagliato; un aumento forte che ha aggiunto contenuti.
 */
export function completenessCheck(raw, revised) {
  const a = countWords(raw, true);
  const b = countWords(revised, false);
  if (a < 30) return { ratio: 1, warn: null };
  const ratio = b / a;
  let warn = null;
  if (ratio < 0.85) warn = `La revisione ha il ${Math.round((1 - ratio) * 100)}% di parole in meno della trascrizione grezza: qui il modello potrebbe aver tagliato o riassunto. Confronta con la versione grezza.`;
  else if (ratio > 1.2) warn = `La revisione ha il ${Math.round((ratio - 1) * 100)}% di parole in più della trascrizione grezza: qui il modello potrebbe aver aggiunto testo. Confronta con la versione grezza.`;
  return { ratio, warn };
}

export const countUncertain = text => (String(text || '').match(/\[\?\]|\[incomprensibile\]/gi) || []).length;

/** Tutti i paragrafi della lezione, rivisti dove disponibili. */
export function lectureParagraphs(job, which = 'revised') {
  if (which === 'revised' && job.edited?.paragraphs) return job.edited.paragraphs.map(p => ({ ...p }));
  const out = [];
  (job.chunks || []).forEach((c, i) => {
    if (which === 'revised' && c.paragraphs?.length) {
      out.push(...c.paragraphs.map(p => ({ ...p, chunk: i })));
    } else if (c.raw) {
      out.push(...paragraphsFromRaw(c.raw, c.start).map(p => ({ ...p, chunk: i })));
    }
  });
  return out;
}

/** Documento Markdown della lezione. */
export function toMarkdown(job, { timestamps = true, which = 'revised' } = {}) {
  const longLecture = (job.duration || 0) >= 3600;
  const date = new Date(job.recordedAt || job.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  const meta = [job.course, date, job.duration ? `durata ${fmtTime(job.duration)}` : null].filter(Boolean).join(', ');
  const paras = lectureParagraphs(job, which).map(p =>
    timestamps && p.t !== null && p.t !== undefined ? `[${fmtTime(p.t, longLecture)}] ${p.text}` : p.text);
  return `# ${job.title}\n\n*${meta}*\n\n${paras.join('\n\n')}\n`;
}

/** Testo per la modifica manuale: un paragrafo per blocco, con il tempo assoluto davanti. */
export function toEditable(job) {
  const long = (job.duration || 0) >= 3600;
  return lectureParagraphs(job, 'revised')
    .map(p => (p.t !== null && p.t !== undefined ? `[${fmtTime(p.t, long)}] ${p.text}` : p.text))
    .join('\n\n');
}

/** Rilegge il testo modificato a mano (tempi assoluti). */
export function parseEditable(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => {
    const m = p.match(TS_RE);
    const t = m ? parseTime(m[1]) : null;
    return { t, text: m ? p.slice(m[0].length).trim() : p };
  }).filter(p => p.text);
}

/** Nome file sicuro per Windows/Android/Drive. */
export function safeFileName(s) {
  return String(s || 'lezione').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'lezione';
}

/** Elenco di termini dal glossario (separati da virgole, punti e virgola o a capo). */
export function glossaryTerms(glossary) {
  const seen = new Set();
  return String(glossary || '')
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(s => s && s.length <= 100 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 300);
}
