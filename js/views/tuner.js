// Guitar tuner. The pitch is smoothed with a quarter-second low-pass (see
// pitch.js), so the needle glides instead of flickering, and jumps straight
// to a new string when you pluck one.

import { h, icon, button, toast, fill } from '../ui.js';
import { detectPitch, PitchTracker, nearestString } from '../pitch.js';
import { TUNINGS } from '../voicings.js';
import { pluck, unlockAudio } from '../audio.js';
import { prefs } from '../prefs.js';

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

export function view() {
  let ctx = null, stream = null, analyser = null, buf = null, raf = 0, running = false;
  const tracker = new PitchTracker({ tau: 0.25, a4: prefs.get('a4') || 440 });
  let tuningKey = prefs.get('tuning') || 'standard';
  const tuning = () => (TUNINGS[tuningKey] || TUNINGS.standard).midi;

  // meter: a 100-cent arc, ±50 either side
  const R = 130, CX = 160, CY = 160;
  const meterSvg = svg('svg', { viewBox: '0 0 320 178', role: 'img', 'aria-label': 'Tuning meter' });
  const arc = (a0, a1, r) => {
    const p = a => [CX + r * Math.sin(a), CY - r * Math.cos(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const MAX = (60 * Math.PI) / 180; // ±50 cents = ±60°
  meterSvg.append(svg('path', { d: arc((-4 / 50) * MAX, (4 / 50) * MAX, R - 8), class: 'zone' }));
  for (let c = -50; c <= 50; c += 5) {
    const a = (c / 50) * MAX;
    const major = c % 25 === 0;
    const r0 = major ? R - 20 : R - 12;
    meterSvg.append(svg('line', { x1: CX + r0 * Math.sin(a), y1: CY - r0 * Math.cos(a), x2: CX + R * Math.sin(a), y2: CY - R * Math.cos(a), class: major ? 'tick major' : 'tick' }));
  }
  for (const [c, lbl] of [[-50, '−50'], [-25, '−25'], [0, '0'], [25, '+25'], [50, '+50']]) {
    const a = (c / 50) * MAX;
    const t = svg('text', { x: CX + (R + 16) * Math.sin(a), y: CY - (R + 16) * Math.cos(a) + 4, 'text-anchor': 'middle', class: 'lbl' });
    t.textContent = lbl;
    meterSvg.append(t);
  }
  const needle = svg('line', { x1: CX, y1: CY, x2: CX, y2: CY - R + 6, class: 'needle' });
  meterSvg.append(needle, svg('circle', { cx: CX, cy: CY, r: 7, class: 'hub' }));

  const meter = h('div', { class: 'meter' }, meterSvg);
  const noteEl = h('div', { class: 'tuner-note idle', 'aria-live': 'polite' }, '–');
  const centsEl = h('div', { class: 'tuner-cents' });
  const hint = h('div', { class: 'tuner-hint' }, 'Tap Start and play a string.');
  const strings = h('div', { class: 'strings', role: 'group', 'aria-label': 'Strings (tap to hear the note)' });
  const startBtn = button('Start tuner', () => (running ? stop() : start()), { cls: 'btn-primary', iconName: 'mic' });
  const tuningSel = h('select', { class: 'select', 'aria-label': 'Tuning', style: { maxWidth: '190px' } }, ...Object.entries(TUNINGS).map(([k, t]) => h('option', { value: k }, t.name)));
  tuningSel.value = tuningKey;
  tuningSel.addEventListener('change', () => { tuningKey = tuningSel.value; prefs.set('tuning', tuningKey); drawStrings(); });
  const a4 = h('select', { class: 'select', 'aria-label': 'Reference pitch', style: { maxWidth: '130px' } }, ...[432, 435, 438, 440, 441, 442, 443, 444, 446].map(f => h('option', { value: String(f) }, `A = ${f} Hz`)));
  a4.value = String(prefs.get('a4') || 440);
  a4.addEventListener('change', () => { prefs.set('a4', +a4.value); tracker.a4 = +a4.value; drawStrings(); });
  const root = h('div', { class: 'tuner' }, noteEl, centsEl, meter, hint, strings, h('div', { class: 'tuner-controls' }, startBtn, tuningSel, a4));

  function drawStrings(active = -1, ok = false) {
    const midi = tuning();
    fill(strings, ...midi.map((m, i) => h('button', {
      type: 'button', class: `string-btn ${i === active ? (ok ? 'ok' : 'near') : ''}`,
      'aria-label': `String ${6 - i}: ${NAMES[m % 12]}${Math.floor(m / 12) - 1}. Tap to hear it.`,
      onClick: () => { unlockAudio(); pluck(m, { duration: 3 }); },
    }, NAMES[m % 12].replace('♯', '#'), h('small', {}, String(Math.floor(m / 12) - 1)))));
  }
  drawStrings();

  let lastString = -1, lastOk = false;
  function frame() {
    if (!running) return;
    analyser.getFloatTimeDomainData(buf);
    const st = tracker.update(detectPitch(buf, ctx.sampleRate), performance.now() / 1000);
    if (!st.active) {
      noteEl.className = 'tuner-note idle';
      fill(noteEl, '–');
      centsEl.textContent = '';
      hint.textContent = 'Listening… play one string at a time.';
      setNeedle(0, false);
      root.classList.remove('in-tune');
      if (lastString !== -1) { lastString = -1; drawStrings(); }
    } else {
      noteEl.className = 'tuner-note';
      fill(noteEl, NAMES[((st.midi % 12) + 12) % 12], h('sup', {}, String(st.octave)));
      const c = Math.round(st.cents);
      centsEl.textContent = `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)} cents · ${st.freq.toFixed(1)} Hz`;
      root.classList.toggle('in-tune', st.inTune);
      meter.classList.toggle('in-tune', st.inTune);
      hint.textContent = st.inTune ? 'In tune' : !st.stable ? ' ' : c < 0 ? 'Tune up a little' : 'Tune down a little';
      setNeedle(st.cents, st.stable);
      const near = nearestString(st.freq, tuning(), prefs.get('a4') || 440);
      const idx = Math.abs(near.cents) < 120 ? near.index : -1;
      if (idx !== lastString || st.inTune !== lastOk) { lastString = idx; lastOk = st.inTune; drawStrings(idx, st.inTune); }
    }
    raf = requestAnimationFrame(frame);
  }

  function setNeedle(cents, visible) {
    const a = Math.max(-60, Math.min(60, (Math.max(-50, Math.min(50, cents)) / 50) * 60));
    needle.setAttribute('transform', `rotate(${a} ${CX} ${CY})`);
    needle.style.opacity = visible ? '1' : '0.35';
  }

  async function start() {
    unlockAudio();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      hint.textContent = denied ? 'TabIt needs the microphone to hear your guitar. Allow it in the browser’s site settings, then try again.' : 'No microphone found.';
      toast(hint.textContent);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume();
    analyser = ctx.createAnalyser();
    analyser.fftSize = ctx.sampleRate > 50000 ? 8192 : 4096;
    buf = new Float32Array(analyser.fftSize);
    ctx.createMediaStreamSource(stream).connect(analyser);
    tracker.reset();
    running = true;
    fill(startBtn, icon('stop'), 'Stop');
    hint.textContent = 'Listening… play one string at a time.';
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach(t => t.stop());
    ctx?.close().catch(() => {});
    ctx = stream = analyser = null;
    fill(startBtn, icon('mic'), 'Start tuner');
    noteEl.className = 'tuner-note idle';
    fill(noteEl, '–');
    centsEl.textContent = '';
    hint.textContent = 'Tap Start and play a string.';
    setNeedle(0, false);
    root.classList.remove('in-tune');
    meter.classList.remove('in-tune');
    drawStrings();
  }

  // the microphone is let go when the app goes to the background
  const onVis = () => { if (document.visibilityState === 'hidden' && running) stop(); };
  document.addEventListener('visibilitychange', onVis);
  setNeedle(0, false);

  const el = h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, h('small', {}, 'Chromatic, any tuning'), 'Tuner')),
    root);
  return { el, title: 'Tuner', tab: 'tuner', destroy() { stop(); document.removeEventListener('visibilitychange', onVis); } };
}
