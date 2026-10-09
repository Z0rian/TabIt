// App state: the library as last synced ("base"), the edits made on this device
// that haven't been saved to GitHub yet ("pending"), and what the screen shows
// (base + pending). Edits show instantly and save in the background; offline
// they wait and retry. Without sync set up, edits go straight into the base.
//
// On GitHub (branch tabit-data, see remote.js) the library is split into an
// index (titles, favorites, settings: small, changes often) and 16 shards of
// song text (big, changes rarely), each encrypted. A save only rewrites the
// files whose contents changed.

import * as db from './db.js';
import { applyOp, applyOps, emptyLibrary, normalize, invertOp } from './model.js';
import { GitHubRemote, MockRemote, RemoteError, repoConfig } from './remote.js';
import { encryptJSON, decryptJSON } from './crypto.js';

export const cfg = repoConfig();
export const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname);
export const useMock = isLocalDev && new URLSearchParams(location.search).has('mock');

const AUTH_KEY = 'tabit.auth';
const SHARDS = 16;
export const INDEX_PATH = 'library/index.json';
export const shardPath = n => `library/songs-${n.toString(16)}.json`;

export const store = {
  lib: emptyLibrary(),
  ready: false,
  sync: { state: 'local', message: '', at: '' }, // local | idle | pending | saving | saved | offline | error
};

const state = { base: emptyLibrary(), rev: null, pending: [] };

const listeners = new Set();
export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; listeners.forEach(fn => fn(store)); });
}

// ---------- auth ----------

export function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch { return null; }
}
export function setAuth(a) {
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  else localStorage.removeItem(AUTH_KEY);
}
export const signedIn = () => !!getAuth()?.token;

let makeRemote = token => (useMock ? new MockRemote(cfg, token) : new GitHubRemote(cfg, token));
export function remote(token = getAuth()?.token || '') {
  return makeRemote(token);
}
// tests: talk to a fake GitHub
export function _useRemote(factory) { makeRemote = factory; }

// ---------- persistence ----------

// Pending edits are written at once (they're small); the whole library a
// moment later, and straight away when the app is hidden or closed.
//
// Signed out, the library itself is the only copy, and Safari doesn't finish a
// write that starts as the page goes away. So each edit also goes into a small
// journal, written at once, that start-up replays (ops are safe to replay).
let persistTimer = null;
let baseDirty = false;
let journal = [];

// Small queues also go to localStorage, which is written synchronously and so
// survives the app being closed the instant after a tap; big ones (an import
// of hundreds of songs) only to IndexedDB.
function saveQueue(name, ops) {
  db.set(`lib.${name}`, ops);
  try {
    const text = JSON.stringify(ops);
    if (text.length < 250_000) localStorage.setItem(`tabit.${name}`, text);
    else localStorage.removeItem(`tabit.${name}`);
  } catch {
    try { localStorage.removeItem(`tabit.${name}`); } catch { /* no storage */ }
  }
}
function readQueue(name, fromDb) {
  try {
    const v = JSON.parse(localStorage.getItem(`tabit.${name}`));
    if (Array.isArray(v)) return v;
  } catch { /* fall back */ }
  return Array.isArray(fromDb) ? fromDb : [];
}
function writeBase() {
  clearTimeout(persistTimer);
  if (!baseDirty) return;
  baseDirty = false;
  const n = journal.length;
  Promise.all([db.set('lib.base', state.base), db.set('lib.rev', state.rev)]).then(() => {
    if (!n) return;
    journal = journal.slice(n);
    saveQueue('journal', journal);
  });
}
function clearJournal() {
  journal = [];
  saveQueue('journal', journal);
}
function persist({ base = false } = {}) {
  saveQueue('pending', state.pending);
  if (base) {
    baseDirty = true;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(writeBase, 80);
  }
}
addEventListener('pagehide', writeBase);

function recompute() {
  store.lib = applyOps(state.base, state.pending);
}

export async function init() {
  const [base, rev, pending, saved] = await Promise.all([db.get('lib.base'), db.get('lib.rev'), db.get('lib.pending'), db.get('lib.journal')]);
  state.base = normalize(base);
  state.rev = rev || null;
  state.pending = readQueue('pending', pending);
  const logged = readQueue('journal', saved);
  if (logged.length && !signedIn()) {
    // edits that may not have reached the saved library before the app closed
    // (only ever kept while signed out: signed in, the pending queue does this)
    state.base = applyOps(state.base, logged);
    journal = logged;
    baseDirty = true;
    writeBase();
  }
  if (!signedIn() && state.pending.length) {
    // signed out with edits left over: keep them locally
    state.base = applyOps(state.base, state.pending);
    state.pending = [];
  }
  recompute();
  store.ready = true;
  store.sync = signedIn() ? { state: state.pending.length ? 'pending' : 'idle', message: '', at: (await db.get('lib.syncedAt')) || '' } : { state: 'local', message: '', at: '' };
  emit();
  return { fresh: !base && !journal.length };
}

// Replaces the whole local library (first run, imports). Not synced by itself.
export function replaceLocal(lib) {
  state.base = normalize(lib);
  state.pending = [];
  clearJournal();
  recompute();
  persist({ base: true });
  emit();
}

// ---------- editing ----------

// Lazy ops (play counts) ride along with the next save instead of causing one.
export function dispatch(op, { lazy = false } = {}) {
  if (!signedIn()) {
    state.base = applyOp(state.base, op);
    journal.push(op);
    saveQueue('journal', journal);
    recompute();
    persist({ base: true });
    emit();
    return;
  }
  coalesce(op);
  store.lib = applyOp(store.lib, op);
  persist();
  if (store.sync.state !== 'saving') store.sync = { ...store.sync, state: 'pending', message: '' };
  emit();
  if (!lazy) scheduleSync(1500);
}

// Repeated view changes of the same song (tapping transpose five times) keep
// only the last value in the queue.
function coalesce(op) {
  const last = state.pending.at(-1);
  if (last && op.t === 'view' && last.t === 'view' && last.id === op.id && !syncing) {
    last.set = { ...last.set, ...op.set };
    return;
  }
  state.pending.push(op);
}

// Applies an op and returns a function that undoes it.
export function undoable(op) {
  const inverse = invertOp(store.lib, op);
  dispatch(op);
  return () => dispatch(inverse);
}

// ---------- the files on GitHub ----------

function hashId(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % SHARDS;
}

const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

// The plain contents of every file for a library.
export function serialize(lib) {
  const index = { v: 1, songs: {}, setlists: lib.setlists, prefs: lib.prefs };
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const [id, s] of Object.entries(lib.songs)) {
    const { content, ...meta } = s;
    index.songs[id] = meta;
    shards[hashId(id)][id] = content || '';
  }
  const out = { [INDEX_PATH]: stable(index) };
  shards.forEach((sh, n) => { out[shardPath(n)] = stable(sh); });
  return out;
}

function assemble(indexObj, shardObjs) {
  const lib = emptyLibrary();
  for (const [id, meta] of Object.entries(indexObj.songs || {})) {
    const content = shardObjs[hashId(id)]?.[id];
    lib.songs[id] = { ...meta, id, content: content ?? '' };
  }
  lib.setlists = indexObj.setlists || {};
  lib.prefs = indexObj.prefs || {};
  return normalize(lib);
}

// Loads the newest library from GitHub (only the files that changed since the
// last load). Returns { lib, rev } or { lib: null } when nothing is there yet.
export async function pull(r = remote(), libKey = getAuth()?.libKey) {
  const head = await r.head();
  if (!head) return { lib: null, rev: null };
  if (state.rev?.commit === head) return { lib: state.base, rev: state.rev };
  const files = await r.files(head);
  if (!files[INDEX_PATH]) return { lib: null, rev: { commit: head, files } };
  const old = state.rev?.files || {};
  const known = state.rev ? serializeCache() : null;
  const read = async path => decryptJSON(await r.blob(files[path]), libKey, path);
  const indexObj = await read(INDEX_PATH);
  const shardObjs = await Promise.all(Array.from({ length: SHARDS }, async (_, n) => {
    const p = shardPath(n);
    if (!files[p]) return {};
    if (known && old[p] === files[p]) return JSON.parse(known[p]);
    return read(p);
  }));
  return { lib: assemble(indexObj, shardObjs), rev: { commit: head, files } };
}

let cache = null;
function serializeCache() {
  if (!cache || cache.base !== state.base) cache = { base: state.base, files: serialize(state.base) };
  return cache.files;
}

// Encrypted texts of the files that differ between two libraries.
async function changedFiles(before, after, libKey) {
  const a = before ? serialize(before) : {};
  const b = serialize(after);
  const out = {};
  for (const [path, text] of Object.entries(b)) {
    if (a[path] === text) continue;
    if (!before && path !== INDEX_PATH && text === '{}') continue; // empty shard on first save
    out[path] = await encryptJSON(JSON.parse(text), libKey, path);
  }
  return out;
}

function commitMessage(ops) {
  const n = ops.length;
  const device = deviceName();
  return `${n ? `${n} change${n === 1 ? '' : 's'}` : 'Sync'} from ${device}`;
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'a browser';
}

// ---------- syncing ----------

let syncing = null;
let timer = null;
let retryDelay = 4000;
let lastPull = 0;

export function scheduleSync(ms = 1500) {
  if (!signedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), ms);
}

export function syncNow() {
  if (!signedIn()) return Promise.resolve();
  if (syncing) return syncing.then(() => (state.pending.length ? syncNow() : undefined));
  clearTimeout(timer);
  syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const auth = getAuth();
  const r = remote(auth.token);
  store.sync = { ...store.sync, state: 'saving', message: '' };
  emit();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { lib: remoteLib, rev } = await pull(r, auth.libKey);
      lastPull = Date.now();
      if (remoteLib && rev) {
        state.base = remoteLib;
        state.rev = rev;
      }
      const batch = state.pending.slice();
      const start = remoteLib || state.base;
      const next = applyOps(start, batch);
      const files = await changedFiles(remoteLib, next, auth.libKey);
      if (!Object.keys(files).length && remoteLib) {
        state.base = next;
        state.pending = state.pending.slice(batch.length);
        break;
      }
      try {
        const commit = await r.commit({ parent: rev?.commit || null, files, message: commitMessage(batch) });
        state.base = next;
        state.rev = { commit, files: await r.files(commit) };
        state.pending = state.pending.slice(batch.length);
        break;
      } catch (e) {
        if (e.kind !== 'conflict' || attempt === 4) throw e;
        // another device saved first: load theirs and rebuild ours on top
      }
    }
    retryDelay = 4000;
    recompute();
    persist({ base: true });
    const at = new Date().toISOString();
    db.set('lib.syncedAt', at);
    store.sync = { state: state.pending.length ? 'pending' : 'saved', message: '', at };
    if (state.pending.length) scheduleSync(800);
  } catch (e) {
    recompute();
    persist({ base: true });
    const n = state.pending.length;
    if (e.kind === 'offline') {
      store.sync = { ...store.sync, state: 'offline', message: n ? `Offline. ${n} change${n === 1 ? ' is' : 's are'} saved on this device and will sync later.` : 'Offline. Your library is on this device.' };
    } else {
      store.sync = { ...store.sync, state: 'error', message: e.message || 'Sync failed.', kind: e.kind };
    }
    if (!['auth', 'forbidden'].includes(e.kind) && !(e instanceof SyntaxError) && e.name !== 'OperationError') {
      scheduleSync(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 120_000);
    }
  } finally {
    emit();
  }
}

// Called on start and when the app comes back to the front.
export function maybePull(maxAge = 30_000) {
  if (!signedIn()) return;
  if (state.pending.length || Date.now() - lastPull > maxAge) syncNow();
}

// ---------- signing in and out ----------

// First save to GitHub, or joining a library that's already there: everything
// on this device that isn't in the synced copy is added to it, nothing is lost.
export function mergeLocalInto(remoteLib) {
  const ops = [];
  const local = applyOps(state.base, state.pending);
  const byUrl = new Map(Object.values(remoteLib.songs).filter(s => s.src?.url).map(s => [s.src.url, s]));
  const key = s => `${(s.title || '').toLowerCase()}|${(s.artist || '').toLowerCase()}`;
  const byName = new Map(Object.values(remoteLib.songs).map(s => [key(s), s]));
  for (const s of Object.values(local.songs)) {
    if (remoteLib.songs[s.id]) continue;
    const twin = (s.src?.url && byUrl.get(s.src.url)) || (s.src?.site === 'legacy' ? byName.get(key(s)) : null);
    if (twin) {
      if (s.fav && !twin.fav) ops.push({ t: 'set', id: twin.id, set: { fav: true } });
      continue;
    }
    ops.push({ t: 'add', song: s });
  }
  for (const l of Object.values(local.setlists)) if (!remoteLib.setlists[l.id]) ops.push({ t: 'list', id: l.id, set: l });
  return ops;
}

export async function startSync(auth, { remoteLib, rev } = {}) {
  setAuth(auth);
  const merged = mergeLocalInto(remoteLib || emptyLibrary());
  clearJournal();
  if (remoteLib) {
    state.base = remoteLib;
    state.rev = rev;
  } else {
    state.base = emptyLibrary();
    state.rev = null;
  }
  state.pending = merged;
  recompute();
  persist({ base: true });
  store.sync = { state: 'pending', message: '', at: '' };
  emit();
  await syncNow();
}

export function signOut({ keepSongs = true } = {}) {
  const lib = store.lib;
  setAuth(null);
  clearJournal();
  clearTimeout(timer);
  state.base = keepSongs ? lib : emptyLibrary();
  state.rev = null;
  state.pending = [];
  recompute();
  persist({ base: true });
  db.del('lib.syncedAt');
  store.sync = { state: 'local', message: '', at: '' };
  emit();
}

export const pendingCount = () => state.pending.length;

// For tests: the raw state.
export const _state = state;
export { RemoteError };

addEventListener('online', () => syncNow());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybePull();
  else {
    writeBase();
    if (state.pending.length && signedIn()) syncNow();
  }
});
