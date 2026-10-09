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
  let j = null;
  try { j = JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
  // the app was closed in the middle of a song: that one starts over
  if (j?.entries) for (const e of j.entries) if (e.status === 'working') e.status = 'waiting';
  if (j && !j.done && !j.cancelled && j.entries?.some(e => e.status === 'waiting')) j.paused = null;
  return j;
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

// Another go for the songs that didn't come in (after the worker is updated, say).
export function retryImport() {
  if (!job || running) return;
  let n = 0;
  for (const e of job.entries) {
    if (e.status === 'notfound' || e.status === 'failed') { e.status = 'waiting'; e.note = ''; n++; }
  }
  if (!n) return;
  job.done = false;
  job.cancelled = false;
  job.paused = null;
  save();
  emit();
  run();
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

// Tabs being fetched right now, so the two workers never bring in the same
// song twice (a list can name it twice, e.g. once as a Guitar Pro favorite).
const inflight = new Map();

async function importOne(e) {
  const { result, how } = await findEntry(e);
  if (!result) { e.status = 'notfound'; e.note = 'Not found on Ultimate Guitar'; return; }
  if (inflight.has(result.url)) await inflight.get(result.url).catch(() => {});
  const skipIfThere = () => {
    const existing = Object.values(store.lib.songs).find(s => s.src?.url === result.url);
    if (!existing) return false;
    if (job.favorite && !existing.fav) dispatch({ t: 'set', id: existing.id, set: { fav: true } });
    e.status = 'skipped';
    e.note = 'Already in your library';
    e.id = existing.id;
    return true;
  };
  if (skipIfThere()) return;
  const loading = fetchTab(result.url);
  inflight.set(result.url, loading);
  let tab;
  try { tab = await loading; } finally { inflight.delete(result.url); }
  if (skipIfThere()) return; // (the library may have changed while it loaded)
  const songs = Object.values(store.lib.songs);
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

// A TabIt backup ({ app: 'tabit', songs: [...], setlists: [...] }) or the old
// app's export (an array) → { songs, setlists, upgrade }. `upgrade` marks a
// file of exact Ultimate Guitar versions (the Tabs & Chords favorites file).
export function readBackup(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { songs: Object.values(convert(data)?.songs || {}), setlists: [] };
  if (data && data.app === 'tabit' && Array.isArray(data.songs)) {
    const lib = normalize({ setlists: Object.fromEntries((Array.isArray(data.setlists) ? data.setlists : []).filter(l => l?.id).map(l => [l.id, l])) });
    return { songs: data.songs.filter(s => s && s.content).map(s => makeSong({ ...s, id: s.id })), setlists: Object.values(lib.setlists), upgrade: data.upgrade === true };
  }
  if (data && data.songs && typeof data.songs === 'object') {
    const lib = normalize(data);
    return { songs: Object.values(lib.songs), setlists: Object.values(lib.setlists) };
  }
  throw new Error('That file isn’t a TabIt backup.');
}

// What a song from a file can add to the same song already in the library:
// details Ultimate Guitar knows (the first worker didn't pass them on). Never
// anything you set yourself.
const DETAILS = ['capo', 'tuning', 'bpm', 'shapes', 'strum', 'cover'];

// Adds the songs (and setlists) that aren't in the library yet, and fills in
// missing details of the ones that are. A song that's already here under
// another id keeps its place in the setlists it came with.
//
// With `upgrade` (a file of exact versions), a song that came in through the
// first worker, with none of those details and perhaps in another version, is
// replaced by the file's version: favorite, notes and settings stay.
export function addSongs(songs, setlists = [], { upgrade = false } = {}) {
  let added = 0, skipped = 0, filled = 0;
  const lib = store.lib;
  const byUrl = new Map(Object.values(lib.songs).filter(s => s.src?.url).map(s => [s.src.url, s.id]));
  const nameOf = s => `${fold(s.title)}|${fold(s.artist)}`;
  // (upgrade) songs here without details that no song in the file matches
  // exactly, by name: each can stand in for one song of the file
  const inFile = new Set(songs.map(s => s.src?.url).filter(Boolean));
  const thin = new Map();
  if (upgrade) {
    for (const s of Object.values(lib.songs)) {
      if (s.src?.site !== 'ug' || s.shapes || s.strum || inFile.has(s.src.url)) continue;
      if (!thin.has(nameOf(s))) thin.set(nameOf(s), []);
      thin.get(nameOf(s)).push(s.id);
    }
  }
  const idFor = new Map();
  const ops = [];
  for (const s of songs) {
    let have = lib.songs[s.id] ? s.id : s.src?.url && byUrl.get(s.src.url);
    let replace = false;
    if (!have && s.src?.site === 'ug' && thin.get(nameOf(s))?.length) {
      have = thin.get(nameOf(s)).shift();
      replace = true;
      if (s.src.url) byUrl.set(s.src.url, have);
    }
    if (have) {
      idFor.set(s.id, have);
      skipped++;
      const cur = lib.songs[have];
      const set = {};
      if (replace) {
        // the version's own text and details, all of them (a cover can stay)
        for (const k of ['content', 'src', 'kind', 'key']) if (s[k] != null) set[k] = s[k];
        for (const k of DETAILS) if (k !== 'cover' || s[k] != null) set[k] = s[k] ?? null;
      } else if (cur.src?.url && cur.src.url === s.src?.url) {
        for (const k of DETAILS) if (cur[k] == null && s[k] != null) set[k] = s[k];
      }
      if (Object.keys(set).length) { ops.push({ t: 'set', id: have, set }); filled++; }
      continue;
    }
    if (s.src?.url) byUrl.set(s.src.url, s.id);
    idFor.set(s.id, s.id);
    ops.push({ t: 'add', song: s });
    added++;
  }
  let lists = 0;
  for (const l of setlists) {
    if (lib.setlists[l.id]) continue;
    const ids = l.songs.map(x => idFor.get(x) || (lib.songs[x] ? x : null)).filter(Boolean);
    ops.push({ t: 'list', id: l.id, set: { ...l, name: l.name || 'Setlist', songs: ids } });
    lists++;
  }
  if (ops.length) dispatch({ t: 'many', ops });
  return { added, skipped, lists, filled };
}

export function exportLibrary() {
  const lib = store.lib;
  return JSON.stringify({ app: 'tabit', v: 1, exported: new Date().toISOString(), songs: Object.values(lib.songs), setlists: Object.values(lib.setlists) }, null, 1);
}
