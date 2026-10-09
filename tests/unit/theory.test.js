import { test, eq, ok, deepEq } from '../harness.js';
import { pc, parseChord, isChord, transposeChord, transposeKey, keyPrefersFlats, simplifyChord, detectKey, respell } from '../../js/theory.js';

const tones = sym => {
  const c = parseChord(sym);
  return c && { req: c.required, opt: c.optional, bass: c.bassPc, root: c.rootPc };
};

test('pitch classes', () => {
  eq(pc('C'), 0); eq(pc('C#'), 1); eq(pc('Db'), 1); eq(pc('B#'), 0); eq(pc('Cb'), 11);
  eq(pc('E♭'), 3); eq(pc('F♯'), 6); eq(pc('H'), -1); eq(pc(''), -1);
});

test('common chords parse to the right tones', () => {
  deepEq(tones('C'), { req: [0, 4], opt: [7], bass: 0, root: 0 });
  deepEq(tones('Am').req, [0, 3]);
  deepEq(tones('G7').req, [0, 4, 10]);
  deepEq(tones('Cmaj7').req, [0, 4, 11]);
  deepEq(tones('Em7').req, [0, 3, 10]);
  deepEq(tones('Dsus4').req, [0, 5]);
  deepEq(tones('Dsus2').req, [0, 2]);
  deepEq(tones('Dsus').req, [0, 5]);
  deepEq(tones('D2').req, [0, 2]);
  deepEq(tones('Cadd9').req, [0, 2, 4]);
  deepEq(tones('C6').req, [0, 4, 9]);
  deepEq(tones('C69').req, [0, 2, 4, 9]);
  deepEq(tones('C6/9').req, [0, 2, 4, 9]);
  deepEq(tones('E5'), { req: [0, 7], opt: [], bass: 4, root: 4 });
  deepEq(tones('Bdim').req, [0, 3, 6]);
  deepEq(tones('Bdim7').req, [0, 3, 6, 9]);
  deepEq(tones('Bo7').req, [0, 3, 6, 9]);
  deepEq(tones('Bm7b5').req, [0, 3, 6, 10]);
  deepEq(tones('Bø').req, [0, 3, 6, 10]);
  deepEq(tones('F#m7(b5)').req, [0, 3, 6, 10]);
  deepEq(tones('Caug').req, [0, 4, 8]);
  deepEq(tones('C+').req, [0, 4, 8]);
  deepEq(tones('A7sus4').req, [0, 5, 10]);
  deepEq(tones('E7#9').req, [0, 3, 4, 10]);
  deepEq(tones('E7b9').req, [0, 1, 4, 10]);
  deepEq(tones('C9').req, [0, 2, 4, 10]);
  deepEq(tones('Cmaj9').req, [0, 2, 4, 11]);
  deepEq(tones('Am9').req, [0, 2, 3, 10]);
  deepEq(tones('CmMaj7').req, [0, 3, 11]);
  deepEq(tones('Cm(maj7)').req, [0, 3, 11]);
  deepEq(tones('C11'), { req: [0, 5, 10], opt: [2, 7], bass: 0, root: 0 });
  deepEq(tones('Am11').req, [0, 3, 5, 10]);
  deepEq(tones('G13').req, [0, 4, 9, 10]);
  deepEq(tones('Cmaj7#11').req, [0, 4, 6, 11]);
  deepEq(tones('Cmaj').req, [0, 4], 'bare maj is a triad');
  deepEq(tones('CM').req, [0, 4], 'bare M is a triad');
  deepEq(tones('CM7').req, [0, 4, 11]);
  deepEq(tones('Cm6').req, [0, 3, 9]);
  deepEq(tones('Cmadd9').req, [0, 2, 3]);
  deepEq(tones('Cadd11').req, [0, 4, 5]);
});

test('slash chords keep their bass', () => {
  eq(parseChord('D/F#').bass, 'F#');
  eq(parseChord('D/F#').bassPc, 6);
  eq(parseChord('G/B').bassPc, 11);
  eq(parseChord('Am7/G').bassPc, 7);
  eq(parseChord('Cmaj7/G').suffix, 'maj7');
  eq(parseChord('Bb/D').root, 'Bb');
  eq(parseChord('C').bass, null);
});

test('flats after the root letter belong to the root', () => {
  eq(parseChord('Bb5').root, 'Bb');
  ok(parseChord('Bb5').quality.power);
  eq(parseChord('Eb9').root, 'Eb');
  deepEq(parseChord('Eb9').required, [0, 2, 4, 10]);
  eq(parseChord('Ab').rootPc, 8);
});

test('things that are not chords', () => {
  for (const s of ['N.C.', 'x2', 'x4', 'Intro', 'Chorus', 'Bridge', 'Verse', '|', '-', '(x2)', 'Bad', 'Add', 'Do', 'Be', 'Em7add', 'Hm', '', 'Cmajor7th', 'Gee']) {
    ok(!isChord(s), `"${s}" should not be a chord`);
  }
  for (const s of ['A', 'Am', 'E', 'Em7', 'C#m', 'F#m7', 'Bbmaj7', 'Gsus4', 'D/F#', 'Asus2', 'G6', 'C*', 'Dm7/C', 'E7sus4', 'Fmaj7#11', 'G7(b9)', 'Dadd9/F#']) {
    ok(isChord(s), `"${s}" should be a chord`);
  }
});

test('transposing keeps the suffix and moves root and bass', () => {
  eq(transposeChord('G', 2), 'A');
  eq(transposeChord('D/F#', 2), 'E/G#');
  eq(transposeChord('Em7', -2), 'Dm7');
  eq(transposeChord('Bb', 2, false), 'C');
  eq(transposeChord('C', 1, true), 'Db');
  eq(transposeChord('C', 1, false), 'C#');
  eq(transposeChord('F#m7b5', 12), 'F#m7b5');
  eq(transposeChord('not a chord', 3), 'not a chord');
  eq(respell('A#', true), 'Bb');
  eq(respell('Gb/Bb', false), 'F#/A#');
});

test('keys and their spelling', () => {
  ok(keyPrefersFlats('F')); ok(keyPrefersFlats('Bb')); ok(keyPrefersFlats('Dm')); ok(keyPrefersFlats('Cm'));
  ok(!keyPrefersFlats('G')); ok(!keyPrefersFlats('E')); ok(!keyPrefersFlats('Em')); ok(!keyPrefersFlats('F#'));
  eq(transposeKey('G', 3), 'Bb');
  eq(transposeKey('Em', 5), 'Am');
  eq(transposeKey('A', -1), 'Ab');
  eq(transposeKey('Am', -1), 'G#m');
  eq(transposeKey('C', 1), 'Db');
});

test('simplify reduces to triads', () => {
  eq(simplifyChord('Cmaj7'), 'C');
  eq(simplifyChord('Am7'), 'Am');
  eq(simplifyChord('G/B'), 'G');
  eq(simplifyChord('Dsus4'), 'D');
  eq(simplifyChord('Bm7b5'), 'Bdim');
  eq(simplifyChord('Cadd9'), 'C');
  eq(simplifyChord('E7#9'), 'E');
  eq(simplifyChord('F#m11'), 'F#m');
  eq(simplifyChord('Caug'), 'Caug');
  eq(simplifyChord('x2'), 'x2');
});

test('key detection on typical progressions', () => {
  eq(detectKey(['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'G']), 'G');
  eq(detectKey(['C', 'G', 'Am', 'F', 'C']), 'C');
  eq(detectKey(['Am', 'G', 'F', 'E', 'Am']), 'Am');
  eq(detectKey(['D', 'A', 'Bm', 'G', 'D']), 'D');
  eq(detectKey(['E', 'B', 'C#m', 'A', 'E']), 'E');
  eq(detectKey(['Em', 'C', 'G', 'D', 'Em']), 'Em');
  eq(detectKey(['F', 'C', 'Dm', 'Bb', 'F']), 'F');
  eq(detectKey(['A', 'D', 'E', 'A', 'G', 'D', 'A']), 'A');
  eq(detectKey([]), null);
});
