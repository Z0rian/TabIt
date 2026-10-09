// A tiny key-value store on IndexedDB. The library lives here instead of
// localStorage, which is small (about 5 MB) and shared with the other apps on
// z0rian.github.io. Falls back to memory when IndexedDB isn't available
// (some private browsing modes), so the app still runs for the session.
//
// Reads and writes that fail are retried once on a fresh connection (Safari
// sometimes loses its connection to the storage process), then reject: a
// caller must know when something it relies on wasn't saved, or wasn't read.

const NAME = 'tabit';
const STORE = 'kv';
let dbp = null;
const memory = new Map();
let useMemory = false;

function open() {
  if (useMemory) return Promise.resolve(null);
  return (dbp ||= new Promise(resolve => {
    let req;
    try {
      req = indexedDB.open(NAME, 1);
    } catch {
      useMemory = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => { useMemory = true; resolve(null); };
    req.onblocked = () => { useMemory = true; resolve(null); };
  }));
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    const r = fn(store);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

// { memory: true } when there's no IndexedDB, else { value }.
async function run(mode, fn) {
  for (let attempt = 0; ; attempt++) {
    const db = await open();
    if (!db) return { memory: true };
    try {
      return { value: await tx(db, mode, fn) };
    } catch (e) {
      if (dbp) dbp = null;
      try { db.close(); } catch { /* already closed */ }
      if (attempt) throw e;
    }
  }
}

export async function get(key) {
  const r = await run('readonly', s => s.get(key));
  return r.memory ? memory.get(key) : r.value;
}

// tests: pretend the disk is full
export const faults = { writes: false };

export async function set(key, value) {
  memory.set(key, value);
  if (faults.writes) throw new DOMException('Storage is full (test)', 'QuotaExceededError');
  await run('readwrite', s => s.put(value, key));
}

export async function del(key) {
  memory.delete(key);
  await run('readwrite', s => s.delete(key));
}

export const persistent = async () => {
  await open();
  return !useMemory;
};

// Ask the browser not to evict the library under storage pressure (Safari
// otherwise may clear site data after weeks without a visit).
export async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist();
    return await navigator.storage?.persisted?.();
  } catch {
    return false;
  }
}
