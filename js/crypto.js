// Encryption for sync, all with the browser's own Web Crypto.
//
//  - Passwords: each password seals what it unlocks with AES-GCM under a key
//    stretched from the password (PBKDF2-SHA256, 600k rounds), the same scheme
//    as the Ranch app.
//  - Each password also has a key pair (ECDH P-256), and the GitHub key is
//    sealed to its public key: a device that's in can give every password a
//    new GitHub key without knowing any of them.
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

async function derive(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// The entries of one sign-in file share a salt, so trying a password on all
// of them stretches it once. (Kept for half a minute, then forgotten.)
const stretched = new Map();
let forget = 0;
function stretch(password, salt, iterations) {
  const k = `${iterations}:${salt}:${normalizePassword(password)}`;
  if (!stretched.has(k)) stretched.set(k, derive(password, salt, iterations).catch(e => { stretched.delete(k); throw e; }));
  clearTimeout(forget);
  forget = setTimeout(() => stretched.clear(), 30_000);
  return stretched.get(k);
}

export const newSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

export async function sealWithPassword(payload, password, salt = newSalt(), iterations = ITERATIONS) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await stretch(password, salt, iterations);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return { iterations, salt, iv: toB64(iv), data: toB64(data) };
}

// The payload if the password opens this entry, otherwise null.
export async function openWithPassword(entry, password) {
  try {
    const key = await stretch(password, entry.salt, entry.iterations || ITERATIONS);
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

// ---------- a key pair per password ----------

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const pubOnly = ({ kty, crv, x, y }) => ({ kty, crv, x, y });

// → { pub, priv } as JWK (priv only ever stored sealed with its password, or on a device signed in with it)
export async function newKeyPair() {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { pub: pubOnly(await crypto.subtle.exportKey('jwk', pair.publicKey)), priv: { ...pubOnly(priv), d: priv.d } };
}

async function boxKey(privateKey, publicKey) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('tabit-sealed-v1') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Sealed so that only the holder of pub's private key opens it.
export async function sealToKey(payload, pub) {
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const key = await boxKey(eph.privateKey, await crypto.subtle.importKey('jwk', pub, ECDH, false, []));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return { epk: pubOnly(await crypto.subtle.exportKey('jwk', eph.publicKey)), iv: toB64(iv), data: toB64(data) };
}

export async function openWithKey(box, priv) {
  try {
    const key = await boxKey(await crypto.subtle.importKey('jwk', priv, ECDH, false, ['deriveBits']), await crypto.subtle.importKey('jwk', box.epk, ECDH, false, []));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
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
