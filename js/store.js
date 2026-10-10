// App state: the shared songbook and your own part of it, shown as one library.
//
// The songbook (every song, its text, key, capo, shapes, cover…) is shared by
// everyone signed in; your part (favorites, transpose and capo, chosen shapes,
// notes, what you played, your setlists) is yours. Each is a Doc (doc.js),
// encrypted on GitHub in the tabit-data repository (remote.js): the songbook
// with the key every sign-in opens, your part with a key only your own
// account's password opens. Without an account your part stays on this
// device; without signing in at all, so does the songbook.
//
// On GitHub the songbook is an index (titles, keys…: small, changes often) and
// 16 shards of song text (big, changes rarely); your part is one file,
// people/<you>.json. A save only rewrites the files whose contents changed.

import * as db from './db.js';
import { applyOp, applyMine, emptyLibrary, normalize, normalizeMine, invertOp, diffOps, splitOp, splitLibrary, joinLibrary, personalPart, PERSONAL_FIELDS } from './model.js';
import { GitHubRemote, MockRemote, RemoteError, repoConfig } from './remote.js';
import { Doc, stable } from './doc.js';

export const cfg = repoConfig();
export const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname);
export const useMock = isLocalDev && new URLSearchParams(location.search).has('mock');

const AUTH_KEY = 'tabit.auth';
const SHARDS = 16;
export const INDEX_PATH = 'library/index.json';
export const shardPath = n => `library/songs-${n.toString(16)}.json`;
export const personPath = id => `people/${id}.json`;

export const store = {
  lib: emptyLibrary(),
  ready: false,
  sync: { state: 'local', message: '', at: '' }, // local | idle | pending | saving | saved | offline | error
};

const listeners = new Set();
export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; listeners.forEach(fn => fn(store)); });
}

// ---------- auth ----------
//
// { token, libKey (the songbook's), via, label, since, person?: { id, key, label } }

export function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch { return null; }
}
export function setAuth(a) {
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  else localStorage.removeItem(AUTH_KEY);
  lookedFor = { token: '', at: 0 };
}
export const signedIn = () => !!getAuth()?.token;
let lookedFor = { token: '', at: 0 }; // (see newKey)
export const hasAccount = () => !!getAuth()?.person;

let makeRemote = token => (useMock ? new MockRemote(cfg, token) : new GitHubRemote(cfg, token));
export function remote(token = getAuth()?.token || '') {
  return makeRemote(token);
}
// tests: talk to a fake GitHub
export function _useRemote(factory) { makeRemote = factory; }

// ---------- the files on GitHub ----------

function hashId(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % SHARDS;
}

// (A songbook from before it was shared still has its owner's part in its
// index: favorites and the rest on the songs, setlists, settings. They're
// kept as they are, unseen, until one of the owner's devices takes them into
// its own part: see claimLegacy.)
const songbookLayout = {
  has: files => !!files[INDEX_PATH],
  files(lib) {
    const index = { v: 2, songs: {} };
    if (Object.keys(lib.setlists || {}).length) index.setlists = lib.setlists;
    if (Object.keys(lib.prefs || {}).length) index.prefs = lib.prefs;
    const shards = Array.from({ length: SHARDS }, () => ({}));
    for (const [id, s] of Object.entries(lib.songs)) {
      const { content, ...meta } = s;
      index.songs[id] = meta;
      shards[hashId(id)][id] = content || '';
    }
    const out = { [INDEX_PATH]: stable(index) };
    shards.forEach((sh, n) => { out[shardPath(n)] = stable(sh); });
    return out;
  },
  async load(read) {
    const index = (await read(INDEX_PATH)) || {};
    const shards = await Promise.all(Array.from({ length: SHARDS }, (_, n) => read(shardPath(n)).then(x => x || {})));
    const lib = { ...emptyLibrary(), setlists: index.setlists || {}, prefs: index.prefs || {} };
    for (const [id, meta] of Object.entries(index.songs || {})) lib.songs[id] = { ...meta, id, content: shards[hashId(id)]?.[id] ?? '' };
    return lib;
  },
  skip: (path, text) => path !== INDEX_PATH && text === '{}', // an empty shard on the first save
  legacy: lib => Object.keys(lib.setlists).length > 0 || Object.keys(lib.prefs).length > 0
    || Object.values(lib.songs).some(s => PERSONAL_FIELDS.some(k => k in s)),
};

const personLayout = {
  has: (files, conn) => !!files[conn.path],
  files: (lib, conn) => ({ [conn.path]: stable({ v: 1, songs: lib.songs, setlists: lib.setlists, prefs: lib.prefs }) }),
  load: (read, conn) => read(conn.path),
};

// The plain contents of the songbook's files (tests).
export const serialize = lib => songbookLayout.files(lib);

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'a browser';
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- the two documents ----------

let storageFailed = false;
function storageError(e) {
  if (storageFailed) return;
  storageFailed = true;
  console.warn('TabIt storage:', e);
  dispatchEvent(new CustomEvent('tabit-storage-error', { detail: e }));
}
const hooks = {
  onUpdate: () => refresh(),
  onSynced: () => channel?.postMessage({ t: 'synced' }),
  wantSync: ms => scheduleSync(ms),
  onStorageError: storageError,
};

export const book = new Doc({
  name: 'book', layout: songbookLayout, apply: applyOp, empty: emptyLibrary, normalize,
  connect() { const a = getAuth(); return a?.token ? { remote: remote(a.token), key: a.libKey, id: keyId(a.libKey) } : null; },
  message: n => `${n ? plural(n, 'change') : 'Sync'} from ${deviceName()}`,
  upgrade: lib => claimLegacy(lib),
  upgraded: () => { claim = null; db.del('book.claim').catch(() => {}); },
  ...hooks,
});

export const mine = new Doc({
  name: 'mine', layout: personLayout, apply: applyMine, empty: emptyLibrary, normalize: normalizeMine,
  connect() { const a = getAuth(); return a?.token && a.person ? { remote: remote(a.token), key: a.person.key, id: keyId(a.person.key), path: personPath(a.person.id) } : null; },
  message: n => `${n ? plural(n, 'personal change') : 'Sync'} from ${deviceName()}`,
  ...hooks,
});

let joined = null;
function refresh() {
  if (joined?.a !== book.lib || joined?.b !== mine.lib) joined = { a: book.lib, b: mine.lib, lib: joinLibrary(book.lib, mine.lib) };
  store.lib = joined.lib;
  store.sync = combinedStatus();
  emit();
}

function combinedStatus() {
  if (!signedIn()) return { state: 'local', message: '', at: '' };
  const docs = [book.status, ...(mine.connect() ? [mine.status] : [])];
  const any = s => docs.find(d => d.state === s);
  const at = docs.map(d => d.at).filter(Boolean).sort().at(-1) || '';
  const n = pendingCount();
  if (any('error')) return { ...any('error'), at };
  if (any('saving')) return { state: 'saving', message: '', at };
  if (any('offline')) return { state: 'offline', message: n ? `Offline. ${plural(n, 'change')} ${n === 1 ? 'is' : 'are'} saved on this device and will sync later.` : 'Offline. Your library is on this device.', at };
  if (any('pending') || n) return { state: 'pending', message: '', at };
  return { state: docs.every(d => d.state === 'idle') ? 'idle' : 'saved', message: '', at };
}

export const pendingCount = () => book.pending.length + mine.pending.length;

// ---------- on this device ----------

// The songbook on GitHub from before it was shared has its owner's part in
// its index. The first of the owner's devices to update (it was signed in to
// that songbook then: `claim` is its key's id) takes it into its own part,
// adding to what it has (favorites add up, its own values stay), and the index
// is written again without it. On any other device it's left as it is.
let claim = null;
function claimLegacy(lib) {
  const a = getAuth();
  if (!claim || !a || claim !== keyId(a.libKey)) return null;
  const { shared, mine: theirs } = splitLibrary(lib);
  for (const op of mergeMine(mine.lib, theirs)) mine.dispatch(op);
  refresh();
  return shared;
}

// From before the songbook was shared (one library with everything in it):
// the songs go to the songbook, favorites and setlists to your part.
async function migrate() {
  const [already, old] = await Promise.all([db.get('book.state'), db.get('lib.state')]);
  if (already || !old) return;
  const { shared, mine: own } = splitLibrary(normalize(old.base));
  const queue = async name => {
    try {
      const v = JSON.parse(localStorage.getItem(`tabit.${name}`));
      if (Array.isArray(v)) return v;
    } catch { /* below */ }
    const v = await db.get(`lib.${name}`);
    return Array.isArray(v) ? v : [];
  };
  const parts = ops => {
    const a = [], b = [];
    for (const op of ops) {
      const [x, y] = splitOp(op);
      if (x) a.push(x);
      if (y) b.push(y);
    }
    return [a, b];
  };
  const [pa, pb] = parts(await queue('pending'));
  const [ja, jb] = parts(await queue('journal'));
  const syncedAt = await db.get('lib.syncedAt');
  const oldSince = await db.get('lib.since');
  const since = oldSince?.lib && oldSince.base ? { lib: oldSince.lib, base: splitLibrary(normalize(oldSince.base)).shared } : null;
  const a = getAuth();
  // (the songbook is read in full from GitHub once, so its index is seen as
  // it is: see claimLegacy)
  await Promise.all([
    db.set('book.state', { base: shared, rev: null, since }), db.set('book.pending', pa), db.set('book.journal', ja),
    db.set('mine.state', { base: own, rev: null }), db.set('mine.pending', pb), db.set('mine.journal', jb),
    syncedAt ? db.set('book.syncedAt', syncedAt) : null,
    a?.token && a.libKey ? db.set('book.claim', keyId(a.libKey)) : null,
  ]);
  await Promise.all(['state', 'pending', 'journal', 'since', 'syncedAt'].map(k => db.del(`lib.${k}`)));
  for (const k of ['tabit.pending', 'tabit.journal']) { try { localStorage.removeItem(k); } catch { /* fine */ } }
}

export async function init() {
  let a, b;
  try {
    await migrate();
    [a, b, claim] = await Promise.all([book.init(), mine.init(), db.get('book.claim')]);
  } catch (e) {
    // Never start from an empty library when the real one just couldn't be read:
    // the next save would replace it.
    throw new Error(`TabIt couldn’t read its storage on this device (${e?.name || e}). Close the app and open it again.`);
  }
  store.ready = true;
  refresh();
  return { fresh: !a.saved && !b.saved };
}

// Replaces the whole local library (first run, imports). Not synced by itself.
export function replaceLocal(lib) {
  const { shared, mine: own } = splitLibrary(normalize(lib));
  Promise.all([book.replace(shared), mine.replace(own)]).then(tellOtherTabs);
  refresh();
}

addEventListener('pagehide', () => { book.writeBase(); mine.writeBase(); });

// ---------- editing ----------

// Every change is one op on the library as shown; its songbook part and your
// part each go to their own document. Lazy ops (play counts) ride along with
// the next save instead of causing one.
export function dispatch(op, { lazy = false, fromTab = false } = {}) {
  if (!fromTab) channel?.postMessage({ t: 'op', op });
  const [shared, own] = splitOp(op);
  if (shared) book.dispatch(shared, { lazy });
  if (own) mine.dispatch(own, { lazy });
  refresh();
}

// Applies an op and returns a function that undoes it.
export function undoable(op) {
  const inverse = invertOp(store.lib, op);
  dispatch(op);
  return () => dispatch(inverse);
}

// ---------- syncing ----------

let syncing = null;
let timer = null;

export function scheduleSync(ms = 1500) {
  if (!signedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), ms);
}

// The songbook, then your part (one after the other, so they don't race each
// other for the same branch).
export function syncNow() {
  if (!signedIn()) return Promise.resolve();
  if (syncing) return syncing.then(() => (pendingCount() && signedIn() ? syncNow() : undefined));
  clearTimeout(timer);
  syncing = (async () => {
    await book.sync();
    await mine.sync();
    if ([book, mine].some(d => d.status.state === 'error' && d.status.kind === 'auth') && (await newKey())) {
      await book.sync();
      await mine.sync();
    }
  })().finally(() => { syncing = null; refresh(); });
  return syncing;
}

// GitHub stopped accepting the key: if it was replaced (on any device), this
// one picks up the new key (account.js). Looked for at most once a minute
// (and again after signing in or out).
async function newKey() {
  const token = getAuth()?.token;
  if (!token || (lookedFor.token === token && Date.now() - lookedFor.at < 60_000)) return false;
  lookedFor = { token, at: Date.now() };
  try { return await (await import('./account.js')).pickUpNewKey(); } catch { return false; }
}

// Called on start and when the app comes back to the front.
export function maybePull(maxAge = 30_000) {
  if (!signedIn()) return;
  const last = Math.min(book.lastPull, mine.connect() ? mine.lastPull : Infinity);
  if (pendingCount() || Date.now() - last > maxAge) syncNow();
}

// The songbook on GitHub, and someone's part (account.js reads them before signing in).
export const pullBook = (r, key) => book.pull({ remote: r, key });
export const pullMine = (r, key, id) => mine.pull({ remote: r, key, path: personPath(id) });

// ---------- signing in and out ----------

// A name for a key that doesn't give it away.
function keyId(key) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (const ch of 'tabit-library:' + key) {
    const c = ch.charCodeAt(0);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

// The songs this device has that the songbook doesn't: added to it. A song
// that's already there (the same Ultimate Guitar tab) isn't added twice; it's
// a twin, and your part moves over to the songbook's copy.
//
// Joining the songbook this device was signed out of, `prior` is the copy it
// had then: what changed here since is applied on top, field by field, and
// songs deleted elsewhere in the meantime stay deleted.
export function mergeSongs(remoteLib, local, prior = null) {
  const ops = [];
  const twins = new Map();
  const byUrl = new Map(Object.values(remoteLib.songs).filter(s => s.src?.url).map(s => [s.src.url, s]));
  const key = s => `${(s.title || '').toLowerCase()}|${(s.artist || '').toLowerCase()}`;
  const byName = new Map(Object.values(remoteLib.songs).map(s => [key(s), s]));
  for (const s of Object.values(local.songs)) {
    if (remoteLib.songs[s.id] || prior?.songs[s.id]) continue;
    const twin = (s.src?.url && byUrl.get(s.src.url)) || (s.src?.site === 'legacy' ? byName.get(key(s)) : null);
    if (twin) twins.set(s.id, twin.id);
    else ops.push({ t: 'add', song: s });
  }
  if (prior) ops.push(...diffOps(prior, local).filter(op => op.t === 'set' || op.t === 'del'));
  return { ops, twins };
}

// Your part for songs that turned out to be twins goes over to the songbook's id.
function moveToTwins(own, twins) {
  const ops = [];
  for (const [from, to] of twins) {
    const entry = own.songs[from];
    if (entry && !own.songs[to]) ops.push({ t: 'set', id: to, set: { ...entry } });
    for (const l of Object.values(own.setlists)) {
      if (l.songs.includes(from)) ops.push({ t: 'list', id: l.id, set: { songs: l.songs.map(x => (x === from ? to : x)) } });
    }
    if (entry) ops.push({ t: 'del', id: from });
  }
  return ops;
}

// Your part on this device, joining your account's. Signing back in to the
// same account (`prior` is what it had at sign-out), what changed here since
// goes on top. The first time from this device, what's here fills in what
// isn't there yet (favorites add up).
export function mergeMine(remoteMine, local, prior = null) {
  if (prior) {
    const clear = Object.fromEntries(PERSONAL_FIELDS.map(k => [k, null]));
    return diffOps(prior, local).map(op => (op.t === 'add' ? { t: 'set', id: op.song.id, set: personalPart(op.song) }
      : op.t === 'del' ? { t: 'set', id: op.id, set: clear } : op));
  }
  const ops = [];
  for (const [id, entry] of Object.entries(local.songs)) {
    const theirs = remoteMine.songs[id] || {};
    const set = {};
    for (const [k, v] of Object.entries(entry)) if (theirs[k] === undefined || (k === 'fav' && v && !theirs.fav)) set[k] = v;
    if (Object.keys(set).length) ops.push({ t: 'set', id, set });
  }
  for (const l of Object.values(local.setlists)) if (!remoteMine.setlists[l.id]) ops.push({ t: 'list', id: l.id, set: l });
  return ops;
}

// Signed in: the songbook (and your part, with an account) from GitHub, and
// what this device has merged into them.
export async function startSync(auth, { remoteLib = null, rev = null, remoteMine = null, mineRev = null } = {}) {
  const bookSince = await book.since();
  const prior = remoteLib && bookSince?.lib === keyId(auth.libKey) ? normalize(bookSince.base) : null;
  const mineSince = auth.person ? await mine.since() : null;
  setAuth(auth);
  const { ops, twins } = mergeSongs(remoteLib || emptyLibrary(), book.lib, prior);
  book.forgetSince();
  const wrote = [book.begin({ remoteLib, rev, ops })];
  const moved = moveToTwins(mine.lib, twins);
  if (auth.person) {
    const here = moved.reduce(applyMine, mine.lib);
    // what's here is someone else's part (they signed out on this device): left out
    const other = mineSince && mineSince.lib !== keyId(auth.person.key);
    const priorMine = mineSince?.lib === keyId(auth.person.key) ? normalizeMine(mineSince.base) : null;
    mine.forgetSince();
    wrote.push(mine.begin({ remoteLib: remoteMine, rev: mineRev, ops: other ? [] : mergeMine(remoteMine || emptyLibrary(), here, priorMine) }));
  } else {
    for (const op of moved) mine.dispatch(op);
  }
  refresh();
  Promise.all(wrote).then(tellOtherTabs);
  await syncNow();
}

// An account for your part, on a device already signed in to the songbook:
// a new one (what's here is its first copy), or yours from another device
// (what's here is added to it; as when signing in, if it's the account that
// signed out here, what changed since goes on top, and if it's someone
// else's, it's left out).
export async function startMine(auth, { remoteMine = null, rev = null } = {}) {
  const since = await mine.since();
  const id = keyId(auth.person.key);
  setAuth(auth);
  mine.forgetSince();
  const ops = !remoteMine ? mergeMine(emptyLibrary(), mine.lib)
    : since && since.lib !== id ? []
      : mergeMine(remoteMine, mine.lib, since ? normalizeMine(since.base) : null);
  const wrote = mine.begin({ remoteLib: remoteMine, rev, ops });
  refresh();
  wrote.then(tellOtherTabs);
  await syncNow();
}

// keepSongs: the songbook stays on this device as it is (else it's emptied,
// with your part). Your part always stays (an account's, remembered as its).
export function signOut({ keepSongs = true } = {}) {
  const auth = getAuth();
  clearTimeout(timer);
  const wrote = [book.end({ keep: keepSongs, since: keepSongs && auth?.libKey ? keyId(auth.libKey) : null })];
  if (!keepSongs) wrote.push(mine.end({ keep: false }));
  else if (auth?.person) wrote.push(mine.end({ keep: true, since: keyId(auth.person.key) }));
  setAuth(null);
  refresh();
  Promise.all(wrote).then(tellOtherTabs);
}

// For tests: the two documents, and saving them now.
export const _docs = { book, mine };
export const _flush = () => Promise.all([book.writeBase(), mine.writeBase()]);
export { RemoteError };

addEventListener('online', () => syncNow());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybePull();
  else {
    book.writeBase();
    mine.writeBase();
    if (pendingCount() && signedIn()) syncNow();
  }
});

// ---------- other tabs ----------

// With TabIt open in two tabs, each passes its edits to the other so neither
// saves over them (the tab that made an edit uploads it; the others catch up
// when it says it saved). Signing in or out, or replacing the library, reloads
// the others once the new state is saved.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tabit-store') : null;
channel?.addEventListener('message', ({ data }) => {
  if (!data || !store.ready) return;
  if (data.t === 'op') dispatch(data.op, { lazy: true, fromTab: true });
  else if (data.t === 'synced') { if (pendingCount()) syncNow(); }
  else if (data.t === 'reload') location.reload();
});
function tellOtherTabs() {
  channel?.postMessage({ t: 'reload' });
}
