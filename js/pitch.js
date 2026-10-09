// Pitch detection and tracking for the tuner. Pure functions and a class, no
// DOM or Web Audio, so the unit tests can drive them with synthetic signals.
//
// detectPitch() is YIN (de Cheveigné & Kawahara, 2002). Its difference function
// comes from an FFT cross-correlation, so a 4096-sample buffer costs two
// 4096-point FFTs instead of ~2.5M multiply-adds. PitchTracker turns the raw,
// jittery readings into a needle that holds still. Once per animation frame:
//   analyser.getFloatTimeDomainData(buf); // fftSize 4096
//   const state = tracker.update(detectPitch(buf, ctx.sampleRate), performance.now() / 1000);

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const mod12 = n => ((n % 12) + 12) % 12;

// ---------- notes ----------

export function centsBetween(f, ref) {
  return 1200 * Math.log2(f / ref);
}

// The nearest equal-tempered note; cents in [-50, 50). null unless freq > 0.
export function noteInfo(freq, a4 = 440) {
  if (!(freq > 0)) return null;
  const x = 69 + 12 * Math.log2(freq / a4);
  let midi = Math.round(x);
  let cents = (x - midi) * 100;
  if (cents >= 50) { midi++; cents -= 100; }
  return { midi, name: NAMES[mod12(midi)], octave: Math.floor(midi / 12) - 1, cents };
}

// Which string of a tuning (MIDI notes, e.g. [40, 45, 50, 55, 59, 64]) a pitch
// is closest to, and how many cents sharp (+) or flat (-) of it it is.
export function nearestString(freq, tuningMidi, a4 = 440) {
  if (!(freq > 0) || !tuningMidi || !tuningMidi.length) return null;
  const x = 6900 + centsBetween(freq, a4);
  let best = null;
  tuningMidi.forEach((midi, index) => {
    const cents = x - midi * 100;
    if (!best || Math.abs(cents) < Math.abs(best.cents)) best = { index, midi, cents };
  });
  return best;
}

// ---------- detection ----------

const MAX_WINDOW = 3072; // integration window: 64 ms at 48 kHz, five periods of low E
const OCTAVE_RATIO = 0.5; // a dip at 2 or 3 times the lag this much deeper means the lag was a harmonic
const OCTAVE_MARGIN = 0.01;
const FIT_RISE = 0.15; // fit the period over the part of the dip this close to its floor
const FIT_SPAN = 48; // ...but no wider than period / FIT_SPAN either side: the dip isn't quite symmetric

const plans = new Map();
const scratch = { q: new Float64Array(0), d: new Float64Array(0), dp: new Float64Array(0) };

// YIN on the newest samples of buf. Returns { freq, clarity, rms } or null when
// the signal is below the gate, has no clear period, or is outside
// minFreq..maxFreq. clarity = 1 - d'(period), 0..1. buf needs at least
// 2·sampleRate/minFreq samples; 4096 at 44.1/48 kHz gives the full 3072-sample window.
export function detectPitch(buf, sampleRate, { minFreq = 60, maxFreq = 1100, threshold = 0.12, gate = 0.008 } = {}) {
  const n = buf.length;
  const maxLag = Math.min(Math.ceil(sampleRate / minFreq), (n - 2) >> 1);
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  if (!(maxLag > minLag + 2)) return null;
  const lastLag = maxLag + 1; // one past the range, for the fit
  const win = Math.min(MAX_WINDOW, n - lastLag);
  const rms = differences(buf, n - win - lastLag, win, lastLag);
  if (!(rms >= gate)) return null;
  const { d, dp } = scratch;
  let i = firstDip(dp, minLag, maxLag, threshold);
  if (i < 0) return null;
  i = fundamental(dp, i, minLag, maxLag);
  if (aboveRange(dp, i, minLag, threshold)) return null;
  return { freq: sampleRate / vertex(d, dp, i, lastLag), clarity: 1 - floorOf(dp, i), rms };
}

// Fills scratch.d with the difference function d(τ) = Σ (x[j] - x[j+τ])² over a
// fixed window, and scratch.dp with its cumulative mean normalized form d'(τ).
// Uses d(τ) = e(0) + e(τ) - 2·r(τ), where e are window energies and r is the
// cross-correlation of the window with the whole segment, done in one complex FFT
// (window as the real part, segment as the imaginary part) and one inverse.
// Returns the segment's RMS (DC removed).
function differences(buf, start, win, lastLag) {
  const size = win + lastLag;
  const p = plan(size);
  const { re, im, n } = p;
  const q = grow('q', size + 1), d = grow('d', lastLag + 1), dp = grow('dp', lastLag + 1);
  let sum = 0, sum2 = 0;
  for (let j = 0; j < size; j++) {
    const v = buf[start + j];
    re[j] = j < win ? v : 0;
    im[j] = v;
    sum += v;
    sum2 += v * v;
    q[j + 1] = sum2;
  }
  re.fill(0, size);
  im.fill(0, size);
  fft(p);
  // Split Z = A + iB into the two real-signal spectra and form conj(A)·B,
  // stored conjugated so the forward FFT acts as the inverse.
  for (let k = 0; k <= n >> 1; k++) {
    const j = (n - k) & (n - 1);
    const zr = re[k], zi = im[k], wr = re[j], wi = im[j];
    const ar = (zr + wr) / 2, ai = (zi - wi) / 2, br = (zi + wi) / 2, bi = (wr - zr) / 2;
    const pr = ar * br + ai * bi, pi = ar * bi - ai * br;
    re[k] = pr; im[k] = -pi;
    re[j] = pr; im[j] = pi;
  }
  fft(p);
  const e0 = q[win];
  let running = 0;
  d[0] = 0;
  dp[0] = 1;
  for (let tau = 1; tau <= lastLag; tau++) {
    const v = Math.max(0, e0 + q[tau + win] - q[tau] - 2 * re[tau] / n);
    d[tau] = v;
    running += v;
    dp[tau] = running > 0 ? v * tau / running : 1;
  }
  const mean = sum / size;
  return Math.sqrt(Math.max(0, sum2 / size - mean * mean));
}

// The bottom of the first dip of d' below the threshold, or -1.
function firstDip(dp, minLag, maxLag, threshold) {
  let i = minLag;
  while (i <= maxLag && dp[i] >= threshold) i++;
  if (i > maxLag) return -1;
  let best = i;
  for (; i <= maxLag && dp[i] < threshold; i++) if (dp[i] < dp[best]) best = i;
  // A dip that keeps falling past either end of the range is a note outside it.
  if (best === minLag && dp[minLag - 1] < dp[minLag]) return -1;
  if (best === maxLag && dp[maxLag + 1] < dp[maxLag]) return -1;
  return best;
}

// YIN's first dip can be the 2nd or 3rd harmonic when the fundamental is weak
// (low strings through a phone mic). A clearly deeper dip at 2x or 3x the lag
// means the real period is that long.
function fundamental(dp, i, minLag, maxLag) {
  for (let round = 0; round < 3; round++) {
    const v = floorOf(dp, i);
    let best = -1, bestV = v;
    for (let m = 2; m <= 3; m++) {
      const c = m * i;
      if (c + m > maxLag) break;
      let j = c - m;
      for (let k = j + 1; k <= c + m; k++) if (dp[k] < dp[j]) j = k;
      const vj = floorOf(dp, j);
      if (vj < OCTAVE_RATIO * v && v - vj > OCTAVE_MARGIN && vj < bestV) { best = j; bestV = vj; }
    }
    if (best < 0) break;
    i = best;
    while (i > minLag && dp[i - 1] < dp[i]) i--;
    while (i < maxLag && dp[i + 1] < dp[i]) i++;
  }
  return i;
}

// A note above maxFreq leaves its first dip inside the range at 2 or 3 times its
// period. Report nothing rather than a note an octave or more too low.
function aboveRange(dp, i, minLag, threshold) {
  const v = floorOf(dp, i);
  for (let m = 2; m <= 3; m++) {
    const c = Math.round(i / m);
    if (c >= minLag || c < 2) continue;
    let j = c - 1;
    if (dp[c] < dp[j]) j = c;
    if (dp[c + 1] < dp[j]) j = c + 1;
    const vj = floorOf(dp, j);
    if (vj < threshold && !(v < OCTAVE_RATIO * vj && vj - v > OCTAVE_MARGIN)) return true;
  }
  return false;
}

// The value at the bottom of a parabola through d' around lag i, so dips can be
// compared without the sampling grid favouring one. On a slope it's just d'(i).
function floorOf(dp, i) {
  const a = dp[i - 1], b = dp[i], c = dp[i + 1];
  if (b > a || b > c) return b;
  const den = a - 2 * b + c;
  return den > 0 ? Math.max(0, b - (a - c) * (a - c) / (8 * den)) : b;
}

// The period to a fraction of a sample: a least-squares parabola through the
// bottom of the dip in d. Low notes have dips dozens of samples wide whose floor
// is rough with noise, where the usual three-point fit wanders by a sample or more.
function vertex(d, dp, i, lastLag) {
  const top = dp[i] + FIT_RISE;
  const most = Math.min(i - 1, lastLag - i, Math.max(1, Math.round(i / FIT_SPAN)));
  let h = 1;
  while (h < most && dp[i - h - 1] <= top && dp[i + h + 1] <= top) h++;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let k = -h; k <= h; k++) {
    const y = d[i + k];
    s0 += y;
    s1 += k * y;
    s2 += k * k * y;
  }
  const n0 = 2 * h + 1, n2 = h * (h + 1) * n0 / 3, n4 = n2 * (3 * h * h + 3 * h - 1) / 5;
  const c = (n0 * s2 - n2 * s0) / (n0 * n4 - n2 * n2);
  if (!(c > 0)) return i;
  return i + Math.max(-h, Math.min(h, -s1 / n2 / (2 * c)));
}

// ---------- FFT ----------

function grow(name, len) {
  if (scratch[name].length < len) scratch[name] = new Float64Array(len);
  return scratch[name];
}

// Twiddles, bit reversal and work buffers for the smallest power of two >= size.
function plan(size) {
  let n = 2;
  while (n < size) n <<= 1;
  let p = plans.get(n);
  if (p) return p;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / n);
    sin[i] = -Math.sin(2 * Math.PI * i / n);
  }
  p = { n, rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  plans.set(n, p);
  return p;
}

// In-place iterative radix-2 forward FFT of p.re + i·p.im.
function fft({ n, rev, cos, sin, re, im }) {
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = s + k, b = a + half;
        const xr = re[b] * cos[w] - im[b] * sin[w];
        const xi = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// ---------- tracking ----------

const MIN_CLARITY = 0.8; // weaker readings count as silence
const MEDIAN = 5; // accepted readings in the outlier median
const OUTLIER = 15; // cents: a reading this far from the median is replaced by it
const START_FRAMES = 2; // agreeing readings before the needle appears, so a click doesn't show a note
const START_TIME = 0.07; // seconds those readings must span (a new note, or a jump to another string)
const AGREE = 30; // cents: consecutive readings of a new note must agree this well
const HYSTERESIS = 60; // cents from the shown note before its name changes
const SETTLE = 20; // cents: a median this close to the needle counts as settled
const STABLE_TIME = 0.3; // seconds settled before the reading is stable
const STALE = 0.1; // seconds without an accepted reading before it stops being stable
const IN_TUNE = 4; // cents

const INACTIVE = { active: false, freq: 0, midi: null, name: '', octave: null, cents: 0, inTune: false, stable: false, clarity: 0 };

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

// Smooths detectPitch() results for display. Works in cents. Readings within
// snapCents of the needle go through a median-based outlier check and a one-pole
// low-pass with time constant tau; readings further away (octave errors, a new
// string) are ignored until snapFrames of them in a row agree, then the needle
// jumps there.
export class PitchTracker {
  constructor({ tau = 0.25, a4 = 440, hold = 0.8, snapCents = 60, snapFrames = 3 } = {}) {
    Object.assign(this, { tau, a4, hold, snapCents, snapFrames });
    this.reset();
  }

  reset() {
    this.y = null; // smoothed pitch, cents above MIDI note 0 at A = 440
    this.recent = []; // last accepted readings
    this.run = []; // consecutive readings far from y
    this.note = null; // MIDI note on display
    this.seen = 0; // time of the last accepted reading
    this.settled = 0; // time the median last strayed more than SETTLE from y
    this.gap = false; // a dropout since the last accepted reading
    this.clarity = 0;
  }

  // detection: a detectPitch() result or null; t: monotonic time in seconds.
  update(detection, t) {
    if (this.y !== null && t - this.seen > this.hold) this.reset();
    if (!detection || !(detection.freq > 0) || !(detection.clarity >= MIN_CLARITY)) {
      this.run.length = 0;
      this.gap = true;
    } else {
      const x = 6900 + centsBetween(detection.freq, 440);
      if (this.y !== null && Math.abs(x - this.y) <= this.snapCents) this.accept(x, t, detection.clarity);
      else this.consider(x, t, detection.clarity);
    }
    return this.y === null ? { ...INACTIVE } : this.state(t);
  }

  accept(x, t, clarity) {
    this.run.length = 0;
    this.recent.push(x);
    if (this.recent.length > MEDIAN) this.recent.shift();
    const m = median(this.recent);
    const input = Math.abs(x - m) <= OUTLIER ? x : m;
    this.y += (input - this.y) * (1 - Math.exp(-Math.max(0, t - this.seen) / this.tau));
    if (Math.abs(m - this.y) > SETTLE) this.settled = t;
    this.seen = t;
    this.gap = false;
    this.clarity = clarity;
    this.pickNote();
  }

  // A reading far from the needle only counts once a few in a row agree; then
  // it's a new string and the needle jumps there instead of sweeping the dial.
  consider(x, t, clarity) {
    const run = this.run;
    if (run.length && Math.abs(x - run[run.length - 1]) > AGREE) { run.length = 0; this.runStart = t; }
    if (!run.length) this.runStart = t;
    run.push(x);
    if (run.length < (this.y === null ? START_FRAMES : this.snapFrames)) return;
    // A pluck's first few dozen milliseconds are noise; so is a window still
    // half full of silence. A new note has to hold for a moment, whatever the
    // frame rate (a 120 Hz iPad would otherwise decide twice as fast).
    if (t - this.runStart < START_TIME) return;
    this.y = median(run);
    this.recent = run.slice(-MEDIAN);
    this.run = [];
    this.note = null;
    this.seen = this.settled = t;
    this.gap = false;
    this.clarity = clarity;
    this.pickNote();
  }

  // The name only changes once the pitch is well past the halfway point to the
  // next note, so a string 50 cents off doesn't flicker between two names.
  pickNote() {
    const z = this.y - centsBetween(this.a4, 440);
    if (this.note === null || Math.abs(z - this.note * 100) > HYSTERESIS) this.note = Math.round(z / 100);
  }

  // stable: settled for STABLE_TIME with no dropout since. An odd rejected
  // reading (an octave error) doesn't count against it, a run of them does.
  state(t) {
    const z = this.y - centsBetween(this.a4, 440);
    const cents = Math.max(-HYSTERESIS, Math.min(HYSTERESIS, z - this.note * 100));
    const stable = !this.gap && t - this.seen <= STALE && t - this.settled >= STABLE_TIME;
    return {
      active: true,
      freq: 440 * 2 ** ((this.y - 6900) / 1200),
      midi: this.note,
      name: NAMES[mod12(this.note)],
      octave: Math.floor(this.note / 12) - 1,
      cents,
      inTune: stable && Math.abs(cents) <= IN_TUNE,
      stable,
      clarity: this.clarity,
    };
  }
}
