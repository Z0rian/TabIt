// Encryption for sync, all with the browser's own Web Crypto.
//
//  - Passwords: each password seals one copy of the sign-in bundle (the GitHub
//    key + the library key) with AES-GCM under a key stretched from the
//    password (PBKDF2-SHA256, 600k rounds), the same scheme as the Ranch app.
//  - The library itself is gzipped and AES-GCM encrypted with the library key,
//    because the data repository is public.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 600_000;

export const toB64 = bytes => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = s => Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0));

// Phones like to capitalize the first letter and add a space; those don't count.
export const normalizePassword = pw => String(pw || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function stretch(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealWithPassword(payload, password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await stretch(password, salt, iterations);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return { iterations, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

// The payload if the password opens this entry, otherwise null.
export async function openWithPassword(entry, password) {
  try {
    const key = await stretch(password, fromB64(entry.salt), entry.iterations || ITERATIONS);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv) }, key, fromB64(entry.data));
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}

// ---------- library key ----------

export function newLibraryKey() {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

const keyCache = new Map();
function importKey(b64) {
  if (!keyCache.has(b64)) keyCache.set(b64, crypto.subtle.importKey('raw', fromB64(b64), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return keyCache.get(b64);
}

// The GitHub key also seals the library key, so a device set up with the key
// itself (the owner's) can read the library without a password.
async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`tabit-owner-v1:${token}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealWithToken(payload, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(token), enc.encode(JSON.stringify(payload)));
  return { iv: toB64(iv), data: toB64(data) };
}

export async function openWithToken(entry, token) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv) }, await tokenKey(token), fromB64(entry.data));
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}

// ---------- compression ----------

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function gzip(bytes) {
  return canGzip ? pipe(bytes, new CompressionStream('gzip')) : bytes;
}

export async function gunzip(bytes) {
  // gzip files start with 1f 8b
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!canGzip) throw new Error('This browser can’t read compressed data. Update it to sync.');
    return pipe(bytes, new DecompressionStream('gzip'));
  }
  return bytes;
}

// A file of the synced library: JSON → gzip → AES-GCM, stored as small JSON.
// The path is bound in as associated data, so files can't be swapped around.
export async function encryptJSON(obj, libKey, path) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await gzip(enc.encode(JSON.stringify(obj)));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(path) }, await importKey(libKey), packed);
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(data) });
}

export async function decryptJSON(text, libKey, path) {
  const box = JSON.parse(text);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: enc.encode(path) }, await importKey(libKey), fromB64(box.data));
  return JSON.parse(dec.decode(await gunzip(new Uint8Array(plain))));
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
