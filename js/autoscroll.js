// Autoscroll that knows how long the song is.
//
// The whole sheet scrolls past in the song's length (from YouTube when known,
// otherwise an estimate from the number of lines, between 2 and 7 minutes), at
// the speed set on the slider. It's paced by lines, not pixels: a section
// title or a blank line takes almost no time, a tab staff takes a few lines'
// worth, the author's notes before the song start don't hold it up. The line
// being played stays about a third of the way down the screen.
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

// The sheet's blocks as (weight, top, height) in page coordinates.
export function measure(sheet) {
  const top0 = sheet.getBoundingClientRect().top + scrollY;
  const out = [];
  for (const b of sheet.children) {
    const r = b.getBoundingClientRect();
    out.push({ w: +b.dataset.w || 0, y: r.top + scrollY - top0, h: r.height });
  }
  return { top: top0, blocks: out, total: out.reduce((a, b) => a + b.w, 0) };
}

// fraction of the song (0..1) → y (page coordinate) of the line being played
export function yAt(map, f) {
  if (!map.blocks.length || map.total <= 0) return map.top;
  let target = Math.max(0, Math.min(1, f)) * map.total;
  for (const b of map.blocks) {
    if (target <= b.w) return map.top + b.y + (b.w ? (target / b.w) * b.h : 0);
    target -= b.w;
  }
  const last = map.blocks.at(-1);
  return map.top + last.y + last.h;
}

// inverse: y → fraction
export function fractionAt(map, y) {
  if (!map.blocks.length || map.total <= 0) return 0;
  const rel = y - map.top;
  let acc = 0;
  for (const b of map.blocks) {
    if (rel < b.y + b.h) {
      const inside = b.h ? Math.max(0, Math.min(1, (rel - b.y) / b.h)) : 0;
      return Math.max(0, Math.min(1, (acc + inside * b.w) / map.total));
    }
    acc += b.w;
  }
  return 1;
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
    this.onChange(this.state());
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  setSpeed(x) {
    this.speed = Math.max(0.25, Math.min(3, x));
    this.onChange(this.state());
  }

  restart() {
    this.t = 0;
    scrollTo({ top: 0 });
    this.pos = 0;
    this.onChange(this.state());
  }

  frame(now) {
    if (!this.playing) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.hold) {
      const f = this.follow?.();
      if (f !== null && f !== undefined) this.t = f * this.duration();
      else this.t += dt * this.speed;
      const want = this.target();
      // glide into place instead of jumping (e.g. right after pressing play)
      const gap = want - this.pos;
      this.pos += Math.abs(gap) > 2 ? gap * Math.min(1, dt * 4) : gap;
      this.lastSet = Math.round(this.pos);
      if (Math.abs(scrollY - this.pos) >= 0.5) scrollTo(0, this.pos);
      if (this.t >= this.duration() && scrollY >= document.documentElement.scrollHeight - innerHeight - 2) {
        this.playing = false;
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

  // A finger or wheel takes over; when it lets go, carry on from there.
  onUser() {
    if (!this.playing) return;
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
