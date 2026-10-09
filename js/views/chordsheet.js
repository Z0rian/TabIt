// The chord drawer: every way to play a chord, swipe through them, hear it.
// The tab author's own shapes come first, then the generated ones.

import { h, iconButton, button, drawer, toast, fill } from '../ui.js';
import { voicings, voicingKey, describe, fromFrets, TUNINGS } from '../voicings.js';
import { renderDiagram } from '../diagram.js';
import { strum, unlockAudio } from '../audio.js';
import { parseChord } from '../theory.js';
import { prefs } from '../prefs.js';

export const tuningMidi = name => (TUNINGS[name] || TUNINGS.standard).midi;

// Shapes for a chord, best first: [{ v, from: 'tab' | 'yours' | null }]
export function shapesFor(name, { author = [], tuning = 'standard' } = {}) {
  const midi = tuningMidi(tuning);
  const seen = new Set();
  const out = [];
  for (const f of author || []) {
    const v = fromFrets(f, midi);
    const k = voicingKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ v, from: 'tab' });
  }
  for (const v of voicings(name, { tuning: midi, limit: 16 })) {
    const k = voicingKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ v, from: null });
  }
  return out;
}

// The shape to show for a chord: the one picked for this song, else the first.
export function chosenShape(name, { author, tuning, pick } = {}) {
  const list = shapesFor(name, { author, tuning });
  if (!list.length) return null;
  return (pick && list.find(x => voicingKey(x.v) === pick)) || list[0];
}

export function diagram(v, name, { size = 120, mini = false } = {}) {
  const p = parseChord(name);
  return renderDiagram(v, { name, size, mini, fingers: !mini, leftHanded: prefs.get('leftHanded'), rootPc: p ? p.rootPc : undefined });
}

// Opens the drawer. onPick(key) saves a shape for this song (omit to hide).
export function openChord(name, { author, tuning = 'standard', pick, onPick, sub } = {}) {
  unlockAudio();
  const list = shapesFor(name, { author, tuning });
  const midi = tuningMidi(tuning);
  if (!list.length) {
    drawer({ title: name, body: h('p', {}, 'That doesn’t read as a chord, so there’s no shape for it.') });
    return;
  }
  let index = Math.max(0, list.findIndex(x => voicingKey(x.v) === pick));
  const track = h('div', { class: 'voicing-track', tabindex: '0', 'aria-label': `${list.length} ways to play ${name}` });
  list.forEach(({ v, from }, i) => {
    track.append(h('div', { class: 'voicing-slide', 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${list.length}: ${describe(v)}` },
      diagram(v, name, { size: Math.min(220, innerWidth * 0.55) }),
      h('div', { class: 'frets' }, describe(v)),
      h('div', { class: 'eyebrow', style: { minHeight: '12px' } }, from === 'tab' ? 'From the tab' : i === list.findIndex(x => !x.from) ? 'Most common' : v.baseFret > 1 ? `Fret ${v.baseFret}` : 'Open position')));
  });
  const count = h('div', { class: 'voicing-count', 'aria-live': 'polite' });
  const dots = h('div', { class: 'voicing-dots' });
  const useBtn = onPick ? button('Use this shape in this song', () => {
    const k = voicingKey(list[index].v);
    onPick(index === 0 ? null : k);
    toast(index === 0 ? 'Back to the usual shape' : 'Shape saved for this song');
    update();
  }, { cls: 'btn-small' }) : null;
  const update = () => {
    count.textContent = `${index + 1} / ${list.length}`;
    fill(dots, ...list.slice(0, 24).map((_, i) => h('button', { type: 'button', 'aria-label': `Shape ${i + 1}`, 'aria-current': String(i === index), onClick: () => goTo(i) })));
    if (useBtn) {
      const k = voicingKey(list[index].v);
      useBtn.disabled = (pick || voicingKey(list[0].v)) === k;
    }
  };
  const goTo = (i, smooth = true) => {
    index = (i + list.length) % list.length;
    track.scrollTo({ left: index * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    update();
  };
  let st = 0;
  track.addEventListener('scroll', () => {
    clearTimeout(st);
    st = setTimeout(() => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== index) { index = i; update(); }
    }, 60);
  });
  track.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(index - 1); }
  });
  const play = button('Play', () => { unlockAudio(); strum(list[index].v, { tuning: midi }); }, { iconName: 'volume', cls: 'btn-small' });
  drawer({
    title: name,
    actions: play,
    body: [
      sub ? h('p', { class: 'hint', style: { marginTop: '-8px' } }, sub) : null,
      h('div', { class: 'voicing-stage' },
        track,
        h('div', { class: 'voicing-nav' }, iconButton('back', 'Previous shape', () => goTo(index - 1)), count, iconButton('forward', 'Next shape', () => goTo(index + 1))),
        dots,
        useBtn),
    ],
  });
  requestAnimationFrame(() => goTo(index, false));
}
