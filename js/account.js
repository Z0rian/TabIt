// Signing in, the same way as the Ranch app: the owner makes one GitHub key
// once; each password in access.json (in the public data repository) unlocks
// the key that encrypts the shared songbook and a key pair of its own, and the
// GitHub key is kept sealed to that pair. Two kinds of password:
//  - an invite: anyone in makes one for friends; it lets a device into the
//    songbook;
//  - an account: someone's own, made by themselves once they're in. It also
//    unlocks a key of their own for their part (favorites, setlists, song
//    settings), so that syncs too and nobody else can read it.
// Only the owner ever needs GitHub. The GitHub key only reaches the data
// repository, so a guessed password can't be used to change the app itself.
// When the GitHub key is replaced, every password is handed the new one
// without anyone typing it, and signed-in devices pick it up by themselves;
// a password that was removed isn't handed it.
//
// An entry: { id, kind: 'invite' | 'person', label, added, device,
//   iterations, salt, iv, data (sealed with the password: { v: 2, libKey, priv, person? }),
//   pub, tok (the GitHub key, sealed to pub) }.
// From before key pairs: sealed { v: 1, token, libKey }, no pub or tok.

import { RemoteError } from './remote.js';
import { sealWithPassword, openWithPassword, sealWithToken, openWithToken, newLibraryKey, newSalt, newKeyPair, sealToKey, openWithKey } from './crypto.js';
import { remote, startSync, startMine, pullBook, pullMine, getAuth, setAuth, store, deviceName, cfg, useMock, syncNow } from './store.js';
import { newId } from './model.js';

export const ACCESS_PATH = 'access.json';
export const MIN_PASSWORD = 8;

function emptyAccess() {
  return {
    v: 2,
    note: 'TabIt sign-in. Each entry only opens with its own password (an invite, or someone’s account). Manage them in TabIt under Settings → Shared songbook.',
    salt: newSalt(),
    owner: null,
    entries: [],
  };
}

// A new entry for a password, and its private key.
async function makeEntry(access, { id = newId('pw'), kind, label, added = today(), device = deviceName(), password, token, libKey, person = null }) {
  access.salt ||= newSalt();
  const { pub, priv } = await newKeyPair();
  const sealed = await sealWithPassword({ v: 2, libKey, priv, ...(person ? { person } : {}) }, password, access.salt);
  return { entry: { id, kind, label, added, device, ...sealed, pub, tok: await sealToKey({ token }, pub) }, priv };
}

// The entry a password opens, and what's in it, or null.
async function findEntry(access, password) {
  for (const e of access?.entries || []) {
    const o = await openWithPassword(e, password);
    if (o) return { e, o };
  }
  return null;
}

// The GitHub key that goes with an opened entry.
async function entryToken(e, o) {
  if (!o.priv) return o.token || ''; // from before key pairs: it's inside
  return (e.tok && (await openWithKey(e.tok, o.priv))?.token) || '';
}

async function readAccess(r) {
  const text = await r.readPublic(ACCESS_PATH);
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new RemoteError('The sign-in file on GitHub is damaged.', 0, 'parse'); }
}

// Pre-filled page for making the repository that holds the library.
export function repoUrl() {
  const q = new URLSearchParams({ name: cfg.repo, owner: cfg.owner, visibility: 'public', description: 'TabIt song library, encrypted. Synced by the TabIt app.' });
  return `https://github.com/new?${q}`;
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------- what's wrong with a key, in words, with where to fix it ----------

const KEYS_PAGE = 'https://github.com/settings/personal-access-tokens';
const repoPage = () => `https://github.com/${cfg.owner}/${cfg.repo}`;

function keyNotValid() {
  return new RemoteError('GitHub doesn’t recognize this key. Copy it again from GitHub (all of it: it starts with github_pat_ and is about 90 characters long), or make a new one.', 401, 'auth',
    [{ href: tokenUrl(), text: 'Make a new key' }]);
}
function cantSave() {
  return new RemoteError(`This key can read ${cfg.repo} but not save to it. On GitHub, open the key and set Repository permissions → Contents to “Read and write”.`, 403, 'forbidden',
    [{ href: KEYS_PAGE, text: 'Your keys on GitHub' }]);
}
function isPrivate() {
  return new RemoteError(`Your ${cfg.repo} repository is private, so your other devices couldn’t sign in with a password. Make it public (everything TabIt saves there is encrypted): its Settings → General → Danger Zone → Change visibility. Then try again.`, 0, 'private',
    [{ href: `${repoPage()}/settings`, text: `${cfg.repo} settings` }]);
}
// The key works but GitHub won't show it the repository: find out why.
async function repoMissing(r) {
  const visible = await r.isPublic().catch(() => null);
  if (visible) {
    return new RemoteError(`Your ${cfg.repo} repository is there, but this key can’t reach it. On GitHub, open the key and under Repository access choose “Only select repositories” → ${cfg.repo}. (A key made before the repository can’t see it until you add it.)`, 404, 'notfound',
      [{ href: KEYS_PAGE, text: 'Your keys on GitHub' }]);
  }
  return new RemoteError(`GitHub has no public repository called ${cfg.repo} on your account (${cfg.owner}). TabIt keeps your library in this second repository, apart from TabIt itself: make it (empty) with step 1’s pre-filled page: name ${cfg.repo}, Public, then Create repository. If you made it private, make it public instead. Then add it to the key under Repository access, and try again.`, 404, 'notfound',
    [{ href: repoUrl(), text: `Make ${cfg.repo}` }, { href: KEYS_PAGE, text: 'Your keys on GitHub' }]);
}
// Checks a key before anything is saved with it.
async function checkKey(r) {
  let perm;
  try {
    perm = await r.canWrite();
  } catch (e) {
    if (e.kind === 'auth') throw keyNotValid();
    if (e.kind === 'notfound') throw await repoMissing(r);
    throw e;
  }
  if (perm.push === false) throw cantSave();
  if (perm.private) throw isPrivate();
}
const saving = e => { throw e.kind === 'forbidden' ? cantSave() : e.kind === 'auth' ? keyNotValid() : e; };

// Pre-filled page for making a fine-grained key that can only touch that repository.
export function tokenUrl() {
  const q = new URLSearchParams({
    name: `TabIt sync ${Math.random().toString(36).slice(2, 6)}`,
    description: `Lets TabIt sync your song library between devices (only ${cfg.repo}).`,
    target_name: cfg.owner,
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
  await checkKey(r);
  const login = await r.whoami();
  // Read with the key (not anonymously): if the repository were private an
  // anonymous read would look like "nothing there" and setup would overwrite it.
  const head = (await r.isEmpty()) ? null : await r.head();
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
    throw new RemoteError('The songbook is already set up. Sign in with your account or an invite instead.', 0, 'otherkey');
  } else {
    libKey = newLibraryKey();
    access = emptyAccess();
    access.owner = await sealWithToken({ v: 1, libKey }, token);
    await writeAccess(r, access, 'Set up TabIt sync').catch(saving);
  }
  const auth = { token, libKey, via: 'key', login, since: new Date().toISOString() };
  const { lib, rev } = await pullBook(r, libKey);
  await startSync(auth, { remoteLib: lib, rev });
  return auth;
}

const badPassword = () => new RemoteError('That password didn’t work. Capitals and spaces don’t matter, but check the spelling.', 0, 'badpassword');

// Any device: a password opens one of the entries.
export async function signInWithPassword(password) {
  if (!String(password || '').trim()) throw new RemoteError('Type your password first.', 0, 'input');
  const access = await readAccess(remote(''));
  if (!access?.entries?.length) throw new RemoteError('The songbook isn’t set up yet. Do it once on your main device (Settings → Shared songbook → Set up).', 0, 'nosetup');
  const found = await findEntry(access, password);
  if (!found) throw badPassword();
  const { e, o } = found;
  const token = await entryToken(e, o);
  const r = remote(token);
  try {
    if (!token) throw new RemoteError('', 401, 'auth');
    await r.head();
  } catch (err) {
    if (err.kind === 'auth') throw new RemoteError('The password is right, but GitHub no longer accepts the key behind it. On the main device, replace the GitHub key (Settings → Shared songbook).', 401, 'auth');
    throw err;
  }
  // an account's password also opens its own part
  const person = o.person ? { id: o.person.id, key: o.person.key, label: e.label || '' } : null;
  const auth = { token, libKey: o.libKey, via: 'password', label: e.label || '', since: new Date().toISOString(), entry: e.id, ...(o.priv ? { priv: o.priv } : {}), ...(person ? { person } : {}) };
  const { lib, rev } = await pullBook(r, o.libKey);
  const own = person ? await pullMine(r, person.key, person.id) : { lib: null, rev: null };
  await startSync(auth, { remoteLib: lib, rev, remoteMine: own.lib, mineRev: own.rev });
  if (!o.priv) upgradeEntry(e.id, password).catch(err => console.warn('TabIt: sign-in entry not updated', err));
  return auth;
}

// An entry from before key pairs, sealed again the new way with the password
// that was just typed, so a new GitHub key can reach it later.
async function upgradeEntry(id, password) {
  let priv = null;
  await updateAccess(async (access, a) => {
    const i = access.entries.findIndex(x => x.id === id);
    if (i < 0 || access.entries[i].pub) return false; // gone, or done already
    const old = access.entries[i];
    const o = await openWithPassword(old, password);
    if (!o) return false;
    const made = await makeEntry(access, { ...old, kind: o.person || old.kind === 'person' ? 'person' : 'invite', password, token: a.token, libKey: a.libKey, person: o.person });
    access.entries[i] = made.entry;
    priv = made.priv;
  }, 'Updated a sign-in password');
  const a = getAuth();
  if (priv && a?.entry === id) setAuth({ ...a, priv });
}

// GitHub stopped accepting this device's key. If someone in the songbook
// replaced it, the new one is in access.json, sealed to this device's
// password: take it. → whether there's a new key to sync with.
export async function pickUpNewKey() {
  const auth = getAuth();
  if (!auth?.entry || !auth.priv) return false;
  const access = await readAccess(remote(''));
  const e = access?.entries?.find(x => x.id === auth.entry);
  const token = e?.tok ? (await openWithKey(e.tok, auth.priv))?.token : '';
  const now = getAuth();
  if (!token || token === auth.token || now?.token !== auth.token) return false; // (or signed out meanwhile)
  setAuth({ ...now, token });
  return true;
}

// Your own account, on a device that's in the songbook: your favorites,
// setlists and song settings, kept with the songbook but locked with a key of
// your own, which only this password opens. No GitHub needed.
export async function makeAccount(password, name) {
  const problem = passwordProblem(password);
  if (problem) throw new RemoteError(problem, 0, 'input');
  name = String(name || '').trim();
  if (!name) throw new RemoteError('Type your name (or a nickname) first.', 0, 'input');
  const auth = getAuth();
  if (!auth?.token) throw new RemoteError('Sign in to the songbook first.', 0, 'auth');
  if (auth.person) throw new RemoteError('This device is signed in to an account already.', 0, 'input');
  const person = { id: newId('p'), key: newLibraryKey() };
  let made;
  await updateAccess(async (access, a) => {
    const dup = await findEntry(access, password);
    if (dup) throw new RemoteError(dup.e.kind === 'person' ? 'That password is someone’s account already. Pick another.' : 'That’s an invite password, which others use too. Pick one of your own.', 0, 'duplicate');
    made = await makeEntry(access, { kind: 'person', label: name, password, token: a.token, libKey: a.libKey, person });
    access.entries.push(made.entry);
  }, 'Made an account');
  const next = { ...auth, entry: made.entry.id, priv: made.priv, person: { ...person, label: name } };
  await startMine(next);
  return next;
}

// On a device that's in the songbook already (with an invite, or the GitHub
// key): your account, made on another device, so your part syncs here too.
// What this device has is added to it.
export async function useAccount(password) {
  const auth = getAuth();
  if (!auth?.token) throw new RemoteError('Sign in to the songbook first.', 0, 'auth');
  if (auth.person) throw new RemoteError('This device is signed in to an account already.', 0, 'input');
  if (!String(password || '').trim()) throw new RemoteError('Type your account’s password first.', 0, 'input');
  const found = await findEntry(await readAccess(remote(auth.token)), password);
  if (!found) throw badPassword();
  const { e, o } = found;
  if (!o.person) throw new RemoteError('That’s an invite password, not an account. Make your account instead.', 0, 'input');
  if (o.libKey !== auth.libKey) throw new RemoteError('That account belongs to another songbook.', 0, 'input');
  const token = (await entryToken(e, o)) || auth.token;
  const person = { id: o.person.id, key: o.person.key, label: e.label || '' };
  const next = { ...auth, token, entry: e.id, ...(o.priv ? { priv: o.priv } : {}), person };
  const own = await pullMine(remote(token), person.key, person.id);
  await startMine(next, { remoteMine: own.lib, rev: own.rev });
  if (!o.priv) upgradeEntry(e.id, password).catch(() => {});
  return next;
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
    if ((await change(access, auth)) === false) return access; // nothing to save
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
  const head = (await r.isEmpty()) ? null : await r.head();
  await r.commit({ parent: head, files: { [ACCESS_PATH]: JSON.stringify(access, null, 2) + '\n' }, message });
}

// Every password: { id, label, added, device, kind: 'invite' | 'person', old }
// (old: from before key pairs, so it's typed again to keep it when the GitHub
// key is replaced).
export async function listPasswords() {
  const auth = getAuth();
  const access = await readAccess(remote(auth?.token || ''));
  return (access?.entries || []).map(e => ({ id: e.id, label: e.label, added: e.added, device: e.device, kind: e.kind === 'person' ? 'person' : 'invite', old: !e.pub }));
}

// A password that lets friends into the songbook (they then make an account).
export async function addInvite(password, label) {
  const problem = passwordProblem(password);
  if (problem) throw new RemoteError(problem, 0, 'input');
  return updateAccess(async (access, auth) => {
    if (await findEntry(access, password)) throw new RemoteError('That password is already on the list.', 0, 'duplicate');
    const n = access.entries.filter(e => e.kind !== 'person').length;
    access.entries.push((await makeEntry(access, { kind: 'invite', label: String(label || '').trim() || `Invite ${n + 1}`, password, token: auth.token, libKey: auth.libKey })).entry);
    if (!access.owner && auth.via === 'key') access.owner = await sealWithToken({ v: 1, libKey: auth.libKey }, auth.token);
  }, 'Added an invite');
}
export const addPassword = addInvite;

export async function removePassword(id) {
  return updateAccess(access => {
    access.entries = access.entries.filter(e => e.id !== id);
  }, 'Removed a sign-in password');
}

// A new GitHub key, after the old one expired or was deleted (the device must
// still be signed in, so it knows the songbook's key). Every password is
// handed the new key, sealed to its own key pair, so none is typed: devices
// signed in pick it up by themselves. Passwords from before key pairs are kept
// only if typed again (`typed`: [{ id, password }]); the others stop working.
export async function replaceKey(newToken, typed = []) {
  const auth = getAuth();
  if (!auth) throw new RemoteError('Sign in first.', 0, 'auth');
  newToken = String(newToken || '').trim();
  if (!newToken) throw new RemoteError('Paste the new key first.', 0, 'input');
  const r = remote(newToken);
  await checkKey(r);
  const opened = new Map(); // id → what its typed password opened
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await r.head();
    const access = (await readAccessAt(r, head)) || emptyAccess();
    const entries = [];
    const privs = new Map();
    for (const e of access.entries) {
      if (e.pub) {
        entries.push({ ...e, tok: await sealToKey({ token: newToken }, e.pub) });
        continue;
      }
      const t = typed.find(x => x.id === e.id && String(x.password || '').trim());
      if (!t) continue;
      if (!opened.has(e.id)) {
        const o = await openWithPassword(e, t.password);
        if (!o) throw new RemoteError(`That isn’t the password for “${e.label}”. (To change a password, add the new one afterwards.)`, 0, 'badpassword');
        opened.set(e.id, o);
      }
      const o = opened.get(e.id);
      const made = await makeEntry(access, { ...e, kind: o.person || e.kind === 'person' ? 'person' : 'invite', password: t.password, token: newToken, libKey: auth.libKey, person: o.person });
      entries.push(made.entry);
      privs.set(e.id, made.priv);
    }
    if (access.entries.length && !entries.length) throw new RemoteError('Type at least one of the passwords, so devices can still sign in.', 0, 'input');
    access.owner = await sealWithToken({ v: 1, libKey: auth.libKey }, newToken);
    access.entries = entries;
    try {
      await r.commit({ parent: head, files: { [ACCESS_PATH]: JSON.stringify(access, null, 2) + '\n' }, message: 'Switched TabIt sync to a new key' });
    } catch (e) {
      if (e.kind === 'conflict') continue;
      saving(e);
    }
    const now = getAuth() || auth;
    setAuth({ ...now, token: newToken, ...(privs.has(now.entry) ? { priv: privs.get(now.entry) } : {}) });
    syncNow();
    return;
  }
  throw new RemoteError('Another device was saving at the same moment. Try again.', 409, 'conflict');
}

export const isMock = () => useMock;
export { store };
