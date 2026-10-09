import { test, eq, ok, deepEq } from '../harness.js';
import { parseTCList, matchEntry, numberVersions, groupResults, shapesFromApplicature, songFromTab, videoIdFrom, score } from '../../js/ug.js';

// A made-up list in the exact shape of the Tabs & Chords "My tabs" page.
const SAMPLE = [
  'My tabs', 'All', 'Chords', 'Artist\tSong\tDate\tType\t',
  'The Example Band\t', 'First Song', 'Jul 16, 2024 \tChords\t',
  'Second Song (ver 2)', 'Jul 17, 2024 \tChords\t',
  'Solo Artist\t', 'Ballad', 'Apr 30, 2025 \tGuitar Pro\t',
  'The Example Band\t', 'Third Song', '30 days ago \tChords\t',
  'Per page', 'Showing 1 - 4 of 4',
].join('\n');

test('reads a Tabs & Chords list: artists carry over, versions and types', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const e = parseTCList(SAMPLE, now);
  eq(e.length, 4);
  deepEq(e.map(x => [x.artist, x.title, x.version, x.type]), [
    ['The Example Band', 'First Song', 1, 'Chords'],
    ['The Example Band', 'Second Song', 2, 'Chords'],
    ['Solo Artist', 'Ballad', 1, 'Guitar Pro'],
    ['The Example Band', 'Third Song', 1, 'Chords'],
  ]);
  eq(e[0].date.slice(0, 10), '2024-07-16');
  eq(e[3].date.slice(0, 10), '2026-09-08');
});

test('reads the owner\'s real list (local corpus)', async () => {
  let text;
  try { const r = await fetch('corpus/tc-favorites.txt'); if (!r.ok) return; text = await r.text(); } catch { return; }
  const e = parseTCList(text);
  eq(e.length, 233);
  eq(e.filter(x => x.artist === 'Zach Bryan').length, 38);
  ok(e.every(x => x.artist && x.title));
});

test('versions are numbered in Ultimate Guitar\'s order when the worker leaves them out', () => {
  const r = numberVersions([
    { title: 'Song', artist: 'A', type: 'Chords', url: 'u1' },
    { title: 'Song', artist: 'A', type: 'Chords', url: 'u2' },
    { title: 'Song', artist: 'A', type: 'Pro', url: 'u3' },
    { title: 'Other', artist: 'A', type: 'Chords', url: 'u4' },
    { title: 'Song', artist: 'A', type: 'Chords', url: 'u5', version: 7 },
  ]);
  deepEq(r.map(x => x.version), [1, 2, 1, 1, 7]);
});

test('matching picks the same version, falls back sensibly', () => {
  const results = [
    { title: 'Song', artist: 'The Band', type: 'Chords', url: 'v1', rating: 4.5, votes: 10 },
    { title: 'Song', artist: 'The Band', type: 'Chords', url: 'v2', rating: 4.9, votes: 900 },
    { title: 'Song', artist: 'The Band', type: 'Pro', url: 'gp', rating: 4.7, votes: 50 },
  ];
  eq(matchEntry({ artist: 'The Band', title: 'Song', version: 2, type: 'Chords' }, results).result.url, 'v2');
  eq(matchEntry({ artist: 'The Band', title: 'Song', version: 1, type: 'Chords' }, results).result.url, 'v1');
  eq(matchEntry({ artist: 'the band', title: 'song', version: 5, type: 'Chords' }, results).how, 'closest');
  const gp = matchEntry({ artist: 'The Band', title: 'Song', version: 1, type: 'Guitar Pro' }, results);
  eq(gp.how, 'chords-for-pro');
  eq(gp.result.url, 'v2');
  eq(matchEntry({ artist: 'Nobody', title: 'Song', version: 1, type: 'Chords' }, results).result, null);
  // punctuation and apostrophes don't matter
  eq(matchEntry({ artist: 'The Band', title: "Song", version: 1, type: 'Chords' }, [{ title: "Song", artist: 'The Band', type: 'Chords', url: 'x' }]).result.url, 'x');
  eq(matchEntry({ artist: 'Bob Dylan', title: 'Dont Think Twice Its All Right', version: 1, type: 'Chords' }, [{ title: "Don't Think Twice It's All Right", artist: 'Bob Dylan', type: 'Chords', url: 'y' }]).result.url, 'y');
});

test('matching works on the real search results in the corpus', async () => {
  let index;
  try { const r = await fetch('corpus/index.json'); if (!r.ok) return; index = await r.json(); } catch { return; }
  const badOld = [], badNew = [];
  let n = 0;
  for (const key of Object.keys(index)) {
    const rec = await (await fetch(`corpus/songs/${key}.json`)).json();
    if (!rec.match || rec.entry.type === 'Guitar Pro') continue;
    n++;
    const typed = rec.results.filter(r => ['Chords', 'Pro'].includes(r.type));
    // the updated worker sends version numbers: every match must be exact
    const withVersions = matchEntry(rec.entry, typed);
    if (withVersions.result?.url !== rec.match.url) badNew.push(`${key}: got ${withVersions.result?.url}, want ${rec.match.url}`);
    // the deployed worker doesn't: versions are counted in Ultimate Guitar's
    // order, which is wrong only where UG itself numbers two tabs "version 1"
    const m = matchEntry(rec.entry, typed.map(({ version, ...r }) => r));
    if (m.result?.url !== rec.match.url) badOld.push(key);
  }
  ok(n > 200, `only ${n} checked`);
  eq(badNew.length, 0, badNew.slice(0, 6).join('\n'));
  ok(badOld.length <= n * 0.03, `${badOld.length} wrong without version numbers: ${badOld.join(', ')}`);
});

test('grouping results into songs with versions', () => {
  const g = groupResults(numberVersions([
    { title: 'Song', artist: 'A', type: 'Chords', url: '1', rating: 4.1, votes: 5 },
    { title: 'Song', artist: 'A', type: 'Chords', url: '2', rating: 4.8, votes: 3000 },
    { title: 'Other', artist: 'B', type: 'Chords', url: '3', rating: 5, votes: 2 },
    { title: 'Song', artist: 'A', type: 'Bass Tabs', url: '4' },
  ]));
  eq(g.length, 2);
  eq(g[0].versions.length, 2);
  eq(g[0].best.url, '2');
  ok(score({ rating: 4.8, votes: 3000 }) > score({ rating: 5, votes: 2 }));
});

test('chord shapes from Ultimate Guitar data are flipped to low string first', () => {
  const s = shapesFromApplicature({
    Em7: [{ frets: [0, 0, 0, 0, 2, 0] }, { frets: [3, 0, 0, 0, 2, 0] }],
    C: [{ frets: [3, 5, 5, 5, 3, -1] }],
    'not a chord': [{ frets: [0, 0, 0, 0, 0, 0] }],
  });
  deepEq(s, { Em7: [[0, 2, 0, 0, 0, 0], [0, 2, 0, 0, 0, 3]], C: [[-1, 3, 5, 5, 5, 3]] });
});

test('a song from a tab takes capo, key and tuning from the metadata', () => {
  const content = '[Verse]\n[tab][ch]G[/ch]   [ch]C[/ch]\nHello there[/tab]';
  const s = songFromTab({ title: 'T', artist: 'A', type: 'Chords', url: 'https://tabs.ultimate-guitar.com/tab/a/t-chords-123', version: 2, rating: 4.8, votes: 10 },
    { content, meta: { capo: 3, tonality: 'G', tuning: { value: 'Eb Ab Db Gb Bb Eb' } }, strummings: [{ bpm: 120 }] });
  eq(s.capo, 3); eq(s.key, 'G'); eq(s.tuning, 'Eb Ab Db Gb Bb Eb'); eq(s.bpm, 120);
  eq(s.src.id, 123); eq(s.src.version, 2);
  // the deployed worker: text only — capo read from the text, key guessed from the chords
  const t = songFromTab({ title: 'T', artist: 'A', type: 'Chords', url: 'u' }, { content: 'Capo 2\n[ch]D[/ch] [ch]A[/ch] [ch]Bm[/ch] [ch]G[/ch] [ch]D[/ch]' });
  eq(t.capo, 2); eq(t.key, 'D');
});

test('YouTube links', () => {
  eq(videoIdFrom('https://www.youtube.com/watch?v=Lw7Q19mtly0&t=3'), 'Lw7Q19mtly0');
  eq(videoIdFrom('https://youtu.be/Lw7Q19mtly0'), 'Lw7Q19mtly0');
  eq(videoIdFrom('Lw7Q19mtly0'), 'Lw7Q19mtly0');
  eq(videoIdFrom('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  eq(videoIdFrom('nope'), null);
});
