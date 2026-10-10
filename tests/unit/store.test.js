// The whole sign-in and sync flow against a fake GitHub (MockRemote): the
// shared songbook (owner setup, invites, a second device, edits from two
// places, conflicts, offline), and accounts (your favorites and setlists,
// synced, unreadable to anyone else).
import { test, eq, ok, deepEq } from '../harness.js';
import { MockRemote, RemoteError } from '../../js/remote.js';
import * as db from '../../js/db.js';
import * as store from '../../js/store.js';
import * as account from '../../js/account.js';
import { decryptJSON, encryptJSON, sealWithPassword, sealToKey, openWithKey, newKeyPair } from '../../js/crypto.js';
import { makeSong, emptyLibrary } from '../../js/model.js';

const cfg = { owner: 'me', repo: 'tabit-data', branch: 'main' };
store._useRemote(token => new MockRemote(cfg, token));

const wait = ms => new Promise(r => setTimeout(r, ms));
const songs = () => Object.values(store.store.lib.songs);
const tree = () => { const st = MockRemote.state(); return st.commits[st.head].tree; };
const access = () => JSON.parse(MockRemote.state().blobs[tree()['access.json']]);
async function until(fn, what, ms = 8000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`never happened: ${what}`);
    await wait(50);
  }
}

// From here on this page is the other device, with what's on it now.
async function otherDevice(auth) {
  await store._flush();
  store.setAuth(auth);
}

// Like another device would save it: a new access.json.
async function writeAccess(a) {
  await new MockRemote(cfg, 'other').commit({ parent: MockRemote.state().head, files: { 'access.json': JSON.stringify(a, null, 2) }, message: 'from other device' });
}

// The songbook straight from the fake GitHub, like another device would read it.
async function remoteLibrary(libKey) {
  const st = MockRemote.state();
  const t = tree();
  const index = await decryptJSON(st.blobs[t['library/index.json']], libKey, 'library/index.json');
  const all = {};
  for (const [path, sha] of Object.entries(t)) {
    if (!path.startsWith('library/songs-')) continue;
    Object.assign(all, await decryptJSON(st.blobs[sha], libKey, path));
  }
  return { index, contents: all, tree: t };
}

// Someone's own part, the same way.
async function remoteMine(person) {
  const path = `people/${person.id}.json`;
  const sha = tree()[path];
  return sha ? decryptJSON(MockRemote.state().blobs[sha], person.key, path) : null;
}

// Another device saves a change directly.
async function otherDeviceAdds(libKey, song) {
  const st = MockRemote.state();
  const t = tree();
  const index = await decryptJSON(st.blobs[t['library/index.json']], libKey, 'library/index.json');
  const { content, ...meta } = song;
  index.songs[song.id] = meta;
  const lib = emptyLibrary();
  lib.songs[song.id] = song;
  const ser = store.serialize(lib);
  const shard = Object.keys(ser).find(p => p.startsWith('library/songs-') && ser[p] !== '{}');
  const cur = t[shard] ? await decryptJSON(st.blobs[t[shard]], libKey, shard) : {};
  cur[song.id] = content;
  const files = { [shard]: await encryptJSON(cur, libKey, shard), 'library/index.json': await encryptJSON(index, libKey, 'library/index.json') };
  await new MockRemote(cfg, 'other').commit({ parent: st.head, files, message: 'from other device' });
}

async function otherDeviceEdits(libKey, edit) {
  const st = MockRemote.state();
  const index = await decryptJSON(st.blobs[tree()['library/index.json']], libKey, 'library/index.json');
  edit(index);
  const files = { 'library/index.json': await encryptJSON(index, libKey, 'library/index.json') };
  await new MockRemote(cfg, 'other').commit({ parent: st.head, files, message: 'from other device' });
}

async function otherDeviceEditsMine(person, edit) {
  const path = `people/${person.id}.json`;
  const own = await remoteMine(person);
  edit(own);
  await new MockRemote(cfg, 'other').commit({ parent: MockRemote.state().head, files: { [path]: await encryptJSON(own, person.key, path) }, message: 'from other device' });
}

async function fresh() {
  MockRemote.reset();
  MockRemote.offline = false;
  MockRemote.badTokens.clear();
  store.signOut({ keepSongs: false });
  await store.init();
  store.replaceLocal(emptyLibrary());
}

async function freshOwner(songList = []) {
  await fresh();
  for (const s of songList) store.dispatch({ t: 'add', song: makeSong(s) });
  return account.setupWithKey('token-owner');
}

test('the songbook: owner setup, invites, a second device, merges, conflicts, offline', async () => {
  await fresh();

  // 1. a library that exists only on this device
  store.dispatch({ t: 'add', song: makeSong({ id: 's-a', title: 'Alpha', artist: 'One', content: '[ch]G[/ch]\nla' }) });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-b', title: 'Beta', artist: 'Two', content: 'lyrics', fav: true }) });
  eq(store.store.sync.state, 'local');
  eq(songs().length, 2);

  // 2. the owner sets up the songbook with a key: the songs go up, not the favorite
  const auth = await account.setupWithKey('token-owner');
  ok(store.signedIn());
  eq(auth.via, 'key');
  eq(store.store.sync.state, 'saved', store.store.sync.message);
  let remote = await remoteLibrary(auth.libKey);
  deepEq(Object.keys(remote.index.songs).sort(), ['s-a', 's-b']);
  eq(remote.contents['s-a'], '[ch]G[/ch]\nla');
  ok(!('fav' in remote.index.songs['s-b']), 'a favorite is yours: not in the songbook');
  eq(store.store.lib.songs['s-b'].fav, true, 'but still yours here');
  ok(remote.tree['access.json'], 'sign-in file saved');
  const raw = MockRemote.state().blobs[remote.tree['library/index.json']];
  ok(!raw.includes('Alpha') && !raw.includes('lyrics'), 'no plain song text on GitHub');

  // 3. invites
  ok(account.passwordProblem('short'));
  ok(!account.passwordProblem('banjo river tuesday'));
  await account.addInvite('Banjo River Tuesday', 'Friends');
  let failed = false;
  try { await account.addInvite('banjo river tuesday', 'Again'); } catch (e) { failed = e.kind === 'duplicate'; }
  ok(failed, 'the same password twice is refused');
  deepEq((await account.listPasswords()).map(p => [p.label, p.kind]), [['Friends', 'invite']]);

  // 4. edits to the songbook sync
  store.dispatch({ t: 'set', id: 's-a', set: { key: 'G' } });
  await store.syncNow();
  eq((await remoteLibrary(auth.libKey)).index.songs['s-a'].key, 'G');

  // 5. another device adds a song while this one edits: both survive
  await otherDeviceAdds(auth.libKey, makeSong({ id: 's-c', title: 'Gamma', artist: 'Three', content: 'from the phone' }));
  store.dispatch({ t: 'set', id: 's-b', set: { capo: 3 } });
  await store.syncNow();
  eq(store.store.lib.songs['s-c']?.content, 'from the phone');
  eq(store.store.lib.songs['s-b'].capo, 3);
  remote = await remoteLibrary(auth.libKey);
  eq(remote.index.songs['s-b'].capo, 3);
  ok(remote.index.songs['s-c']);

  // 6. a conflict in the middle of a save is retried on top of the newer copy
  const realCommit = MockRemote.prototype.commit;
  let raced = false;
  MockRemote.prototype.commit = async function (args) {
    if (!raced && /change/.test(args.message)) {
      raced = true;
      MockRemote.prototype.commit = realCommit;
      await otherDeviceAdds(auth.libKey, makeSong({ id: 's-d', title: 'Delta', artist: 'Four', content: 'raced' }));
    }
    return realCommit.call(this, args);
  };
  store.dispatch({ t: 'set', id: 's-a', set: { title: 'Alpha (live)' } });
  await store.syncNow();
  MockRemote.prototype.commit = realCommit;
  ok(raced, 'the race happened');
  remote = await remoteLibrary(auth.libKey);
  eq(remote.index.songs['s-a'].title, 'Alpha (live)');
  ok(remote.index.songs['s-d'], 'the other device\'s song is kept');
  eq(store.store.sync.state, 'saved');

  // 7. offline: changes wait, then go up
  MockRemote.offline = true;
  store.dispatch({ t: 'del', id: 's-c' });
  await store.syncNow();
  eq(store.store.sync.state, 'offline');
  eq(store.pendingCount(), 1, 'the songbook’s change (without an account, your part is only here)');
  ok(!store.store.lib.songs['s-c'], 'the screen already shows it');
  MockRemote.offline = false;
  await store.syncNow();
  eq(store.pendingCount(), 0);
  remote = await remoteLibrary(auth.libKey);
  ok(!remote.index.songs['s-c'] && !remote.contents['s-c']);

  // 8. a second device signs in with the invite (capitals and spaces don't matter)
  store.signOut({ keepSongs: false });
  eq(songs().length, 0);
  store.dispatch({ t: 'add', song: makeSong({ id: 's-phone', title: 'Phone Only', artist: 'P', content: 'p' }) });
  let wrong = '';
  try { await account.signInWithPassword('wrong password here'); } catch (e) { wrong = e.kind; }
  eq(wrong, 'badpassword');
  const a2 = await account.signInWithPassword('  banjo  RIVER tuesday ');
  eq(a2.via, 'password');
  eq(a2.libKey, auth.libKey);
  ok(!a2.person, 'an invite has no account behind it');
  deepEq(songs().map(s => s.title).sort(), ['Alpha (live)', 'Beta', 'Delta', 'Phone Only'], 'the songbook plus the phone\'s own');
  ok(!store.store.lib.songs['s-b'].fav, 'the owner\'s favorite isn\'t anyone else\'s');
  ok((await remoteLibrary(auth.libKey)).index.songs['s-phone'], 'the phone\'s song went into the songbook');

  // 9. a key that GitHub rejects
  MockRemote.badTokens.add('token-owner');
  await store.syncNow();
  ok(['error', 'saved'].includes(store.store.sync.state));
  MockRemote.badTokens.clear();
  store.signOut({ keepSongs: true });
  eq(store.store.sync.state, 'local');
  ok(songs().length >= 4, 'signing out keeps the songs on the device');
});

test('accounts: your favorites and setlists, on all your devices, and nobody else’s to read', async () => {
  const owner = await freshOwner([{ id: 's-1', title: 'One', content: 'one' }, { id: 's-2', title: 'Two', content: 'two', fav: true }]);
  await account.addInvite('campfire songs together', 'Friends');
  store.dispatch({ t: 'list', id: 'l-1', set: { name: 'Gig', songs: ['s-2'] } });

  // the owner makes their account: what's here is its first copy
  const me = await account.makeAccount('the owners own words', 'Owner');
  ok(me.person?.id && me.person.key, 'an account has a key of its own');
  ok(store.hasAccount());
  let mine = await remoteMine(me.person);
  eq(mine.songs['s-2'].fav, true, 'the favorite is in the account');
  eq(mine.setlists['l-1'].name, 'Gig', 'so is the setlist');
  ok(!('fav' in (await remoteLibrary(owner.libKey)).index.songs['s-2']), 'and not in the songbook');
  store.dispatch({ t: 'set', id: 's-1', set: { fav: true, notes: 'slow down' } });
  store.dispatch({ t: 'view', id: 's-1', set: { tr: 2 } });
  await store.syncNow();
  mine = await remoteMine(me.person);
  deepEq([mine.songs['s-1'].fav, mine.songs['s-1'].notes, mine.songs['s-1'].view.tr], [true, 'slow down', 2]);
  let failed = '';
  try { await account.makeAccount('campfire songs together', 'Sneaky'); } catch (e) { failed = e.kind; }
  eq(failed, 'input', 'one account per device');

  // the owner's other device: their password brings back their part too
  store.signOut({ keepSongs: false });
  const again = await account.signInWithPassword('The Owners Own Words');
  eq(again.person.id, me.person.id);
  eq(store.store.lib.songs['s-1'].fav, true, 'favorites come with the account');
  eq(store.store.lib.songs['s-1'].view.tr, 2, 'and the transpose');
  eq(store.store.lib.setlists['l-1']?.name, 'Gig');

  // a friend, with the invite
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('campfire songs together');
  ok(!store.hasAccount());
  ok(!store.store.lib.songs['s-1'].fav && !store.store.lib.songs['s-1'].notes, 'the owner’s favorites and notes aren’t the friend’s');
  deepEq(Object.keys(store.store.lib.setlists), [], 'nor their setlists');
  store.dispatch({ t: 'set', id: 's-2', set: { fav: true } });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-3', title: 'Three', content: 'from the friend' }) });
  await store.syncNow();
  ok((await remoteLibrary(owner.libKey)).index.songs['s-3'], 'the friend’s song is in the songbook for everyone');
  mine = await remoteMine(me.person);
  eq(mine.songs['s-2']?.fav, true, 'the owner’s own favorite is untouched');
  failed = '';
  try { await account.makeAccount('campfire songs together', 'Sam'); } catch (e) { failed = e.kind; }
  eq(failed, 'duplicate', 'an invite password can’t become someone’s account');
  const sam = await account.makeAccount('sams very own password', 'Sam');
  const samsPart = await remoteMine(sam.person);
  eq(samsPart.songs['s-2'].fav, true, 'what the friend did before having an account comes along');
  let unreadable = false;
  try { await decryptJSON(MockRemote.state().blobs[tree()[`people/${sam.person.id}.json`]], me.person.key, `people/${sam.person.id}.json`); } catch { unreadable = true; }
  ok(unreadable, 'the owner can’t read the friend’s part, nor anyone theirs');
  deepEq((await account.listPasswords()).map(p => [p.label, p.kind]).sort(), [['Friends', 'invite'], ['Owner', 'person'], ['Sam', 'person']]);

  // back on the owner's device: the friend's song, not the friend's favorites
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('the owners own words');
  ok(store.store.lib.songs['s-3'], 'the owner sees the friend’s song');
  eq(store.store.lib.songs['s-2'].fav, true);
  ok(!store.store.lib.songs['s-3'].fav);
});

test('a key pair per password: only its private key opens what’s sealed to it', async () => {
  const a = await newKeyPair();
  const b = await newKeyPair();
  ok(!('d' in a.pub), 'the public half has no private part');
  const box = await sealToKey({ token: 'secret' }, a.pub);
  eq((await openWithKey(box, a.priv))?.token, 'secret');
  eq(await openWithKey(box, b.priv), null, 'another key doesn’t open it');
  ok(!JSON.stringify(box).includes('secret'));
});

test('a new GitHub key reaches every password without typing any, and devices pick it up; a removed one doesn’t', async () => {
  await freshOwner([{ id: 's-1', title: 'One', content: '1' }]);
  await account.addInvite('campfire songs together', 'Friends');
  await account.addInvite('a second invite here', 'Later removed');
  const ownerAuth = store.getAuth();
  ok(access().entries.every(e => e.pub && e.tok && !JSON.stringify(e).includes('token-owner')), 'the GitHub key is only ever sealed');

  // two friends' devices (this page plays each in turn)
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('campfire songs together');
  const friend = store.getAuth();
  ok(friend.entry && friend.priv, 'a device knows which password it came in with');
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('a second invite here');
  const later = store.getAuth();

  // the owner removes the second invite; GitHub stops taking the key; the owner pastes a new one
  await otherDevice(ownerAuth);
  await account.removePassword(later.entry);
  MockRemote.badTokens.add('token-owner');
  await account.replaceKey('token-new');
  await store.syncNow();
  eq(access().entries.length, 1);

  // the first friend's device: its next sync just works
  await otherDevice(friend);
  store.dispatch({ t: 'set', id: 's-1', set: { key: 'E' } });
  await store.syncNow();
  eq(store.getAuth().token, 'token-new', 'it picked up the new key');
  eq(store.store.sync.state, 'saved', store.store.sync.message);
  eq((await remoteLibrary(ownerAuth.libKey)).index.songs['s-1'].key, 'E');

  // the removed invite's device doesn't get it
  await otherDevice(later);
  await store.syncNow();
  deepEq([store.store.sync.state, store.store.sync.kind, store.getAuth().token], ['error', 'auth', 'token-owner'], 'it stays shut out');
  MockRemote.badTokens.clear();
});

test('a password from before key pairs still signs in, and is sealed again the new way', async () => {
  const owner = await freshOwner([{ id: 's-1', title: 'One', content: '1' }]);
  // as the older TabIt wrote them
  const a = access();
  a.entries = [
    { id: 'pw-one', label: 'Me', added: '2026-09-01', device: 'iPhone', ...(await sealWithPassword({ v: 1, token: 'token-owner', libKey: owner.libKey }, 'banjo river tuesday')) },
    { id: 'pw-two', label: 'Laptop', added: '2026-09-02', device: 'Windows', ...(await sealWithPassword({ v: 1, token: 'token-owner', libKey: owner.libKey }, 'another old one')) },
  ];
  delete a.salt;
  await writeAccess(a);
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('Banjo River Tuesday');
  ok(store.store.lib.songs['s-1'], 'signed in');
  await until(() => access().entries.find(e => e.id === 'pw-one').pub && store.getAuth().priv, 'the entry sealed again');
  const one = access().entries.find(e => e.id === 'pw-one');
  deepEq([one.label, one.kind, one.added], ['Me', 'invite', '2026-09-01'], 'as it was, otherwise');
  deepEq((await account.listPasswords()).map(p => [p.label, p.old]), [['Me', false], ['Laptop', true]]);

  // a new key: the old-style one has to be typed again, and is checked
  MockRemote.badTokens.add('token-owner');
  let failed = '';
  try { await account.replaceKey('token-new', [{ id: 'pw-two', password: 'not the one at all' }]); } catch (e) { failed = e.kind; }
  eq(failed, 'badpassword');
  await account.replaceKey('token-new', [{ id: 'pw-two', password: 'another old one' }]);
  await store.syncNow();
  ok(access().entries.every(e => e.pub), 'both are the new kind now');
  MockRemote.badTokens.clear();
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('another old one');
  eq(store.getAuth().token, 'token-new');
});

test('an account made on one device, used on another that’s in with an invite: its part is added', async () => {
  await freshOwner([{ id: 's-1', title: 'One', content: '1' }, { id: 's-2', title: 'Two', content: '2' }]);
  await account.addInvite('campfire songs together', 'Friends');
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('campfire songs together');
  store.dispatch({ t: 'set', id: 's-1', set: { fav: true } });
  const me = await account.makeAccount('sams very own password', 'Sam');
  // Sam's tablet, in with the invite, with a favorite of its own
  store.signOut({ keepSongs: false });
  await account.signInWithPassword('campfire songs together');
  store.dispatch({ t: 'set', id: 's-2', set: { fav: true, notes: 'tablet' } });
  let failed = '';
  try { await account.useAccount('campfire songs together'); } catch (e) { failed = e.message; }
  ok(/invite/.test(failed), 'an invite isn’t an account');
  const used = await account.useAccount('Sams Very Own Password');
  eq(used.person.id, me.person.id);
  ok(store.hasAccount());
  deepEq([store.store.lib.songs['s-1'].fav, store.store.lib.songs['s-2'].fav, store.store.lib.songs['s-2'].notes], [true, true, 'tablet'], 'both devices’ favorites');
  const own = await remoteMine(me.person);
  deepEq([own.songs['s-1'].fav, own.songs['s-2'].notes], [true, 'tablet'], 'and the account has them');
  deepEq((await account.listPasswords()).filter(p => p.kind === 'person').map(p => p.id), [store.getAuth().entry], 'the device knows which account is its');

  // Sam signs out here, comes back in with the invite, unfavorites a song, then uses the account again
  store.signOut({ keepSongs: true });
  await account.signInWithPassword('campfire songs together');
  store.dispatch({ t: 'set', id: 's-1', set: { fav: null } });
  await account.useAccount('sams very own password');
  ok(!store.store.lib.songs['s-1'].fav && !(await remoteMine(me.person)).songs['s-1']?.fav, 'what changed here since signing out goes on top, unfavorites too');

  // Kim's account signed out on this device; Sam uses theirs here: Kim's part isn't added to it
  store.signOut({ keepSongs: true });
  await account.signInWithPassword('campfire songs together');
  await account.makeAccount('kims own password here', 'Kim');
  store.dispatch({ t: 'set', id: 's-1', set: { notes: 'Kim’s note' } });
  await store.syncNow();
  store.signOut({ keepSongs: true });
  await account.signInWithPassword('campfire songs together');
  await account.useAccount('sams very own password');
  ok(!store.store.lib.songs['s-1'].notes && !(await remoteMine(me.person)).songs['s-1']?.notes, 'someone else’s part left on the device stays out of yours');
});

test('signing out while a sync is running: that sync stops, nothing here is lost', async () => {
  await freshOwner([{ id: 's-x', title: 'X', content: 'x' }]);
  store.dispatch({ t: 'set', id: 's-x', set: { key: 'A', notes: 'before' } });
  const running = store.syncNow();
  await wait(30); // waiting on "GitHub"
  store.signOut({ keepSongs: true });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-after', title: 'After', content: 'a' }) });
  await running;
  ok(store.store.lib.songs['s-after'], 'the song added after signing out is still here');
  deepEq([store.store.lib.songs['s-x'].key, store.store.lib.songs['s-x'].notes], ['A', 'before']);
  eq(store.store.sync.state, 'local');
  eq(store._docs.book.rev, null, 'no commit remembered while signed out');
});

test('a save whose file list then fails to load isn’t made again later', async () => {
  const auth = await freshOwner([{ id: 's-a', title: 'Alpha', content: 'a' }]);
  const realCommit = MockRemote.prototype.commit;
  const realFiles = MockRemote.prototype.files;
  let failNext = false;
  MockRemote.prototype.commit = async function (args) { const c = await realCommit.call(this, args); failNext = true; return c; };
  MockRemote.prototype.files = async function (c) {
    if (failNext) { failNext = false; throw new RemoteError('No connection', 0, 'offline'); }
    return realFiles.call(this, c);
  };
  try {
    store.dispatch({ t: 'set', id: 's-a', set: { title: 'Alpha (laptop)' } });
    await store.syncNow();
  } finally {
    MockRemote.prototype.commit = realCommit;
    MockRemote.prototype.files = realFiles;
  }
  eq(store.pendingCount(), 0, 'the change counts as saved');
  await otherDeviceEdits(auth.libKey, index => { index.songs['s-a'].title = 'Alpha (phone)'; });
  await store.syncNow();
  eq(store.store.lib.songs['s-a'].title, 'Alpha (phone)', 'the phone’s later rename isn’t overwritten');
  eq(store.store.lib.songs['s-a'].content, 'a', 'and the song text was read again');
});

test('signing back in keeps what changed here, and what was deleted elsewhere', async () => {
  const owner = await freshOwner(['s-1', 's-2', 's-3', 's-4'].map(id => ({ id, title: id, content: `text ${id}` })));
  store.dispatch({ t: 'list', id: 'l-gig', set: { name: 'Gig', songs: ['s-1', 's-4'] } });
  const me = await account.makeAccount('banjo river tuesday', 'Me');
  await store.syncNow();
  // GitHub stops accepting the key: these wait
  MockRemote.badTokens.add('token-owner');
  store.dispatch({ t: 'set', id: 's-1', set: { title: 'One, renamed', notes: 'from this device' } });
  store.dispatch({ t: 'del', id: 's-2' });
  await store.syncNow();
  eq(store.store.sync.kind, 'auth');
  store.signOut({ keepSongs: true });
  // signed out
  store.dispatch({ t: 'set', id: 's-3', set: { fav: true } });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-5', title: 'New here', content: 'n' }) });
  // meanwhile another device deletes a song, and (one of yours) the setlist
  await otherDeviceEdits(owner.libKey, index => { delete index.songs['s-4']; });
  await otherDeviceEditsMine(me.person, own => { delete own.setlists['l-gig']; });
  MockRemote.badTokens.clear();
  await account.signInWithPassword('banjo river tuesday');
  const lib = store.store.lib;
  deepEq([lib.songs['s-1']?.title, lib.songs['s-1']?.notes], ['One, renamed', 'from this device'], 'edits that hadn’t synced at sign-out');
  ok(!lib.songs['s-2'], 'a delete that hadn’t synced at sign-out');
  eq(lib.songs['s-3']?.fav, true, 'an edit made while signed out');
  ok(lib.songs['s-5'], 'a song added while signed out');
  ok(!lib.songs['s-4'], 'the song deleted on the other device stays deleted');
  ok(!lib.setlists['l-gig'], 'and so does the setlist');
  const remote = await remoteLibrary(owner.libKey);
  eq(remote.index.songs['s-1'].title, 'One, renamed');
  ok(!remote.index.songs['s-2'] && !remote.index.songs['s-4'] && remote.index.songs['s-5']);
  eq(remote.contents['s-5'], 'n', 'the new song’s text went up too');
  const own = await remoteMine(me.person);
  deepEq([own.songs['s-1'].notes, own.songs['s-3'].fav], ['from this device', true]);
});

test('signing out, and the app closes before that’s saved: nothing is lost, and it goes up on signing back in', async () => {
  const owner = await freshOwner([{ id: 's-1', title: 'One', content: '1' }]);
  const me = await account.makeAccount('banjo river tuesday', 'Me');
  await store.syncNow();
  MockRemote.offline = true;
  store.dispatch({ t: 'set', id: 's-1', set: { key: 'G', fav: true } });
  await store.syncNow();
  db.faults.writes = true; // (the page goes away: nothing more reaches the database)
  try {
    store.signOut({ keepSongs: true });
    await store._flush();
  } finally {
    db.faults.writes = false;
  }
  await store.init(); // opened again
  deepEq([store.store.lib.songs['s-1'].key, store.store.lib.songs['s-1'].fav], ['G', true], 'the edits are here');
  MockRemote.offline = false;
  await otherDeviceEdits(owner.libKey, index => { index.songs['s-1'].title = 'One (phone)'; });
  await account.signInWithPassword('banjo river tuesday');
  const s = store.store.lib.songs['s-1'];
  deepEq([s.title, s.key, s.fav], ['One (phone)', 'G', true], 'signed back in: the other device’s change and this one’s');
  eq((await remoteLibrary(owner.libKey)).index.songs['s-1'].key, 'G');
  eq((await remoteMine(me.person)).songs['s-1'].fav, true);
});

test('joining from a device that was never signed in adds its songs', async () => {
  const owner = await freshOwner([{ id: 's-own', title: 'Owner', content: 'o' }]);
  await account.addInvite('banjo river tuesday', 'Friends');
  store.signOut({ keepSongs: false });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-phone', title: 'Phone', content: 'p' }) });
  await account.signInWithPassword('banjo river tuesday');
  ok(store.store.lib.songs['s-own'] && store.store.lib.songs['s-phone']);
  ok((await remoteLibrary(owner.libKey)).index.songs['s-phone']);
});

test('a song this device has that the songbook has too isn’t added twice; your part moves to it', async () => {
  const url = 'https://tabs.ultimate-guitar.com/tab/x/song-chords-1';
  await freshOwner([{ id: 's-book', title: 'Song', content: 'x', src: { site: 'ug', url } }]);
  await account.addInvite('banjo river tuesday', 'Friends');
  store.signOut({ keepSongs: false });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-mine', title: 'Song', content: 'x', src: { site: 'ug', url }, fav: true, notes: 'n' }) });
  store.dispatch({ t: 'list', id: 'l', set: { name: 'L', songs: ['s-mine'] } });
  await account.signInWithPassword('banjo river tuesday');
  deepEq(Object.keys(store.store.lib.songs), ['s-book'], 'one copy');
  deepEq([store.store.lib.songs['s-book'].fav, store.store.lib.songs['s-book'].notes], [true, 'n'], 'with this device’s favorite and notes');
  deepEq(store.store.lib.setlists.l.songs, ['s-book'], 'and its place in the setlist');
});

async function clearDevice() {
  await store._flush();
  for (const k of ['state', 'pending', 'journal', 'claim']) {
    await db.del(`book.${k}`);
    await db.del(`mine.${k}`);
    localStorage.removeItem(`tabit.book.${k}`);
    localStorage.removeItem(`tabit.mine.${k}`);
  }
}

test('from before the songbook was shared: songs become the songbook’s, favorites and setlists yours', async () => {
  await fresh();
  await clearDevice();
  const old = emptyLibrary();
  old.songs['s-o'] = makeSong({ id: 's-o', title: 'Old', content: 'o', key: 'G', fav: true, notes: 'n', view: { tr: 1 } });
  old.setlists['l-o'] = { id: 'l-o', name: 'Old gig', songs: ['s-o'] };
  await db.set('lib.state', { base: old, rev: null });
  localStorage.setItem('tabit.pending', JSON.stringify([{ t: 'set', id: 's-o', set: { capo: 2, plays: 3 } }]));
  await store.init();
  const s = store.store.lib.songs['s-o'];
  deepEq([s.title, s.key, s.capo, s.fav, s.notes, s.view?.tr, s.plays], ['Old', 'G', 2, true, 'n', 1, 3], 'everything is still there');
  eq(store.store.lib.setlists['l-o']?.name, 'Old gig');
  ok(!('fav' in store._docs.book.lib.songs['s-o']) && store._docs.mine.lib.songs['s-o'].fav, 'the favorite moved to your part');
  eq(await db.get('lib.state'), undefined, 'the old record is gone');
  eq(localStorage.getItem('tabit.pending'), null);
  eq(await db.get('book.claim'), undefined, 'not signed in then: no claim on any songbook');
});

test('the songbook on GitHub from then: its owner’s part stays, unseen, until one of the owner’s devices takes it', async () => {
  const owner = await freshOwner([{ id: 's-1', title: 'One', content: '1' }, { id: 's-2', title: 'Two', content: '2' }]);
  const then = index => {
    Object.assign(index.songs['s-1'], { fav: true, notes: 'from then', view: { tr: 3 } });
    index.songs['s-2'].fav = true;
    index.setlists = { x: { id: 'x', name: 'Then', songs: ['s-1'] } };
  };
  await otherDeviceEdits(owner.libKey, then);

  // a device that wasn't one of them (a friend's, or the owner's set up anew): left as it is
  store.dispatch({ t: 'set', id: 's-1', set: { key: 'D' } });
  await store.syncNow();
  let index = (await remoteLibrary(owner.libKey)).index;
  eq(index.songs['s-1'].key, 'D', 'the edit is saved');
  ok(index.songs['s-1'].fav && index.songs['s-1'].notes && index.setlists?.x, 'and the old part is still there');
  ok(!store.store.lib.songs['s-1'].fav && !store.store.lib.songs['s-1'].notes && !store.store.lib.setlists.x, 'not shown as this device’s');

  // one of the owner's devices updates: it was signed in, with its library from then
  await clearDevice();
  const old = emptyLibrary();
  old.songs['s-1'] = makeSong({ id: 's-1', title: 'One', content: '1', notes: 'kept here' });
  old.songs['s-2'] = makeSong({ id: 's-2', title: 'Two', content: '2' });
  await db.set('lib.state', { base: old, rev: null });
  localStorage.setItem('tabit.pending', JSON.stringify([{ t: 'add', song: makeSong({ id: 's-3', title: 'Three', content: '3', fav: true }) }]));
  await store.init();
  ok(await db.get('book.claim'), 'it claims what’s left of its part on GitHub');
  await store.syncNow();
  const lib = store.store.lib;
  deepEq([lib.songs['s-1'].fav, lib.songs['s-1'].notes, lib.songs['s-1'].view?.tr, lib.songs['s-2'].fav, lib.setlists.x?.name],
    [true, 'kept here', 3, true, 'Then'], 'the part from GitHub, added to its own (its own notes stay)');
  eq(lib.songs['s-1'].key, 'D', 'with the songbook as it is now');
  index = (await remoteLibrary(owner.libKey)).index;
  ok(!['s-1', 's-2'].some(id => ['fav', 'notes', 'view'].some(k => k in index.songs[id])) && !index.setlists, 'and the songbook is written again without it');
  eq(await db.get('book.claim'), undefined, 'once');
  ok(lib.songs['s-3']?.fav, 'its song that hadn’t synced then went into the songbook, the favorite stayed its own');
  ok(index.songs['s-3'] && !('fav' in index.songs['s-3']));
});

test('when saving to this device fails, the edit stays in the journal until it works', async () => {
  MockRemote.reset();
  store.signOut({ keepSongs: false });
  await store.init();
  store.replaceLocal(emptyLibrary());
  await store._flush();
  db.faults.writes = true;
  try {
    store.dispatch({ t: 'add', song: makeSong({ id: 's-j', title: 'J', content: 'j' }) });
    await store._flush();
    const journal = JSON.parse(localStorage.getItem('tabit.book.journal'));
    ok(journal.some(op => op.song?.id === 's-j'), 'still in the journal');
  } finally {
    db.faults.writes = false;
  }
  await store._flush();
  deepEq(JSON.parse(localStorage.getItem('tabit.book.journal')), [], 'trimmed once the library is saved');
  const saved = await db.get('book.state');
  ok(saved.base.songs['s-j'], 'and the library has it');
});

test('opening a backup fills in what a song here is missing, never what you set', async () => {
  store.signOut({ keepSongs: false });
  await store.init();
  store.replaceLocal(emptyLibrary());
  const { addSongs } = await import('../../js/importer.js');
  const url = 'https://tabs.ultimate-guitar.com/tab/band/song-chords-1';
  store.dispatch({ t: 'add', song: makeSong({ id: 's-here', title: 'Song', content: 'x', src: { site: 'ug', url }, notes: 'mine', fav: true, key: 'G' }) });
  const fromFile = makeSong({ id: 's-file', title: 'Song', content: 'x', src: { site: 'ug', url }, capo: 2, key: 'A', shapes: { G: [[3, 2, 0, 0, 0, 3]] }, strum: [{ part: '', den: 8, m: [1, 101] }], cover: 'https://x/c.jpg', notes: 'theirs' });
  const other = makeSong({ id: 's-new', title: 'New', content: 'n', src: { site: 'ug', url: url + '9' } });
  const r = addSongs([fromFile, other]);
  deepEq([r.added, r.skipped, r.filled], [1, 1, 1]);
  const s = store.store.lib.songs['s-here'];
  eq(s.capo, 2);
  ok(s.shapes?.G && s.strum?.length && s.cover, 'chord shapes, strumming and cover filled in');
  deepEq([s.notes, s.fav, s.key], ['mine', true, 'G'], 'your notes, favorite and key stay');
  ok(store.store.lib.songs['s-new'], 'the song that was missing is added');

  // a song that came in through the first worker, in another version
  store.dispatch({ t: 'add', song: makeSong({ id: 's-thin', title: 'Other Song', artist: 'Band', content: 'version 1', src: { site: 'ug', url: url + '1' }, fav: true, notes: 'n' }) });
  const exact = makeSong({ id: 's-exact', title: 'Other Song', artist: 'Band', content: 'version 2', src: { site: 'ug', url: url + '2', version: 2 }, capo: 3, shapes: { C: [[-1, 3, 2, 0, 1, 0]] } });
  deepEq(addSongs([exact]).added, 1, 'an ordinary backup adds it as another version');
  store.dispatch({ t: 'del', id: 's-exact' });
  const up = addSongs([exact], [], { upgrade: true });
  deepEq([up.added, up.filled], [0, 1], 'the favorites file puts its exact version in its place');
  const t = store.store.lib.songs['s-thin'];
  deepEq([t.content, t.src.version, t.capo, t.fav, t.notes], ['version 2', 2, 3, true, 'n']);
  eq(Object.values(store.store.lib.songs).filter(x => x.title === 'Other Song').length, 1, 'no duplicate');

  // two versions of one song, both favorites, both in through the first worker:
  // one at the right address, the other at a third version's
  store.dispatch({ t: 'add', song: makeSong({ id: 's-b1', title: 'Bars', artist: 'E', content: 'some other version', src: { site: 'ug', url: url + 'Bx' } }) });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-b2', title: 'Bars', artist: 'E', content: 'v5', src: { site: 'ug', url: url + 'B5' } }) });
  const v2 = makeSong({ id: 'f-2', title: 'Bars', artist: 'E', content: 'v2', src: { site: 'ug', url: url + 'B2' }, shapes: { A: [[0, 0, 2, 2, 2, 0]] } });
  const v5 = makeSong({ id: 'f-5', title: 'Bars', artist: 'E', content: 'v5', src: { site: 'ug', url: url + 'B5' }, shapes: { D: [[-1, -1, 0, 2, 3, 2]] } });
  addSongs([v2, v5], [], { upgrade: true });
  const bars = Object.values(store.store.lib.songs).filter(x => x.title === 'Bars').map(x => [x.src.url.slice(-2), x.content, Object.keys(x.shapes || {})[0]]).sort();
  deepEq(bars, [['B2', 'v2', 'A'], ['B5', 'v5', 'D']], 'each version ends up with its own text and shapes');
});

test('another tab’s edits arrive here, and this tab’s go to it', async () => {
  store.signOut({ keepSongs: false });
  await store.init();
  store.replaceLocal(emptyLibrary());
  const other = new BroadcastChannel('tabit-store');
  const heard = [];
  other.onmessage = e => heard.push(e.data);
  try {
    store.dispatch({ t: 'add', song: makeSong({ id: 's-here', title: 'Here', content: 'h' }) });
    other.postMessage({ t: 'op', op: { t: 'add', song: makeSong({ id: 's-there', title: 'There', content: 't', fav: true }) } });
    await wait(150);
    ok(store.store.lib.songs['s-there']?.fav, 'the other tab’s song is here, favorite and all');
    ok(heard.some(m => m.t === 'op' && m.op.song?.id === 's-here'), 'this tab’s song was passed on');
    ok(!heard.some(m => m.t === 'op' && m.op.song?.id === 's-there'), 'and not sent back');
  } finally {
    other.close();
  }
});

test('serialize: songs spread over shards, the index has no song text', () => {
  const lib = emptyLibrary();
  for (let i = 0; i < 40; i++) lib.songs[`s-${i}`] = makeSong({ id: `s-${i}`, title: `T${i}`, content: `text ${i}` });
  const files = store.serialize(lib);
  const index = JSON.parse(files['library/index.json']);
  eq(Object.keys(index.songs).length, 40);
  ok(!JSON.stringify(index).includes('text 1'));
  const shards = Object.keys(files).filter(p => p.startsWith('library/songs-'));
  eq(shards.length, 16);
  ok(shards.filter(p => files[p] !== '{}').length >= 10);
});

test('a wrong library key is detected, not silently accepted', async () => {
  const text = await encryptJSON({ a: 1 }, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'p');
  let threw = false;
  try { await decryptJSON(text, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', 'p'); } catch { threw = true; }
  ok(threw);
  let threw2 = false;
  try { await decryptJSON(text, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'other/path'); } catch { threw2 = true; }
  ok(threw2, 'a file moved to another path won\'t open');
});
