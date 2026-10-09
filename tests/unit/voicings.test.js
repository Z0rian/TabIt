import { test, eq, ok, deepEq } from '../harness.js';
import { voicings, voicingKey, describe, TUNINGS, CANONICAL } from '../../js/voicings.js';
import { parseChord } from '../../js/theory.js';

const STD = TUNINGS.standard.midi;
const mod12 = n => ((n % 12) + 12) % 12;
const first = (sym, opts) => voicingKey(voicings(sym, opts)[0]);
const keys = (sym, opts) => voicings(sym, opts).map(voicingKey);
const shape = s => (s.includes('-') ? s.split('-') : [...s]).map(c => (c === 'x' ? -1 : +c));

const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
const SUFFIXES = ['', 'm', '7', 'm7', 'maj7', '6', 'm6', '69', '9', 'm9', 'maj9', '11', 'm11', '13', 'm13', 'maj13',
  'sus2', 'sus4', '7sus4', 'add9', 'madd9', 'add11', 'dim', 'dim7', 'm7b5', 'aug', 'aug7', '7b5', '7#5', '7b9', '7#9',
  '7#11', '9#11', '13b9', 'mMaj7', '5', '2', '4'];
const SLASHES = ['C/G', 'C/E', 'C/B', 'Am/G', 'G/F#', 'D/F#', 'F/C', 'Em/D', 'Cmaj7/B', 'Bb/D', 'Ab/Gb', 'Dm/C', 'Gsus2/B',
  'Bbmaj7#11/F', 'C7#9b13', 'G/B', 'A/C#', 'E/G#', 'F/A', 'D/A', 'G/D', 'Am/C', 'Am/E', 'C/D', 'Fmaj7/E'];
const COMMON = new Set(['', 'm', '7', 'm7', 'maj7', 'sus2', 'sus4', 'add9', '5']);

// The rules restated independently of the generator, so a shape is checked
// against the spec rather than against the code that made it. Returns a list
// of problems (empty when the voicing is fine).
function problems(sym, v, { tuning = STD, maxFret = 15, span = 4 } = {}) {
  const c = parseChord(sym);
  const tone = iv => mod12(c.rootPc + iv);
  const allowed = new Set([...c.required, ...c.optional].map(tone).concat(c.bassPc));
  const out = [];
  const n = tuning.length;
  if (v.frets.length !== n || v.fingers.length !== n) out.push('string count');
  if (v.frets.some(f => !Number.isInteger(f) || f < -1 || f > maxFret)) out.push('fret out of range');
  const notes = [];
  v.frets.forEach((f, s) => { if (f >= 0) notes.push(tuning[s] + f); });
  const bassNote = notes[0];
  notes.sort((a, b) => a - b);
  if (JSON.stringify(notes) !== JSON.stringify(v.notes)) out.push(`notes ${v.notes} != frets ${notes}`);
  if (notes.length < (c.quality.power ? 2 : 3) && !v.relaxed) out.push('too few strings');
  const pcs = new Set(notes.map(mod12));
  for (const p of pcs) if (!allowed.has(p)) out.push(`non-chord tone ${p}`);
  if (mod12(notes[0]) !== c.bassPc || bassNote !== notes[0]) out.push('wrong bass');
  if (!v.relaxed) for (const iv of c.required) if (!pcs.has(tone(iv))) out.push(`missing ${iv}`);
  const pressed = v.frets.filter(f => f > 0);
  const lo = pressed.length ? Math.min(...pressed) : 0;
  const hi = pressed.length ? Math.max(...pressed) : 0;
  if (!v.relaxed && hi - lo > span) out.push(`span ${hi - lo}`);
  if (v.baseFret !== (hi <= 4 ? 1 : lo)) out.push(`baseFret ${v.baseFret}`);
  // fingers: one per fretted string, 1-4; a finger on several strings must be a legal barre
  v.frets.forEach((f, s) => {
    if ((f > 0) !== (v.fingers[s] >= 1 && v.fingers[s] <= 4)) out.push(`finger on string ${s}`);
  });
  for (const b of v.barres) {
    if (!(b.from < b.to) || b.fret !== lo) out.push('barre shape');
    for (let s = b.from; s <= b.to; s++) if (!(v.frets[s] >= b.fret)) out.push('open or muted string under a barre');
    for (let s = b.from; s <= b.to; s++) if (v.frets[s] === b.fret && v.fingers[s] !== b.finger) out.push('barre finger');
  }
  const used = new Map();
  v.frets.forEach((f, s) => { if (f > 0) used.set(v.fingers[s], (used.get(v.fingers[s]) || []).concat(s)); });
  for (const [finger, strings] of used) {
    if (strings.length > 1 && !v.barres.some(b => b.finger === finger && strings.every(s => s >= b.from && s <= b.to))) {
      out.push(`finger ${finger} on strings ${strings} without a barre`);
    }
  }
  return out;
}

function assertValid(sym, list, opts) {
  for (const v of list) {
    const p = problems(sym, v, opts);
    ok(!p.length, `${sym} ${voicingKey(v)}: ${p.join(', ')}`);
  }
}

test('tunings', () => {
  deepEq(TUNINGS.standard.midi, [40, 45, 50, 55, 59, 64]);
  deepEq(TUNINGS.dropD.midi, [38, 45, 50, 55, 59, 64]);
  deepEq(TUNINGS.dadgad.midi, [38, 45, 50, 55, 57, 62]);
  for (const t of Object.values(TUNINGS)) {
    ok(t.name && t.midi.length === 6 && t.midi.every(Number.isInteger), `tuning ${t.name}`);
  }
  ok(Object.isFrozen(TUNINGS.standard.midi), 'shared defaults are frozen');
});

test('things that are not chords have no voicings', () => {
  for (const s of ['N.C.', 'x2', '', 'Verse', 'Hm', null, undefined]) deepEq(voicings(s), [], String(s));
});

test('the shapes everyone learns come first', () => {
  const want = {
    C: 'x32010', C7: 'x32310', Cmaj7: 'x32000', Cadd9: 'x32033', Csus4: 'x33011', 'C/G': '332010', 'C/E': '032010', Cm: 'x35543',
    D: 'xx0232', Dm: 'xx0231', D7: 'xx0212', Dmaj7: 'xx0222', Dm7: 'xx0211', Dsus2: 'xx0230', Dsus4: 'xx0233', 'D/F#': '200232', D6: 'xx0202',
    E: '022100', Em: '022000', E7: '020100', Em7: '022030', Emaj7: '021100', Esus4: '022200', E5: '022xxx',
    F: '133211', Fm: '133111', F7: '131211', Fmaj7: 'xx3210', 'F/C': 'x33211', Fsus2: 'xx3013',
    G: '320003', G7: '320001', Gmaj7: '320002', G6: '320000', Gsus4: '330013', 'G/B': 'x20003', Gm: '355333', G5: '355xxx',
    A: 'x02220', Am: 'x02210', A7: 'x02020', Am7: 'x02010', Amaj7: 'x02120', Asus2: 'x02200', Asus4: 'x02230', A7sus4: 'x02030',
    A6: 'x02222', A5: 'x022xx', 'A/C#': 'x42220', 'Am/G': '302210', 'Am/C': 'x32210',
    B: 'x24442', Bm: 'x24432', B7: 'x21202', Bm7: 'x20202', Bsus4: 'x24452', Bm7b5: 'x2323x',
    Bb: 'x13331', Bbm: 'x13321', Bb7: 'x13131', Bbmaj7: 'x13231',
    'F#': '244322', 'F#m': '244222', 'F#7': '242322', 'F#m7': '242222',
    'C#m': 'x46654', 'C#m7': 'x46454', 'G#m': '466444', Ab: '466544', Db: 'x46664', Eb: 'x68886',
  };
  for (const [sym, key] of Object.entries(want)) eq(first(sym), key, sym);
});

test('other spellings of the same chord get the same first shape', () => {
  eq(first('A#'), 'x13331');
  eq(first('Gb'), '244322');
  eq(first('C#'), 'x46664');
  eq(first('Abm'), '466444');
  eq(first('CM7'), 'x32000');
  eq(first('Dsus'), 'xx0233');
  eq(first('D2'), 'xx0230');
  eq(first('Gmaj'), '320003');
});

test('every curated shape spells its chord', () => {
  let count = 0;
  for (const [sym, shapes] of Object.entries(CANONICAL)) {
    const c = parseChord(sym);
    ok(c, `${sym} parses`);
    for (const s of [].concat(shapes)) {
      const frets = shape(s);
      const notes = [];
      frets.forEach((f, i) => { if (f >= 0) notes.push(STD[i] + f); });
      const pcs = new Set(notes.map(mod12));
      const allowed = new Set([...c.required, ...c.optional].map(iv => mod12(c.rootPc + iv)).concat(c.bassPc));
      ok([...pcs].every(p => allowed.has(p)), `${sym} ${s} only chord tones`);
      ok(c.required.every(iv => pcs.has(mod12(c.rootPc + iv))), `${sym} ${s} has every required tone`);
      eq(mod12(notes[0]), c.bassPc, `${sym} ${s} bass`);
      ok(Math.min(...notes) === notes[0], `${sym} ${s} lowest string is the bass`);
      // and the generator accepted it (it validates the table with the same rules as the search)
      ok(keys(sym, { limit: 32 }).includes(voicingKey(frets)), `${sym} ${s} is offered`);
      count++;
    }
  }
  ok(count >= 70, `table has ${count} shapes`);
});

test('fingers', () => {
  const find = (sym, key) => voicings(sym, { limit: 32 }).find(v => voicingKey(v) === key);
  deepEq(find('C', 'x32010').fingers, [0, 3, 2, 0, 1, 0], 'C');
  deepEq(find('G', '320003').fingers, [2, 1, 0, 0, 0, 3], 'G');
  deepEq(find('D', 'xx0232').fingers, [0, 0, 0, 1, 3, 2], 'D');
  const f = find('F', '133211');
  deepEq(f.barres, [{ fret: 1, from: 0, to: 5, finger: 1 }], 'F barre');
  deepEq(f.fingers, [1, 3, 4, 2, 1, 1], 'F');
  const a = find('A', 'x02220');
  deepEq(a.barres, [], 'A has no barre');
  deepEq(a.fingers, [0, 0, 1, 2, 3, 0], 'A');
  deepEq(find('E', '022100').fingers, [0, 2, 3, 1, 0, 0], 'E');
  deepEq(find('Am', 'x02210').fingers, [0, 0, 2, 3, 1, 0], 'Am');
  deepEq(find('B7', 'x21202').fingers, [0, 2, 1, 3, 0, 4], 'B7');
  deepEq(find('Fm', '133111').fingers, [1, 3, 4, 1, 1, 1], 'Fm skips a finger over the empty fret');
  const bm = find('Bm', 'x24432');
  deepEq(bm.barres, [{ fret: 2, from: 1, to: 5, finger: 1 }], 'Bm barre');
  deepEq(bm.fingers, [0, 1, 3, 4, 2, 1], 'Bm');
  const dm7 = find('Dm7', 'xx0211');
  deepEq(dm7.barres, [{ fret: 1, from: 4, to: 5, finger: 1 }], 'Dm7 small barre');
  deepEq(dm7.fingers, [0, 0, 0, 2, 1, 1], 'Dm7');
});

test('every chord the parser knows gets playable voicings', () => {
  const syms = [];
  for (const r of ROOTS) for (const s of SUFFIXES) syms.push(r + s);
  syms.push(...SLASHES);
  for (const r of ROOTS) syms.push(`${r}/E`, `${r}m/G`);
  let total = 0;
  for (const sym of syms) {
    ok(parseChord(sym), `${sym} parses`);
    const list = voicings(sym);
    ok(list.length >= 1, `${sym} has a voicing`);
    const suffix = parseChord(sym).suffix;
    if (COMMON.has(suffix) || (sym.includes('/') && ['', 'm'].includes(suffix))) ok(list.length >= 4, `${sym} has ${list.length} voicings`);
    assertValid(sym, list);
    total += list.length;
  }
  ok(total / syms.length >= 10, `about ${Math.round(total / syms.length)} voicings per chord`);
});

test('strict shapes fit four frets with at most one muted string inside', () => {
  for (const sym of ['C', 'G', 'Am', 'F', 'Bb', 'C#m', 'Dsus4', 'E7', 'Gmaj7', 'Fm7', 'D/F#', 'Cadd9']) {
    for (const v of voicings(sym)) {
      const pressed = v.frets.filter(f => f > 0);
      ok(!pressed.length || Math.max(...pressed) - Math.min(...pressed) <= 3, `${sym} ${voicingKey(v)} span`);
      const sounding = v.frets.map((f, s) => (f >= 0 ? s : -1)).filter(s => s >= 0);
      const inner = v.frets.slice(sounding[0], sounding[sounding.length - 1]).filter(f => f < 0).length;
      ok(inner <= 1, `${sym} ${voicingKey(v)} inner mutes`);
      ok(!v.relaxed, `${sym} needs no relaxing`);
    }
  }
});

test('results are sorted, deduplicated, limited and deterministic', () => {
  for (const sym of ['C', 'G7', 'F#m7b5', 'Bbmaj7#11/F', 'E5']) {
    const list = voicings(sym);
    eq(new Set(list.map(voicingKey)).size, list.length, `${sym} has no duplicates`);
    for (let i = 1; i < list.length; i++) ok(list[i - 1].score >= list[i].score, `${sym} sorted at ${i}`);
    ok(list.length <= 16, `${sym} default limit`);
  }
  eq(voicings('C', { limit: 3 }).length, 3);
  eq(voicings('C', { limit: 0 }).length, 0);
  ok(voicings('C', { limit: 30 }).length > 16, 'more on request');
  deepEq(voicings('C', { limit: 5 }), voicings('C').slice(0, 5), 'limit only truncates');
  // separate computations (different cache entries) of the same chord agree
  deepEq(voicings('CM'), voicings('Cmaj'));
  deepEq(voicings('Am7'), voicings('Am7'));
});

test('callers get their own copies', () => {
  const a = voicings('G');
  a[0].frets[0] = 9;
  a[0].fingers.length = 0;
  a.length = 0;
  eq(voicingKey(voicings('G')[0]), '320003');
  eq(voicings('G')[0].fingers.length, 6);
});

test('voicingKey and describe', () => {
  const c = voicings('C')[0];
  eq(voicingKey(c), 'x32010');
  eq(describe(c), 'x 3 2 0 1 0');
  eq(voicingKey([-1, 10, 12, 12, 12, 10]), 'x-10-12-12-12-10');
  eq(describe([-1, 10, 12, 12, 12, 10]), 'x 10 12 12 12 10');
  eq(voicingKey({ frets: [3, 2, 0, 0, 0, 3] }), '320003');
});

test('baseFret shows the nut only for shapes in the first four frets', () => {
  const at = (sym, key) => voicings(sym, { limit: 32 }).find(v => voicingKey(v) === key);
  eq(at('C', 'x32010').baseFret, 1);
  eq(at('A', '577655').baseFret, 5);
  eq(at('Eb', 'x68886').baseFret, 6);
  eq(at('C#m', 'x46654').baseFret, 4);
  eq(at('D', 'xx0775').baseFret, 5);
});

test('other tunings', () => {
  const dropD = TUNINGS.dropD.midi;
  eq(first('D', { tuning: dropD }), '000232', 'drop D uses the low D');
  eq(first('D', { tuning: TUNINGS.dropD }), '000232', 'a TUNINGS entry works as well');
  eq(first('C', { tuning: dropD }), 'x32010', 'shapes off the low string still work');
  eq(first('D', { tuning: TUNINGS.openD.midi }), '000000');
  eq(first('G', { tuning: TUNINGS.openG.midi }), 'x00000', 'open G with G in the bass');
  // same intervals as standard: the standard shapes, a semitone or two off
  eq(first('Eb', { tuning: TUNINGS.halfDown.midi }), '022100', 'E shape sounds Eb');
  eq(first('Bb', { tuning: TUNINGS.halfDown.midi }), 'x24442');
  eq(first('D', { tuning: TUNINGS.fullDown.midi }), '022100');
  eq(first('G', { tuning: TUNINGS.fullDown.midi }), 'x02220');
  for (const [name, t] of Object.entries(TUNINGS)) {
    for (const sym of ['D', 'G', 'Em', 'A7', 'Cmaj7', 'Bm', 'F#m7b5', 'D/F#', 'Esus4']) {
      const list = voicings(sym, { tuning: t.midi });
      ok(list.length >= 1, `${sym} in ${name}`);
      assertValid(sym, list, { tuning: t.midi });
    }
  }
});

test('when nothing fits, a tone is left out and the voicing says so', () => {
  // with only the first four frets a 13b9 can't keep all five tones
  const list = voicings('C13b9', { maxFret: 4 });
  ok(list.length >= 1);
  const c = parseChord('C13b9');
  for (const v of list) {
    ok(v.relaxed, `${voicingKey(v)} is marked relaxed`);
    const pcs = new Set(v.notes.map(mod12));
    const missing = c.required.filter(iv => !pcs.has(mod12(c.rootPc + iv)));
    eq(missing.length, 1, `${voicingKey(v)} drops exactly one tone`);
    ok(![0, 4, 10].includes(missing[0]), `${voicingKey(v)} keeps the root, third and seventh`);
    ok(v.frets.every(f => f <= 4), `${voicingKey(v)} stays in range`);
    assertValid('C13b9', [v], { maxFret: 4 });
  }
  // even no frets at all still gives something to show
  const open = voicings('F#m7b5', { maxFret: 0 });
  ok(open.length >= 1 && open.every(v => v.relaxed), 'last resort');
  assertValid('F#m7b5', open);
});

test('power chords stay on the bass strings', () => {
  eq(first('E5'), '022xxx');
  eq(first('A5'), 'x022xx');
  eq(first('G5'), '355xxx');
  eq(first('C5'), 'x355xx');
  eq(first('F5'), '133xxx');
  for (const v of voicings('B5').slice(0, 4)) ok(v.notes.length <= 3, `${voicingKey(v)} is a small shape`);
});

test('the list spreads along the neck instead of repeating one shape', () => {
  const variant = (a, b) => a.frets.every((f, s) => f === b.frets[s] || f < 0 || b.frets[s] < 0)
    && a.frets.filter((f, s) => (f < 0) !== (b.frets[s] < 0)).length <= 1;
  for (const sym of ['G', 'C', 'D', 'A', 'E', 'Am', 'Em', 'F', 'Bm']) {
    const top = voicings(sym, { limit: 8 });
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) ok(!variant(top[i], top[j]), `${sym}: ${voicingKey(top[i])} ~ ${voicingKey(top[j])}`);
    }
    ok(new Set(top.map(v => v.baseFret)).size >= 3, `${sym} covers several positions`);
  }
  // and the classic barre shape is in the first few for the open chords
  ok(keys('G', { limit: 4 }).includes('355433'), 'G barre');
  ok(keys('C', { limit: 4 }).includes('x35553'), 'C barre');
  ok(keys('A', { limit: 4 }).includes('577655'), 'A barre');
});

test('hundreds of chords are fast to compute', () => {
  const syms = [];
  for (const r of ROOTS) for (const s of SUFFIXES) syms.push(r + s);
  for (const s of SLASHES) syms.push(s);
  // a tuning nothing else uses, so none of this is cached yet
  const tuning = STD.map(m => m + 12);
  const t0 = performance.now();
  for (const sym of syms) ok(voicings(sym, { tuning }).length >= 1, sym);
  const ms = performance.now() - t0;
  ok(syms.length >= 600, `${syms.length} chords`);
  ok(ms < 3000, `${syms.length} chords took ${Math.round(ms)} ms`);
  const t1 = performance.now();
  for (const sym of syms) voicings(sym, { tuning });
  ok(performance.now() - t1 < 200, 'cached calls are cheap');
});
