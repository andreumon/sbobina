// Lettore audio della lezione: barra di scorrimento con i punti da verificare,
// play/pausa, ±5 secondi, velocità, comandi dalla schermata di blocco del telefono.
import { fmtTime } from './text.js';
import { device } from './store.js';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export class Player {
  constructor(root) {
    this.root = root;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.url = null;
    this.duration = 0;
    this.loader = null; // funzione che restituisce il Blob quando serve
    this.listeners = new Set();
    this.$ = sel => root.querySelector(sel);
    this.seekEl = this.$('[data-p=seek]');
    this.curEl = this.$('[data-p=cur]');
    this.durEl = this.$('[data-p=dur]');
    this.playEl = this.$('[data-p=play]');
    this.rateEl = this.$('[data-p=rate]');
    this.ticksEl = this.$('[data-p=ticks]');
    this.msgEl = this.$('[data-p=msg]');
    this.dragging = false;

    this.setRate(device.get('rate', 1));
    this.playEl.addEventListener('click', () => this.toggle());
    this.$('[data-p=back]').addEventListener('click', () => this.skip(-5));
    this.$('[data-p=fwd]').addEventListener('click', () => this.skip(5));
    this.rateEl.addEventListener('click', () => this.cycleRate());
    this.seekEl.addEventListener('input', () => {
      this.dragging = true;
      const t = (this.seekEl.value / 1000) * this.duration;
      this.curEl.textContent = fmtTime(t, this.duration >= 3600);
      this.paintFill();
    });
    this.seekEl.addEventListener('change', async () => {
      this.dragging = false;
      await this.seek((this.seekEl.value / 1000) * this.duration, false);
    });

    const a = this.audio;
    a.addEventListener('timeupdate', () => this.tick());
    a.addEventListener('play', () => this.paintPlay());
    a.addEventListener('pause', () => this.paintPlay());
    a.addEventListener('ended', () => this.paintPlay());
    a.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(a.duration) && a.duration > 0) this.setDuration(a.duration);
    });

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      const set = (k, fn) => { try { ms.setActionHandler(k, fn); } catch { /* non supportato */ } };
      set('play', () => this.play());
      set('pause', () => this.audio.pause());
      set('seekbackward', () => this.skip(-5));
      set('seekforward', () => this.skip(5));
      set('seekto', d => this.seek(d.seekTime));
    }
  }

  /** Prepara il lettore per una lezione. L'audio viene caricato solo al primo play o salto. */
  prepare({ id, title, course, duration, loader }) {
    this.unload();
    this.id = id;
    this.title = title;
    this.course = course;
    this.loader = loader;
    this.setDuration(duration || 0);
    this.message('');
    this.paintPlay();
  }

  unload() {
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.loading = null;
  }

  get ready() { return !!this.url; }

  async ensureLoaded() {
    if (this.url) return true;
    if (!this.loader) return false;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const blob = await this.loader(p => this.message(`Recupero l'audio da Drive… ${Math.round(p * 100)}%`));
          if (!blob) { this.message('Audio non disponibile su questo dispositivo.'); return false; }
          this.url = URL.createObjectURL(blob);
          this.audio.src = this.url;
          this.audio.playbackRate = this.rate;
          await new Promise(res => {
            if (this.audio.readyState >= 1) return res();
            this.audio.addEventListener('loadedmetadata', res, { once: true });
            this.audio.addEventListener('error', res, { once: true });
          });
          this.message('');
          if ('mediaSession' in navigator && window.MediaMetadata) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: this.title, artist: this.course || 'Sbobina', album: 'Sbobina' });
          }
          return true;
        } catch (e) {
          this.message(e.message || 'Audio non disponibile.');
          return false;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  async play() {
    if (!(await this.ensureLoaded())) return;
    this.audio.playbackRate = this.rate;
    try { await this.audio.play(); } catch { /* bloccato dal browser */ }
  }

  async toggle() {
    if (this.ready && !this.audio.paused) this.audio.pause(); else await this.play();
  }

  async seek(t, autoplay = true) {
    if (!(await this.ensureLoaded())) return;
    this.audio.currentTime = Math.max(0, Math.min(this.duration || this.audio.duration || 0, t));
    this.tick();
    if (autoplay && this.audio.paused) await this.play();
  }

  async skip(d) {
    if (!(await this.ensureLoaded())) return;
    await this.seek(this.audio.currentTime + d, false);
  }

  setRate(r) {
    this.rate = RATES.includes(r) ? r : 1;
    this.audio.playbackRate = this.rate;
    this.rateEl.textContent = `${String(this.rate).replace('.', ',')}×`;
    this.rateEl.setAttribute('aria-label', `Velocità ${this.rateEl.textContent}`);
    device.set('rate', this.rate);
  }

  cycleRate(dir = 1) {
    const i = RATES.indexOf(this.rate);
    this.setRate(RATES[(i + dir + RATES.length) % RATES.length]);
  }

  setDuration(d) {
    this.duration = d || 0;
    this.durEl.textContent = fmtTime(this.duration, this.duration >= 3600);
    this.tick();
    this.renderMarks();
  }

  /** marks: [{t, kind:'uncertain'}] mostrati come tacche sulla barra. */
  setMarks(marks) { this.marks = marks || []; this.renderMarks(); }

  renderMarks() {
    this.ticksEl.innerHTML = '';
    if (!this.duration) return;
    for (const m of this.marks || []) {
      const s = document.createElement('span');
      s.className = `tick ${m.kind || ''}`;
      s.style.left = `${(m.t / this.duration) * 100}%`;
      this.ticksEl.appendChild(s);
    }
  }

  get currentTime() { return this.ready ? this.audio.currentTime : 0; }

  tick() {
    const t = this.currentTime;
    if (!this.dragging) {
      this.seekEl.value = this.duration ? Math.round((t / this.duration) * 1000) : 0;
      this.curEl.textContent = fmtTime(t, this.duration >= 3600);
      this.paintFill();
    }
    this.listeners.forEach(fn => fn(t));
  }

  paintFill() {
    this.seekEl.style.setProperty('--fill', `${this.seekEl.value / 10}%`);
  }

  paintPlay() {
    const playing = this.ready && !this.audio.paused && !this.audio.ended;
    this.playEl.dataset.state = playing ? 'pause' : 'play';
    this.playEl.setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
  }

  message(text) {
    this.msgEl.textContent = text;
    this.msgEl.hidden = !text;
  }

  onTime(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
