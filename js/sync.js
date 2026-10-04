// Sincronizzazione con Google Drive. Principio "local-first": l'app lavora sempre
// sul database locale; questo modulo copia su Drive ciò che è cambiato e porta qui
// ciò che è cambiato altrove. Se Drive non è collegato, semplicemente aspetta.
import * as store from './store.js';
import { DriveAuthError } from './drive.js';
import { toMarkdown, safeFileName } from './text.js';

const SETTINGS_FILE = 'settings.json';
const extOf = mime => ({ 'audio/aac': 'aac', 'audio/m4a': 'm4a', 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm', 'audio/flac': 'flac' }[mime] || 'aac');

/** Cosa del record locale finisce nel file su Drive (il resto è solo di questo dispositivo). */
function shareable(job) {
  const { _sync, ...rest } = job;
  return rest;
}

export class Sync {
  constructor(drive) {
    this.drive = drive;
    this.running = null;
    this.again = false;
    this.lastError = '';
    this.lastRun = 0;
  }

  get state() {
    if (!this.drive.configured) return 'off';
    if (!this.drive.connected) return this.drive.linked ? 'expired' : 'off';
    if (this.running) return 'busy';
    return this.lastError ? 'error' : 'ok';
  }

  /** Avvia una sincronizzazione (se ne è già in corso una, ne accoda un'altra). */
  run() {
    if (!this.drive.connected) { store.emit('sync', this.state); return Promise.resolve(); }
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      store.emit('sync', 'busy');
      try {
        do {
          this.again = false;
          await this.syncSettings();
          await this.pull();
          for (const job of await store.listJobs()) {
            if (store.isDirty(job) || this.needsAudio(job)) await this.push(job.id);
          }
        } while (this.again);
        this.lastError = '';
      } catch (e) {
        this.lastError = e instanceof DriveAuthError ? '' : (e.message || String(e));
        if (!(e instanceof DriveAuthError)) console.error(e);
      } finally {
        this.running = null;
        this.lastRun = Date.now();
        store.emit('sync', this.state);
      }
    })();
    return this.running;
  }

  needsAudio(job) {
    return !job.remote?.audioId && job.hasLocalAudio && job.origin === store.deviceId;
  }

  async syncSettings() {
    // Unione campo per campo (e corso per corso), non "vince tutto l'ultimo che salva":
    // così una modifica fatta su un dispositivo non cancella quelle fatte sull'altro.
    const local = store.loadSettings();
    const remote = await this.drive.readAppFile(SETTINGS_FILE);
    const merged = remote?.data ? store.mergeSettings(local, remote.data) : local;
    const same = store.sameSettings;
    if (!same(merged, local)) store.saveSettings(store.syncedSettings(merged), { fromRemote: true });
    if (!remote?.data || !same(merged, remote.data)) {
      await this.drive.writeAppFile(remote?.id, SETTINGS_FILE, store.syncedSettings(merged));
    }
  }

  async pull() {
    const remote = await this.drive.listLectures();
    const seen = new Set();
    for (const f of remote) {
      const id = f.appProperties?.job;
      if (!id) continue;
      seen.add(id);
      const local = await store.getJob(id);
      if (local && local._sync?.remoteModified === f.modifiedTime) continue;
      const data = await this.drive.getJson(f.id);
      if (!data?.id) continue;
      if (local && store.isDirty(local) && (local.rev || 0) >= (data.rev || 0)) continue; // vince la copia locale, verrà caricata
      const merged = {
        ...data,
        hasLocalAudio: !!local?.hasLocalAudio,
        _sync: { dataId: f.id, syncedRev: data.rev || 0, remoteModified: f.modifiedTime },
      };
      await store.putJob(merged, { touch: false });
    }
    // Lezioni eliminate da un altro dispositivo.
    for (const job of await store.listJobs()) {
      if (job._sync?.dataId && !seen.has(job.id) && !store.isDirty(job)) await store.removeJob(job.id);
    }
  }

  async push(id) {
    let job = await store.getJob(id);
    if (!job) return;
    const ids = { ...(job.remote || {}) };
    // Cartella del corso (sottocartella di "Sbobina"); senza corso, la cartella principale.
    const parentId = await this.drive.courseFolder(job.course || '');
    const currentParent = ids.parentId || await this.drive.folderId();
    if (currentParent !== parentId) {
      for (const fid of [ids.audioId, ids.mdId]) if (fid) await this.drive.move(fid, parentId).catch(e => { if (e.status !== 404) throw e; });
    }
    if (ids.parentId !== parentId) {
      job = await store.updateJob(id, j => { j.remote = { ...(j.remote || {}), parentId }; });
      ids.parentId = parentId;
    }

    // 1. Audio originale (solo dal dispositivo che lo ha ricevuto).
    if (!ids.audioId && job.hasLocalAudio) {
      const blob = await store.getAudio(id);
      if (blob) {
        const name = `${safeFileName(job.title)}.${extOf(job.mime)}`;
        const file = await this.drive.uploadLarge(blob, { name, mimeType: job.mime, parentId, appProperties: { kind: 'audio', job: id } },
          p => store.emit('upload', { id, progress: p }));
        store.emit('upload', { id, progress: 1, done: true });
        job = await store.updateJob(id, j => { j.remote = { ...(j.remote || {}), audioId: file.id, audioName: name }; });
        ids.audioId = file.id; ids.audioName = name;
      }
    } else if (ids.audioId && ids.audioName && !ids.audioName.startsWith(safeFileName(job.title) + '.')) {
      const name = `${safeFileName(job.title)}.${extOf(job.mime)}`;
      await this.drive.json(`https://www.googleapis.com/drive/v3/files/${ids.audioId}?fields=id`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      }).catch(() => {});
      job = await store.updateJob(id, j => { j.remote = { ...(j.remote || {}), audioName: name }; });
    }

    // 2. Testo in Markdown (quando c'è qualcosa da leggere).
    if (job.chunks?.some(c => c.raw)) {
      const md = await this.drive.writeSmall({
        id: ids.mdId, name: `${safeFileName(job.title)}.md`, mimeType: 'text/markdown', parentId,
        content: toMarkdown(job), appProperties: { kind: 'md', job: id },
      });
      if (md.id !== ids.mdId) job = await store.updateJob(id, j => { j.remote = { ...(j.remote || {}), mdId: md.id }; });
    }

    // 3. Dati completi della lezione, nella cartella nascosta dell'app (non ingombrano Drive).
    const snapshot = job.rev || 0;
    const res = await this.drive.writeSmall({
      id: job._sync?.dataId, name: `${id}.json`, mimeType: 'application/json', space: 'appDataFolder',
      content: JSON.stringify(shareable(job)), appProperties: { kind: 'data', job: id },
    });
    await store.updateJob(id, j => {
      j._sync = { dataId: res.id, syncedRev: snapshot, remoteModified: res.modifiedTime };
    }, { touch: false });
  }

  /** Elimina una lezione da Drive (nel cestino di Drive, recuperabile per 30 giorni). */
  async removeRemote(job) {
    if (!this.drive.connected) return false;
    const r = job.remote || {};
    for (const fid of [job._sync?.dataId, r.mdId, r.audioId]) await this.drive.trash(fid);
    return true;
  }

  /** Audio della lezione: dalla memoria locale o, se manca, da Drive (poi resta in cache). */
  async audio(job, onProgress) {
    const local = await store.getAudio(job.id);
    if (local) return local;
    if (!job.remote?.audioId) return null;
    if (!this.drive.connected) throw new DriveAuthError('Collega Google Drive per ascoltare questa lezione.');
    let blob = await this.drive.getBlob(job.remote.audioId, job.size, onProgress);
    if (job.mime && blob.type !== job.mime) blob = new Blob([blob], { type: job.mime });
    await store.putAudio(job.id, blob);
    await store.updateJob(job.id, j => { j.hasLocalAudio = true; }, { touch: false });
    return blob;
  }
}
