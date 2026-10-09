// Album covers for songs that don't have one: Ultimate Guitar's (the same
// search the app uses), else Apple's iTunes catalog. In the background, one
// song every couple of seconds, only while the app is open and online. A
// cover found here syncs like any edit, so each song is looked up once.
//
// cover: 'none' means you removed it by hand: it's left alone, on every device.

import { store, subscribe, dispatch, isLocalDev } from './store.js';
import { searchUG } from './ug.js';
import { fold } from './model.js';

export const NO_COVER = 'none';
export const coverOf = s => (s?.cover && s.cover !== NO_COVER ? s.cover : '');

const TRIED = 'tabit.covers.tried'; // song id → when nothing was found (this device)
const RETRY_DAYS = 30;

const sameArtist = (a, b) => {
  const x = fold(a), y = fold(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
// 2: the same title; 1: the same with something added ("(Live)", "- Remastered")
const titleMatch = (a, b) => {
  const x = fold(a), y = fold(b);
  return !x || !y ? 0 : x === y ? 2 : x.startsWith(y) || y.startsWith(x) ? 1 : 0;
};

// From Ultimate Guitar's results: this very tab's cover, else the same song's.
export function pickUG(song, results) {
  const withCover = (results || []).filter(r => r.cover);
  const same = song.src?.url && withCover.find(r => r.url === song.src.url);
  if (same) return same.cover;
  return withCover.find(r => titleMatch(r.title, song.title) === 2 && sameArtist(r.artist, song.artist))?.cover || '';
}

const SOUNDALIKE = /karaoke|tribute|made famous|in the style of|instrumental|backing track|lullaby/i;

// From iTunes: the same artist and title, not a karaoke or tribute album
// (300 px, plenty for a thumbnail).
export function pickItunes(song, results) {
  let best = null;
  let bestScore = 0;
  for (const r of results || []) {
    if (!r.artworkUrl100 || !sameArtist(r.artistName, song.artist)) continue;
    const t = titleMatch(r.trackName, song.title);
    if (!t) continue;
    const score = t * 2 - (SOUNDALIKE.test(`${r.collectionName} ${r.artistName}`) ? 5 : 0) - (/\blive\b/i.test(r.collectionName || '') ? 0.5 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best ? best.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x300bb.') : '';
}

async function itunes(song) {
  const q = new URLSearchParams({ term: `${song.artist} ${song.title}`, entity: 'song', media: 'music', limit: '10' });
  const res = await fetch(`https://itunes.apple.com/search?${q}`);
  if (!res.ok) throw new Error(`iTunes answered ${res.status}`);
  return (await res.json()).results || [];
}

// '' when there's none to be found; throws when it couldn't look (offline…).
export async function findCover(song) {
  if (song.src?.site === 'ug') {
    const cover = pickUG(song, await searchUG(`${song.artist} ${song.title}`));
    if (cover) return cover;
  }
  if (!song.artist) return '';
  return pickItunes(song, await itunes(song));
}

function tried() {
  try { return JSON.parse(localStorage.getItem(TRIED)) || {}; } catch { return {}; }
}
function saveTried(t) {
  // (only songs still in the library)
  for (const id of Object.keys(t)) if (!store.lib.songs[id]) delete t[id];
  try { localStorage.setItem(TRIED, JSON.stringify(t)); } catch { /* full */ }
}

let running = false;

export async function fillCovers({ gap = 1500 } = {}) {
  if (running) return;
  running = true;
  try {
    const t = tried();
    const cutoff = Date.now() - RETRY_DAYS * 86_400_000;
    while (navigator.onLine !== false && document.visibilityState === 'visible') {
      const song = Object.values(store.lib.songs).find(s => !s.cover && !(t[s.id] > cutoff));
      if (!song) break;
      let cover;
      try {
        cover = await findCover(song);
      } catch {
        break; // couldn't look right now: another time
      }
      const now = store.lib.songs[song.id];
      if (cover && now && !now.cover) dispatch({ t: 'set', id: song.id, set: { cover } }, { lazy: true });
      else if (!cover) { t[song.id] = Date.now(); saveTried(t); }
      await new Promise(r => setTimeout(r, gap));
    }
  } finally {
    running = false;
  }
}

// Looks once the app has settled, when songs come in, and when it comes back
// to the front. (Not while testing locally, unless the page asks with ?covers.)
export function startCovers() {
  if (isLocalDev && !new URLSearchParams(location.search).has('covers')) return;
  let timer = null;
  const soon = (ms = 4000) => { clearTimeout(timer); timer = setTimeout(() => fillCovers(), ms); };
  let count = Object.keys(store.lib.songs).length;
  subscribe(st => {
    const n = Object.keys(st.lib.songs).length;
    if (n > count) soon();
    count = n;
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });
  addEventListener('online', () => soon());
  soon(5000);
}
