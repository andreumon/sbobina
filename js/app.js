// Sbobina: interfaccia. Collega elenco, nuova trascrizione, lezione, lettore, impostazioni.
import * as store from './store.js';
import * as db from './db.js';
import { DRIVE_CLIENT_ID } from './config.js';
import { Drive, DriveAuthError } from './drive.js';
import { Sync } from './sync.js';
import { Player } from './player.js';
import { processJob, BusyError } from './pipeline.js';
import { Gemini, explainError } from './gemini.js';
import { guessMime, cleanForPlayback } from './aac.js';
import { diagnose, describeStrategy, saveStrategy, resetStrategy, loadStrategy } from './strategy.js';
import {
  fmtTime, lectureParagraphs, toMarkdown, safeFileName, countUncertain, toEditable, parseEditable,
} from './text.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isWide = () => matchMedia('(min-width: 960px)').matches;
const canPickFolder = 'showDirectoryPicker' in window;

let settings = store.loadSettings();
const drive = new Drive(DRIVE_CLIENT_ID || store.device.get('clientId', ''));
const sync = new Sync(drive);
const player = new Player($('player'));

const state = {
  view: 'home',
  jobId: null,
  tab: 'revised',
  editing: false,
  pending: [],             // file in attesa di "Trascrivi" [{file, inboxId}]
  runner: null,            // { id, abort }
  progress: {},            // id → ultimo avanzamento
  uploads: {},             // id → avanzamento copia su Drive
  paraTimes: [],
};

// ====================================================================
// Navigazione
// ====================================================================

function show(view) {
  state.view = view;
  for (const [name, el] of Object.entries({ home: 'vHome', new: 'vNew', course: 'vCourse', lecture: 'vLecture', settings: 'vSettings' })) {
    $(el).hidden = name !== view;
  }
  if (view !== 'course') { state.courseName = null; markCurrentRow(); }
  document.body.dataset.screen = view === 'home' ? 'list' : 'pane';
  if (view !== 'lecture') { state.jobId = null; player.unload(); markCurrentRow(); }
  document.querySelector('.pane').scrollTop = 0;
  window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  const to = go.dataset.go;
  if (to === 'settings') { renderSettings(); show('settings'); history.pushState({ v: 'settings' }, ''); }
  else { show('home'); history.pushState({ v: 'home' }, ''); }
});

window.addEventListener('popstate', e => {
  const v = e.state?.v || 'home';
  if (v === 'lecture' && e.state.id) openLecture(e.state.id, { push: false });
  else if (v === 'course') openCourse(e.state.name ?? null, { push: false });
  else if (v === 'settings') { renderSettings(); show('settings'); }
  else show('home');
});

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function notice(html) {
  const n = $('notice');
  n.innerHTML = html || '';
  n.hidden = !html;
}

// ====================================================================
// Tema
// ====================================================================

function applyTheme(t = store.device.get('theme', 'auto')) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('themeBtn').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('themeBtn').setAttribute('aria-label', dark ? 'Passa al tema chiaro' : 'Passa al tema scuro');
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach(m => { if (t !== 'auto') m.setAttribute('content', dark ? '#1c2622' : '#f4f5f1'); });
}
$('themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  store.device.set('theme', dark ? 'light' : 'dark');
  applyTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

// ====================================================================
// Elenco delle lezioni
// ====================================================================

function stateLabel(job) {
  const p = state.progress[job.id];
  if (state.runner?.id === job.id && p) return { text: progressText(job, p), cls: '' };
  switch (job.status) {
    case 'queued': return { text: 'In coda', cls: '' };
    case 'running':
      return job.runner === store.deviceId ? { text: 'In coda', cls: '' } : { text: 'In elaborazione su un altro dispositivo', cls: '' };
    case 'paused': return { text: 'In pausa', cls: '' };
    case 'waiting': return { text: 'In attesa: Google è sovraccarico', cls: '' };
    case 'error': return { text: 'Interrotta', cls: 'err' };
    default: return null;
  }
}

function lectureMeta(job) {
  const date = new Date(job.recordedAt || job.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  return [job.course, date, job.duration ? fmtTime(job.duration) : null].filter(Boolean).join(', ');
}

function lectureRow(job) {
  const st = stateLabel(job);
  const unsure = job.status === 'done' ? countUncertain(lectureParagraphs(job).map(p => p.text).join(' ')) : 0;
  const extra = st ? `<span class="l-state ${st.cls}">${esc(st.text)}</span>`
    : unsure ? `${unsure} ${unsure === 1 ? 'punto' : 'punti'} da verificare` : '';
  const date = new Date(job.recordedAt || job.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  const meta = [date, job.duration ? fmtTime(job.duration) : null].filter(Boolean).join(', ');
  return `<li><button type="button" class="row-btn" data-id="${job.id}"${job.id === state.jobId ? ' aria-current="true"' : ''}>
    <span class="l-title">${esc(job.title)}</span>
    <span class="l-meta">${esc(meta)}${extra ? `<br>${extra}` : ''}</span>
  </button><button type="button" class="row-more" data-id="${job.id}" aria-label="Altre azioni per ${esc(job.title)}">⋯</button></li>`;
}

/** Corsi noti: quelli salvati più quelli che compaiono solo nelle lezioni (es. creati su un altro dispositivo). */
function allCourseNames(jobs) {
  const names = new Set(settings.courses.map(c => c.name));
  for (const j of jobs) if (j.course) names.add(j.course);
  return [...names].sort((a, b) => a.localeCompare(b, 'it'));
}

async function renderList() {
  const jobs = await store.listJobs();
  const closed = new Set(store.device.get('closedFolders', []));
  const groups = allCourseNames(jobs).map(name => ({ name, jobs: jobs.filter(j => j.course === name) }));
  const loose = jobs.filter(j => !j.course);
  if (loose.length) groups.push({ name: '', jobs: loose });
  // La cartella della lezione aperta resta aperta.
  const current = jobs.find(j => j.id === state.jobId);
  if (current) closed.delete(current.course || '');

  $('lectureList').innerHTML = groups.map(g => {
    const isOpen = !closed.has(g.name) || groups.length === 1;
    const label = g.name || 'Senza corso';
    return `<section class="folder" data-course="${esc(g.name)}" data-open="${isOpen}">
      <div class="folder-head"${g.name && g.name === state.courseName ? ' aria-current="true"' : ''}>
        <button type="button" class="folder-toggle" aria-expanded="${isOpen}">
          <svg><use href="#i-chev"/></svg>
          <span class="folder-name">${esc(label)}</span>
          <span class="folder-count">${g.jobs.length}</span>
        </button>
        ${g.name ? `<button type="button" class="folder-edit" aria-label="Parole chiave di ${esc(label)}">Parole chiave</button>` : ''}
      </div>
      ${g.jobs.length ? `<ol class="lectures folder-body">${g.jobs.map(lectureRow).join('')}</ol>` : `<p class="folder-empty folder-body">Ancora nessuna lezione.</p>`}
    </section>`;
  }).join('');
  $('emptyList').hidden = groups.length > 0;
}

function markCurrentRow() {
  document.querySelectorAll('.row-btn').forEach(b => {
    if (b.dataset.id === state.jobId) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.folder-head').forEach(h => {
    const name = h.parentElement.dataset.course;
    if (name && name === state.courseName) h.setAttribute('aria-current', 'true'); else h.removeAttribute('aria-current');
  });
}

$('lectureList').addEventListener('click', e => {
  const row = e.target.closest('.row-btn');
  if (row) { openLecture(row.dataset.id); return; }
  const folder = e.target.closest('.folder');
  if (!folder) return;
  const name = folder.dataset.course;
  if (e.target.closest('.folder-edit')) { openCourse(name); return; }
  if (e.target.closest('.folder-toggle')) {
    const isOpen = folder.dataset.open !== 'true';
    folder.dataset.open = String(isOpen);
    folder.querySelector('.folder-toggle').setAttribute('aria-expanded', String(isOpen));
    const closed = new Set(store.device.get('closedFolders', []));
    if (isOpen) closed.delete(name); else closed.add(name);
    store.device.set('closedFolders', [...closed]);
  }
});

$('newCourseBtn').addEventListener('click', () => openCourse(null));

let listTimer;
const refreshList = () => { clearTimeout(listTimer); listTimer = setTimeout(renderList, 120); };

// ====================================================================
// Corsi (cartelle)
// ====================================================================

async function openCourse(name, { push = true } = {}) {
  const course = name ? settings.courses.find(c => c.name === name) || { name, glossary: '' } : null;
  state.courseName = name || null;
  show('course');
  markCurrentRow();
  if (push) history.pushState({ v: 'course', name }, '');
  $('courseHeading').textContent = course ? course.name : 'Nuovo corso';
  $('courseName').value = course?.name || '';
  $('courseKeywords').value = course?.glossary || '';
  $('courseSave').textContent = course ? 'Salva modifiche' : 'Crea corso';
  $('courseDelete').hidden = !course;
  $('courseAddRec').hidden = !course;
  const jobs = course ? (await store.listJobs()).filter(j => j.course === course.name) : [];
  $('courseLectures').innerHTML = course
    ? (jobs.length ? `<h3>Lezioni</h3><ol>${jobs.map(lectureRow).join('')}</ol>` : '<p class="help">Ancora nessuna lezione in questo corso.</p>')
    : '';
  if (!course) $('courseName').focus();
}

$('courseLectures').addEventListener('click', e => {
  const row = e.target.closest('.row-btn');
  if (row) openLecture(row.dataset.id);
});

$('courseForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('courseName').value.trim().replace(/[\\/]+/g, '-');
  const glossary = $('courseKeywords').value.trim();
  if (!name) return;
  const oldName = state.courseName;
  if (name !== oldName && settings.courses.some(c => c.name === name)) {
    toast(`Esiste già un corso "${name}".`);
    return;
  }
  const courses = settings.courses.filter(c => c.name !== oldName);
  courses.push({ name, glossary });
  courses.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  settings = store.saveSettings({ courses });
  if (oldName && oldName !== name) {
    for (const j of await store.listJobs()) if (j.course === oldName) await store.updateJob(j.id, x => { x.course = name; });
    const closed = new Set(store.device.get('closedFolders', []));
    if (closed.delete(oldName)) { closed.add(name); store.device.set('closedFolders', [...closed]); }
    if (drive.connected) await drive.renameCourseFolder(oldName, name).catch(err => console.warn(err));
  }
  toast(oldName ? 'Corso aggiornato' : 'Corso creato');
  await renderList();
  sync.run();
  openCourse(name, { push: false });
  history.replaceState({ v: 'course', name }, '');
});

$('courseDelete').addEventListener('click', async () => {
  const name = state.courseName;
  if (!name) return;
  const n = (await store.listJobs()).filter(j => j.course === name).length;
  const msg = n
    ? `Eliminare il corso "${name}"? Le sue ${n === 1 ? 'lezione resta' : `${n} lezioni restano`}, in "Senza corso".`
    : `Eliminare il corso "${name}"?`;
  if (!confirm(msg)) return;
  settings = store.saveSettings({ courses: settings.courses.filter(c => c.name !== name) });
  for (const j of await store.listJobs()) if (j.course === name) await store.updateJob(j.id, x => { x.course = ''; });
  show('home');
  history.pushState({ v: 'home' }, '');
  await renderList();
  toast('Corso eliminato');
  if (drive.connected) {
    await sync.run();
    drive.trashCourseFolderIfEmpty(name).catch(() => {});
  }
});

$('courseFileInput').addEventListener('change', e => {
  state.pendingCourse = state.courseName;
  addPending([...e.target.files].map(file => ({ file })));
  e.target.value = '';
});

// Spostare una lezione in un altro corso
function fillMoveSelect(job) {
  const names = settings.courses.map(c => c.name);
  if (job.course && !names.includes(job.course)) names.push(job.course);
  $('moveSel').innerHTML = '<option value="">Senza corso</option>' +
    names.map(n => `<option${n === job.course ? ' selected' : ''}>${esc(n)}</option>`).join('');
}
$('moveSel').addEventListener('change', async () => {
  $('moveRow').hidden = true;
  await moveLecture(state.jobId, $('moveSel').value);
});

async function moveLecture(id, course) {
  await store.updateJob(id, j => { j.course = course; });
  const closed = new Set(store.device.get('closedFolders', []));
  closed.delete(course);
  store.device.set('closedFolders', [...closed]);
  toast(course ? `Spostata in ${course}` : 'Spostata in Senza corso');
  renderList();
  if (state.view === 'course') openCourse(state.courseName, { push: false });
  if (state.jobId === id) renderLecture();
  sync.run();
}

// ====================================================================
// Nuova trascrizione
// ====================================================================

$('fileInput').addEventListener('change', e => {
  addPending([...e.target.files].map(file => ({ file })));
  e.target.value = '';
});

function looksAudio(f) {
  return /^audio\//.test(f.type) || /\.(aac|m4a|mp3|wav|ogg|oga|opus|webm|flac|mp4)$/i.test(f.name);
}

function addPending(items) {
  const ok = items.filter(i => looksAudio(i.file));
  if (!ok.length) { if (items.length) toast('Questo file non sembra un audio.'); return; }
  state.pending.push(...ok);
  renderNew();
  show('new');
  history.pushState({ v: 'new' }, '');
}

function defaultTitle(file) {
  const base = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const generic = /^(registrazione|recording|rec|audio|voice|nota|record)?[\s\d\-–.:]*$/i.test(base);
  if (!generic) return base;
  const d = new Date(file.lastModified || Date.now());
  return `Lezione del ${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}`;
}

function dateInputValue(ms) {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderNew() {
  $('newFiles').innerHTML = state.pending.map((p, i) => `
    <div class="file-card">
      <p class="file-name">${esc(p.file.name)}, ${(p.file.size / 1048576).toFixed(1).replace('.', ',')} MB</p>
      <div class="field">
        <label for="nt${i}">Titolo</label>
        <div class="row">
          <input id="nt${i}" data-i="${i}" class="new-title" value="${esc(defaultTitle(p.file))}">
          <input type="date" id="nd${i}" data-i="${i}" class="new-date" value="${dateInputValue(p.file.lastModified)}" aria-label="Data della lezione">
        </div>
      </div>
    </div>`).join('');
  const sel = $('newCourse');
  const last = state.pendingCourse ?? store.device.get('lastCourse', '');
  state.pendingCourse = null;
  sel.innerHTML = '<option value="">Nessun corso</option>' +
    settings.courses.map(c => `<option${c.name === last ? ' selected' : ''}>${esc(c.name)}</option>`).join('') +
    '<option value="__new">Nuovo corso…</option>';
  $('newCourseName').hidden = true;
  fillGlossary();
}

function fillGlossary() {
  const name = $('newCourse').value;
  $('newCourseName').hidden = name !== '__new';
  const c = settings.courses.find(x => x.name === name);
  $('newGlossary').value = c?.glossary || '';
}
$('newCourse').addEventListener('change', () => { fillGlossary(); if ($('newCourse').value === '__new') $('newCourseName').focus(); });

$('cancelNew').addEventListener('click', async () => {
  for (const p of state.pending) if (p.inboxId) await db.del('inbox', p.inboxId);
  state.pending = [];
  show('home');
});

$('newForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!state.pending.length) return;
  if (!settings.apiKey) {
    toast('Prima inserisci la chiave API Gemini.');
    renderSettings(); show('settings'); $('sKey').focus();
    return;
  }
  const btn = $('startBtn');
  btn.disabled = true;
  try {
    // Il tocco su "Trascrivi" è il momento giusto per il popup Google (se serve).
    if (drive.configured && !drive.connected) {
      try { await drive.connect(); } catch (err) { toast(`Drive non collegato: ${err.message}`, 4000); }
    }
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    let course = $('newCourse').value;
    if (course === '__new') course = $('newCourseName').value.trim();
    const glossary = $('newGlossary').value.trim();
    if (course) {
      const courses = settings.courses.filter(c => c.name !== course);
      courses.push({ ...(settings.courses.find(c => c.name === course) || {}), name: course, glossary });
      courses.sort((a, b) => a.name.localeCompare(b.name, 'it'));
      settings = store.saveSettings({ courses });
      store.device.set('lastCourse', course);
    }

    const created = [];
    for (let i = 0; i < state.pending.length; i++) {
      const { file, inboxId } = state.pending[i];
      const title = document.querySelector(`.new-title[data-i="${i}"]`).value.trim() || defaultTitle(file);
      const dateVal = document.querySelector(`.new-date[data-i="${i}"]`).value;
      const recordedAt = dateVal ? new Date(`${dateVal}T12:00:00`).getTime() : (file.lastModified || Date.now());
      const id = crypto.randomUUID();
      await store.putAudio(id, file);
      await store.putJob({
        id, title, course, glossary, recordedAt, createdAt: Date.now(),
        fileName: file.name, mime: guessMime(file), size: file.size,
        origin: store.deviceId, hasLocalAudio: true, status: 'queued', chunks: [], log: [],
      });
      if (inboxId) await db.del('inbox', inboxId);
      created.push(id);
    }
    state.pending = [];
    await renderList();
    openLecture(created[0], { replace: true });
    runQueue();
    sync.run();
  } finally {
    btn.disabled = false;
  }
});

// File condivisi dal Registratore (arrivano tramite il service worker).
async function checkInbox() {
  const items = await db.all('inbox');
  if (!items.length) return false;
  const known = new Set(state.pending.map(p => p.inboxId));
  const fresh = items.filter(i => !known.has(i.id)).map(i => ({
    file: i.file instanceof File ? i.file : new File([i.file], i.name || 'registrazione.aac', { type: i.type || 'audio/aac', lastModified: i.receivedAt }),
    inboxId: i.id,
  }));
  if (fresh.length) addPending(fresh);
  return true;
}

// Trascina e rilascia (PC).
let dragDepth = 0;
window.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('dropVeil').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropVeil').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0; $('dropVeil').hidden = true;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addPending(files.map(file => ({ file })));
});

// ====================================================================
// Elaborazione (una lezione alla volta)
// ====================================================================

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* non disponibile */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.runner) keepAwake(true);
    scheduleWakeups();
    checkInbox();
    if (drive.connected && Date.now() - sync.lastRun > 30_000) sync.run();
  }
});

/** Rimette in coda le lezioni "in attesa" quando è il momento di riprovare. */
let wakeTimer;
async function scheduleWakeups() {
  clearTimeout(wakeTimer);
  const waiting = (await store.listJobs()).filter(j => j.status === 'waiting' && (!j.runner || j.runner === store.deviceId));
  if (!waiting.length) return;
  const now = Date.now();
  const due = waiting.filter(j => (j.retryAt || 0) <= now);
  for (const j of due) await store.updateJob(j.id, x => { x.status = 'queued'; x.error = null; });
  if (due.length) runQueue();
  const next = Math.min(...waiting.filter(j => (j.retryAt || 0) > now).map(j => j.retryAt));
  if (Number.isFinite(next)) wakeTimer = setTimeout(scheduleWakeups, Math.max(5_000, next - now + 1_000));
}

async function runQueue() {
  if (state.runner) return;
  if (!settings.apiKey) return;
  for (;;) {
    const jobs = (await store.listJobs()).filter(j => j.status === 'queued' && (!j.runner || j.runner === store.deviceId))
      .sort((a, b) => a.createdAt - b.createdAt);
    const job = jobs[0];
    if (!job) break;
    const abort = new AbortController();
    state.runner = { id: job.id, abort };
    keepAwake(true);
    try {
      const done = await processJob(job.id, {
        settings: store.loadSettings(),
        signal: abort.signal,
        getAudio: j => sync.audio(j, p => onProgress({ id: j.id, step: 'fetch', progress: p })),
        log: () => { if (state.jobId === job.id) renderStatus(); },
        onProgress,
        onChunkDone: j => { if (state.jobId === j.id) renderLecture(); sync.run(); },
      });
      notifyDone(done);
      autoSaveToFolder(done);
    } catch (e) {
      const paused = e.name === 'AbortError';
      const busy = e instanceof BusyError;
      if (!paused) console.error(e);
      await store.updateJob(job.id, j => {
        j.status = paused ? 'paused' : busy ? 'waiting' : 'error';
        j.error = paused ? null : explainError(busy ? e.cause : e);
        j.retryAt = busy ? Date.now() + e.retryAfterMs : null;
        if (busy) j.runner = store.deviceId; else delete j.runner;
      });
      if (busy) scheduleWakeups();
    } finally {
      delete state.progress[job.id];
      state.runner = null;
      keepAwake(false);
      refreshList();
      if (state.jobId === job.id) renderLecture();
      sync.run();
    }
  }
}

function onProgress(p) {
  state.progress[p.id] = p;
  if (state.jobId === p.id) renderStatus();
  refreshList();
}

function progressText(job, p) {
  const n = p.total || job.chunks?.length || 0;
  const part = n > 1 ? `Blocco ${p.chunk + 1} di ${n}: ` : '';
  switch (p.step) {
    case 'fetch': return `Recupero l'audio da Drive… ${Math.round((p.progress || 0) * 100)}%`;
    case 'plan': return 'Analizzo l\'audio e cerco le pause…';
    case 'diagnose': return `Google ha rifiutato la richiesta: provo alcune varianti${p.label ? ` (${p.label})` : ''}…`;
    case 'upload': return `${part}invio a Gemini ${Math.round((p.progress || 0) * 100)}%`;
    case 'transcribe': return `${part}trascrizione letterale…`;
    case 'revise': return `${part}revisione e controllo…`;
    case 'done': return 'Completata';
    default: return 'In elaborazione…';
  }
}

function progressFraction(job, p) {
  const n = p.total || job.chunks?.length || 1;
  if (p.step === 'diagnose') return 0.03;
  const w = { plan: 0, fetch: 0, upload: 0.15 * (p.progress || 0), transcribe: 0.2, revise: 0.6, done: 1 }[p.step] ?? 0;
  if (p.step === 'done') return 1;
  if (p.step === 'plan' || p.step === 'fetch') return 0.02;
  return Math.min(0.99, ((p.chunk || 0) + w) / n);
}

function notifyDone(job) {
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then(reg => reg.showNotification('Sbobina pronta', {
    body: job.title, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: job.id, data: { id: job.id },
  })).catch(() => {});
}

// ====================================================================
// Lezione
// ====================================================================

async function openLecture(id, { push = true, replace = false } = {}) {
  const job = await store.getJob(id);
  if (!job) { show('home'); return; }
  const changed = state.jobId !== id;
  show('lecture');
  state.jobId = id;
  if (changed) { state.tab = 'revised'; state.userTab = false; state.editing = false; $('moveRow').hidden = true; }
  if (push) history[replace ? 'replaceState' : 'pushState']({ v: 'lecture', id }, '');
  markCurrentRow();
  player.prepare({
    id, title: job.title, course: job.course, duration: job.duration,
    loader: onProg => loadAudio(id, onProg),
  });
  renderLecture(job);
}

async function loadAudio(id, onProg) {
  const job = await store.getJob(id);
  if (!job) return null;
  let blob;
  try {
    blob = await sync.audio(job, onProg);
  } catch (e) {
    if (!(e instanceof DriveAuthError && drive.configured)) throw e;
    player.message('');
    await drive.connect(); // siamo dentro un tocco su play: il popup è consentito
    blob = await sync.audio(await store.getJob(id), onProg);
  }
  return blob ? cleanForPlayback(blob) : blob;
}

async function renderLecture(job) {
  if (!job && !state.jobId) return;
  job = job || await store.getJob(state.jobId);
  if (!job || job.id !== state.jobId) return;
  $('lecTitle').textContent = job.title;
  const up = state.uploads[job.id];
  const driveNote = up && !up.done ? `, copia su Drive ${Math.round(up.progress * 100)}%` : '';
  $('lecMeta').textContent = lectureMeta(job) + driveNote;
  $('lecActions').querySelector('[data-act="share"]').hidden = !navigator.share;
  if (job.duration && Math.abs(job.duration - player.duration) > 1) player.setDuration(job.duration);

  renderStatus(job);

  const warns = (job.chunks || []).map((c, i) => c.warn ? `<p>Blocco ${i + 1} (${fmtTime(c.start)}–${fmtTime(c.end)}): ${esc(c.warn)}</p>` : '').join('');
  $('lecChecks').innerHTML = warns;
  $('lecChecks').hidden = !warns || state.tab !== 'revised' || !!job.edited;

  const hasRevised = !!job.edited || (job.chunks || []).some(c => c.revised);
  $('lecTabs').hidden = !hasRevised;
  if (!hasRevised) state.tab = 'raw';
  else if (!state.userTab) state.tab = 'revised';
  document.querySelectorAll('#lecTabs [role="tab"]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));

  $('editorWrap').hidden = !state.editing;
  $('transcript').hidden = state.editing;
  if (!state.editing) renderTranscript(job);
}

function renderStatus(job) {
  const run = async () => {
    if (!job && !state.jobId) return;
    job = job || await store.getJob(state.jobId);
    if (!job || job.id !== state.jobId) return;
    const box = $('lecStatus');
    const p = state.progress[job.id];
    const mine = state.runner?.id === job.id;
    if (job.status === 'done' && !mine) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('error', job.status === 'error');
    let text = '', actions = '';
    if (mine && p) {
      text = progressText(job, p);
      actions = '<button type="button" class="btn" data-run="stop">Interrompi</button>';
      $('progressFill').style.width = `${Math.round(progressFraction(job, p) * 100)}%`;
    } else if (job.status === 'error') {
      text = job.error || 'Elaborazione interrotta.';
      actions = '<button type="button" class="btn" data-run="resume">Riprendi</button>';
    } else if (job.status === 'waiting') {
      const at = new Date(job.retryAt || Date.now()).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      text = `Google è sovraccarico o ha esaurito la quota gratuita per ora. Riprovo da solo alle ${at}, con l'app aperta.`;
      actions = '<button type="button" class="btn" data-run="resume">Riprova ora</button>';
    } else if (job.status === 'paused') {
      text = 'Elaborazione in pausa.';
      actions = '<button type="button" class="btn" data-run="resume">Riprendi</button>';
    } else if (job.status === 'running' && job.runner !== store.deviceId) {
      const stale = Date.now() - (job.heartbeat || 0) > 5 * 60_000;
      text = stale ? 'L\'elaborazione si è fermata su un altro dispositivo.' : 'In elaborazione su un altro dispositivo.';
      if (stale) actions = '<button type="button" class="btn" data-run="takeover">Continua qui</button>';
    } else {
      text = state.runner ? 'In coda dopo la lezione in corso.' : 'In coda.';
      if (!settings.apiKey) text = 'Manca la chiave API Gemini: inseriscila nelle impostazioni.';
    }
    const doneChunks = (job.chunks || []).filter(c => c.paragraphs).length;
    if (!mine) $('progressFill').style.width = job.chunks?.length ? `${(doneChunks / job.chunks.length) * 100}%` : '0';
    $('statusText').textContent = text;
    $('statusActions').innerHTML = actions;
    $('logText').textContent = (job.log || []).join('\n');
    box.querySelector('.log').hidden = !(job.log || []).length;
  };
  run();
}

$('statusActions').addEventListener('click', async e => {
  const b = e.target.closest('[data-run]');
  if (!b) return;
  const id = state.jobId;
  if (b.dataset.run === 'stop') state.runner?.abort.abort();
  else {
    if (b.dataset.run === 'takeover' || b.dataset.run === 'resume') {
      if (!drive.connected && drive.configured && !(await store.getAudio(id))) {
        try { await drive.connect(); } catch (err) { toast(err.message); return; }
      }
      await store.updateJob(id, j => { j.status = 'queued'; j.runner = store.deviceId; j.error = null; });
      renderLecture();
      runQueue();
    }
  }
});

document.querySelectorAll('#lecTabs [role="tab"]').forEach(t => t.addEventListener('click', () => {
  state.tab = t.dataset.tab;
  state.userTab = true;
  renderLecture();
}));

function highlight(text) {
  let h = esc(text);
  h = h.replace(/^(Studente|Docente|Studentessa|Professore|Professoressa):/, '<b class="who">$1:</b>');
  h = h.replace(/\[incomprensibile\]/gi, '<span class="unintelligible">[incomprensibile]</span>');
  // Evidenzia la parola o la breve espressione che precede [?]
  h = h.replace(/((?:[^\s<>[\]]+\s){0,1}[^\s<>[\]]+)\s?\[\?\]/g, '<mark class="unsure">$1 [?]</mark>');
  return h;
}

function renderTranscript(job) {
  const art = $('transcript');
  const long = (job.duration || 0) >= 3600;
  const paras = lectureParagraphs(job, state.tab);
  if (!paras.length) {
    art.innerHTML = `<p class="transcript-empty">${job.status === 'done' ? 'Nessun parlato riconosciuto.' : 'Il testo comparirà qui man mano che i blocchi vengono trascritti.'}</p>`;
    state.paraTimes = [];
    player.setMarks([]);
    $('uncertainBtn').hidden = true;
    return;
  }
  let html = '';
  let lastChunk = -1;
  paras.forEach((p, i) => {
    if (state.tab === 'raw' && p.chunk !== lastChunk && job.chunks.length > 1) {
      const c = job.chunks[p.chunk];
      html += `<p class="chunk-label">Blocco ${p.chunk + 1}, da ${fmtTime(c.start, long)} a ${fmtTime(c.end, long)}</p>`;
      lastChunk = p.chunk;
    }
    const ts = p.t !== null && p.t !== undefined
      ? `<button type="button" class="ts" data-t="${p.t}" aria-label="Ascolta da ${fmtTime(p.t, long)}">${fmtTime(p.t, long)}</button>` : '';
    html += `<p class="para" data-i="${i}">${ts}${highlight(p.text)}</p>`;
  });
  art.innerHTML = html;

  // Tempi effettivi (i paragrafi senza tempo ereditano il precedente) e punti da verificare.
  let last = 0;
  state.paraTimes = paras.map(p => (last = p.t ?? last));
  const unsure = [];
  paras.forEach((p, i) => { if (/\[\?\]|\[incomprensibile\]/i.test(p.text)) unsure.push(i); });
  state.unsure = unsure;
  player.setMarks(unsure.map(i => ({ t: state.paraTimes[i], kind: 'uncertain' })));
  const ub = $('uncertainBtn');
  ub.hidden = !unsure.length || state.tab !== 'revised';
  ub.textContent = `${unsure.length} ${unsure.length === 1 ? 'punto' : 'punti'} da verificare`;
  state.unsureCursor = -1;
  highlightNow(player.currentTime);
  if (/\$[^$\n]+\$/.test(art.textContent)) renderMath(art);
}

$('uncertainBtn').addEventListener('click', () => {
  if (!state.unsure?.length) return;
  state.unsureCursor = (state.unsureCursor + 1) % state.unsure.length;
  const i = state.unsure[state.unsureCursor];
  const el = $('transcript').querySelector(`.para[data-i="${i}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.classList.remove('flash'); void el?.offsetWidth; el?.classList.add('flash');
  $('uncertainBtn').textContent = `${state.unsureCursor + 1} di ${state.unsure.length} da verificare`;
});

$('transcript').addEventListener('click', e => {
  const ts = e.target.closest('.ts');
  if (ts) player.seek(Number(ts.dataset.t), true);
});

function highlightNow(t) {
  const times = state.paraTimes;
  if (!times?.length || !player.ready) return;
  let lo = 0, hi = times.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t + 0.3) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx === state.nowIdx) return;
  state.nowIdx = idx;
  $('transcript').querySelectorAll('.para.now').forEach(p => p.classList.remove('now'));
  if (idx >= 0) $('transcript').querySelector(`.para[data-i="${idx}"]`)?.classList.add('now');
}
player.onTime(t => highlightNow(t));

// Formule LaTeX (KaTeX caricato solo quando serve).
let katexReady;
function renderMath(el) {
  if (!katexReady) {
    katexReady = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
      document.head.appendChild(css);
      const s1 = document.createElement('script');
      s1.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
      s1.onload = () => {
        const s2 = document.createElement('script');
        s2.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js';
        s2.onload = resolve; s2.onerror = reject;
        document.head.appendChild(s2);
      };
      s1.onerror = reject;
      document.head.appendChild(s1);
    }).catch(() => { katexReady = null; });
  }
  katexReady?.then(() => {
    try { window.renderMathInElement?.(el, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false }); } catch { /* lascia il testo com'è */ }
  });
}

// Titolo modificabile.
$('lecTitle').addEventListener('click', startRename);
$('lecTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startRename(); } });
function startRename() {
  const h = $('lecTitle');
  if (h.hidden) return;
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = h.textContent;
  input.setAttribute('aria-label', 'Titolo della lezione');
  h.hidden = true;
  h.after(input);
  input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const v = input.value.trim();
    input.remove(); h.hidden = false;
    if (save && v && v !== h.textContent) {
      await store.updateJob(state.jobId, j => { j.title = v; });
      h.textContent = v;
      refreshList();
      sync.run();
    }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

// Azioni: copia, salva, condividi, modifica, elimina.
$('lecActions').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && state.jobId) lectureAction(b.dataset.act, state.jobId, 'page');
});

/** Azioni su una lezione, dalla sua pagina o dal menu (pressione prolungata, tasto destro, ⋯). */
async function lectureAction(act, id, from = 'menu') {
  const job = await store.getJob(id);
  if (!job) return;
  const md = toMarkdown(job);
  const name = `${safeFileName(job.title)}.md`;
  switch (act) {
    case 'open':
      openLecture(id);
      break;
    case 'copy':
      try { await navigator.clipboard.writeText(md); toast('Testo copiato'); } catch { toast('Copia non riuscita'); }
      break;
    case 'save': {
      const handle = canPickFolder ? await store.kv.get('dirHandle') : null;
      if (handle && await writeToFolder(job, handle, true)) { toast(`Salvata in ${handle.name}/${name}`); break; }
      download(name, md);
      break;
    }
    case 'share': {
      const file = new File([md], name, { type: 'text/markdown' });
      try {
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: job.title });
        else {
          const txt = new File([md], name.replace(/\.md$/, '.txt'), { type: 'text/plain' });
          if (navigator.canShare?.({ files: [txt] })) await navigator.share({ files: [txt], title: job.title });
          else await navigator.share({ title: job.title, text: md });
        }
      } catch (err) { if (err.name !== 'AbortError') toast('Condivisione non riuscita'); }
      break;
    }
    case 'rename':
      if (from === 'page') { startRename(); break; }
      openSheet(`
        <form class="sheet-form" data-form="rename">
          <label for="sheetInput">Nuovo titolo</label>
          <input id="sheetInput" value="${esc(job.title)}">
          <div class="form-actions"><button type="submit" class="primary">Rinomina</button><button type="button" class="quiet" data-close>Annulla</button></div>
        </form>`, { id, keep: true });
      $('sheetInput').select();
      break;
    case 'move':
      if (from === 'page') {
        fillMoveSelect(job);
        $('moveRow').hidden = !$('moveRow').hidden;
        if (!$('moveRow').hidden) $('moveSel').focus();
        break;
      }
      openSheet(`<p class="sheet-title">Sposta in</p>` +
        ['', ...allCourseNames(await store.listJobs())].map(c => `<button type="button" class="sheet-item" data-move="${esc(c)}"${c === (job.course || '') ? ' aria-current="true"' : ''}>${esc(c || 'Senza corso')}</button>`).join(''), { id, keep: true });
      break;
    case 'edit':
      if (state.jobId !== id || state.view !== 'lecture') await openLecture(id);
      state.editing = true;
      $('editor').value = toEditable(await store.getJob(id));
      $('resetEdit').hidden = !job.edited;
      renderLecture();
      $('editor').focus();
      break;
    case 'resume':
      await store.updateJob(id, j => { j.status = 'queued'; j.runner = store.deviceId; j.error = null; j.retryAt = null; });
      runQueue();
      toast('Elaborazione ripresa');
      break;
    case 'delete': {
      const onDrive = !!(job._sync?.dataId || job.remote?.audioId);
      const msg = onDrive
        ? `Eliminare "${job.title}"? Testo e audio vanno nel cestino di Google Drive (recuperabili per 30 giorni).`
        : `Eliminare "${job.title}" da questo dispositivo?`;
      if (!confirm(msg)) return;
      if (onDrive && !drive.connected) {
        try { await drive.connect(); } catch (err) { toast(`Collega Drive per eliminare anche lì: ${err.message}`, 4000); return; }
      }
      if (state.runner?.id === job.id) state.runner.abort.abort();
      try { await sync.removeRemote(job); } catch (err) { toast(`Drive: ${err.message}`, 4000); return; }
      await store.removeJob(job.id);
      if (state.jobId === job.id) show('home');
      renderList();
      toast('Lezione eliminata');
      break;
    }
  }
}

// ---------- Menu della lezione ----------

function openSheet(html, { id, x, y, keep = false } = {}) {
  const sheet = $('sheet');
  sheet.innerHTML = html;
  sheet.dataset.id = id || '';
  sheet.hidden = false;
  $('sheetBackdrop').hidden = false;
  const desktop = x !== undefined;
  sheet.classList.toggle('popover', desktop);
  $('sheetBackdrop').classList.toggle('clear', desktop);
  if (desktop) {
    const r = sheet.getBoundingClientRect();
    sheet.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    sheet.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  } else if (!keep) {
    sheet.style.left = sheet.style.top = '';
  }
  if (!keep) sheet.querySelector('button')?.focus({ preventScroll: true });
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheetBackdrop').hidden = true;
}

async function openLectureMenu(id, pos = {}) {
  const job = await store.getJob(id);
  if (!job) return;
  const hasText = (job.chunks || []).some(c => c.raw) || !!job.edited;
  const canResume = ['error', 'paused', 'waiting'].includes(job.status);
  const items = [
    ['open', 'Apri'],
    ...(canResume ? [['resume', 'Riprendi elaborazione']] : []),
    ['rename', 'Rinomina'],
    ['move', 'Sposta in un altro corso'],
    ...(hasText ? [['edit', 'Modifica testo'], ['copy', 'Copia testo'], ['save', 'Salva .md'], ...(navigator.share ? [['share', 'Condividi']] : [])] : []),
    ['delete', 'Elimina'],
  ];
  if ('vibrate' in navigator && pos.x === undefined) navigator.vibrate?.(12);
  openSheet(`<p class="sheet-title">${esc(job.title)}</p>` +
    items.map(([a, label]) => `<button type="button" class="sheet-item${a === 'delete' ? ' danger' : ''}" data-act="${a}">${label}</button>`).join(''),
  { id, ...pos });
}

$('sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
$('sheet').addEventListener('click', async e => {
  const id = $('sheet').dataset.id;
  if (e.target.closest('[data-close]')) { closeSheet(); return; }
  const mv = e.target.closest('[data-move]');
  if (mv) {
    closeSheet();
    await moveLecture(id, mv.dataset.move);
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act !== 'rename' && act !== 'move') closeSheet();
  lectureAction(act, id, 'menu');
});
$('sheet').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('sheet').dataset.id;
  const v = $('sheetInput')?.value.trim();
  closeSheet();
  if (!v) return;
  await store.updateJob(id, j => { j.title = v; });
  if (state.jobId === id) $('lecTitle').textContent = v;
  refreshList();
  sync.run();
  toast('Lezione rinominata');
});

// Pressione prolungata (telefono), tasto destro e pulsante ⋯ (PC) sulle righe delle lezioni.
let pressTimer = null, pressStart = null, suppressClick = false;
function bindRowMenus(container) {
  container.addEventListener('pointerdown', e => {
    suppressClick = false; // nuovo gesto
    const row = e.target.closest('.row-btn');
    if (!row || e.pointerType === 'mouse') return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      suppressClick = true;
      openLectureMenu(row.dataset.id);
    }, 480);
  });
  const cancel = e => {
    if (!pressTimer) return;
    if (e.type === 'pointermove' && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) < 10) return;
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  container.addEventListener('pointermove', cancel);
  container.addEventListener('pointerup', cancel);
  container.addEventListener('pointercancel', cancel);
  container.addEventListener('contextmenu', e => {
    const row = e.target.closest('.row-btn');
    if (!row) return;
    e.preventDefault();
    if (suppressClick) return; // il menu è già aperto dalla pressione prolungata
    const touch = e.pointerType ? e.pointerType !== 'mouse' : !matchMedia('(pointer: fine)').matches;
    openLectureMenu(row.dataset.id, touch ? {} : { x: e.clientX, y: e.clientY });
  });
  container.addEventListener('click', e => {
    if (suppressClick) { e.stopImmediatePropagation(); e.preventDefault(); suppressClick = false; return; }
    const more = e.target.closest('.row-more');
    if (more) {
      e.stopImmediatePropagation();
      const r = more.getBoundingClientRect();
      openLectureMenu(more.dataset.id, { x: r.left - 160, y: r.bottom + 4 });
    }
  }, true);
}
bindRowMenus($('lectureList'));
bindRowMenus($('courseLectures'));

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$('saveEdit').addEventListener('click', async () => {
  const paragraphs = parseEditable($('editor').value);
  await store.updateJob(state.jobId, j => { j.edited = { paragraphs, at: Date.now() }; });
  state.editing = false;
  renderLecture();
  sync.run();
  toast('Modifiche salvate');
});
$('cancelEdit').addEventListener('click', () => { state.editing = false; renderLecture(); });
$('resetEdit').addEventListener('click', async () => {
  if (!confirm('Tornare alla trascrizione automatica? Le modifiche a mano andranno perse.')) return;
  await store.updateJob(state.jobId, j => { delete j.edited; });
  state.editing = false;
  renderLecture();
  sync.run();
});

// Scorciatoie da tastiera per il lettore (PC).
document.addEventListener('keydown', e => {
  if (state.view !== 'lecture' || state.editing) return;
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowLeft' || e.key === 'j') { e.preventDefault(); player.skip(e.shiftKey ? -30 : -5); }
  else if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); player.skip(e.shiftKey ? 30 : 5); }
  else if (e.key === ']') player.cycleRate(1);
  else if (e.key === '[') player.cycleRate(-1);
});

// ====================================================================
// Cartella sul PC (File System Access API, Chrome/Edge desktop)
// ====================================================================

async function writeToFolder(job, handle, interactive) {
  try {
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    const fh = await handle.getFileHandle(`${safeFileName(job.title)}.md`, { create: true });
    const w = await fh.createWritable();
    await w.write(toMarkdown(job));
    await w.close();
    return true;
  } catch (e) {
    console.warn(e);
    return false;
  }
}

async function autoSaveToFolder(job) {
  if (!canPickFolder || !store.device.get('folderAuto', false)) return;
  const handle = await store.kv.get('dirHandle');
  if (handle) await writeToFolder(job, handle, false);
}

// ====================================================================
// Sincronizzazione: indicatore e avvisi
// ====================================================================

function renderSyncState() {
  const b = $('syncBtn');
  const st = sync.state;
  b.hidden = !drive.configured;
  b.dataset.state = st;
  const labels = {
    off: 'Collega Google Drive', expired: 'Accesso a Drive scaduto: tocca per ricollegare',
    busy: 'Sincronizzazione in corso', ok: `Sincronizzato con Drive${drive.email ? ` (${drive.email})` : ''}`,
    error: `Errore di sincronizzazione: ${sync.lastError}`,
  };
  b.setAttribute('aria-label', labels[st]);
  b.title = labels[st];

  if (!settings.apiKey) notice('Per iniziare inserisci la chiave API Gemini nelle <button type="button" data-go="settings">impostazioni</button>.');
  else if (drive.configured && st === 'expired') notice('L\'accesso a Google Drive è scaduto. <button type="button" id="reconnect">Ricollega</button> per sincronizzare.');
  else notice('');
}

$('syncBtn').addEventListener('click', connectAndSync);
$('notice').addEventListener('click', e => { if (e.target.id === 'reconnect') connectAndSync(); });

async function connectAndSync() {
  try {
    if (!drive.connected) await drive.connect();
    await sync.run();
    if (sync.lastError) toast(`Drive: ${sync.lastError}`, 4000);
  } catch (e) { toast(e.message, 4000); }
  renderSyncState();
}

store.on('sync', () => { renderSyncState(); if (state.view === 'settings') renderDriveState(); });
store.on('job', job => {
  refreshList();
  if (job.id === state.jobId && !state.editing && state.view === 'lecture') {
    clearTimeout(renderLecture.t);
    renderLecture.t = setTimeout(() => renderLecture(), 150);
  }
});
store.on('removed', id => { refreshList(); if (id === state.jobId) show('home'); });
let uploadTimer;
store.on('upload', u => {
  state.uploads[u.id] = u;
  if (u.id === state.jobId && state.view === 'lecture') {
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => renderLecture(), 300);
  }
});
store.on('settings', ({ settings: s, fromRemote }) => {
  settings = s;
  if (fromRemote && state.view === 'settings' && !document.activeElement?.closest('#settingsForm')) renderSettings();
  renderSyncState();
  if (s.apiKey) runQueue();
});
drive.onChange(renderSyncState);

// ====================================================================
// Impostazioni
// ====================================================================

let settingsTimer;
function saveSetting(patch) {
  settings = store.saveSettings(patch);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => sync.run(), 1500);
}

function renderSettings() {
  settings = store.loadSettings();
  $('sKey').value = settings.apiKey;
  $('sKeyResult').textContent = '';
  $('sChunk').value = settings.chunkMin;
  $('sChunkOut').textContent = settings.chunkMin;
  $('sRevise').checked = settings.revise;
  $('sRelisten').checked = settings.relisten;
  $('sRelisten').disabled = !settings.revise;
  $('sTModel').value = settings.transcribeModel;
  $('sRModel').value = settings.reviseModel;
  $('sLang').value = settings.language;
  $('sTheme').value = store.device.get('theme', 'auto');
  $('sClient').value = store.device.get('clientId', '');
  $('sClientField').hidden = !!DRIVE_CLIENT_ID;
  renderDriveState();
  renderFolderState();
  renderStorage();
}

$('sKey').addEventListener('change', () => saveSetting({ apiKey: $('sKey').value.trim() }));
$('sKeyShow').addEventListener('click', () => {
  const k = $('sKey');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('sKeyShow').textContent = k.type === 'password' ? 'Mostra' : 'Nascondi';
});
$('sKeyTest').addEventListener('click', async () => {
  const key = $('sKey').value.trim();
  saveSetting({ apiKey: key });
  const out = $('sKeyResult');
  out.className = 'help result';
  out.textContent = 'Verifico…';
  try {
    const models = await new Gemini(key).listModels();
    const t = models.includes(settings.transcribeModel), r = models.includes(settings.reviseModel);
    out.classList.add(t && r ? 'ok' : 'bad');
    out.textContent = t && r
      ? 'Chiave valida, modelli disponibili.'
      : `Chiave valida, ma non trovo ${[!t && settings.transcribeModel, !r && settings.reviseModel].filter(Boolean).join(' e ')}. Modelli disponibili: ${models.filter(m => /gemini/.test(m)).slice(0, 12).join(', ')}…`;
  } catch (e) {
    out.classList.add('bad');
    out.textContent = explainError(e);
  }
});
$('sDiag').addEventListener('click', async () => {
  const out = $('sDiagOut');
  const btn = $('sDiag');
  if (!settings.apiKey) { out.hidden = false; out.textContent = 'Inserisci prima la chiave API.'; return; }
  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Provo le varianti della richiesta (circa un minuto)…';
  try {
    // Se c'è una lezione con l'audio su questo dispositivo, si prova anche il suo formato.
    let audio = null;
    for (const j of await store.listJobs()) { audio = await store.getAudio(j.id); if (audio) break; }
    const lines = [];
    const { strategy, results } = await diagnose(new Gemini(settings.apiKey), {
      audio, settings, onStep: label => { out.textContent = `${lines.join('\n')}\n… ${label}`.trim(); },
    });
    for (const r of results) lines.push(`${r.ok ? 'OK ' : 'NO '} ${r.label}${r.ok ? '' : `\n    ${r.error}`}`);
    if (strategy) {
      saveStrategy(strategy);
      lines.push('', `Variante scelta: ${describeStrategy(strategy)}`);
    } else lines.push('', 'Nessuna variante accettata: copia questo testo e mandalo a chi ti aiuta.');
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = explainError(e);
  } finally {
    btn.disabled = false;
  }
});
$('sDiagReset').addEventListener('click', () => {
  resetStrategy();
  $('sDiagOut').hidden = false;
  $('sDiagOut').textContent = 'Tornato alla variante predefinita.';
});

$('sChunk').addEventListener('input', () => { $('sChunkOut').textContent = $('sChunk').value; });
$('sChunk').addEventListener('change', () => saveSetting({ chunkMin: Number($('sChunk').value) }));
$('sRevise').addEventListener('change', () => { saveSetting({ revise: $('sRevise').checked }); $('sRelisten').disabled = !$('sRevise').checked; });
$('sRelisten').addEventListener('change', () => saveSetting({ relisten: $('sRelisten').checked }));
$('sTModel').addEventListener('change', () => saveSetting({ transcribeModel: $('sTModel').value.trim() }));
$('sRModel').addEventListener('change', () => saveSetting({ reviseModel: $('sRModel').value.trim() }));
$('sLang').addEventListener('change', () => saveSetting({ language: $('sLang').value.trim() }));
$('sTheme').addEventListener('change', () => { store.device.set('theme', $('sTheme').value); applyTheme(); });
$('sClient').addEventListener('change', () => {
  store.device.set('clientId', $('sClient').value.trim());
  drive.clientId = $('sClient').value.trim();
  renderDriveState(); renderSyncState();
});

function renderDriveState() {
  const el = $('sDriveState');
  if (!drive.configured) {
    el.innerHTML = 'Non configurato. <small>Serve l\'ID client OAuth qui sotto.</small>';
  } else if (drive.connected) {
    el.innerHTML = `Collegato${drive.email ? ` come <b>${esc(drive.email)}</b>` : ''}. <small>Cartella "Sbobina" nel tuo Drive.</small>`;
  } else if (drive.linked) {
    el.innerHTML = `Accesso scaduto${drive.email ? ` (${esc(drive.email)})` : ''}. <small>Ricollega per sincronizzare.</small>`;
  } else {
    el.innerHTML = 'Non collegato. <small>Le lezioni restano solo su questo dispositivo.</small>';
  }
  $('sDriveConnect').hidden = !drive.configured || drive.connected;
  $('sDriveConnect').textContent = drive.linked ? 'Ricollega Drive' : 'Collega Drive';
  $('sDriveDisconnect').hidden = !drive.linked;
}
$('sDriveConnect').addEventListener('click', async () => {
  await connectAndSync();
  renderDriveState();
});
$('sDriveDisconnect').addEventListener('click', () => {
  if (!confirm('Scollegare Google Drive da questo dispositivo? I file su Drive restano.')) return;
  drive.disconnect();
  renderDriveState();
});

async function renderFolderState() {
  $('sFolderSet').hidden = !canPickFolder;
  if (!canPickFolder) return;
  const handle = await store.kv.get('dirHandle');
  $('sFolderState').innerHTML = handle
    ? `I file .md vengono salvati in <b>${esc(handle.name)}</b>.`
    : 'Nessuna cartella scelta: "Salva .md" scarica il file nei Download.';
  $('sFolderPick').textContent = handle ? 'Cambia cartella' : 'Scegli cartella';
  $('sFolderAll').hidden = !handle;
  $('sFolderAuto').checked = store.device.get('folderAuto', false);
  $('sFolderAuto').disabled = !handle;
}
$('sFolderPick').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'sbobina', mode: 'readwrite' });
    await store.kv.set('dirHandle', handle);
    store.device.set('folderAuto', true);
    renderFolderState();
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
});
$('sFolderAuto').addEventListener('change', () => store.device.set('folderAuto', $('sFolderAuto').checked));
$('sFolderAll').addEventListener('click', async () => {
  const handle = await store.kv.get('dirHandle');
  if (!handle) return;
  const jobs = (await store.listJobs()).filter(j => j.chunks?.some(c => c.raw));
  let n = 0;
  for (const j of jobs) if (await writeToFolder(j, handle, n === 0)) n++;
  toast(`${n} ${n === 1 ? 'lezione salvata' : 'lezioni salvate'} in ${handle.name}`);
});

async function renderStorage() {
  const ids = await store.audioKeys();
  let bytes = 0, freeable = 0;
  const jobs = new Map((await store.listJobs()).map(j => [j.id, j]));
  for (const id of ids) {
    const b = await store.getAudio(id);
    bytes += b?.size || 0;
    const j = jobs.get(id);
    if (j?.remote?.audioId && j.status === 'done' && state.runner?.id !== id) freeable += b?.size || 0;
  }
  const mb = x => `${(x / 1048576).toFixed(0)} MB`;
  $('sStorage').innerHTML = ids.length
    ? `Audio salvati su questo dispositivo: <b>${mb(bytes)}</b> (${ids.length} ${ids.length === 1 ? 'lezione' : 'lezioni'}).`
    : 'Nessun audio salvato su questo dispositivo.';
  $('sFreeSpace').hidden = !freeable;
}
$('sFreeSpace').addEventListener('click', async () => {
  const jobs = await store.listJobs();
  let n = 0;
  for (const j of jobs) {
    if (j.remote?.audioId && j.status === 'done' && state.runner?.id !== j.id && await store.getAudio(j.id)) {
      await store.deleteAudio(j.id);
      await store.updateJob(j.id, x => { x.hasLocalAudio = false; }, { touch: false });
      n++;
    }
  }
  toast(`Liberato lo spazio di ${n} ${n === 1 ? 'lezione' : 'lezioni'}`);
  renderStorage();
});

// ====================================================================
// Avvio
// ====================================================================

async function start() {
  applyTheme();
  $('addHint').textContent = matchMedia('(pointer: fine)').matches
    ? 'Oppure trascina qui un file audio' : 'Oppure condividila dal Registratore';

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker non registrato', e));
    navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'inbox') checkInbox(); });
  }
  try { await navigator.storage?.persist?.(); } catch { /* facoltativo */ }

  // Le lezioni lasciate a metà su questo dispositivo ripartono da sole.
  for (const j of await store.listJobs()) {
    if (j.status === 'running' && j.runner === store.deviceId) await store.updateJob(j.id, x => { x.status = 'queued'; }, { touch: false });
  }

  await renderList();
  renderSyncState();
  history.replaceState({ v: 'home' }, '');

  const params = new URLSearchParams(location.search);
  if (params.has('share') || params.has('job')) history.replaceState({ v: 'home' }, '', location.pathname);
  const shared = await checkInbox();
  if (!shared && params.get('job')) openLecture(params.get('job'));
  else if (!shared && isWide()) show('home');

  runQueue();
  if (drive.connected) sync.run();
  scheduleWakeups();
  setInterval(() => {
    scheduleWakeups();
    if (document.visibilityState === 'visible' && drive.connected && !sync.running) sync.run();
    if (state.jobId) renderStatus();
  }, 60_000);
}

start();
