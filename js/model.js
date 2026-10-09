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
//  { t: 'list', id, set: { name, songs } }  create/change a setlist
//  { t: 'list-del', id }
//  { t: 'prefs', set: { … } }               synced settings
//  { t: 'many', ops: [...] }

export const SONG_FIELDS = ['title', 'artist', 'kind', 'content', 'src', 'key', 'capo', 'tuning', 'bpm', 'duration', 'durationFrom', 'yt', 'fav', 'added', 'edited', 'played', 'plays', 'notes', 'view', 'shapes', 'cover'];

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
