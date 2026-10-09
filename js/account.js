// Signing in, the same way as the Ranch app: the owner makes one GitHub key
// once; each password stored in access.json (on the data branch, public)
// unlocks an encrypted copy of that key plus the key that encrypts the library.
// A new device only needs a password.

import { RemoteError } from './remote.js';
import { sealWithPassword, openWithPassword, sealWithToken, openWithToken, newLibraryKey } from './crypto.js';
import { remote, startSync, pull, getAuth, setAuth, store, deviceName, cfg, useMock } from './store.js';
import { newId } from './model.js';

export const ACCESS_PATH = 'access.json';
export const MIN_PASSWORD = 8;

function emptyAccess() {
  return {
    v: 1,
    note: 'TabIt sign-in. Each entry is the sync key encrypted with one password; it only opens with that password. Manage them in TabIt under Settings → Sync.',
    owner: null,
    entries: [],
  };
}

async function readAccess(r) {
  const text = await r.readPublic(ACCESS_PATH);
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new RemoteError('The sign-in file on GitHub is damaged.', 0, 'parse'); }
}

// Pre-filled page for making a fine-grained key that can only touch this repository.
export function tokenUrl() {
  const q = new URLSearchParams({
    name: `TabIt sync ${Math.random().toString(36).slice(2, 6)}`,
    description: 'Lets TabIt sync your song library between devices.',
    expires_in: 'none',
    contents: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}

export function passwordProblem(pw) {
  const p = String(pw || '').trim();
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters. A few words is easiest, like “banjo river tuesday”.`;
  if (/^(password|tabit|12345678|qwertyui|guitar12)/i.test(p)) return 'That one is too easy to guess.';
  return '';
}

// Owner setup on the first device: check the key, then either join the library
// that's already there (this key made it) or create it.
export async function setupWithKey(token) {
  token = String(token || '').trim();
  if (!token) throw new RemoteError('Paste the key first.', 0, 'input');
  const r = remote(token);
  const perm = await r.canWrite().catch(e => {
    if (e.kind === 'notfound') throw new RemoteError(`This key can’t see ${cfg.owner}/${cfg.repo}. Under “Repository access”, pick that repository.`, 404, 'notfound');
    throw e;
  });
  if (!perm.push) throw new RemoteError('This key can read but not save. Set Contents to “Read and write”.', 403, 'forbidden');
  const login = await r.whoami();
  // Read with the key (not anonymously): if the repository were private an
  // anonymous read would look like "nothing there" and setup would overwrite it.
  const head = await r.head();
  let access = await readAccessAt(r, head);
  let libKey;
  if (!access && head && (await r.files(head))['library/index.json']) {
    throw new RemoteError('There’s a synced library on GitHub but its sign-in file is missing, so it can’t be opened. Nothing was changed.', 0, 'damaged');
  }
  if (access?.owner) {
    const opened = await openWithToken(access.owner, token);
    if (!opened) {
      throw new RemoteError('A synced library already exists but was set up with a different key. Sign in with one of your passwords instead; you can then switch to this key.', 0, 'otherkey');
    }
    libKey = opened.libKey;
  } else if (access?.entries?.length) {
    throw new RemoteError('Sync is already set up. Sign in with one of your passwords instead.', 0, 'otherkey');
  } else {
    libKey = newLibraryKey();
    access = emptyAccess();
    access.owner = await sealWithToken({ v: 1, libKey }, token);
    await writeAccess(r, access, 'Set up TabIt sync');
  }
  const auth = { token, libKey, via: 'key', login, since: new Date().toISOString() };
  const { lib, rev } = await pull(r, libKey);
  await startSync(auth, { remoteLib: lib, rev });
  return auth;
}

// Any device: a password opens one of the entries.
export async function signInWithPassword(password) {
  if (!String(password || '').trim()) throw new RemoteError('Type your password first.', 0, 'input');
  const r0 = remote('');
  const access = await readAccess(r0);
  if (!access || (!access.entries?.length)) throw new RemoteError('Sync isn’t set up yet. Do it once on your main device (Settings → Sync → Set up sync).', 0, 'nosetup');
  let opened = null;
  for (const e of access.entries) {
    opened = await openWithPassword(e, password);
    if (opened) { opened.label = e.label; break; }
  }
  if (!opened) throw new RemoteError('That password didn’t work. Capitals and spaces don’t matter, but check the spelling.', 0, 'badpassword');
  const r = remote(opened.token);
  let head;
  try {
    head = await r.head();
  } catch (e) {
    if (e.kind === 'auth') throw new RemoteError('The password is right, but GitHub no longer accepts the key behind it. On the main device, make a new key and add your passwords again.', 401, 'auth');
    throw e;
  }
  void head;
  const auth = { token: opened.token, libKey: opened.libKey, via: 'password', label: opened.label || '', since: new Date().toISOString() };
  const { lib, rev } = await pull(r, opened.libKey);
  await startSync(auth, { remoteLib: lib, rev });
  return auth;
}

// Read-modify-write of access.json in its own commit, retried if another
// device saved in between.
async function updateAccess(change, message) {
  const auth = getAuth();
  if (!auth) throw new RemoteError('Sign in first.', 0, 'auth');
  const r = remote(auth.token);
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await r.head();
    const access = (await readAccessAt(r, head)) || emptyAccess();
    await change(access, auth);
    try {
      await r.commit({ parent: head, files: { [ACCESS_PATH]: JSON.stringify(access, null, 2) + '\n' }, message });
      return access;
    } catch (e) {
      if (e.kind !== 'conflict') throw e;
    }
  }
  throw new RemoteError('Another device was saving at the same moment. Try again.', 409, 'conflict');
}

async function readAccessAt(r, head) {
  if (!head) return null;
  const files = await r.files(head);
  if (!files[ACCESS_PATH]) return null;
  return JSON.parse(await r.blob(files[ACCESS_PATH]));
}

async function writeAccess(r, access, message) {
  const head = await r.head();
  await r.commit({ parent: head, files: { [ACCESS_PATH]: JSON.stringify(access, null, 2) + '\n' }, message });
}

export async function listPasswords() {
  const auth = getAuth();
  const access = await readAccess(remote(auth?.token || ''));
  return (access?.entries || []).map(e => ({ id: e.id, label: e.label, added: e.added, device: e.device }));
}

export async function addPassword(password, label) {
  const problem = passwordProblem(password);
  if (problem) throw new RemoteError(problem, 0, 'input');
  return updateAccess(async (access, auth) => {
    for (const e of access.entries) {
      if (await openWithPassword(e, password)) throw new RemoteError('That password is already on the list.', 0, 'duplicate');
    }
    const sealed = await sealWithPassword({ v: 1, token: auth.token, libKey: auth.libKey }, password);
    access.entries.push({ id: newId('pw'), label: String(label || '').trim() || `Password ${access.entries.length + 1}`, added: new Date().toISOString().slice(0, 10), device: deviceName(), ...sealed });
    if (!access.owner && auth.via === 'key') access.owner = await sealWithToken({ v: 1, libKey: auth.libKey }, auth.token);
  }, `Added a sign-in password (${label || 'unnamed'})`);
}

export async function removePassword(id) {
  return updateAccess(access => {
    access.entries = access.entries.filter(e => e.id !== id);
  }, 'Removed a sign-in password');
}

// Switch every password to a new GitHub key (after the old one was deleted or
// expired). The device must still be signed in, so it knows the library key;
// the passwords themselves have to be typed again.
export async function replaceKey(newToken, passwords) {
  const auth = getAuth();
  if (!auth) throw new RemoteError('Sign in first.', 0, 'auth');
  newToken = newToken.trim();
  const r = remote(newToken);
  const perm = await r.canWrite();
  if (!perm.push) throw new RemoteError('The new key can’t save. Set Contents to “Read and write”.', 403, 'forbidden');
  const head = await r.head();
  const access = (await readAccessAt(r, head)) || emptyAccess();
  access.owner = await sealWithToken({ v: 1, libKey: auth.libKey }, newToken);
  access.entries = [];
  for (const { password, label } of passwords) {
    const sealed = await sealWithPassword({ v: 1, token: newToken, libKey: auth.libKey }, password);
    access.entries.push({ id: newId('pw'), label, added: new Date().toISOString().slice(0, 10), device: deviceName(), ...sealed });
  }
  await r.commit({ parent: head, files: { [ACCESS_PATH]: JSON.stringify(access, null, 2) + '\n' }, message: 'Switched TabIt sync to a new key' });
  setAuth({ ...auth, token: newToken, via: 'key' });
}

export const isMock = () => useMock;
export { store };
