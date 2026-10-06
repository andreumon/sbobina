// Gestore delle quote gratuite della Gemini API.
//
// Google limita ogni modello, per progetto, su tre assi: richieste al minuto (RPM),
// token al minuto (TPM) e richieste al giorno (RPD, azzerate a mezzanotte del Pacifico,
// cioè alle 9:00 italiane). Invece di andare a sbattere contro l'errore 429 e riprovare
// alla cieca, qui si tiene il conto, si aspetta il tempo giusto e si ricorda quali
// modelli sono esauriti o sovraccarichi, così i blocchi successivi non li ritentano.

import { ApiError } from './gemini.js';

// Limiti del piano gratuito visti nella pagina "Limiti di frequenza" di AI Studio (ottobre 2026).
// Per i modelli non elencati si parte prudenti e si impara dagli errori di Google.
export const KNOWN_LIMITS = {
  'gemini-3.5-transcribe': { rpm: 3, tpm: 10_000, rpd: 25 },
  'gemini-3.8-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.7-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
};
const DEFAULT_LIMITS = { rpm: 5, tpm: 250_000, rpd: null };
const OVERLOAD_COOLDOWN = 5 * 60_000; // dopo un 503 il modello si ritenta solo dopo 5 minuti

const KEY = 'sbobina.quota';

// Con più chiavi API le quote sono separate: lo stato di un modello usato con la chiave
// di riserva si salva come "modello@k2". La chiave principale resta senza suffisso.
export const scoped = (model, tag = '') => (tag ? `${model}@${tag}` : model);
export const baseModel = id => String(id).split('@')[0];
export const keyTagOf = id => String(id).split('@')[1] || '';
const now = () => Date.now();

/** Giorno di quota corrente (data del Pacifico) e istante del prossimo azzeramento. */
export function quotaDay(t = now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const elapsed = ((+parts.hour * 60 + +parts.minute) * 60 + +parts.second) * 1000;
  return { day, resetAt: t - elapsed + 24 * 3600 * 1000 + 30_000 };
}

function load() {
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { s = {}; }
  const { day } = quotaDay();
  if (s.day !== day) s = { day, models: Object.fromEntries(Object.entries(s.models || {}).map(([m, v]) => [m, { learned: v.learned, calls: v.calls || [] }])) };
  s.models = s.models || {};
  // Quota giornaliera esaurita con un orario di ripristino indicato da Google ("Please retry in 2h21m"):
  // passato quell'orario il modello torna utilizzabile, senza aspettare la mezzanotte del Pacifico.
  for (const e of Object.values(s.models)) {
    if (e.exhaustedUntil && e.exhaustedUntil <= now()) { delete e.exhausted; delete e.exhaustedUntil; e.used = 0; }
  }
  return s;
}
function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }

function entry(s, model) {
  s.models[model] = s.models[model] || { used: 0, calls: [] };
  const e = s.models[model];
  e.used = e.used || 0;
  e.calls = (e.calls || []).filter(c => now() - c.t < 15 * 60_000);
  return e;
}

export function limitsOf(model, s = load()) {
  return { ...DEFAULT_LIMITS, ...(KNOWN_LIMITS[baseModel(model)] || {}), ...(s.models[model]?.learned || {}) };
}

/** Il modello si può usare adesso? (non esaurito oggi, non in pausa per sovraccarico) */
export function usable(model) {
  const s = load();
  const e = s.models[model];
  if (!e) return true;
  const lim = limitsOf(model, s);
  if (e.exhausted) return false;
  if (lim.rpd && e.used >= lim.rpd) return false;
  return !(e.cooldownUntil > now());
}

/** Il modello ha finito la quota giornaliera (non è solo in pausa per qualche minuto)? */
export function isExhausted(model) {
  const s = load();
  const e = s.models[model];
  if (!e) return false;
  const lim = limitsOf(model, s);
  return !!e.exhausted || !!(lim.rpd && e.used >= lim.rpd);
}

/** Quando il modello tornerà disponibile (ms epoch). */
export function availableAt(model) {
  const s = load();
  const e = s.models[model];
  if (!e) return now();
  const lim = limitsOf(model, s);
  if (e.exhausted) return e.exhaustedUntil || quotaDay().resetAt;
  if (lim.rpd && e.used >= lim.rpd) return quotaDay().resetAt;
  return Math.max(now(), e.cooldownUntil || 0);
}

/**
 * Quanto aspettare prima di inviare una richiesta di `tokens` token, per restare
 * dentro RPM e TPM. Una richiesta più grande del limite al minuto passa da sola,
 * ma "occupa" la finestra per tokens/TPM minuti: la successiva deve aspettare.
 */
export function waitBefore(model, tokens) {
  const s = load();
  const e = s.models[model];
  if (!e) return 0;
  const lim = limitsOf(model, s);
  const t = now();
  let wait = 0;
  const recent = e.calls.filter(c => t - c.t < 60_000);
  if (lim.rpm && recent.length >= lim.rpm) wait = Math.max(wait, recent[recent.length - lim.rpm].t + 60_000 - t);
  if (lim.tpm) {
    for (const c of e.calls) wait = Math.max(wait, c.t + (c.tokens / lim.tpm) * 60_000 - t);
    const inWindow = recent.reduce((a, c) => a + c.tokens, 0);
    if (recent.length && inWindow + tokens > lim.tpm) wait = Math.max(wait, recent[0].t + 60_000 - t);
  }
  return Math.max(0, Math.ceil(wait));
}

/** Registra una richiesta andata a buon fine. */
export function record(model, tokens) {
  const s = load();
  const e = entry(s, model);
  e.used += 1;
  e.calls.push({ t: now(), tokens });
  delete e.cooldownUntil;
  save(s);
}

/** "Please retry in 2h21m49.6s" → millisecondi (NaN se assente). */
export function retryFromText(msg) {
  const m = /retry in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(String(msg || ''));
  if (!m || !(m[1] || m[2] || m[3])) return NaN;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000;
}

/**
 * Classifica un errore di Google e aggiorna lo stato del modello.
 * @returns {{kind: 'daily'|'minute'|'overload'|'other', waitMs?: number}}
 */
export function onError(model, err) {
  if (!(err instanceof ApiError)) return { kind: 'other' };
  const s = load();
  const e = entry(s, model);
  let out = { kind: 'other' };
  if (err.status === 429) {
    const details = err.body?.error?.details || [];
    const violations = details.flatMap(d => d.violations || []);
    const retry = details.find(d => String(d['@type'] || '').includes('RetryInfo'));
    let retryMs = retry ? parseFloat(retry.retryDelay) * 1000 : NaN;
    if (!Number.isFinite(retryMs)) retryMs = retryFromText(err.message);
    const ids = violations.map(v => `${v.quotaId || ''} ${v.quotaMetric || ''}`).join(' ');
    const daily = /PerDay|per_day|requests_per_day/i.test(ids) || /per day|daily/i.test(err.message);
    // Impara il limite reale se Google lo comunica
    for (const v of violations) {
      const val = Number(v.quotaValue);
      if (!val) continue;
      e.learned = e.learned || {};
      if (/PerDay/i.test(v.quotaId || '')) e.learned.rpd = val;
      else if (/Token/i.test(`${v.quotaId} ${v.quotaMetric}`)) e.learned.tpm = val;
      else if (/PerMinute/i.test(v.quotaId || '')) e.learned.rpm = val;
    }
    if (daily) {
      e.exhausted = true;
      // Google dice tra quanto riprovare: se è prima della mezzanotte del Pacifico, si usa quello.
      // Ma un'attesa breve su una quota GIORNALIERA è il suggerimento generico di Google (spesso
      // "retry in 40s" anche quando la quota del giorno è finita): seguirlo farebbe ritentare
      // ogni minuto fino alle 9:00 invece di mettere la lezione in attesa. Si usa solo se lungo.
      if (Number.isFinite(retryMs) && retryMs >= 15 * 60_000 && now() + retryMs < quotaDay().resetAt) e.exhaustedUntil = now() + retryMs + 30_000;
      else delete e.exhaustedUntil;
      out = { kind: 'daily' };
    } else {
      const waitMs = Number.isFinite(retryMs) ? retryMs + 1500 : 60_000;
      e.cooldownUntil = now() + waitMs;
      e.minuteHits = (e.minuteHits || 0) + 1;
      out = { kind: 'minute', waitMs };
    }
  } else if ([500, 502, 503, 504].includes(err.status)) {
    e.cooldownUntil = now() + OVERLOAD_COOLDOWN;
    out = { kind: 'overload', waitMs: OVERLOAD_COOLDOWN };
  }
  save(s);
  return out;
}

/** Stima dei token di una richiesta: audio (~32 token al secondo) + testo (~4 caratteri per token). */
export const estimateTokens = (audioSec = 0, textChars = 0) => Math.round(audioSec * 32 + textChars / 4 + 300);

/** Riepilogo per le impostazioni. */
export function summary() {
  const s = load();
  const names = new Set([...Object.keys(KNOWN_LIMITS), ...Object.keys(s.models)]);
  return [...names].map(m => {
    const e = s.models[m] || {};
    const lim = limitsOf(m, s);
    return { model: m, used: e.used || 0, rpd: lim.rpd, exhausted: !!e.exhausted || (lim.rpd && (e.used || 0) >= lim.rpd), cooldownUntil: e.cooldownUntil || 0 };
  });
}

export function resetLocal() { localStorage.removeItem(KEY); }
