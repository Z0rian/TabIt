import { test, ok, near, eq, deepEq } from '../harness.js';
import { detectPitch, noteInfo, centsBetween, nearestString, PitchTracker } from '../../js/pitch.js';

// ---------- synthetic signals, seeded so every run sees the same "noise" ----------

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = rnd => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const cents = (f, ref) => 1200 * Math.log2(f / ref);
const shift = (f, c) => f * 2 ** (c / 1200);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };

const RATES = [44100, 48000];
// The open strings in standard tuning, A4, and the low D of drop D.
const NOTES = { E2: 82.41, A2: 110, D3: 146.83, G3: 196.0, B3: 246.94, E4: 329.63, A4: 440, D2: 73.42 };

function sine(freq, rate, { phase = 0, amp = 0.5, n = 4096 } = {}) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin(2 * Math.PI * freq * i / rate + phase);
  return b;
}

// Roughly a plucked string 0.3 s in: partials 1-6 with the 2nd louder than the
// fundamental (as on the low strings), higher partials dying away faster,
// slightly sharp partials (inharmonicity B, which stretches the period YIN sees
// by ~0.3 cents), random phases, RMS 0.3.
const GUITAR = [0.5, 1, 0.5, 0.35, 0.25, 0.15];
// What a phone mic makes of a low string: the fundamental 20 dB under the 2nd
// harmonic and little odd-harmonic energy. Plain YIN reads these an octave high.
const WEAK_FUNDAMENTAL = [0.1, 1, 0.1, 0.3, 0.05, 0.1];

function pluck(freq, rate, { amps = GUITAR, seed = 1, B = 3e-5, n = 4096, start = 0.3 } = {}) {
  const rnd = mulberry32(seed);
  const parts = amps.map((a, k) => ({
    a, f: (k + 1) * freq * Math.sqrt(1 + B * (k + 1) ** 2), phase: 2 * Math.PI * rnd(), decay: 1.5 / Math.sqrt(k + 1),
  }));
  const b = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = start + i / rate;
    let v = 0;
    for (const p of parts) v += p.a * Math.exp(-t / p.decay) * Math.sin(2 * Math.PI * p.f * t + p.phase);
    b[i] = v;
    sum += v * v;
  }
  const k = 0.3 / Math.sqrt(sum / n);
  return b.map(v => v * k);
}

// Adds white noise `db` below the signal's RMS.
function noisy(buf, db, seed) {
  const rnd = mulberry32(seed);
  const level = Math.sqrt(mean(Array.from(buf, v => v * v))) * 10 ** (-db / 20);
  return buf.map(v => v + level * gaussian(rnd));
}

function expectPitch(buf, rate, freq, tol, what) {
  const r = detectPitch(buf, rate);
  ok(r, `${what}: no pitch found`);
  near(cents(r.freq, freq), 0, tol, `${what}: cents off`);
  return r;
}

// ---------- detectPitch ----------

test('pure sines read within 1 cent', () => {
  for (const rate of RATES) {
    for (const [name, f] of Object.entries(NOTES)) {
      for (const phase of [0, 1, 2.5]) expectPitch(sine(f, rate, { phase }), rate, f, 1, `${name} sine at ${rate}`);
    }
  }
});

test('guitar-like tones read within 1 cent, in the right octave', () => {
  for (const rate of RATES) {
    for (const [name, f] of Object.entries(NOTES)) {
      for (let seed = 1; seed <= 3; seed++) expectPitch(pluck(f, rate, { seed }), rate, f, 1, `${name} pluck ${seed} at ${rate}`);
    }
  }
});

test('a weak fundamental under a strong 2nd harmonic is not read an octave high', () => {
  for (const rate of RATES) {
    for (const [name, f] of Object.entries(NOTES)) {
      for (let seed = 1; seed <= 3; seed++) {
        expectPitch(pluck(f, rate, { seed, amps: WEAK_FUNDAMENTAL }), rate, f, 1, `${name} weak fundamental ${seed} at ${rate}`);
      }
    }
  }
});

test('white noise at -20 dB: within 3 cents', () => {
  for (const rate of RATES) {
    for (const [name, f] of Object.entries(NOTES)) {
      for (let seed = 1; seed <= 3; seed++) {
        expectPitch(noisy(sine(f, rate, { phase: seed }), 20, seed), rate, f, 3, `${name} sine + noise ${seed} at ${rate}`);
        expectPitch(noisy(pluck(f, rate, { seed }), 20, 10 + seed), rate, f, 3, `${name} pluck + noise ${seed} at ${rate}`);
        expectPitch(noisy(pluck(f, rate, { seed, amps: WEAK_FUNDAMENTAL }), 20, 20 + seed), rate, f, 3, `${name} weak + noise ${seed} at ${rate}`);
      }
    }
  }
});

test('silence, quiet input and noise give null', () => {
  eq(detectPitch(new Float32Array(4096), 48000), null, 'silence');
  eq(detectPitch(sine(110, 48000, { amp: 0.01 }), 48000), null, 'below the noise gate');
  for (let seed = 1; seed <= 20; seed++) {
    const rnd = mulberry32(seed);
    const white = Float32Array.from({ length: 4096 }, () => 0.1 * gaussian(rnd));
    eq(detectPitch(white, seed % 2 ? 44100 : 48000), null, `white noise ${seed}`);
    let v = 0;
    const brown = Float32Array.from({ length: 4096 }, () => (v = 0.995 * v + 0.02 * gaussian(rnd)));
    eq(detectPitch(brown, 48000), null, `brown noise ${seed}`);
  }
  eq(detectPitch(new Float32Array(4096).fill(NaN), 48000), null, 'NaN');
  eq(detectPitch(new Float32Array(64), 48000), null, 'too short');
});

test('clarity and level are reported', () => {
  const clean = detectPitch(sine(110, 48000), 48000);
  near(clean.rms, 0.5 / Math.SQRT2, 0.005, 'rms');
  ok(clean.clarity > 0.99 && clean.clarity <= 1, `clean clarity ${clean.clarity}`);
  const rough = detectPitch(noisy(sine(110, 48000), 20, 3), 48000);
  ok(rough.clarity < clean.clarity && rough.clarity > 0.9, `noisy clarity ${rough.clarity}`);
  const offset = sine(110, 48000).map(v => v + 0.3);
  near(detectPitch(offset, 48000).rms, 0.5 / Math.SQRT2, 0.005, 'rms ignores a DC offset');
});

test('notes outside minFreq..maxFreq give null, not a wrong octave', () => {
  for (const rate of RATES) {
    for (const f of [1300, 1500, 2500]) eq(detectPitch(sine(f, rate), rate), null, `${f} Hz sine`);
    for (const f of [1500, 2500]) eq(detectPitch(pluck(f, rate), rate), null, `${f} Hz pluck`);
    for (const f of [50, 55]) eq(detectPitch(pluck(f, rate), rate), null, `${f} Hz pluck`);
    expectPitch(sine(1046.5, rate), rate, 1046.5, 1, 'C6, inside the range');
  }
});

test('options: range, threshold and gate', () => {
  const r = detectPitch(sine(1500, 48000), 48000, { maxFreq: 2000 });
  near(cents(r.freq, 1500), 0, 1, 'maxFreq raised');
  eq(detectPitch(sine(110, 48000), 48000, { minFreq: 150 }), null, 'minFreq above the note');
  eq(detectPitch(noisy(sine(110, 48000), 20, 3), 48000, { threshold: 0.005 }), null, 'strict threshold');
  eq(detectPitch(sine(110, 48000), 48000, { gate: 0.5 }), null, 'high gate');
});

test('other buffer sizes and sample rates', () => {
  for (const [n, rate] of [[2048, 44100], [2048, 48000], [8192, 48000], [4096, 96000], [8192, 96000]]) {
    expectPitch(pluck(82.41, rate, { n }), rate, 82.41, 1, `E2 in ${n} samples at ${rate}`);
    expectPitch(pluck(329.63, rate, { n }), rate, 329.63, 1, `E4 in ${n} samples at ${rate}`);
  }
});

test('detectPitch is cheap enough for every animation frame', () => {
  for (const rate of RATES) {
    const buf = pluck(82.41, rate);
    for (let i = 0; i < 20; i++) detectPitch(buf, rate);
    const runs = 200, t0 = performance.now();
    for (let i = 0; i < runs; i++) detectPitch(buf, rate);
    const ms = (performance.now() - t0) / runs;
    ok(ms < 6, `${ms.toFixed(3)} ms per 4096-sample call at ${rate}`);
  }
});

// ---------- notes ----------

test('centsBetween', () => {
  near(centsBetween(880, 440), 1200, 1e-9);
  near(centsBetween(440, 880), -1200, 1e-9);
  near(centsBetween(shift(110, 7), 110), 7, 1e-9);
});

test('noteInfo names notes with sharps and scientific octaves', () => {
  const cases = [[440, 69, 'A', 4], [82.41, 40, 'E', 2], [110, 45, 'A', 2], [246.94, 59, 'B', 3], [261.63, 60, 'C', 4],
    [277.18, 61, 'C#', 4], [466.16, 70, 'A#', 4], [73.42, 38, 'D', 2], [65.41, 36, 'C', 2], [1046.5, 84, 'C', 6]];
  for (const [f, midi, name, octave] of cases) {
    const n = noteInfo(f);
    deepEq([n.midi, n.name, n.octave], [midi, name, octave], `${f} Hz`);
    near(n.cents, 0, 0.5, `${f} Hz cents`);
  }
  near(noteInfo(shift(440, 30)).cents, 30, 1e-9);
  near(noteInfo(shift(440, -49.5)).cents, -49.5, 1e-9);
  const up = noteInfo(shift(440, 50.5));
  deepEq([up.name, up.octave], ['A#', 4], 'past halfway is the next note');
  near(up.cents, -49.5, 1e-9);
  for (let f = 30; f < 2000; f *= 1.0123) {
    const n = noteInfo(f);
    ok(n.cents >= -50 && n.cents < 50, `${f} Hz: cents ${n.cents}`);
    near(440 * 2 ** ((n.midi - 69) / 12 + n.cents / 1200), f, f * 1e-9, `${f} Hz round trip`);
  }
  for (const bad of [0, -5, NaN, undefined]) eq(noteInfo(bad), null, String(bad));
});

test('noteInfo with A4 = 432', () => {
  const a = noteInfo(432, 432);
  deepEq([a.midi, a.name, a.octave], [69, 'A', 4]);
  near(a.cents, 0, 1e-9);
  near(noteInfo(440, 432).cents, 31.77, 0.01);
  eq(noteInfo(108, 432).name, 'A');
});

test('nearestString finds the string and how far off it is', () => {
  const standard = [40, 45, 50, 55, 59, 64];
  const close = (freq, tuning, a4) => { const s = nearestString(freq, tuning, a4); return [s.index, s.midi, Math.round(s.cents)]; };
  deepEq(close(82.41, standard), [0, 40, 0]);
  deepEq(close(112, standard), [1, 45, 31]);
  deepEq(close(100, standard), [1, 45, -165], 'between E2 and A2, closer to A2');
  deepEq(close(90, standard), [0, 40, 153]);
  deepEq(close(329.63, standard), [5, 64, 0]);
  deepEq(close(240, standard), [4, 59, -49]);
  deepEq(close(73.42, [38, 45, 50, 55, 59, 64]), [0, 38, 0], 'drop D');
  deepEq(close(108, standard, 432), [1, 45, 0], 'A4 = 432');
  eq(nearestString(0, standard), null);
  eq(nearestString(110, []), null);
});

// ---------- PitchTracker ----------

const FPS = 60;
const reading = (freq, clarity = 0.97) => ({ freq, clarity, rms: 0.1 });

test('tracker smooths ±8 cents of frame-to-frame jitter', () => {
  for (const seed of [1, 2, 3]) {
    const rnd = mulberry32(seed), tr = new PitchTracker();
    const out = [];
    for (let k = 0; k < 5 * FPS; k++) {
      const s = tr.update(reading(shift(110, (2 * rnd() - 1) * 8)), k / FPS);
      if (k >= FPS) out.push(cents(s.freq, 110));
    }
    for (let w = 0; w < 4; w++) {
      const sd = std(out.slice(w * FPS, (w + 1) * FPS));
      ok(sd < 1.5, `seed ${seed}, second ${w + 2}: std ${sd.toFixed(2)} cents`);
    }
    // Over 4 s: with tau = 0.25 s even a perfect filter's 1 s mean wanders ~0.5 cents (1σ) on this input.
    near(mean(out), 0, 1, `seed ${seed}: mean error`);
  }
});

test('a small change glides in with a ~0.25 s time constant, at any frame rate', () => {
  const step = cents(112, 110);
  for (const fps of [60, 30]) {
    const tr = new PitchTracker();
    let t90 = null;
    for (let k = 0; k < 4 * fps; k++) {
      const t = k / fps, s = tr.update(reading(t < 2 ? 110 : 112), t);
      if (t < 2) continue;
      eq(s.name + s.octave, 'A2', 'stays A2');
      if (t <= 2.1 + 1e-9) ok(cents(s.freq, 110) < step / 2, `${fps} fps: no snap for a ${step.toFixed(1)} cent step`);
      if (t90 === null && cents(s.freq, 110) >= 0.9 * step) t90 = t - 2;
    }
    ok(t90 >= 0.45 && t90 <= 0.75, `${fps} fps: 90% after ${t90} s`);
  }
});

test('plucking another string snaps the needle over without sweeping', () => {
  const rnd = mulberry32(7), tr = new PitchTracker();
  const shown = [];
  let within = null, s;
  for (let k = 0; k < 3 * FPS; k++) {
    const t = k / FPS, f = t < 1.5 ? 82.41 : 110;
    s = tr.update(reading(shift(f, (2 * rnd() - 1) * 3)), t);
    if (s.active && shown[shown.length - 1] !== s.name + s.octave) shown.push(s.name + s.octave);
    if (t >= 1.5 && within === null && Math.abs(cents(s.freq, 110)) < 5) {
      within = t - 1.5;
      eq(s.stable, false, 'not stable right after the snap');
    }
  }
  ok(within !== null && within <= 0.15, `within 5 cents of A2 after ${within} s`);
  deepEq(shown, ['E2', 'A2'], 'notes shown');
  ok(s.stable, 'stable again once settled');
});

test('isolated octave errors (1 frame in 8) do not move the needle', () => {
  for (const ratio of [2, 0.5, 3, 1.5]) {
    const rnd = mulberry32(11), tr = new PitchTracker();
    let worst = 0;
    for (let k = 0; k < 4 * FPS; k++) {
      const f = shift(110, (2 * rnd() - 1) * 2);
      const s = tr.update(reading(k % 8 === 7 ? f * ratio : f), k / FPS);
      if (k < FPS) continue;
      worst = Math.max(worst, Math.abs(cents(s.freq, 110)));
      eq(s.name + s.octave, 'A2', `x${ratio}: note`);
      ok(s.stable, `x${ratio}: stays stable at frame ${k}`);
    }
    ok(worst < 1, `x${ratio}: worst deviation ${worst.toFixed(2)} cents`);
  }
});

test('stray readings inside the snap range do not twitch the needle', () => {
  const tr = new PitchTracker();
  let worst = 0;
  for (let k = 0; k < 4 * FPS; k++) {
    // a glitch every 10th frame, sometimes two in a row, 25-45 cents off
    const glitch = k % 10 === 9 || k % 40 === 0 ? (k % 20 < 10 ? 45 : -25) : 0;
    const s = tr.update(reading(shift(110, glitch)), k / FPS);
    if (k >= FPS) worst = Math.max(worst, Math.abs(cents(s.freq, 110)));
  }
  ok(worst < 0.5, `worst deviation ${worst.toFixed(2)} cents`);
});

test('a jump is followed once it holds for snapFrames readings and 70 ms', () => {
  const tr = new PitchTracker();
  let s;
  for (let k = 0; k < FPS; k++) s = tr.update(reading(110), k / FPS);
  // 50 ms of a new pitch: as long as a pluck's attack, not followed
  for (let k = 0; k <= 3; k++) s = tr.update(reading(220), 1 + k / FPS);
  eq(s.name + s.octave, 'A2', 'a jump lasting 50 ms is not followed');
  s = tr.update(reading(220), 1 + 5 / FPS);
  eq(s.name + s.octave, 'A3', 'one lasting 83 ms is');
  near(cents(s.freq, 220), 0, 0.01);
  // on a 120 Hz screen the same 70 ms applies, not the same number of frames
  const fast = new PitchTracker();
  for (let k = 0; k < 120; k++) fast.update(reading(110), k / 120);
  for (let k = 0; k < 6; k++) s = fast.update(reading(220), 1 + k / 120);
  eq(s.octave, 2, '6 frames at 120 Hz (42 ms) are still too short');
  const slow = new PitchTracker({ snapFrames: 8 });
  for (let k = 0; k < FPS; k++) slow.update(reading(110), k / FPS);
  for (let k = 0; k < 7; k++) s = slow.update(reading(220), 1 + k / FPS);
  eq(s.octave, 2, 'snapFrames is configurable');
});

test('a string ~50 cents off does not flicker between two names', () => {
  // The pitch wanders across the halfway point (+49..+52 cents over A2) with jitter on top.
  const rnd = mulberry32(3), tr = new PitchTracker();
  const names = new Set();
  let crossings = 0, side = 0;
  for (let k = 0; k < 6 * FPS; k++) {
    const t = k / FPS, c = 50.5 + 1.5 * Math.sin(Math.PI * t) + (2 * rnd() - 1);
    const s = tr.update(reading(shift(110, c)), t);
    if (!s.active) continue;
    names.add(s.name + s.octave);
    const above = cents(s.freq, 110) > 50 ? 1 : -1;
    if (side && above !== side) crossings++;
    side = above;
    ok(Math.abs(s.cents) <= 53, `cents ${s.cents} relative to the shown note`);
  }
  ok(crossings >= 4, `the smoothed pitch crossed the halfway point ${crossings} times`);
  eq(names.size, 1, `names shown: ${[...names]}`);
});

test('the name switches only 10 cents past the halfway point', () => {
  const tr = new PitchTracker();
  let t = 0, s;
  const hold = c => { for (let k = 0; k < 2 * FPS; k++, t += 1 / FPS) s = tr.update(reading(shift(110, c)), t); return [s.name + s.octave, Math.round(s.cents)]; };
  deepEq(hold(45), ['A2', 45]);
  deepEq(hold(57), ['A2', 57], 'inside the hysteresis band');
  deepEq(hold(65), ['A#2', -35], 'past it');
  deepEq(hold(45), ['A#2', -55], 'and back inside the band from above');
  deepEq(hold(30), ['A2', 30]);
});

test('holds the last reading through a dropout, then goes inactive', () => {
  const tr = new PitchTracker();
  let s;
  for (let k = 0; k < FPS; k++) s = tr.update(reading(110), k / FPS);
  ok(s.active && s.stable && s.inTune, 'settled on A2');
  const last = (FPS - 1) / FPS;
  for (let k = FPS; k < 3 * FPS; k++) {
    const t = k / FPS;
    s = tr.update(k % 2 ? null : reading(110, 0.5), t); // low-clarity readings count as silence
    if (t - last < 0.79) {
      ok(s.active, `active ${(t - last).toFixed(2)} s into the dropout`);
      eq(s.stable, false, 'not stable while holding');
      near(s.freq, 110, 1e-9);
    } else if (t - last > 0.81) {
      eq(s.active, false, `inactive ${(t - last).toFixed(2)} s into the dropout`);
      eq(s.freq, 0);
    }
  }
  s = tr.update(reading(220), 3);
  eq(s.active, false, 'a lone reading does not bring the needle back');
  s = tr.update(reading(220), 3 + 1 / FPS);
  eq(s.active, false, 'nor do two right away (a pluck starts with noise)');
  for (let k = 2; k <= 5; k++) s = tr.update(reading(220), 3 + k / FPS);
  ok(s.active && s.name + s.octave === 'A3', 'readings that agree for 70 ms do');
});

test('stable and inTune wait for the needle to settle', () => {
  const run = cents => {
    const tr = new PitchTracker(), states = [];
    for (let k = 0; k < FPS; k++) states.push(tr.update(reading(shift(196, cents)), k / FPS));
    return states;
  };
  const exact = run(0);
  ok(exact.slice(0, 15).every(s => !s.stable && !s.inTune), 'not stable in the first 0.25 s');
  ok(exact.slice(-20).every(s => s.stable && s.inTune), 'stable and in tune after');
  ok(run(-3).slice(-20).every(s => s.inTune), '3 cents flat is in tune');
  ok(run(10).slice(-20).every(s => s.stable && !s.inTune), '10 cents sharp is stable but not in tune');
});

test('tracker uses its a4 for names and cents', () => {
  const tr = new PitchTracker({ a4: 432 });
  let s;
  for (let k = 0; k < FPS; k++) s = tr.update(reading(432), k / FPS);
  deepEq([s.name, s.octave, s.midi], ['A', 4, 69]);
  near(s.cents, 0, 1e-6);
  ok(s.inTune);
  near(s.freq, 432, 1e-6);
});

test('reset clears the tracker', () => {
  const tr = new PitchTracker();
  for (let k = 0; k < FPS; k++) tr.update(reading(110), k / FPS);
  tr.reset();
  deepEq(tr.update(null, 1.1), { active: false, freq: 0, midi: null, name: '', octave: null, cents: 0, inTune: false, stable: false, clarity: 0 });
});

test('detector and tracker together: a noisy plucked A string reads steady', () => {
  const rate = 48000;
  const audio = noisy(pluck(110, rate, { n: 3 * rate, start: 0.05, amps: WEAK_FUNDAMENTAL }), 30, 5);
  const tr = new PitchTracker(), hop = rate / FPS, late = [];
  for (let end = 4096; end <= audio.length; end += hop) {
    const t = end / rate, s = tr.update(detectPitch(audio.subarray(end - 4096, end), rate), t);
    if (t < 0.6) continue;
    ok(s.active && s.name + s.octave === 'A2', `A2 at ${t.toFixed(2)} s`);
    ok(s.stable && s.inTune, `stable and in tune at ${t.toFixed(2)} s`);
    late.push(s.cents);
  }
  ok(std(late) < 0.3, `std ${std(late).toFixed(3)} cents`);
  near(mean(late), 0, 1, 'mean');
});
