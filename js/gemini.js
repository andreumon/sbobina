// Client minimo per la Gemini API (piano gratuito di Google AI Studio).
// Endpoint usati: Files API (caricamento audio) e Interactions API (modelli),
// con ripiego su generateContent se Interactions non risponde.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Interrotto', 'AbortError')); }, { once: true });
});

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.detail = errorDetail(body);
  }
}

/** Dettagli tecnici di un errore Google (campo sbagliato, motivo), utili per la diagnosi. */
export function errorDetail(body) {
  const e = body?.error;
  if (!e) return '';
  const out = [];
  if (e.status) out.push(e.status);
  for (const d of e.details || []) {
    for (const v of d.fieldViolations || []) out.push(`${v.field || '?'}: ${v.description || ''}`.trim());
    if (d.reason) out.push(d.reason);
    if (d.metadata) out.push(Object.entries(d.metadata).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  return out.filter(Boolean).join('; ');
}

/** Blob → base64 (per l'audio inviato direttamente dentro la richiesta). */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const audioItem = a => (a.uri
  ? { type: 'audio', uri: a.uri, mime_type: a.mimeType }
  : { type: 'audio', data: a.data, mime_type: a.mimeType });
const audioPart = a => (a.uri
  ? { fileData: { fileUri: a.uri, mimeType: a.mimeType } }
  : { inlineData: { mimeType: a.mimeType, data: a.data } });

function retryDelayMs(body) {
  const info = (body?.error?.details || []).find(d => String(d['@type'] || '').includes('RetryInfo'));
  const s = info ? parseFloat(info.retryDelay) : NaN;
  return Number.isFinite(s) ? s * 1000 : null;
}

/** Messaggio comprensibile per l'utente a partire da un errore dell'API. */
export function explainError(e) {
  if (e?.name === 'AbortError') return 'Elaborazione interrotta.';
  const msg = e?.message || String(e);
  const s = e?.status;
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'La chiave API Gemini non è valida. Controllala nelle impostazioni.';
  if (/ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(msg) || (s === 401 && /token type/i.test(msg))) {
    return 'Google ha rifiutato il tipo di chiave (problema noto di alcune chiavi "AQ."). Crea una nuova chiave in AI Studio e riprova; se persiste, segnalalo.';
  }
  if (s === 429) return 'Quota gratuita Gemini esaurita per ora (troppe richieste). Riprova più tardi: l\'elaborazione ripartirà dal punto in cui si è fermata.';
  if (s === 403) return `Accesso negato dalla Gemini API: ${msg}`;
  if (s === 404) return `Modello o risorsa non trovati: ${msg}. Controlla i nomi dei modelli nelle impostazioni.`;
  if (s === 0) return 'Connessione assente o interrotta. L\'elaborazione ripartirà dal punto in cui si è fermata.';
  return e?.detail ? `${msg} (${e.detail})` : msg;
}

export class Gemini {
  constructor(apiKey, { log = () => {}, signal } = {}) {
    this.key = (apiKey || '').trim();
    this.log = log;
    this.signal = signal;
    this.legacy = false;
  }

  async call(path, init = {}, { retries = 6, label = 'Gemini' } = {}) {
    const url = path.startsWith('http') ? path : GEMINI_BASE + path;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { ...init, signal: this.signal, headers: { 'x-goog-api-key': this.key, ...(init.headers || {}) } });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (attempt >= retries) throw new ApiError(`Errore di rete (${err.message})`, 0);
        await this.backoff(attempt, null, label, 'rete assente');
        continue;
      }
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (res.ok) return { body, res };
      const msg = body?.error?.message || `HTTP ${res.status}`;
      const retryable = [429, 500, 502, 503, 504].includes(res.status);
      const hint = retryDelayMs(body);
      if (retryable && attempt < retries && !(hint && hint > 5 * 60_000)) {
        await this.backoff(attempt, hint, label, res.status === 429 ? 'limite di richieste' : `errore ${res.status}`);
        continue;
      }
      throw new ApiError(msg, res.status, body);
    }
  }

  async backoff(attempt, hintMs, label, why) {
    const ms = hintMs ?? Math.min(90_000, 3000 * 2 ** attempt) + Math.random() * 1500;
    this.log(`${label}: ${why}, nuovo tentativo tra ${Math.round(ms / 1000)} s`);
    await sleep(ms, this.signal);
  }

  async listModels() {
    const { body } = await this.call('/v1beta/models?pageSize=1000', {}, { retries: 1, label: 'Verifica chiave' });
    return (body.models || []).map(m => m.name.replace(/^models\//, ''));
  }

  /** Carica un file con la Files API. I file restano su Google 48 ore. */
  async upload(blob, mime, displayName, onProgress = () => {}) {
    const { res } = await this.call('/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    }, { label: 'Caricamento' });
    const uploadUrl = res.headers.get('x-goog-upload-url');
    let file;
    if (uploadUrl) {
      file = await this.putBytes(uploadUrl, blob, onProgress);
    } else {
      file = await this.uploadMultipart(blob, mime, displayName);
      onProgress(1);
    }
    return this.waitActive(file);
  }

  putBytes(url, blob, onProgress) {
    const attemptOnce = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
      xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* ignora */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.file) resolve(body.file);
        else reject(new ApiError(body?.error?.message || `Caricamento fallito (HTTP ${xhr.status})`, xhr.status, body));
      };
      xhr.onerror = () => reject(new ApiError('Caricamento interrotto dalla rete', 0));
      const onAbort = () => xhr.abort();
      this.signal?.addEventListener('abort', onAbort, { once: true });
      xhr.onabort = () => reject(new DOMException('Interrotto', 'AbortError'));
      xhr.send(blob);
    });
    return (async () => {
      for (let i = 0; ; i++) {
        try { return await attemptOnce(); } catch (e) {
          if (e.name === 'AbortError' || i >= 2) throw e;
          await this.backoff(i, null, 'Caricamento', 'interrotto');
        }
      }
    })();
  }

  async uploadMultipart(blob, mime, displayName) {
    const boundary = 'sbobina' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ file: { display_name: displayName } }),
      `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--\r\n`,
    ]);
    const { body: out } = await this.call('/upload/v1beta/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }, { label: 'Caricamento' });
    return out.file;
  }

  async waitActive(file) {
    for (let i = 0; i < 150; i++) {
      if (!file.state || file.state === 'ACTIVE') return file;
      if (file.state === 'FAILED') throw new ApiError('Google non è riuscito a elaborare il file audio.', 0);
      await sleep(2000, this.signal);
      ({ body: file } = await this.call(`/v1beta/${file.name}`, {}, { label: 'Stato file' }));
    }
    throw new ApiError('Il file audio non è diventato disponibile in tempo.', 0);
  }

  async deleteFile(name) {
    try { await this.call(`/v1beta/${name}`, { method: 'DELETE' }, { retries: 0 }); } catch { /* scade comunque in 48 ore */ }
  }

  /** Chiamata alla Interactions API, con attesa se la risposta è asincrona. */
  async interact(body, label) {
    let { body: out } = await this.call('/v1beta/interactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, { label });
    const pending = ['in_progress', 'queued', 'pending', 'running', 'processing'];
    for (let i = 0; out?.id && pending.includes(String(out.status).toLowerCase()); i++) {
      if (i > 400) throw new ApiError('Il modello non ha risposto in tempo.', 0);
      await sleep(3000, this.signal);
      const path = out.id.startsWith('interactions/') ? `/v1beta/${out.id}` : `/v1beta/interactions/${out.id}`;
      ({ body: out } = await this.call(path, {}, { label }));
    }
    const st = String(out?.status || '').toLowerCase();
    if (['failed', 'cancelled', 'canceled'].includes(st)) {
      throw new ApiError(out?.error?.message || 'Il modello non ha completato la richiesta.', 500, out);
    }
    return extractText(out);
  }

  /**
   * Richiesta multimodale (audio opzionale + testo).
   * audio: { uri, mimeType } dopo un caricamento, oppure { data, mimeType } in base64.
   * endpoint: 'interactions' (predefinito) o 'generate' (generateContent).
   */
  async generate({ model, prompt, audio, label, endpoint = 'interactions' }) {
    if (endpoint === 'interactions' && !this.legacy) {
      const input = [];
      if (audio) input.push(audioItem(audio));
      input.push({ type: 'text', text: prompt });
      try {
        return await this.interact({ model, input }, label);
      } catch (e) {
        if (e.status !== 404 || /model/i.test(e.message)) throw e;
        this.log('Interactions API non disponibile, uso generateContent');
        this.legacy = true;
      }
    }
    const parts = [];
    if (audio) parts.push(audioPart(audio));
    parts.push({ text: prompt });
    const { body } = await this.call(`/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
    }, { label });
    return extractText(body);
  }

  /** Trascrizione con il modello dedicato (gemini-3.5-transcribe). */
  transcribe({ model, audio, language, vocabulary }) {
    const cfg = {};
    if (language) cfg.language_codes = [language];
    if (vocabulary?.length) cfg.custom_vocabulary = vocabulary;
    const body = { model, input: [audioItem(audio)] };
    if (Object.keys(cfg).length) body.generation_config = { transcription_config: cfg };
    return this.interact(body, 'Trascrizione');
  }
}

/** Estrae il testo dalle varie forme di risposta dell'API. */
export function extractText(r) {
  if (!r) return '';
  if (typeof r.output_text === 'string' && r.output_text) return r.output_text;
  const texts = [];
  for (const o of r.outputs || []) if (o?.type === 'text' && o.text) texts.push(o.text);
  if (!texts.length) {
    for (const st of r.steps || []) {
      if (st?.type && st.type !== 'model_output') continue;
      for (const c of st?.content || []) if (c?.type === 'text' && c.text) texts.push(c.text);
    }
  }
  if (!texts.length) {
    for (const c of r.candidates || []) for (const p of c?.content?.parts || []) if (p.text && !p.thought) texts.push(p.text);
  }
  return texts.join('').trim();
}
