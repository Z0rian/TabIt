// Brings songs over from the previous TabIt (one big file, songs in
// localStorage under "tabit_songs_v3"), once, on the first start of this one.
// The old copy is left where it was, in case anything needs checking.

import { makeSong, emptyLibrary } from './model.js';

const OLD_SONGS = 'tabit_songs_v3';
const OLD_CONFIG = 'tabit_config_v1';
const OLD_THEME = 'tabit_theme_v2';
const DONE = 'tabit.migrated';

function readOld(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

// The old app's songs → this app's library (null if there's nothing to bring).
export function oldLibrary() {
  if (localStorage.getItem(DONE)) return null;
  const old = readOld(OLD_SONGS);
  if (!Array.isArray(old) || !old.length) return null;
  return convert(old);
}

export function convert(old) {
  const lib = emptyLibrary();
  const now = Date.now();
  old.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !s.content) return;
    // the old ids were Date.now() numbers (or a slug for the built-in song)
    const added = typeof s.id === 'number' && s.id > 1e12 && s.id < now + 1e10 ? new Date(s.id).toISOString() : new Date(now - (old.length - i) * 1000).toISOString();
    const song = makeSong({
      title: s.title, artist: s.artist, content: String(s.content),
      key: s.key || undefined, capo: +s.capo || undefined,
      bpm: s.tempo && +s.tempo !== 100 && +s.tempo !== 120 ? +s.tempo : undefined,
      fav: !!s.liked || undefined, added,
      src: { site: 'legacy' },
      cover: typeof s.cover === 'string' && s.cover.length < 300_000 ? s.cover : undefined,
    });
    lib.songs[song.id] = song;
  });
  return Object.keys(lib.songs).length ? lib : null;
}

export function markMigrated() {
  localStorage.setItem(DONE, new Date().toISOString());
}

// The old theme names → this app's.
export function oldTheme() {
  const t = localStorage.getItem(OLD_THEME);
  if (!t) return null;
  return t === 'dark' ? 'dark' : 'light';
}

// The old app could back up to a private GitHub Gist with a personal key.
export function oldGist() {
  const c = readOld(OLD_CONFIG);
  return c && c.ghGistId ? { gistId: c.ghGistId, token: c.ghToken || '' } : null;
}

export async function fetchOldGist({ gistId, token }) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `token ${token}`;
  const r = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { headers, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub said ${r.status} for the old backup.`);
  const d = await r.json();
  const file = d.files?.['tabit-songs.json'];
  if (!file) throw new Error('The old backup has no songs file.');
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('The old backup isn’t a song list.');
  return convert(arr);
}
