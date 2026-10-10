// Autoscroll that knows how long the song is.
//
// The song scrolls past in its length (from YouTube when known, otherwise an
// estimate from the number of lines, between 2 and 7 minutes), times the speed
// on the slider, at one steady speed: from its first line (the author's notes
// before the song are skipped, with a short glide) to its last. The line being
// played stays about a third of the way down the screen.
//
// (It used to give every line the same time, but lines aren't the same height,
// so the speed changed at almost every line.)
//
// Scrolling by hand while it plays is fine: it carries on from wherever you
// leave it.

export const DEFAULT_SECONDS_PER_LINE = 4;
const MIN_EST = 120;
const MAX_EST = 420;
export const READ_LINE = 0.36; // where the current line sits, as a fraction of the screen height

// Seconds the song probably lasts, from the rendered sheet's line weights.
export function estimateDuration(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  return Math.round(Math.min(MAX_EST, Math.max(MIN_EST, total * DEFAULT_SECONDS_PER_LINE)));
}

// Where the song starts and ends on the page (y, page coordinates): its first
// block after the author's notes, and the bottom of its last block.
export function measure(sheet) {
  const blocks = [...sheet.children];
  const top = sheet.getBoundingClientRect().top + scrollY;
  if (!blocks.length) return { start: top, end: top };
  const first = blocks.find(b => !b.classList.contains('pre')) || blocks[0];
  const last = blocks.findLast(b => !b.classList.contains('gap')) || blocks.at(-1);
  const start = first.getBoundingClientRect().top + scrollY;
  return { start, end: Math.max(start, last.getBoundingClientRect().bottom + scrollY) };
}

const clamp01 = x => Math.max(0, Math.min(1, x));

// fraction of the song (0..1) → y (page coordinate) of the line being played
export function yAt(map, f) {
  return map.start + clamp01(f) * (map.end - map.start);
}

// inverse: y → fraction
export function fractionAt(map, y) {
  return map.end > map.start ? clamp01((y - map.start) / (map.end - map.start)) : 0;
}

export class AutoScroll {
  // sheet: the rendered .sheet; duration: () => seconds; onChange(state)
  constructor({ sheet, duration, onChange, follow }) {
    this.sheet = sheet;
    this.duration = duration;
    this.onChange = onChange || (() => {});
    this.follow = follow || null; // () => fraction from a playing video, or null
    this.speed = 1;
    this.playing = false;
    this.t = 0; // seconds of song played
    this.raf = 0;
    this.map = null;
    this.hold = false;
    this.lastSet = null;
    this.idleTimer = 0;
    this.frame = this.frame.bind(this);
    this.onUser = this.onUser.bind(this);
    this.onScroll = this.onScroll.bind(this);
    this.onTouchEnd = this.onTouchEnd.bind(this);
    addEventListener('wheel', this.onUser, { passive: true });
    addEventListener('touchstart', this.onUser, { passive: true });
    addEventListener('touchend', this.onTouchEnd, { passive: true });
    addEventListener('keydown', this.onKey = e => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) this.onUser(); });
    addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => { this.map = null; });
    this.ro.observe(sheet);
  }

  get total() { return Math.max(10, this.duration() / this.speed); }
  get fraction() { return Math.min(1, this.t / Math.max(1, this.duration())); }
  get remaining() { return Math.max(0, (this.duration() - this.t) / this.speed); }

  state() {
    return { playing: this.playing, speed: this.speed, t: this.t, duration: this.duration(), fraction: this.fraction, remaining: this.remaining };
  }

  ensureMap() {
    if (!this.map) this.map = measure(this.sheet);
    return this.map;
  }

  // Where the window should be for the current song time.
  target() {
    const map = this.ensureMap();
    const y = yAt(map, this.fraction) - innerHeight * READ_LINE;
    const max = document.documentElement.scrollHeight - innerHeight;
    return Math.max(0, Math.min(max, y));
  }

  play() {
    if (this.playing) return;
    // start from what's on screen now
    this.syncFromScroll();
    if (this.fraction >= 0.999) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    this.pos = scrollY;
    this.raf = requestAnimationFrame(this.frame);
    this.onChange(this.state());
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.unshift();
    this.onChange(this.state());
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  setSpeed(x) {
    this.speed = Math.max(0.25, Math.min(3, x));
    this.onChange(this.state());
  }

  restart() {
    this.t = 0;
    this.unshift();
    scrollTo({ top: 0 });
    this.pos = 0;
    this.onChange(this.state());
  }

  frame(now) {
    if (!this.playing) return;
    // (capped so a frame after the app was in the background doesn't leap ahead)
    const dt = Math.min(0.3, (now - this.last) / 1000);
    this.last = now;
    if (!this.hold) {
      const f = this.follow?.();
      if (f !== null && f !== undefined) this.t = f * this.duration();
      else this.t += dt * this.speed;
      const want = this.target();
      // glide into place instead of jumping (e.g. right after pressing play)
      const gap = want - this.pos;
      this.pos += Math.abs(gap) > 2 ? gap * Math.min(1, dt * 4) : gap;
      this.place(this.pos);
      if (this.t >= this.duration() && scrollY >= document.documentElement.scrollHeight - innerHeight - 2) {
        this.playing = false;
        this.unshift();
        this.onChange({ ...this.state(), ended: true });
        return;
      }
    }
    if (now - (this.lastUi || 0) > 200) {
      this.lastUi = now;
      this.onChange(this.state());
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  // The page itself only scrolls by whole pixels (on a phone, a jump of two
  // or three of the screen's dots, which reads as a stutter at reading speed).
  // The sheet makes up the rest by shifting a fraction of a pixel, in whole
  // dots, so the text glides and stays sharp.
  place(pos) {
    const dots = devicePixelRatio || 1;
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const at = Math.min(max, Math.round(pos * dots) / dots);
    const whole = Math.floor(at + 1e-6);
    if (Math.abs(scrollY - whole) > 0.01) scrollTo(0, whole);
    this.lastSet = whole;
    const el = this.sheet;
    if (this.shifted !== el) {
      this.unshift();
      this.shifted = el;
      el.classList.add('autoscrolling'); // its own layer while it moves
    }
    el.style.transform = `translate3d(0, ${-(at - whole).toFixed(3)}px, 0)`;
  }

  unshift() {
    if (!this.shifted) return;
    this.shifted.style.transform = '';
    this.shifted.classList.remove('autoscrolling');
    this.shifted = null;
  }

  // A finger or wheel takes over; when it lets go, carry on from there.
  onUser() {
    if (!this.playing) return;
    this.unshift();
    this.hold = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.release(), 700);
  }

  onTouchEnd() {
    if (!this.playing) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.release(), 250);
  }

  onScroll() {
    if (!this.playing || !this.hold) return;
    // momentum scrolling: keep holding until it settles
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.release(), 220);
  }

  release() {
    this.hold = false;
    this.syncFromScroll();
    this.pos = scrollY;
    this.last = performance.now();
  }

  syncFromScroll() {
    const map = this.ensureMap();
    const atTop = scrollY < 4;
    this.t = atTop && this.t === 0 ? 0 : fractionAt(map, scrollY + innerHeight * READ_LINE) * this.duration();
    this.pos = scrollY;
  }

  invalidate() { this.map = null; }

  destroy() {
    this.pause();
    this.unshift();
    clearTimeout(this.idleTimer);
    removeEventListener('wheel', this.onUser);
    removeEventListener('touchstart', this.onUser);
    removeEventListener('touchend', this.onTouchEnd);
    removeEventListener('keydown', this.onKey);
    removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
  }
}

// Keeps the screen on while a song is open (where the browser allows it).
export class WakeLock {
  constructor() { this.lock = null; this.want = false; this.onVis = () => { if (this.want && document.visibilityState === 'visible') this.acquire(); }; }
  async acquire() {
    this.want = true;
    document.addEventListener('visibilitychange', this.onVis);
    try { if ('wakeLock' in navigator && !this.lock) { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => { this.lock = null; }); } } catch { /* not allowed now */ }
  }
  release() {
    this.want = false;
    document.removeEventListener('visibilitychange', this.onVis);
    try { this.lock?.release(); } catch { /* ignore */ }
    this.lock = null;
  }
}
