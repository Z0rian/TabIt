// The sheet's DOM structure: which text a chord is glued to, and what may wrap.
import { test, eq, ok, deepEq } from '../harness.js';
import { parseSong } from '../../js/parse.js';
import { renderSheet } from '../../js/sheet.js';
import { transposeChord } from '../../js/theory.js';

const render = (src, opts) => renderSheet(parseSong(src), opts);
const units = sheet => [...sheet.querySelectorAll('.pair .c')].map(u => [u.querySelector('.cn').textContent, u.querySelector('.tx').textContent]);

test('each chord is glued to the text from its character to the next chord or word end', () => {
  const s = render('[G]Mama take this [D]badge off of [Am]me');
  deepEq(units(s), [['G', 'Mama'], ['D', 'badge'], ['Am', 'me']]);
  // mid-word chord: the word can't break, and the chord sits on its syllable
  const m = render('Be-[C]fore the [G]dawn');
  deepEq(units(m), [['C', 'fore'], ['G', 'dawn']]);
  const w = m.querySelector('.w');
  eq(w.textContent.replace(/[CG]/g, ''), 'Be-fore');
  ok(m.querySelector('.c.mid') === null, 'unit ends at the word end');
  const two = render('Hal[G]le[C]lujah');
  deepEq(units(two), [['G', 'le'], ['C', 'lujah']]);
  ok(two.querySelector('.c.mid'), 'a unit ending inside a word is marked');
});

test('chords over a pause keep the spaces under them; trailing chords come after', () => {
  const s = render('[ch]G[/ch]          [ch]C[/ch]       [ch]D[/ch]\nI        love you');
  const u = units(s);
  eq(u[0][0], 'G');
  eq(u.at(-1)[0], 'D', 'D is past the end of the words');
  ok(/^\s+$/.test(u.at(-1)[1]), 'nothing under a trailing chord');
});

test('transposed names are shown, the original is kept for diagrams', () => {
  const s = render('[ch]G[/ch]   [ch]D/F#[/ch]\nHello there', { chordName: n => transposeChord(n, 2) });
  deepEq(units(s).map(x => x[0]), ['A', 'E/G#']);
  eq(s.querySelector('.cn').dataset.orig, 'G');
  eq(s.querySelector('.cn').dataset.chord, 'A');
});

test('footnote marks are shown but not part of the chord', () => {
  const s = render('[tab][ch]Am[/ch]*      [ch]G[/ch]\nI love blues guitar[/tab]');
  const cn = s.querySelector('.pair .cn');
  eq(cn.textContent, 'Am*');
  eq(cn.dataset.chord, 'Am');
});

test('autoscroll weights: notes before the music count for little', () => {
  const s = render('This tab is easy.\nPlay along with the record.\n\n[Verse]\n[ch]G[/ch]\nla la');
  const w = [...s.children].map(b => +b.dataset.w);
  ok(w[0] < 0.2 && w[1] < 0.2, 'notes');
  ok(s.children[0].classList.contains('pre'));
  eq(w.at(-1), 1, 'a lyric line');
});

test('lyrics-only and monospace modes', () => {
  ok(render('[G]la', { hideChords: true }).classList.contains('no-chords'));
  ok(render('[G]la', { mono: true }).classList.contains('mono'));
});
