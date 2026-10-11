// Tablature: how a staff is cut into rows to fit a screen, made a little
// smaller when that saves a row, and what goes with it (headings, notes, chord
// names, string names on every row). The tabs here are made up.
import { test, eq, ok, deepEq } from '../harness.js';
import { parseSong, guessKind } from '../../js/parse.js';
import { searchSongs, makeSong } from '../../js/model.js';
import { renderSheet, layoutTabs, tabSegments, cutPoints, planStaff, tabWeight } from '../../js/sheet.js';
import { isTabType, typeName, versionKind, groupResults, numberVersions, matchEntry } from '../../js/ug.js';

const staffRows = texts => texts.map(text => ({ text, parts: [], staff: true }));
const measure = notes => notes.padEnd(16, '-') + '|';
const STAFF = [
  'e|' + measure('') + measure('') + measure('') + measure(''),
  'B|' + measure('---0-1') + measure('') + measure('-3') + measure(''),
  'G|' + measure('--------2') + measure('-0') + measure('') + measure('-------0'),
  'D|' + measure('') + measure('---------2-0') + measure('-------2') + measure(''),
  'A|' + measure('') + measure('') + measure('') + measure('-3'),
  'E|' + measure('') + measure('') + measure('') + measure(''),
];
const segsOf = src => tabSegments(parseSong(src).blocks.find(b => b.type === 'tab').lines.map(l => ({ ...l, chords: l.chords.map(c => ({ ...c, orig: c.name })) })));

test('a staff that doesn’t fit is cut in rows of about the same length, at a bar line', () => {
  eq(STAFF[0].length, 70);
  const rows = staffRows(STAFF);
  deepEq(cutPoints(rows, 40, 2), [36], 'after the second measure, the middle');
  deepEq(cutPoints(rows, 80, 2), [], 'it fits: not cut');
  const three = cutPoints(rows, 26, 2);
  eq(three.length, 3, 'one measure a row on a narrow screen');
  ok(three.every(c => STAFF[0][c - 1] === '|'), 'every cut right after a bar');
});

test('a cut never goes through a fret number or a chord name', () => {
  const texts = ['e|' + '-'.repeat(21) + '10' + '-'.repeat(19) + '|', 'B|' + '-'.repeat(19) + '12-15' + '-'.repeat(18) + '|'];
  const cuts = cutPoints(staffRows(texts), 30, 2);
  eq(cuts.length, 1);
  for (const t of texts) ok(!(/\d/.test(t[cuts[0] - 1]) && /\d/.test(t[cuts[0]])), `not inside a number: ${t.slice(cuts[0] - 3, cuts[0])}|${t.slice(cuts[0], cuts[0] + 3)}`);
  const withChords = [{ text: '      Am7               Cadd9', parts: [{ col: 6, name: 'Am7' }, { col: 24, name: 'Cadd9' }], staff: false }, ...staffRows(['e|' + '-'.repeat(40) + '|'])];
  for (const c of cutPoints(withChords, 26, 2)) ok(!/[A-Za-z0-9]/.test(withChords[0].text[c - 1] || ' ') || !/[A-Za-z0-9]/.test(withChords[0].text[c] || ' '), 'not inside a chord name');
});

test('a little smaller when that saves a row; as it is when it doesn’t', () => {
  const seg = segsOf('[tab]' + STAFF.map(l => l.slice(0, 49)).join('\n') + '[/tab]')[0];
  eq(seg.len, 49);
  deepEq(planStaff(seg, 46), { scale: 0.9, bare: false, cuts: [] }, 'three columns too long: smaller, on one row');
  const wide = segsOf('[tab]' + STAFF.join('\n') + '[/tab]')[0];
  const p = planStaff(wide, 46);
  deepEq([p.scale, p.cuts.length], [1, 1], 'two rows anyway: full size');
  eq(planStaff(wide, 80).cuts.length, 0);
});

test('words after a staff’s last bar go above it when the staff wouldn’t fit with them', () => {
  const lines = STAFF.map(l => l.slice(0, 36)).map((l, i) => (i === 3 ? `${l}      R1` : l));
  const seg = segsOf(`[tab]${lines.join('\n')}[/tab]`)[0];
  deepEq(seg.notes, ['R1']);
  eq(seg.full, 44);
  eq(seg.len, 36);
  deepEq(planStaff(seg, 60), { scale: 1, bare: false, cuts: [] }, 'room for them beside it: left there');
  deepEq(planStaff(seg, 40), { scale: 1, bare: true, cuts: [] }, 'not: above it, and the staff still on one row');
});

test('a heading above a staff is a heading; chord names and beat marks stay over their columns', () => {
  const seg = segsOf(`[tab]Part A\n  [ch]G[/ch]        [ch]C[/ch]\n  |   |   |   |\n${STAFF.join('\n')}[/tab]`)[0];
  deepEq(seg.titles, ['Part A']);
  eq(seg.rows.length, 8, 'chord names, beat marks and six strings');
  deepEq(seg.rows[0].parts.map(p => [p.col, p.name]), [[2, 'G'], [11, 'C']]);
  eq(seg.head, 2, 'string names two columns wide');
  const nc = segsOf(`[tab]  N/C\n${STAFF.join('\n')}[/tab]`)[0];
  deepEq(nc.titles, [], '“N/C” is over a column, not a heading');
});

test('staves stacked without a blank line are laid out one by one', () => {
  const two = segsOf(`[tab]Guitar 1\n${STAFF.join('\n')}\nGuitar 2\n${STAFF.join('\n')}[/tab]`);
  deepEq(two.map(s => [s.titles.join(), s.rows.filter(r => r.staff).length]), [['Guitar 1', 6], ['Guitar 2', 6]]);
  // one line of a staff that isn't recognized as one doesn't split it
  const odd = STAFF.slice();
  odd[2] = 'G|~~ let ring ~~';
  const one = segsOf(`[tab]${odd.join('\n')}[/tab]`);
  eq(one.length, 1);
  eq(one[0].rows.length, 6);
});

test('on a narrow screen: every row of the staff in every part, string names first', () => {
  const box = document.createElement('div');
  box.className = 'song';
  box.style.cssText = 'width:300px;--fs:18px';
  document.getElementById('sandbox').append(box);
  const sheet = renderSheet(parseSong(`[tab]${STAFF.join('\n')}[/tab]`));
  box.append(sheet);
  layoutTabs(sheet);
  const parts = [...sheet.querySelectorAll('.tseg .sys')];
  ok(parts.length > 1, `cut in ${parts.length} parts`);
  for (const p of parts) eq(p.querySelectorAll('.tl.st').length, 6, 'all six strings');
  deepEq([...parts[1].querySelectorAll('.tl.st')].map(r => r.textContent.slice(0, 2)), ['e|', 'B|', 'G|', 'D|', 'A|', 'E|'], 'the string names again');
  const joined = [...parts].map((p, k) => p.querySelector('.tl.st').textContent.slice(k ? 2 : 0)).join('');
  eq(joined, STAFF[0], 'put together: the staff as written');
  for (const r of sheet.querySelectorAll('.tl')) ok(r.scrollWidth <= r.clientWidth + 1, 'nothing past the edge');
  box.remove();
});

test('a staff plays for about as long as it is wide; a pasted tab is a tab', () => {
  const short = segsOf(`[tab]${STAFF.map(l => l.slice(0, 30)).join('\n')}[/tab]`);
  const long = segsOf(`[tab]${STAFF.join('\n')}[/tab]`);
  ok(tabWeight(long) > tabWeight(short) * 1.8, `${tabWeight(long)} vs ${tabWeight(short)}`);
  eq(guessKind(parseSong(`[Intro]\n[tab]${STAFF.join('\n')}[/tab]\n[Verse]\n[ch]G[/ch]\nOne line\n[ch]C[/ch]\nTwo lines\n[ch]D[/ch]\nThree\n[ch]G[/ch]\nFour\n[ch]C[/ch]\nFive\n[ch]D[/ch]\nSix\n[ch]G[/ch]\nSeven`)), 'chords', 'a riff in a chord sheet');
  eq(guessKind(parseSong(`Play it slow.\n\n${STAFF.join('\n')}\n\n${STAFF.join('\n')}`)), 'tab');
  ok(parseSong(STAFF.join('\n')).blocks[0].lines.every(l => l.staff), 'staff rows are marked');
});

test('Ultimate Guitar’s tab versions: kept, and named', () => {
  ok(isTabType('Tabs') && isTabType('Tab') && !isTabType('Chords'));
  deepEq(['Chords', 'Tabs', 'Pro'].map(typeName), ['Chords', 'Tab', 'Guitar Pro']);
  const r = (type, url, votes = 10) => ({ title: 'Breakdown', artist: 'The Pickers', type, url, rating: 4.5, votes, version: null });
  const g = groupResults(numberVersions([r('Tabs', 'u1'), r('Chords', 'u2'), r('Tabs', 'u3', 50), r('Pro', 'u4')]));
  eq(g.length, 1);
  deepEq(g[0].versions.map(v => [v.type, v.version]), [['Chords', 1], ['Tabs', 1], ['Tabs', 2], ['Pro', 1]], 'chords first, then tabs, by version');
});

test('a tab of part of a song (the intro) is numbered apart, and says so', () => {
  deepEq([versionKind({ type: 'Tabs' }), versionKind({ type: 'Tabs', part: 'intro' }), versionKind({ type: 'Chords', part: 'solo' })], ['Tab', 'Intro tab', 'Solo chords']);
  const r = (part, url, version = null) => ({ title: 'Breakdown', artist: 'The Pickers', type: 'Tabs', part, url, rating: 4.5, votes: 3, version });
  deepEq(numberVersions([r('', 'a'), r('intro', 'b'), r('', 'c'), r('intro', 'd')]).map(x => x.version), [1, 1, 2, 2], 'counted per part');
  const listed = [r('intro', 'intro-1', 1), r('', 'whole-1', 1)];
  eq(matchEntry({ artist: 'The Pickers', title: 'Breakdown', version: 1, type: 'Tab' }, listed).result.url, 'whole-1', 'a list entry is the whole song’s version');
});

test('“tab” in the library search finds your tabs', () => {
  const songs = [makeSong({ id: 'a', title: 'Breakdown', kind: 'tab' }), makeSong({ id: 'b', title: 'Breakdown' }), makeSong({ id: 'c', title: 'Waltz', kind: 'tab' })];
  deepEq(searchSongs(songs, 'tab').map(s => s.id).sort(), ['a', 'c']);
  deepEq(searchSongs(songs, 'breakdown tab').map(s => s.id), ['a']);
  eq(searchSongs(songs, 'breakdown').length, 2);
});
