// Chord finder: pick a root and a type (or type any chord) and see every way
// to play it. Tap one to hear it and swipe through the rest.

import { h, icon, toast, fill } from '../ui.js';
import { voicings, describe, voicingKey } from '../voicings.js';
import { isChord, parseChord } from '../theory.js';
import { prefs } from '../prefs.js';
import { openChord, diagram, tuningMidi } from './chordsheet.js';
import { strum, unlockAudio } from '../audio.js';

const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const TYPES = [
  ['', 'major'], ['m', 'minor'], ['7', '7'], ['maj7', 'maj7'], ['m7', 'm7'], ['sus2', 'sus2'], ['sus4', 'sus4'], ['add9', 'add9'],
  ['6', '6'], ['m6', 'm6'], ['9', '9'], ['m9', 'm9'], ['maj9', 'maj9'], ['7sus4', '7sus4'], ['5', '5 (power)'], ['dim', 'dim'],
  ['dim7', 'dim7'], ['m7b5', 'm7♭5'], ['aug', 'aug'], ['11', '11'], ['13', '13'], ['7#9', '7♯9'], ['mMaj7', 'm(maj7)'], ['69', '6/9'],
];
const TUNING_LABEL = { standard: 'Standard', dropD: 'Drop D', halfDown: '½ step down', fullDown: 'Full step down', openG: 'Open G', openD: 'Open D', dadgad: 'DADGAD' };

export function view(route) {
  let root = route.args[0] && parseChord(route.args[0]) ? parseChord(route.args[0]).root : (prefs.get('chordRoot') || 'C');
  let type = route.args[0] && parseChord(route.args[0]) ? parseChord(route.args[0]).suffix : (prefs.get('chordType') ?? '');
  let custom = route.args[0] && !ROOTS.includes(parseChord(route.args[0])?.root) ? route.args[0] : '';
  let tuning = prefs.get('chordTuning') || 'standard';

  const rootRow = h('div', { class: 'root-row', role: 'group', 'aria-label': 'Root note' });
  const typeRow = h('div', { class: 'qual-row', role: 'group', 'aria-label': 'Chord type' });
  const input = h('input', { class: 'input', placeholder: 'Or type any chord: Bbmaj7#11/F', value: custom, autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Any chord' });
  const tuningSel = h('select', { class: 'select', 'aria-label': 'Tuning', style: { maxWidth: '170px' } }, ...Object.entries(TUNING_LABEL).map(([k, l]) => h('option', { value: k }, l)));
  tuningSel.value = tuning;
  const title = h('h2', { class: 'voicing-name', style: { fontSize: '44px', margin: '18px 0 2px' } });
  const sub = h('p', { class: 'hint', style: { margin: '0 0 12px' } });
  const grid = h('div', { class: 'diagram-grid' });

  const current = () => (custom && isChord(custom) ? custom : root + type);

  function draw() {
    fill(rootRow, ...ROOTS.map(r => h('button', { type: 'button', class: 'root-btn', 'aria-pressed': String(!custom && r === root), onClick: () => { root = r; custom = ''; input.value = ''; prefs.set('chordRoot', r); draw(); } }, r)));
    fill(typeRow, ...TYPES.map(([t, label]) => h('button', { type: 'button', class: 'qual-btn', 'aria-pressed': String(!custom && t === type), onClick: () => { type = t; custom = ''; input.value = ''; prefs.set('chordType', t); draw(); } }, label)));
    const name = current();
    const list = voicings(name, { tuning: tuningMidi(tuning), limit: 24 });
    title.textContent = name;
    const p = parseChord(name);
    sub.textContent = p ? `${list.length} shapes · notes ${noteNames(p)}` : '';
    fill(grid, ...list.map((v, i) => h('button', {
      type: 'button', class: 'diagram-card', 'aria-label': `${name}, shape ${i + 1}: ${describe(v)}`,
      onClick: () => { unlockAudio(); strum(v, { tuning: tuningMidi(tuning) }); openChord(name, { tuning, pick: voicingKey(v) }); },
    }, diagram(v, name, { size: 112 }), h('small', {}, describe(v).replace(/ /g, '')))));
  }

  input.addEventListener('change', () => {
    const v = input.value.trim().replace(/\s+/g, '');
    if (!v) { custom = ''; draw(); return; }
    if (!isChord(v)) { toast('That doesn’t read as a chord. Try something like F#m7 or Cadd9/G.'); return; }
    custom = v;
    draw();
  });
  tuningSel.addEventListener('change', () => { tuning = tuningSel.value; prefs.set('chordTuning', tuning); draw(); });

  draw();
  const el = h('div', { class: 'page wide' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, h('small', {}, 'Every shape for every chord'), 'Chords')),
    rootRow,
    h('div', { style: { height: '8px' } }),
    typeRow,
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, h('div', { class: 'search', style: { flex: 1 } }, icon('search'), input), tuningSel),
    title, sub, grid);
  return { el, title: 'Chords', tab: 'chords' };
}

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
function noteNames(p) {
  const all = [...p.required, ...p.optional].sort((a, b) => a - b);
  return all.map(i => NAMES[(p.rootPc + i) % 12]).join(' ') + (p.bass ? ` / ${p.bass}` : '');
}
