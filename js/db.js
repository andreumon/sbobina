// Archivio locale (IndexedDB). Lo stesso schema è replicato in sw.js:
// se cambi DB_VERSION qui, cambialo anche là.
export const DB_NAME = 'sbobina';
export const DB_VERSION = 1;

let dbPromise;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let out;
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transazione annullata'));
  }));
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const put = (store, value, key) =>
  run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const all = store => run(store, 'readonly', s => s.getAll());
export const keys = store => run(store, 'readonly', s => s.getAllKeys());

/** Legge, modifica e riscrive un record in un'unica transazione (niente sovrascritture incrociate). */
export function update(store, key, fn) {
  return openDb().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    let out;
    const r = s.get(key);
    r.onsuccess = () => {
      if (r.result === undefined) return;
      out = fn(r.result) || r.result;
      s.put(out);
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transazione annullata'));
  }));
}
