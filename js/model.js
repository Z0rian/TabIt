// The library: songs, setlists and synced settings, plus the edit operations
// ("ops") that change it. Pure functions, no DOM or storage.
//
// Every change is an op so edits made offline, or on two devices at once, can
// be re-applied on top of the newest synced copy (see sync.js). Ops must stay
// meaningful when replayed on a newer library: they set values, they don't toggle.
//
//  { t: 'add', song }                       add a song (ignored if the id exists)
//  { t: 'set', id, set: { field: value } }  change song fields (undefined/null deletes)
//  { t: 'view', id, set: { tr, capo, … } }  per-song view settings, merged
//  { t: 'del', id }                         delete a song (also leaves setlists)
//  { t: 'list', id, set: { name, songs } }  create (needs a name)/change a setlist
//  { t: 'list-del', id }
//  { t: 'prefs', set: { … } }               synced settings
//  { t: 'many', ops: [...] }

export const SONG_FIELDS = ['title', 'artist', 'kind', 'content', 'src', 'key', 'capo', 'tuning', 'bpm', 'duration', 'durationFrom', 'yt', 'fav', 'added', 'edited', 'played', 'plays', 'notes', 'view', 'shapes', 'strum', 'cover'];

export function emptyLibrary() {
  return { v: 1, songs: {}, setlists: {}, prefs: {} };
}

export function newId(prefix = 's') {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return prefix + '-' + [...b].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

export function makeSong(fields) {
  const now = new Date().toISOString();
  const s = {
    id: fields.id || newId('s'),
    title: String(fields.title || 'Untitled').trim(),
    artist: String(fields.artist || '').trim(),
    kind: fields.kind || 'chords',
    content: String(fields.content || ''),
    added: fields.added || now,
  };
  for (const k of SONG_FIELDS) if (fields[k] !== undefined && s[k] === undefined && fields[k] !== null && fields[k] !== '') s[k] = fields[k];
  return s;
}

const clean = o => {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
  return o;
};

export function applyOp(lib, op) {
  switch (op.t) {
    case 'add': {
      const s = op.song;
      if (!s || !s.id || lib.songs[s.id]) return lib;
      return { ...lib, songs: { ...lib.songs, [s.id]: { ...s } } };
    }
    case 'set': {
      const cur = lib.songs[op.id];
      if (!cur) return lib;
      const next = clean({ ...cur, ...op.set, id: cur.id });
      return { ...lib, songs: { ...lib.songs, [op.id]: next } };
    }
    case 'view': {
      const cur = lib.songs[op.id];
      if (!cur) return lib;
      const view = clean({ ...(cur.view || {}), ...op.set });
      const next = { ...cur };
      if (Object.keys(view).length) next.view = view; else delete next.view;
      return { ...lib, songs: { ...lib.songs, [op.id]: next } };
    }
    case 'del': {
      if (!lib.songs[op.id]) return lib;
      const songs = { ...lib.songs };
      delete songs[op.id];
      const setlists = {};
      for (const [k, l] of Object.entries(lib.setlists)) setlists[k] = l.songs.includes(op.id) ? { ...l, songs: l.songs.filter(x => x !== op.id) } : l;
      return { ...lib, songs, setlists };
    }
    case 'list': {
      // a change to a setlist another device deleted doesn't bring it back
      if (!lib.setlists[op.id] && !op.set?.name) return lib;
      const cur = lib.setlists[op.id] || { id: op.id, name: 'Setlist', songs: [], created: new Date().toISOString() };
      const next = { ...cur, ...op.set, id: op.id };
      next.songs = (next.songs || []).filter((x, i, a) => a.indexOf(x) === i);
      return { ...lib, setlists: { ...lib.setlists, [op.id]: next } };
    }
    case 'list-del': {
      if (!lib.setlists[op.id]) return lib;
      const setlists = { ...lib.setlists };
      delete setlists[op.id];
      return { ...lib, setlists };
    }
    case 'prefs':
      return { ...lib, prefs: clean({ ...lib.prefs, ...op.set }) };
    case 'many':
      return op.ops.reduce(applyOp, lib);
    default:
      return lib;
  }
}

export const applyOps = (lib, ops) => ops.reduce(applyOp, lib);

// The op that undoes `op` on `lib` (before it was applied).
export function invertOp(lib, op) {
  switch (op.t) {
    case 'add': return { t: 'del', id: op.song.id };
    case 'del': {
      const s = lib.songs[op.id];
      if (!s) return { t: 'many', ops: [] };
      const lists = Object.values(lib.setlists).filter(l => l.songs.includes(op.id)).map(l => ({ t: 'list', id: l.id, set: { songs: l.songs } }));
      return { t: 'many', ops: [{ t: 'add', song: s }, ...lists] };
    }
    case 'set': {
      const s = lib.songs[op.id];
      const set = {};
      for (const k of Object.keys(op.set)) set[k] = s ? s[k] ?? null : null;
      return { t: 'set', id: op.id, set };
    }
    case 'view': {
      const v = lib.songs[op.id]?.view || {};
      const set = {};
      for (const k of Object.keys(op.set)) set[k] = v[k] ?? null;
      return { t: 'view', id: op.id, set };
    }
    case 'list': {
      const l = lib.setlists[op.id];
      return l ? { t: 'list', id: op.id, set: { name: l.name, songs: l.songs } } : { t: 'list-del', id: op.id };
    }
    case 'list-del': {
      const l = lib.setlists[op.id];
      return l ? { t: 'list', id: op.id, set: { ...l } } : { t: 'many', ops: [] };
    }
    case 'prefs': {
      const set = {};
      for (const k of Object.keys(op.set)) set[k] = lib.prefs[k] ?? null;
      return { t: 'prefs', set };
    }
    case 'many': {
      const inv = [];
      let cur = lib;
      for (const o of op.ops) { inv.unshift(invertOp(cur, o)); cur = applyOp(cur, o); }
      return { t: 'many', ops: inv };
    }
    default: return { t: 'many', ops: [] };
  }
}

// The ops that turn library `from` into `to`, field by field, so applying them
// to a third copy changes only what changed here.
export function diffOps(from, to) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = (a = {}, b = {}) => {
    const set = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[k], b[k])) set[k] = b[k] ?? null;
    return set;
  };
  const ops = [];
  for (const [id, s] of Object.entries(to.songs)) {
    const old = from.songs[id];
    if (!old) { ops.push({ t: 'add', song: { ...s, id } }); continue; } // (your part's entries have no id of their own)
    const { view: v0, ...a } = old;
    const { view: v1, ...b } = s;
    const set = changed(a, b);
    delete set.id;
    if (Object.keys(set).length) ops.push({ t: 'set', id, set });
    const view = changed(v0, v1);
    if (Object.keys(view).length) ops.push({ t: 'view', id, set: view });
  }
  for (const id of Object.keys(from.songs)) if (!to.songs[id]) ops.push({ t: 'del', id });
  for (const [id, l] of Object.entries(to.setlists)) {
    const old = from.setlists[id];
    if (!old) { ops.push({ t: 'list', id, set: { ...l } }); continue; }
    const set = changed(old, l);
    delete set.id;
    if (Object.keys(set).length) ops.push({ t: 'list', id, set });
  }
  for (const id of Object.keys(from.setlists)) if (!to.setlists[id]) ops.push({ t: 'list-del', id });
  const prefs = changed(from.prefs, to.prefs);
  if (Object.keys(prefs).length) ops.push({ t: 'prefs', set: prefs });
  return ops;
}

// ---------- the shared songbook and your own part of it ----------
//
// Signed in, the songs belong to a songbook everyone in it shares; what's
// yours (favorite, transpose and capo, chosen shapes, notes, what you played)
// is kept apart, with your setlists. The screen shows the two together, so
// every op above still works on the whole; splitOp says which part of an op
// goes where.

export const PERSONAL_FIELDS = ['fav', 'view', 'played', 'plays', 'notes'];
const isPersonal = k => PERSONAL_FIELDS.includes(k);

export const sharedPart = s => Object.fromEntries(Object.entries(s).filter(([k]) => !isPersonal(k)));
export const personalPart = s => Object.fromEntries(Object.entries(s).filter(([k]) => isPersonal(k)));

// → [op for the songbook or null, op for your part or null]
export function splitOp(op) {
  switch (op.t) {
    case 'add': {
      const mine = personalPart(op.song || {});
      return [{ t: 'add', song: sharedPart(op.song || {}) }, Object.keys(mine).length ? { t: 'set', id: op.song.id, set: mine } : null];
    }
    case 'set': {
      const shared = sharedPart(op.set || {});
      const mine = personalPart(op.set || {});
      return [Object.keys(shared).length ? { t: 'set', id: op.id, set: shared } : null, Object.keys(mine).length ? { t: 'set', id: op.id, set: mine } : null];
    }
    case 'del': return [op, op];
    case 'many': {
      const a = [], b = [];
      for (const o of op.ops) {
        const [x, y] = splitOp(o);
        if (x) a.push(x);
        if (y) b.push(y);
      }
      return [a.length ? { t: 'many', ops: a } : null, b.length ? { t: 'many', ops: b } : null];
    }
    default: return [null, op]; // view, list, list-del, prefs
  }
}

// Your part: { songs: { id: { fav, view… } }, setlists, prefs }. Unlike the
// songbook's, a change to a song you have nothing saved for yet makes the entry.
export function applyMine(lib, op) {
  switch (op.t) {
    case 'add': return applyMine(lib, { t: 'set', id: op.song?.id, set: personalPart(op.song || {}) });
    case 'set': {
      if (!op.id) return lib;
      const next = clean({ ...(lib.songs[op.id] || {}), ...personalPart(op.set || {}) });
      const songs = { ...lib.songs };
      if (Object.keys(next).length) songs[op.id] = next; else delete songs[op.id];
      return { ...lib, songs };
    }
    case 'view': {
      if (!op.id) return lib;
      const view = clean({ ...(lib.songs[op.id]?.view || {}), ...op.set });
      return applyMine(lib, { t: 'set', id: op.id, set: { view: Object.keys(view).length ? view : null } });
    }
    case 'del': {
      const songs = { ...lib.songs };
      delete songs[op.id];
      const setlists = {};
      for (const [k, l] of Object.entries(lib.setlists)) setlists[k] = l.songs.includes(op.id) ? { ...l, songs: l.songs.filter(x => x !== op.id) } : l;
      return { ...lib, songs, setlists };
    }
    case 'many': return op.ops.reduce(applyMine, lib);
    default: return applyOp(lib, op); // setlists and settings, as anywhere
  }
}

export function normalizeMine(raw) {
  const lib = emptyLibrary();
  if (!raw || typeof raw !== 'object') return lib;
  for (const [id, s] of Object.entries(raw.songs || {})) {
    if (!s || typeof s !== 'object') continue;
    const mine = personalPart(s);
    if (Object.keys(mine).length) lib.songs[id] = mine;
  }
  const rest = normalize({ setlists: raw.setlists, prefs: raw.prefs });
  lib.setlists = rest.setlists;
  lib.prefs = rest.prefs;
  return lib;
}

// A whole library → the songbook's part and yours.
export function splitLibrary(lib) {
  const shared = emptyLibrary();
  const mine = emptyLibrary();
  for (const [id, s] of Object.entries(lib.songs || {})) {
    shared.songs[id] = sharedPart(s);
    const m = personalPart(s);
    if (Object.keys(m).length) mine.songs[id] = m;
  }
  mine.setlists = lib.setlists || {};
  mine.prefs = lib.prefs || {};
  return { shared, mine };
}

// What the screen shows: every song in the songbook, with your part on it.
// (A songbook from before it was shared can still have its owner's part in
// it, until one of the owner's devices takes it: never shown as anyone's.)
export function joinLibrary(shared, mine) {
  const songs = {};
  for (const [id, s] of Object.entries(shared.songs)) {
    const own = mine.songs[id];
    songs[id] = own || PERSONAL_FIELDS.some(k => k in s) ? { ...sharedPart(s), ...own, id } : s;
  }
  return { v: 1, songs, setlists: mine.setlists, prefs: mine.prefs };
}

// Makes a library read from storage or the network safe to use.
export function normalize(raw) {
  const lib = emptyLibrary();
  if (!raw || typeof raw !== 'object') return lib;
  for (const [id, s] of Object.entries(raw.songs || {})) {
    if (!s || typeof s !== 'object') continue;
    lib.songs[id] = { ...s, id, title: String(s.title || 'Untitled'), artist: String(s.artist || ''), content: String(s.content || '') };
  }
  for (const [id, l] of Object.entries(raw.setlists || {})) {
    if (!l || typeof l !== 'object') continue;
    lib.setlists[id] = { ...l, id, name: String(l.name || 'Setlist'), songs: Array.isArray(l.songs) ? l.songs.filter(x => typeof x === 'string') : [] };
  }
  if (raw.prefs && typeof raw.prefs === 'object') lib.prefs = { ...raw.prefs };
  return lib;
}

// ---------- finding and sorting ----------

export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function searchSongs(songs, q) {
  const f = fold(q);
  if (!f) return songs;
  const words = f.split(' ');
  const scored = [];
  for (const s of songs) {
    const title = fold(s.title), artist = fold(s.artist);
    const hay = `${title} ${artist}`;
    if (!words.every(w => hay.includes(w))) continue;
    let score = 0;
    if (title.startsWith(f)) score += 4;
    else if (title.includes(f)) score += 2;
    if (artist.startsWith(f)) score += 2;
    if (words.every(w => title.split(' ').some(t => t.startsWith(w)))) score += 1;
    scored.push({ s, score });
  }
  return scored.sort((a, b) => b.score - a.score).map(x => x.s);
}

const sortKey = s => fold(s).replace(/^the /, '');
export const SORTS = {
  added: { label: 'Recently added', fn: (a, b) => (b.added || '').localeCompare(a.added || '') },
  played: { label: 'Recently played', fn: (a, b) => (b.played || '').localeCompare(a.played || '') || (b.added || '').localeCompare(a.added || '') },
  title: { label: 'Title', fn: (a, b) => sortKey(a.title).localeCompare(sortKey(b.title)) },
  artist: { label: 'Artist', fn: (a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || sortKey(a.title).localeCompare(sortKey(b.title)) },
};

export function sortSongs(songs, by = 'added') {
  return [...songs].sort((SORTS[by] || SORTS.added).fn);
}

export function groupByArtist(songs) {
  const groups = new Map();
  for (const s of sortSongs(songs, 'artist')) {
    const k = s.artist || 'Unknown artist';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()].map(([artist, list]) => ({ artist, songs: list }));
}

// The same song from the same source counts as a duplicate.
export function findDuplicate(lib, song) {
  const url = song.src?.url;
  for (const s of Object.values(lib.songs)) {
    if (url && s.src?.url === url) return s;
    if (!url && fold(s.title) === fold(song.title) && fold(s.artist) === fold(song.artist) && s.content === song.content) return s;
  }
  return null;
}
