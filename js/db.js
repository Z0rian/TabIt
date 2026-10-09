// A tiny key-value store on IndexedDB. The library lives here instead of
// localStorage, which is small (about 5 MB) and shared with the other apps on
// z0rian.github.io. Falls back to memory when IndexedDB isn't available
// (some private browsing modes), so the app still runs for the session.

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

export async function get(key) {
  const db = await open();
  if (!db) return memory.get(key);
  try { return await tx(db, 'readonly', s => s.get(key)); } catch { return memory.get(key); }
}

export async function set(key, value) {
  const db = await open();
  memory.set(key, value);
  if (!db) return;
  try { await tx(db, 'readwrite', s => s.put(value, key)); } catch (e) {
    // quota or a broken database: keep the session working from memory
    console.warn('TabIt storage:', e);
  }
}

export async function del(key) {
  const db = await open();
  memory.delete(key);
  if (!db) return;
  try { await tx(db, 'readwrite', s => s.delete(key)); } catch { /* ignore */ }
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
