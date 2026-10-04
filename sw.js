// Service worker di Sbobina:
//  - riceve i file condivisi dal Registratore (Web Share Target) e li mette in "inbox";
//  - tiene in cache i file dell'app, così si apre anche senza rete;
//  - apre la lezione quando tocchi la notifica "Sbobina pronta".

const VERSION = 'sbobina-v2';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/aac.js', './js/config.js', './js/db.js', './js/drive.js', './js/gemini.js',
  './js/pipeline.js', './js/player.js', './js/prompts.js', './js/store.js', './js/strategy.js', './js/sync.js', './js/text.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

// Stesso schema di js/db.js
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sbobina', 1);
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

async function saveShared(request) {
  const form = await request.formData();
  const files = form.getAll('audio').filter(f => f && typeof f === 'object' && f.size > 0);
  if (files.length) {
    const d = await openDb();
    await new Promise((resolve, reject) => {
      const t = d.transaction('inbox', 'readwrite');
      const s = t.objectStore('inbox');
      for (const f of files) {
        s.put({ id: crypto.randomUUID(), file: f, name: f.name, type: f.type, receivedAt: Date.now() });
      }
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'inbox' }));
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(saveShared(req).catch(() => Response.redirect(new URL('./', self.registration.scope).href, 303)));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Rete prima (aggiornamenti immediati), cache se offline.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      return cached || caches.match('./index.html');
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data?.id;
  const target = new URL(id ? `./?job=${encodeURIComponent(id)}` : './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => c.url.startsWith(self.registration.scope));
    if (w) { await w.focus(); return w.navigate(target); }
    return self.clients.openWindow(target);
  })());
});
