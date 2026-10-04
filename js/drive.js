// Google Drive: login con Google Identity Services e chiamate REST v3.
// Permessi richiesti:
//  - drive.file    → solo i file creati da Sbobina (cartella "Sbobina")
//  - drive.appdata → una cartella nascosta per le impostazioni sincronizzate

const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'sbobina.driveToken';
const FOLDER_KEY = 'sbobina.driveFolder';
const FOLDER_NAME = 'Sbobina';
const CHUNK = 8 * 1024 * 1024; // multiplo di 256 KB, richiesto da Drive

export class DriveAuthError extends Error {}
export class DriveError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!loadGis.p) {
    loadGis.p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loadGis.p = null; reject(new Error('Impossibile caricare il login Google (sei offline?)')); };
      document.head.appendChild(s);
    });
  }
  return loadGis.p;
}

export class Drive {
  constructor(clientId) {
    this.clientId = (clientId || '').trim();
    try { this.token = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { this.token = null; }
    this.listeners = new Set();
  }

  get configured() { return !!this.clientId; }
  get connected() { return !!(this.token?.access_token && this.token.expires_at > Date.now() + 60_000); }
  get email() { return this.token?.email || ''; }
  /** È già stato collegato in passato (anche se il token è scaduto). */
  get linked() { return !!this.token?.email || !!this.token?.access_token; }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach(fn => fn()); }

  saveToken(t) {
    this.token = t;
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else localStorage.removeItem(TOKEN_KEY);
    this.emit();
  }

  /** Va chiamato da un gesto dell'utente (tocco/click), perché apre un popup Google. */
  async connect() {
    if (!this.configured) throw new DriveAuthError('Manca l\'ID client di Google: vedi Impostazioni → Google Drive.');
    await loadGis();
    const firstTime = !this.token?.email;
    const resp = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPES,
        callback: r => (r.error ? reject(new DriveAuthError(r.error_description || r.error)) : resolve(r)),
        error_callback: e => reject(new DriveAuthError(e?.type === 'popup_closed' ? 'Accesso annullato.' : (e?.message || 'Accesso Google non riuscito.'))),
      });
      client.requestAccessToken({ prompt: firstTime ? 'consent' : '', login_hint: this.token?.email || undefined });
    });
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(' '))) {
      throw new DriveAuthError('Serve l\'autorizzazione per i file di Sbobina su Drive: riprova e spunta tutte le caselle.');
    }
    const t = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000, email: this.token?.email || '' };
    this.saveToken(t);
    if (!t.email) {
      try {
        const about = await this.json(`${API}/about?fields=user(emailAddress)`);
        this.saveToken({ ...t, email: about.user?.emailAddress || '' });
      } catch { /* non indispensabile */ }
    }
    return this.email;
  }

  disconnect() {
    try { if (this.token?.access_token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token.access_token, () => {}); } catch { /* ignora */ }
    localStorage.removeItem(FOLDER_KEY);
    this.saveToken(null);
  }

  async req(url, init = {}, { retries = 4, raw = false } = {}) {
    if (!this.connected) throw new DriveAuthError('Accesso a Drive scaduto.');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${this.token.access_token}`, ...(init.headers || {}) } });
      } catch (e) {
        if (attempt >= retries) throw new DriveError(`Drive non raggiungibile (${e.message})`, 0);
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      if (res.status === 401) {
        this.saveToken({ ...this.token, access_token: '', expires_at: 0 });
        throw new DriveAuthError('Accesso a Drive scaduto.');
      }
      if (res.ok) return raw ? res : (res.status === 204 ? null : res.json());
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        await sleep(1500 * 2 ** attempt + Math.random() * 500);
        continue;
      }
      let msg = `Errore Drive ${res.status}`;
      try { msg = (await res.json())?.error?.message || msg; } catch { /* ignora */ }
      throw new DriveError(msg, res.status);
    }
  }

  json(url, init) { return this.req(url, init); }

  async folderId() {
    const cached = localStorage.getItem(FOLDER_KEY);
    if (cached) {
      try {
        const f = await this.json(`${API}/files/${cached}?fields=id,trashed`);
        if (f && !f.trashed) return cached;
      } catch (e) { if (e instanceof DriveAuthError) throw e; }
    }
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await this.json(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
    let id = found.files?.[0]?.id;
    if (!id) {
      const f = await this.json(`${API}/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      });
      id = f.id;
    }
    localStorage.setItem(FOLDER_KEY, id);
    return id;
  }

  /**
   * Tutti i file "dati lezione" creati da Sbobina: nella cartella nascosta dell'app
   * (versioni nuove) o nella cartella Sbobina (versioni precedenti).
   */
  async listLectures() {
    await this.folderId();
    const q = encodeURIComponent("appProperties has { key='kind' and value='data' } and trashed=false");
    const out = [];
    for (const space of ['appDataFolder', 'drive']) {
      let pageToken = '';
      do {
        const r = await this.json(`${API}/files?q=${q}&spaces=${space}&pageSize=200&fields=nextPageToken,files(id,name,modifiedTime,appProperties)${pageToken ? `&pageToken=${pageToken}` : ''}`);
        out.push(...(r.files || []));
        pageToken = r.nextPageToken || '';
      } while (pageToken);
    }
    return out;
  }

  // ---------- Cartelle dei corsi (dentro "Sbobina") ----------

  async findCourseFolder(name) {
    const root = await this.folderId();
    const safe = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(`name='${safe}' and '${root}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await this.json(`${API}/files?q=${q}&spaces=drive&fields=files(id,name)`);
    return r.files?.[0]?.id || null;
  }

  /** Cartella del corso (creata se manca). Senza corso: la cartella Sbobina. */
  async courseFolder(name) {
    if (!name) return this.folderId();
    this.courseCache = this.courseCache || new Map();
    if (this.courseCache.has(name)) return this.courseCache.get(name);
    let id = await this.findCourseFolder(name);
    if (!id) {
      const f = await this.json(`${API}/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [await this.folderId()] }),
      });
      id = f.id;
    }
    this.courseCache.set(name, id);
    return id;
  }

  async renameCourseFolder(oldName, newName) {
    this.courseCache?.clear();
    const id = await this.findCourseFolder(oldName);
    if (!id || await this.findCourseFolder(newName)) return;
    await this.json(`${API}/files/${id}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }),
    });
  }

  /** Cestina la cartella del corso se non contiene più file. */
  async trashCourseFolderIfEmpty(name) {
    this.courseCache?.delete(name);
    const id = await this.findCourseFolder(name);
    if (!id) return;
    const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
    const r = await this.json(`${API}/files?q=${q}&spaces=drive&pageSize=1&fields=files(id)`);
    if (!r.files?.length) await this.trash(id);
  }

  /** Sposta un file in un'altra cartella. */
  async move(fileId, toId) {
    const f = await this.json(`${API}/files/${fileId}?fields=parents`);
    const from = (f.parents || []).filter(p => p !== toId).join(',');
    if ((f.parents || []).includes(toId) && !from) return;
    await this.json(`${API}/files/${fileId}?addParents=${toId}${from ? `&removeParents=${from}` : ''}&fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  }

  getJson(id) { return this.json(`${API}/files/${id}?alt=media`); }

  /** Scarica un file mostrando l'avanzamento. */
  async getBlob(id, size, onProgress = () => {}) {
    const res = await this.req(`${API}/files/${id}?alt=media`, {}, { raw: true });
    const total = Number(res.headers.get('content-length')) || size || 0;
    if (!res.body || !total) return res.blob();
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    return new Blob(parts, { type: res.headers.get('content-type') || 'application/octet-stream' });
  }

  async meta(id, fields = 'id,name,size,trashed,mimeType') {
    return this.json(`${API}/files/${id}?fields=${fields}`);
  }

  /** Crea o aggiorna un file piccolo (testo/JSON) in un colpo solo. */
  async writeSmall({ id, name, mimeType, content, appProperties, parentId, space }) {
    const meta = { name, mimeType };
    if (appProperties) meta.appProperties = appProperties;
    if (!id) meta.parents = [space === 'appDataFolder' ? 'appDataFolder' : (parentId || await this.folderId())];
    const boundary = 'sb' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, content, `\r\n--${boundary}--`,
    ]);
    const url = id ? `${UP}/files/${id}?uploadType=multipart&fields=id,modifiedTime` : `${UP}/files?uploadType=multipart&fields=id,modifiedTime`;
    try {
      return await this.json(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    } catch (e) {
      if (id && e.status === 404) return this.writeSmall({ name, mimeType, content, appProperties, parentId, space });
      throw e;
    }
  }

  /** Caricamento a pezzi (ripristinabile) per file grandi come l'audio. */
  async uploadLarge(blob, { name, mimeType, appProperties, parentId }, onProgress = () => {}) {
    const parent = parentId || await this.folderId();
    const start = await this.req(`${UP}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name, mimeType, parents: [parent], appProperties }),
    }, { raw: true });
    const session = start.headers.get('location');
    if (!session) throw new DriveError('Drive non ha restituito l\'indirizzo di caricamento.', 0);

    const total = blob.size;
    let offset = 0;
    let failures = 0;
    while (offset < total) {
      const end = Math.min(offset + CHUNK, total);
      try {
        const r = await this.putChunk(session, blob.slice(offset, end), offset, end - 1, total, onProgress);
        if (r.done) { onProgress(1); return r.file; }
        offset = r.next ?? end;
        failures = 0;
      } catch (e) {
        if (e instanceof DriveAuthError || ++failures > 5) throw e;
        await sleep(2000 * failures);
        const st = await this.queryUpload(session, total);
        if (st.done) { onProgress(1); return st.file; }
        offset = st.next ?? offset;
      }
    }
    const st = await this.queryUpload(session, total);
    if (st.done) return st.file;
    throw new DriveError('Caricamento su Drive incompleto.', 0);
  }

  putChunk(session, part, from, to, total, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', session);
      xhr.setRequestHeader('Authorization', `Bearer ${this.token.access_token}`);
      xhr.setRequestHeader('Content-Range', `bytes ${from}-${to}/${total}`);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress((from + e.loaded) / total);
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          let file = {}; try { file = JSON.parse(xhr.responseText); } catch { /* ignora */ }
          resolve({ done: true, file });
        } else if (xhr.status === 308) {
          const range = xhr.getResponseHeader('Range');
          const m = range && range.match(/bytes=0-(\d+)/);
          resolve({ done: false, next: m ? Number(m[1]) + 1 : to + 1 });
        } else if (xhr.status === 401) {
          reject(new DriveAuthError('Accesso a Drive scaduto.'));
        } else {
          reject(new DriveError(`Caricamento Drive fallito (HTTP ${xhr.status})`, xhr.status));
        }
      };
      xhr.onerror = () => reject(new DriveError('Rete interrotta durante il caricamento', 0));
      xhr.send(part);
    });
  }

  queryUpload(session, total) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', session);
      xhr.setRequestHeader('Authorization', `Bearer ${this.token.access_token}`);
      xhr.setRequestHeader('Content-Range', `bytes */${total}`);
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          let file = {}; try { file = JSON.parse(xhr.responseText); } catch { /* ignora */ }
          resolve({ done: true, file });
        } else if (xhr.status === 308) {
          const range = xhr.getResponseHeader('Range');
          const m = range && range.match(/bytes=0-(\d+)/);
          resolve({ done: false, next: m ? Number(m[1]) + 1 : 0 });
        } else reject(new DriveError(`Stato caricamento non leggibile (HTTP ${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new DriveError('Rete interrotta', 0));
      xhr.send();
    });
  }

  async trash(id) {
    if (!id) return;
    try {
      await this.json(`${API}/files/${id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    } catch (e) { if (e.status !== 404) throw e; }
  }

  async readAppFile(name) {
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const r = await this.json(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
    const f = r.files?.[0];
    if (!f) return null;
    return { id: f.id, data: await this.getJson(f.id) };
  }

  writeAppFile(id, name, data) {
    return this.writeSmall({ id, name, mimeType: 'application/json', content: JSON.stringify(data), space: 'appDataFolder' });
  }
}
