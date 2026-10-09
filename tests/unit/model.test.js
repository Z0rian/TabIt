import { test, eq, ok, deepEq } from '../harness.js';
import { emptyLibrary, makeSong, applyOp, applyOps, invertOp, normalize, searchSongs, sortSongs, groupByArtist, findDuplicate, fold } from '../../js/model.js';

const lib0 = () => {
  let lib = emptyLibrary();
  lib = applyOp(lib, { t: 'add', song: makeSong({ id: 's-1', title: 'Fast Lane', artist: 'The Example Band', content: 'x', added: '2024-01-01T00:00:00Z' }) });
  lib = applyOp(lib, { t: 'add', song: makeSong({ id: 's-2', title: 'Slow River', artist: 'Ana Sample', content: 'y', added: '2025-01-01T00:00:00Z', fav: true }) });
  return lib;
};

test('ops add, set, view, delete — without touching the original', () => {
  const a = lib0();
  const b = applyOps(a, [
    { t: 'set', id: 's-1', set: { fav: true, notes: 'capo 2' } },
    { t: 'view', id: 's-1', set: { tr: 2 } },
    { t: 'view', id: 's-1', set: { fs: 20 } },
    { t: 'set', id: 's-2', set: { fav: null } },
  ]);
  eq(a.songs['s-1'].fav, undefined);
  eq(b.songs['s-1'].fav, true);
  deepEq(b.songs['s-1'].view, { tr: 2, fs: 20 });
  ok(!('fav' in b.songs['s-2']), 'null deletes the field');
  const c = applyOp(b, { t: 'del', id: 's-1' });
  ok(!c.songs['s-1']);
  // adding an existing id is ignored
  eq(applyOp(b, { t: 'add', song: { id: 's-2', title: 'X' } }).songs['s-2'].title, 'Slow River');
});

test('setlists follow deleted songs', () => {
  let lib = applyOp(lib0(), { t: 'list', id: 'l-1', set: { name: 'Gig', songs: ['s-1', 's-2', 's-1'] } });
  deepEq(lib.setlists['l-1'].songs, ['s-1', 's-2'], 'no duplicates');
  lib = applyOp(lib, { t: 'del', id: 's-1' });
  deepEq(lib.setlists['l-1'].songs, ['s-2']);
});

test('every op can be undone', () => {
  const base = applyOp(lib0(), { t: 'list', id: 'l-1', set: { name: 'Gig', songs: ['s-1'] } });
  const ops = [
    { t: 'set', id: 's-1', set: { fav: true, title: 'Renamed' } },
    { t: 'view', id: 's-1', set: { tr: -3 } },
    { t: 'del', id: 's-1' },
    { t: 'add', song: makeSong({ id: 's-9', title: 'New' }) },
    { t: 'list', id: 'l-1', set: { name: 'Renamed gig' } },
    { t: 'list-del', id: 'l-1' },
    { t: 'prefs', set: { duration: 200 } },
    { t: 'many', ops: [{ t: 'set', id: 's-2', set: { notes: 'n' } }, { t: 'del', id: 's-2' }] },
  ];
  for (const op of ops) {
    const after = applyOp(base, op);
    const back = applyOp(after, invertOp(base, op));
    deepEq(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(base)), `undo of ${op.t}`);
  }
});

test('normalize repairs junk', () => {
  const lib = normalize({ songs: { a: { title: 5 }, b: null }, setlists: { l: { songs: ['a', 3] } } });
  eq(lib.songs.a.title, '5');
  eq(lib.songs.a.content, '');
  ok(!lib.songs.b);
  deepEq(lib.setlists.l.songs, ['a']);
  deepEq(normalize(null), emptyLibrary());
});

test('search ignores accents, case and punctuation; ranks title matches first', () => {
  const songs = Object.values(applyOp(lib0(), { t: 'add', song: makeSong({ id: 's-3', title: 'Chachachá', artist: "Don't Stop" }) }).songs);
  eq(searchSongs(songs, 'chachacha')[0].id, 's-3');
  eq(searchSongs(songs, 'dont')[0].id, 's-3');
  eq(searchSongs(songs, 'river ana')[0].id, 's-2');
  eq(searchSongs(songs, 'slo')[0].id, 's-2');
  eq(searchSongs(songs, 'zzz').length, 0);
  eq(fold('Simon & Garfunkel'), 'simon and garfunkel');
});

test('sorting and grouping', () => {
  const songs = Object.values(lib0().songs);
  deepEq(sortSongs(songs, 'added').map(s => s.id), ['s-2', 's-1']);
  deepEq(sortSongs(songs, 'title').map(s => s.id), ['s-1', 's-2']);
  // "The" is ignored when sorting artists
  deepEq(sortSongs(songs, 'artist').map(s => s.id), ['s-2', 's-1']);
  deepEq(groupByArtist(songs).map(g => g.artist), ['Ana Sample', 'The Example Band']);
});

test('duplicates by source url, or same title/artist/text', () => {
  const lib = applyOp(lib0(), { t: 'add', song: makeSong({ id: 's-4', title: 'U', src: { site: 'ug', url: 'https://x/1' } }) });
  eq(findDuplicate(lib, { title: 'whatever', src: { url: 'https://x/1' } })?.id, 's-4');
  eq(findDuplicate(lib, { title: 'Fast Lane', artist: 'The Example Band', content: 'x' })?.id, 's-1');
  eq(findDuplicate(lib, { title: 'Fast Lane', artist: 'The Example Band', content: 'different' }), null);
});
