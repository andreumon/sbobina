// Lezioni e impostazioni salvate su questo dispositivo, più un piccolo "bus" di eventi.
import * as db from './db.js';
import { DEFAULTS } from './config.js';

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
  return { ...DEFAULTS, ...saved, courses: Array.isArray(saved.courses) ? saved.courses : [] };
}

export function saveSettings(patch, { fromRemote = false } = {}) {
  const s = { ...loadSettings(), ...patch };
  if (!fromRemote) s.updatedAt = Date.now();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  emit('settings', { settings: s, fromRemote });
  return s;
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
