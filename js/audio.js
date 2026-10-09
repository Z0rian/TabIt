// A plucked-string synth (Karplus-Strong) so a chord diagram can be heard.
// One shared AudioContext, created on first use; every call is a quiet no-op
// when Web Audio is missing or blocked, so callers never need a try/catch.

const STANDARD = [40, 45, 50, 55, 59, 64];
const SECONDS = 3; // rendered per note; longer notes are cut to this
const buffers = new Map(); // midi -> AudioBuffer, for the shared context's sample rate
let ctx = null;
let input = null; // master gain, into a compressor so a full strum can't clip

function context() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    const c = new AC();
    const gain = c.createGain();
    gain.gain.value = 0.8;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    gain.connect(comp);
    comp.connect(c.destination);
    ctx = c;
    input = gain;
  } catch {
    ctx = null;
  }
  return ctx;
}

function wake(c) {
  if (c.state === 'running') return;
  try {
    const p = c.resume();
    if (p && p.catch) p.catch(() => {});
  } catch { /* stays suspended until the next gesture */ }
}

// Call from a tap or click: iOS only lets audio start inside a user gesture,
// and wants a sound started there too (a one-sample silent buffer will do).
export function unlockAudio() {
  const c = context();
  if (!c) return;
  wake(c);
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, c.sampleRate);
    src.connect(c.destination);
    src.start(0);
  } catch { /* nothing to unlock */ }
}

// One note, by MIDI number (60 = middle C).
export function pluck(midi, { duration = 2.5, volume = 0.7 } = {}) {
  const c = context();
  if (!c || !Number.isFinite(midi)) return;
  wake(c);
  try {
    play(c, midi, c.currentTime + 0.01, duration, volume);
  } catch { /* a failed note shouldn't break the page */ }
}

// The audio clock (seconds), for scheduling strokes ahead; 0 without Web Audio.
export const audioTime = () => (context()?.currentTime ?? 0);
export const hasAudio = () => !!context();

// Strums a voicing ({ frets }, -1 = muted): 'down' plays low string to high,
// 'up' the top four strings back down. `at` is a time on the audio clock;
// `short` damps the strings straight away (a muted stroke).
export function strum(voicing, { tuning = STANDARD, direction = 'down', spread = 0.028, volume = 0.6, at = 0, short = false } = {}) {
  const c = context();
  if (!c || !Array.isArray(voicing?.frets)) return;
  wake(c);
  let notes = [];
  voicing.frets.forEach((f, s) => { if (f >= 0 && Number.isFinite(tuning[s])) notes.push(tuning[s] + f); });
  if (direction === 'up') notes = notes.slice(-4).reverse();
  // later strings in a stroke are a touch softer, and an upstroke lighter overall
  const level = volume * (direction === 'up' ? 0.8 : 1);
  try {
    const t0 = Math.max(c.currentTime + 0.02, at);
    notes.forEach((m, i) => play(c, m, t0 + i * Math.max(0, spread), short ? 0.07 : 2.5, level * (1 - i * 0.04)));
  } catch { /* as above */ }
}

function play(c, midi, at, duration, volume) {
  const src = c.createBufferSource();
  src.buffer = stringBuffer(c, Math.round(midi));
  const gain = c.createGain();
  const end = at + Math.min(Math.max(duration, 0.05), SECONDS);
  const v = Math.max(0, Math.min(1, volume));
  // a 3 ms ramp in and a short fade out, so neither end clicks
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(v, at + 0.003);
  gain.gain.setTargetAtTime(0, Math.max(at + 0.003, end - 0.12), 0.04);
  src.connect(gain);
  gain.connect(input);
  src.start(at);
  src.stop(end + 0.05);
}

function stringBuffer(c, midi) {
  let b = buffers.get(midi);
  if (b) return b;
  const data = karplusStrong(midi, c.sampleRate, SECONDS);
  b = c.createBuffer(1, data.length, c.sampleRate);
  b.getChannelData(0).set(data);
  buffers.set(midi, b);
  return b;
}

// Karplus-Strong: a burst of noise circulating in a delay line one period long,
// averaged with its neighbour on every trip so the highs die away first, like a
// real string. An all-pass filter supplies the fraction of a sample the integer
// delay can't, which keeps the high notes in tune.
function karplusStrong(midi, rate, seconds) {
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const period = rate / freq;
  const len = Math.max(2, Math.floor(period - 0.6)); // the averaging adds half a sample
  const frac = period - 0.5 - len; // 0.1..1.1, where a first-order all-pass behaves
  const ap = (1 - frac) / (1 + frac);
  const line = new Float32Array(len);
  // Excitation: noise through a one-pole lowpass, a little brighter as the pitch
  // goes up (wound bass strings are darker), with the DC taken out.
  const bright = Math.min(0.85, Math.max(0.3, (midi - 30) / 55));
  let lp = 0, mean = 0;
  for (let i = 0; i < len; i++) {
    lp += bright * (Math.random() * 2 - 1 - lp);
    line[i] = lp;
    mean += lp / len;
  }
  for (let i = 0; i < len; i++) line[i] -= mean;
  // Picking a seventh of the way along the string notches some harmonics out.
  const pick = Math.max(1, Math.round(len / 7));
  for (let i = len - 1; i >= pick; i--) line[i] -= 0.5 * line[i - pick];
  // Loss per trip for a decay (to -60 dB) from ~4.5 s on the low E down to ~1.2 s,
  // net of what the averaging already takes from the fundamental.
  const t60 = Math.max(1.2, 4.5 - (midi - 40) * 0.07);
  const loss = Math.min(0.9996, 0.001 ** (1 / (freq * t60)) / Math.cos((Math.PI * freq) / rate));
  const total = Math.floor(rate * seconds);
  const out = new Float32Array(total);
  let prev = 0, apIn = 0, apOut = 0, i = 0, peak = 0;
  for (let t = 0; t < total; t++) {
    const cur = line[i];
    out[t] = cur;
    const avg = 0.5 * (cur + prev);
    prev = cur;
    apOut = ap * avg + apIn - ap * apOut;
    apIn = avg;
    line[i] = apOut * loss;
    i = i + 1 === len ? 0 : i + 1;
    const a = cur < 0 ? -cur : cur;
    if (a > peak) peak = a;
  }
  const fade = Math.min(total, Math.floor(rate * 0.05));
  for (let k = 0; k < fade; k++) out[total - 1 - k] *= k / fade;
  if (peak > 0) for (let k = 0; k < total; k++) out[k] /= peak;
  return out;
}
