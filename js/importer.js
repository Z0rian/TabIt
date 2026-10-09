// Brings a Tabs & Chords list into the library, one song at a time, in the
// background (it keeps going while you look around the app, and picks up
// where it left off if the app is closed).

import { findEntry, fetchTab, songFromTab } from './ug.js';
import { store, dispatch } from './store.js';
import { fold, makeSong, normalize } from './model.js';
import { convert } from './migrate.js';

const KEY = 'tabit.import';
const listeners = new Set();
export const subscribeImport = fn => (listeners.add(fn), () => listeners.delete(fn));

let job = load();
let running = false;
const emit = () => listeners.forEach(fn => fn(job));

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
function save() {
  try { if (job) localStorage.setItem(KEY, JSON.stringify(job)); else localStorage.removeItem(KEY); } catch { /* full */ }
}

export const importJob = () => job;

// Songs already in the library are skipped (same Ultimate Guitar tab, or the
// same title and artist from the old TabIt, which gets replaced by the real tab).
export function startImport(entries, { favorite = true } = {}) {
  job = { entries: entries.map(e => ({ ...e, status: 'waiting' })), favorite, started: new Date().toISOString(), done: false, cancelled: false };
  save();
  emit();
  run();
}

export function cancelImport() {
  if (!job) return;
  job.cancelled = true;
  job.done = true;
  save();
  emit();
}

export function clearImport() {
  job = null;
  save();
  emit();
}

export function resumeImport() {
  if (job && !job.done && !running) run();
}

async function run() {
  if (running) return;
  running = true;
  const workers = [worker(), worker()];
  await Promise.all(workers);
  running = false;
  if (job && !job.cancelled) {
    job.done = true;
    save();
    emit();
  }
}

async function worker() {
  while (job && !job.cancelled) {
    const e = job.entries.find(x => x.status === 'waiting');
    if (!e) return;
    e.status = 'working';
    emit();
    try {
      await importOne(e);
    } catch (err) {
      if (!navigator.onLine) {
        e.status = 'waiting';
        job.paused = 'offline';
        save();
        emit();
        await new Promise(r => addEventListener('online', r, { once: true }));
        job.paused = null;
        continue;
      }
      e.status = 'failed';
      e.note = err.message || 'failed';
    }
    save();
    emit();
    await new Promise(r => setTimeout(r, 350)); // be gentle with Ultimate Guitar
  }
}

async function importOne(e) {
  const songs = Object.values(store.lib.songs);
  const { result, how } = await findEntry(e);
  if (!result) { e.status = 'notfound'; e.note = 'Not found on Ultimate Guitar'; return; }
  const existing = songs.find(s => s.src?.url === result.url);
  if (existing) {
    if (job.favorite && !existing.fav) dispatch({ t: 'set', id: existing.id, set: { fav: true } });
    e.status = 'skipped';
    e.note = 'Already in your library';
    e.id = existing.id;
    return;
  }
  const tab = await fetchTab(result.url);
  const song = songFromTab(result, tab, { fav: job.favorite || undefined, added: e.date || new Date().toISOString() });
  // the old TabIt's copy of the same song gives way to the real tab
  const legacy = songs.find(s => s.src?.site === 'legacy' && fold(s.title) === fold(song.title) && fold(s.artist) === fold(song.artist));
  if (legacy) {
    const { id: _id, ...fields } = song;
    void _id;
    dispatch({ t: 'set', id: legacy.id, set: { ...fields, fav: legacy.fav || song.fav, added: legacy.added } });
    e.id = legacy.id;
  } else {
    dispatch({ t: 'add', song });
    e.id = song.id;
  }
  e.status = how === 'exact' ? 'done' : 'close';
  e.note = how === 'exact' ? '' : how === 'chords-for-pro' ? 'Guitar Pro file: took the best Chords version' : `Version ${e.version} not found: took version ${result.version}`;
}

// ---------- files ----------

// A TabIt backup ({ app: 'tabit', songs: [...] }) or the old app's export (an array).
export function songsFromFile(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return Object.values(convert(data)?.songs || {});
  if (data && data.app === 'tabit' && Array.isArray(data.songs)) {
    return data.songs.filter(s => s && s.content).map(s => makeSong({ ...s, id: s.id }));
  }
  if (data && data.songs && typeof data.songs === 'object') return Object.values(normalize(data).songs);
  throw new Error('That file isn’t a TabIt backup.');
}

export function addSongs(songs) {
  let added = 0, skipped = 0;
  const lib = store.lib;
  const urls = new Set(Object.values(lib.songs).map(s => s.src?.url).filter(Boolean));
  const ops = [];
  for (const s of songs) {
    if (lib.songs[s.id] || (s.src?.url && urls.has(s.src.url))) { skipped++; continue; }
    if (s.src?.url) urls.add(s.src.url);
    ops.push({ t: 'add', song: s });
    added++;
  }
  if (ops.length) dispatch({ t: 'many', ops });
  return { added, skipped };
}

export function exportLibrary() {
  const lib = store.lib;
  return JSON.stringify({ app: 'tabit', v: 1, exported: new Date().toISOString(), songs: Object.values(lib.songs), setlists: Object.values(lib.setlists) }, null, 1);
}
