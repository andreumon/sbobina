// Lezioni e impostazioni salvate su questo dispositivo, più un piccolo "bus" di eventi.
import * as db from './db.js';
import { DEFAULTS } from './defaults.js';

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));

export const deviceId = (() => {
  let id = localStorage.getItem('sbobina.device');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('sbobina.device', id); }
  return id;
})();

// ---------- Lezioni ----------

export const getJob = id => db.get('jobs', id);

export async function listJobs() {
  const jobs = await db.all('jobs');
  return jobs.sort((a, b) => ((b.recordedAt || b.createdAt) - (a.recordedAt || a.createdAt)) || (b.createdAt - a.createdAt));
}

export async function putJob(job, { touch = true } = {}) {
  if (touch) job.rev = Date.now();
  await db.put('jobs', job);
  emit('job', job);
  return job;
}

/** Modifica atomica: fn riceve il record aggiornato dal database e lo modifica. */
export async function updateJob(id, fn, { touch = true } = {}) {
  const job = await db.update('jobs', id, j => { fn(j); if (touch) j.rev = Date.now(); return j; });
  if (job) emit('job', job);
  return job;
}

export async function removeJob(id) {
  await db.del('jobs', id);
  await db.del('blobs', id);
  emit('removed', id);
}

export const isDirty = job => (job.rev || 0) > (job._sync?.syncedRev || 0);

// ---------- Audio locale ----------

export const getAudio = id => db.get('blobs', id);
export async function putAudio(id, blob) { await db.put('blobs', blob, id); emit('audio', id); }
export async function deleteAudio(id) { await db.del('blobs', id); emit('audio', id); }
export const audioKeys = () => db.keys('blobs');

// ---------- Impostazioni ----------
// Quelle in DEFAULTS si sincronizzano tra dispositivi; tema e cartella PC no.

const SETTINGS_KEY = 'sbobina.settings';

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* ignora */ }
  const out = { ...DEFAULTS, ...saved, courses: Array.isArray(saved.courses) ? saved.courses : [] };
  // Blocchi da 20 minuti erano il vecchio valore predefinito: con le quote gratuite conviene 45.
  if (!saved.chunkV2) { if (!saved.chunkMin || saved.chunkMin === 20) out.chunkMin = 45; out.chunkV2 = true; }
  return out;
}

export function saveSettings(patch, { fromRemote = false } = {}) {
  const prev = loadSettings();
  const s = { ...prev, ...patch };
  if (!fromRemote) {
    const t = Date.now();
    s.updatedAt = t;
    s.fieldsAt = { ...(prev.fieldsAt || {}) };
    for (const k of Object.keys(patch)) if (k !== 'courses') s.fieldsAt[k] = t;
    if (patch.courses) {
      // Ogni corso porta la data della sua ultima modifica; quelli tolti diventano "eliminati".
      const old = new Map((prev.courses || []).map(c => [c.name, c]));
      const strip = ({ at, ...c }) => JSON.stringify(c);
      s.courses = patch.courses.map(c => {
        const o = old.get(c.name);
        return o && strip(o) === strip(c) ? { ...c, at: o.at || 0 } : { ...c, at: t };
      });
      s.coursesDeleted = { ...(prev.coursesDeleted || {}) };
      const now = new Set(s.courses.map(c => c.name));
      for (const name of old.keys()) if (!now.has(name)) s.coursesDeleted[name] = t;
      for (const name of now) delete s.coursesDeleted[name];
    }
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  emit('settings', { settings: s, fromRemote });
  return s;
}

/**
 * Unisce le impostazioni locali con quelle su Drive senza perdere modifiche fatte altrove:
 * per ogni campo vince la modifica più recente; i corsi si uniscono uno per uno
 * (vince la versione più recente di ciascuno; un'eliminazione più recente lo toglie).
 * Le impostazioni salvate da versioni precedenti (senza date per campo) contano con la loro data globale.
 */
export function mergeSettings(local, remote) {
  const fieldTime = (s, k) => (s.fieldsAt ? s.fieldsAt[k] || 0 : s.updatedAt || 0);
  const out = { ...local, fieldsAt: { ...(local.fieldsAt || {}) } };
  for (const k of Object.keys(DEFAULTS)) {
    if (['courses', 'fieldsAt', 'coursesDeleted', 'updatedAt'].includes(k)) continue;
    if (!(k in remote)) continue;
    const tr = fieldTime(remote, k), tl = fieldTime(local, k);
    if (tr > tl) { out[k] = remote[k]; out.fieldsAt[k] = tr; }
  }
  const deleted = { ...(local.coursesDeleted || {}) };
  for (const [n, t] of Object.entries(remote.coursesDeleted || {})) deleted[n] = Math.max(deleted[n] || 0, t);
  const byName = new Map();
  for (const c of [...(local.courses || []), ...(Array.isArray(remote.courses) ? remote.courses : [])]) {
    const cur = byName.get(c.name);
    if (!cur || (c.at || 0) > (cur.at || 0)) byName.set(c.name, c);
  }
  out.courses = [...byName.values()]
    .filter(c => !(deleted[c.name] > (c.at || 0)))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));
  for (const c of out.courses) delete deleted[c.name];
  out.coursesDeleted = deleted;
  out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  return out;
}

/** Le due versioni delle impostazioni sincronizzate sono uguali? (indipendente dall'ordine delle chiavi) */
export function sameSettings(a, b) {
  const stable = v => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
      : JSON.stringify(v ?? null));
  return stable(syncedSettings({ ...DEFAULTS, ...a })) === stable(syncedSettings({ ...DEFAULTS, ...b }));
}

export function syncedSettings(s = loadSettings()) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = s[k];
  return out;
}

export const device = {
  get(key, fallback) { const v = localStorage.getItem(`sbobina.dev.${key}`); return v === null ? fallback : JSON.parse(v); },
  set(key, value) { localStorage.setItem(`sbobina.dev.${key}`, JSON.stringify(value)); emit('device', { key, value }); },
};

export const kv = {
  get: key => db.get('kv', key),
  set: (key, value) => db.put('kv', value, key),
  del: key => db.del('kv', key),
};
