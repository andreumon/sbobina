// Banco di prova: esegue processJob() di Sbobina contro un finto server Gemini.
// Uso (dalla cartella test): npm install, poi  node run.mjs <scenario>   oppure   npm test  (tutti)
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCEN = process.argv[2] || 'normale';
const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const K1 = 'KEY-PRINCIPALE', K2 = 'KEY-RISERVA';

// ---------- ambiente browser minimo
const ls = {};
globalThis.localStorage = { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
globalThis.window = globalThis;
// Orologio virtuale: le attese (backoff, pause per quota) passano all'istante.
let offset = 0;
const realNow = Date.now.bind(Date), realST = setTimeout;
Date.now = () => realNow() + offset;
globalThis.setTimeout = (fn, ms = 0, ...a) => { offset += Math.max(0, ms); return realST(fn, 0, ...a); };

// ---------- finto Gemini
const tagOf = key => (key === K1 ? 'P' : key === K2 ? 'R' : '?');
const calls = []; // [tag, cosa, modello, esito]
const files = {}; // nome file -> tag chiave che l'ha caricato
let fileSeq = 0;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const quota429 = (perDay, model) => json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: `You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, model: ${model}`,
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: perDay ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: perDay ? '20' : '5' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: perDay ? '3600s' : '40s' },
  ] } });
const invalidKey = () => json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } });
const overload = () => json(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } });

// Comportamento per scenario: (tag, modello, tipo) -> Response | 'net' | null (= ok)
const S = {
  normale: () => null,
  principale_esaurita_trascrizione: (t, m) => (t === 'P' && m === 'gemini-3.5-transcribe' ? quota429(true, m) : null),
  principale_esaurita_tutto: (t, m) => (t === 'P' && m ? quota429(true, m) : null),
  principale_limite_minuto: (t, m) => (t === 'P' && m === 'gemini-3.5-transcribe' ? quota429(false, m) : null),
  principale_offline: t => (t === 'P' ? 'net' : null),
  principale_revocata: t => (t === 'P' ? invalidKey() : null),
  principale_sovraccarica: (t, m) => (t === 'P' && m === 'gemini-3.5-transcribe' ? overload() : null),
  trascrizione_esaurita_su_entrambe: (t, m) => (m === 'gemini-3.5-transcribe' ? quota429(true, m) : null),
  tutto_esaurito: (t, m) => (m ? quota429(true, m) : null),
  entrambe_offline: () => 'net',
  solo_principale_esaurita: (t, m) => (m ? quota429(true, m) : null), // senza chiave di riserva
  telefono_offline: () => 'net', // navigator.onLine = false
  // Google rifiuta la forma della richiesta del modello di trascrizione (400) + principale revocata:
  // l'autodiagnosi deve girare con la chiave di riserva.
  diagnosi_con_principale_revocata: (t, m) => (t === 'P' ? invalidKey()
    : m === 'gemini-3.5-transcribe' ? json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }) : null),
};
if (SCEN === 'telefono_offline') Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
const behave = S[SCEN];

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const key = init.headers?.['x-goog-api-key'];
  const t = tagOf(key);
  const method = init.method || 'GET';
  let model = null, what;
  if (url.includes('/upload/')) what = 'upload';
  else if (url.includes('/interactions')) { what = 'interactions'; model = JSON.parse(init.body).model; }
  else if (url.includes(':generateContent')) { what = 'generate'; model = url.match(/models\/([^:]+)/)[1]; }
  else if (/\/files\//.test(url)) what = method === 'DELETE' ? 'delete' : 'file';
  else if (url.includes('/models')) what = 'list';
  const b = behave(t, model, what);
  if (b === 'net') { calls.push([t, what, model, 'RETE GIÙ']); throw new TypeError('Failed to fetch'); }
  if (b) { calls.push([t, what, model, `HTTP ${b.status}`]); return b; }
  // Un file si può usare/cancellare solo con la chiave che l'ha caricato (stesso progetto).
  if (what === 'interactions') {
    const audio = JSON.parse(init.body).input.find(x => x.type === 'audio');
    const fname = audio?.uri?.split('/v1beta/')[1];
    if (fname && files[fname] !== t) { calls.push([t, what, model, 'HTTP 403 file di un altro progetto']); return json(403, { error: { code: 403, message: `You do not have permission to access the File ${fname} or it may not exist.` } }); }
  }
  if (what === 'delete') {
    const fname = url.split('/v1beta/')[1];
    const ok = files[fname] === t;
    calls.push([t, what, fname, ok ? 'ok' : 'HTTP 403 (altro progetto)']);
    return ok ? json(200, {}) : json(403, { error: { code: 403, message: 'permission denied' } });
  }
  calls.push([t, what, model, 'ok']);
  if (what === 'upload') {
    const name = `files/${t}${++fileSeq}`;
    files[name] = t;
    return json(200, { file: { name, uri: `https://generativelanguage.googleapis.com/v1beta/${name}`, state: 'ACTIVE' } });
  }
  if (what === 'interactions') {
    const text = model.includes('transcribe') ? 'Buongiorno a tutti, oggi parliamo di regressione lineare.' : '[00:00] Buongiorno a tutti, oggi parliamo di regressione lineare.';
    return json(200, { id: 'x', status: 'completed', outputs: [{ type: 'text', text }] });
  }
  return json(200, {});
};

// ---------- esecuzione
const imp = p => import(pathToFileURL(`${APP}/js/${p}`).href);
const store = await imp('store.js');
const { processJob } = await imp('pipeline.js');
const quota = await imp('quota.js');

const settings = { ...store.loadSettings(), apiKey: K1, apiKey2: SCEN === 'solo_principale_esaurita' ? '' : K2 };
const audio = new Blob([readFileSync(new URL('./test.aac', import.meta.url))], { type: 'audio/aac' });
const id = 'lezione-test';
await store.putJob({ id, title: 'Lezione di prova', status: 'queued', createdAt: Date.now(), mime: 'audio/aac', course: '' });

let outcome;
try {
  const job = await processJob(id, { settings, getAudio: async () => audio, signal: undefined });
  outcome = `COMPLETATA. Trascrizione con: ${job.chunks.map(c => c.engine).join(', ')}; revisione con: ${job.chunks.map(c => c.reviseEngine).join(', ')}`;
} catch (e) {
  outcome = `FERMATA: ${e.constructor.name}: ${e.message}${e.retryAt ? ` (riprova alle ${new Date(e.retryAt).toISOString()}, quota giornaliera: ${e.daily})` : ''}`;
}
const job = await store.getJob(id);
console.log(`\n=== SCENARIO: ${SCEN} ===`);
console.log('ESITO:', outcome);
console.log('-- Log della lezione (quello che vede l\'utente):');
for (const l of job.log || []) console.log('  ', l.replace(/^\S+ /, ''));
console.log('-- Richieste a Google (P = principale, R = riserva):');
for (const c of calls.filter(c => c[1] !== 'list')) console.log(`   ${c[0]}  ${c[1].padEnd(12)} ${(c[2] || '').padEnd(24)} ${c[3]}`);
const rows = quota.summary().filter(r => r.used || r.exhausted);
console.log('-- Quote registrate:', rows.map(r => `${r.model}=${r.used}${r.exhausted ? ' (esaurita)' : ''}`).join(', ') || 'nessuna');
process.exit(0);
