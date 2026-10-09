import { test, eq, ok, deepEq } from '../harness.js';
import { parseSong, toPlainText, fromPlainText, decodeEntities, snapAnchors } from '../../js/parse.js';

// Lyrics here are invented; only the layouts copy real Ultimate Guitar sheets.
const types = doc => doc.blocks.map(b => b.type);
const pairs = doc => doc.blocks.filter(b => b.type === 'pair');
const at = (pair, name) => pair.chords.find(c => c.name === name)?.at;

test('UG chord line + lyric line become a pair with exact columns', () => {
  // Em7 at column 7, D/F# at 31, G at 52 once the tags are removed
  const chordLine = ' '.repeat(7) + '[ch]Em7[/ch]' + ' '.repeat(21) + '[ch]D/F#[/ch]' + ' '.repeat(17) + '[ch]G[/ch]';
  const src = `[Verse 1]\n[tab]${chordLine}\nThey'll be fine by sunrise I'm telling you lately[/tab]`;
  const doc = parseSong(src);
  deepEq(types(doc), ['section', 'pair']);
  const p = pairs(doc)[0];
  eq(p.lyric, "They'll be fine by sunrise I'm telling you lately");
  // Em7 sits over the space before "be" (col 7) and snaps onto "be"
  eq(at(p, 'Em7'), 8);
  eq(p.lyric.slice(8, 10), 'be');
  // D/F# at col 31 is the "t" of "telling" — tags don't shift later chords
  eq(at(p, 'D/F#'), 31);
  eq(p.lyric.slice(31, 38), 'telling');
  // G is past the end of the lyric: kept as a trailing chord
  ok(at(p, 'G') >= p.lyric.length);
  deepEq(doc.chords, ['Em7', 'D/F#', 'G']);
});

test('later chords are not shifted by the tags of earlier ones', () => {
  const chordLine = '[ch]C[/ch]    [ch]G[/ch]    [ch]Am[/ch]   [ch]F[/ch]';
  const lyric = 'One two three four five six seven';
  const p = pairs(parseSong(chordLine + '\n' + lyric))[0];
  deepEq(p.chords.map(c => c.at), [0, 5, 10, 15]);
});

test('plain chords-over-lyrics text is detected and paired', () => {
  const chordLine = 'G' + ' '.repeat(7) + 'D' + ' '.repeat(13) + 'Em' + ' '.repeat(11) + 'C';
  const src = chordLine + '\nWalking down the road with nothing but a song\n\nAm   (x2)\n';
  const doc = parseSong(src);
  deepEq(types(doc), ['pair', 'blank', 'chords']);
  const p = pairs(doc)[0];
  deepEq(p.chords.map(c => [c.name, c.at]), [['G', 0], ['D', 8], ['Em', 22], ['C', 35]]);
  eq(p.lyric.slice(8, 12), 'down');
  eq(p.lyric.slice(22, 26), 'with');
  eq(p.lyric.slice(35, 38), 'but');
});

test('the old app\'s bracketed chord lines keep their real columns', () => {
  // The previous TabIt stored "[G]" in chord-only lines; each pair of brackets
  // shifted later chords right by two columns.
  const src = '     [G]        [B]\nWhen the sky was falling down';
  const p = pairs(parseSong(src))[0];
  deepEq(p.chords.map(c => [c.name, c.at]), [['G', 5], ['B', 14]]);
});

test('inline ChordPro chords anchor to the following text', () => {
  const p = pairs(parseSong('[G]Mama take this [D]badge off of [Am]me'))[0];
  eq(p.lyric, 'Mama take this badge off of me');
  deepEq(p.chords.map(c => [c.name, c.at]), [['G', 0], ['D', 15], ['Am', 28]]);
  const mid = pairs(parseSong('Some-[C]where over'))[0];
  eq(mid.lyric, 'Some-where over');
  eq(at(mid, 'C'), 5);
});

test('chord-only lines, including bars and repeats', () => {
  const doc = parseSong('[Intro]\n[ch]G[/ch] [ch]D[/ch] [ch]Em[/ch] [ch]C[/ch] (x2)\n\n| G . . . | D . . . |');
  deepEq(types(doc), ['section', 'chords', 'blank', 'chords']);
  deepEq(doc.blocks[1].items.map(x => x.chord || x.text), ['G', 'D', 'Em', 'C', '(x2)']);
  deepEq(doc.blocks[3].items.filter(x => x.chord).map(x => x.chord), ['G', 'D']);
});

test('marked chord lines with words are shown inline and not paired', () => {
  const doc = parseSong('Intro: [ch]G[/ch]  [ch]C[/ch]  play twice\nThen the words begin here');
  deepEq(types(doc), ['chords', 'lyric']);
  deepEq(doc.blocks[0].items.map(x => x.chord || x.text), ['Intro:', 'G', 'C', 'play', 'twice']);
});

test('tablature stays together, chord names above it keep columns', () => {
  const src = '[tab]  Fill 1 (*)\ne|-----------|\nB|-----------|\nG|-----------|\nD|-----------|\nA|-----------|\nE|-2--/7--0--|  / = slide up[/tab]\n\n[Intro]\n[ch]Em7[/ch]  *  [ch]G[/ch]';
  const doc = parseSong(src);
  deepEq(types(doc), ['tab', 'blank', 'section', 'chords']);
  const tab = doc.blocks[0];
  eq(tab.lines.length, 7);
  eq(tab.lines[0].text, '  Fill 1 (*)');
  eq(tab.lines[6].text, 'E|-2--/7--0--|  / = slide up');
  const t2 = parseSong('   G         C\ne|---3-----|---0-----|\nB|---0-----|---1-----|\n');
  eq(t2.blocks.length, 1);
  eq(t2.blocks[0].type, 'tab');
  deepEq(t2.blocks[0].lines[0].chords, [{ col: 3, name: 'G' }, { col: 13, name: 'C' }]);
  eq(t2.blocks[0].lines[0].text, '   G         C');
});

test('section headers, with notes', () => {
  const doc = parseSong('[Chorus] x2\nLa la la\n\nVerse 2:\nMore words here\n[Pre-Chorus]');
  deepEq(types(doc), ['section', 'lyric', 'blank', 'section', 'lyric', 'section']);
  eq(doc.blocks[0].label, 'Chorus');
  eq(doc.blocks[0].note, 'x2');
  eq(doc.blocks[3].label, 'Verse 2');
});

test('section header followed by chords on the same line', () => {
  const doc = parseSong('[Intro] [ch]Am[/ch] [ch]F[/ch]');
  deepEq(types(doc), ['section', 'chords']);
});

test('lyric lines that only look a bit like chords are not chord lines', () => {
  const doc = parseSong('A man walks down\nAm I wrong\nBe that way');
  deepEq(types(doc), ['lyric', 'lyric', 'lyric']);
});

test('meta: capo, key, tuning, tempo from the text', () => {
  const doc = parseSong('Capo: 2nd fret\nKey: Em\nTuning: Eb Ab Db Gb Bb Eb\n120 bpm\n\n[Verse]\nla');
  eq(doc.meta.capo, 2);
  eq(doc.meta.key, 'Em');
  eq(doc.meta.tuning, 'Eb Ab Db Gb Bb Eb');
  eq(doc.meta.bpm, 120);
  eq(parseSong('CAPO ON THIRD FRET').meta.capo, 3);
  eq(parseSong('capo 5').meta.capo, 5);
});

test('entities and CRLF', () => {
  eq(decodeEntities('Don&#039;t &amp; won&rsquo;t'), 'Don\'t & won’t');
  const doc = parseSong('[ch]C[/ch]\r\nDon&#039;t stop\r\n');
  eq(pairs(doc)[0].lyric, "Don't stop");
});

test('snapping: one space before a word moves on, a long gap stays', () => {
  deepEq(snapAnchors('go home now', [{ at: 2, name: 'G' }]).map(c => c.at), [3]);
  deepEq(snapAnchors('go    home', [{ at: 3, name: 'G' }]).map(c => c.at), [3]);
  // two chords never share a character
  deepEq(snapAnchors('abc', [{ at: 1, name: 'G' }, { at: 1, name: 'C' }]).map(c => c.at), [1, 2]);
});

test('plain text round trip keeps columns', () => {
  const ug = '[Verse]\n[tab]   [ch]G[/ch]      [ch]D/F#[/ch]\nHello there friend[/tab]\n[ch]Am[/ch] (x2)';
  const plain = toPlainText(ug);
  eq(plain, '[Verse]\n   G      D/F#\nHello there friend\nAm (x2)');
  const back = fromPlainText(plain);
  eq(back, '[Verse]\n   [ch]G[/ch]      [ch]D/F#[/ch]\nHello there friend\n[ch]Am[/ch] (x2)');
  // and both parse the same
  deepEq(parseSong(back).blocks, parseSong(ug).blocks.map(b => b));
  eq(fromPlainText('(G)  (C)'), '([ch]G[/ch])  ([ch]C[/ch])');
});

test('blank lines collapse and edges are trimmed', () => {
  deepEq(types(parseSong('\n\n[ch]G[/ch]\nla\n\n\n\nla\n\n')), ['pair', 'blank', 'lyric']);
});
