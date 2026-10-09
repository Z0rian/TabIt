// The whole sign-in and sync flow against a fake GitHub (MockRemote): owner
// setup, passwords, a second device, edits from two places, conflicts, offline.
import { test, eq, ok, deepEq } from '../harness.js';
import { MockRemote, RemoteError } from '../../js/remote.js';
import * as db from '../../js/db.js';
import * as store from '../../js/store.js';
import * as account from '../../js/account.js';
import { decryptJSON, encryptJSON } from '../../js/crypto.js';
import { makeSong, emptyLibrary } from '../../js/model.js';

const cfg = { owner: 'me', repo: 'tabit-data', branch: 'main' };
store._useRemote(token => new MockRemote(cfg, token));

const wait = ms => new Promise(r => setTimeout(r, ms));
const songs = () => Object.values(store.store.lib.songs);

// Reads the library straight from the fake GitHub, like another device would.
async function remoteLibrary(libKey) {
  const r = new MockRemote(cfg, 'x');
  const st = MockRemote.state();
  const tree = st.commits[st.head].tree;
  const index = await decryptJSON(st.blobs[tree['library/index.json']], libKey, 'library/index.json');
  const all = {};
  for (const [path, sha] of Object.entries(tree)) {
    if (!path.startsWith('library/songs-')) continue;
    Object.assign(all, await decryptJSON(st.blobs[sha], libKey, path));
  }
  void r;
  return { index, contents: all, tree };
}

// Another device saves a change directly.
async function otherDeviceAdds(libKey, song) {
  const st = MockRemote.state();
  const tree = st.commits[st.head].tree;
  const index = await decryptJSON(st.blobs[tree['library/index.json']], libKey, 'library/index.json');
  const { content, ...meta } = song;
  index.songs[song.id] = meta;
  const shardFiles = {};
  // find which shard: re-serialize through the store's own function
  const lib = emptyLibrary();
  lib.songs[song.id] = song;
  const ser = store.serialize(lib);
  const shard = Object.keys(ser).find(p => p.startsWith('library/songs-') && ser[p] !== '{}');
  const cur = tree[shard] ? await decryptJSON(st.blobs[tree[shard]], libKey, shard) : {};
  cur[song.id] = content;
  shardFiles[shard] = await encryptJSON(cur, libKey, shard);
  shardFiles['library/index.json'] = await encryptJSON(index, libKey, 'library/index.json');
  await new MockRemote(cfg, 'other').commit({ parent: st.head, files: shardFiles, message: 'from other device' });
}

test('sync: owner setup, passwords, second device, merges, conflicts, offline', async () => {
  MockRemote.reset();
  store.signOut({ keepSongs: false });
  await store.init();
  store.replaceLocal(emptyLibrary());

  // 1. a library that exists only on this device
  store.dispatch({ t: 'add', song: makeSong({ id: 's-a', title: 'Alpha', artist: 'One', content: '[ch]G[/ch]\nla' }) });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-b', title: 'Beta', artist: 'Two', content: 'lyrics', fav: true }) });
  eq(store.store.sync.state, 'local');
  eq(songs().length, 2);

  // 2. owner sets up sync with a key: the local songs go up
  const auth = await account.setupWithKey('token-owner');
  ok(store.signedIn());
  eq(auth.via, 'key');
  eq(store.store.sync.state, 'saved', store.store.sync.message);
  let remote = await remoteLibrary(auth.libKey);
  deepEq(Object.keys(remote.index.songs).sort(), ['s-a', 's-b']);
  eq(remote.contents['s-a'], '[ch]G[/ch]\nla');
  ok(remote.tree['access.json'], 'sign-in file saved');

  // the files on "GitHub" are encrypted
  const st = MockRemote.state();
  const raw = st.blobs[remote.tree['library/index.json']];
  ok(!raw.includes('Alpha') && !raw.includes('lyrics'), 'no plain song text on GitHub');

  // 3. passwords
  ok(account.passwordProblem('short'));
  ok(!account.passwordProblem('banjo river tuesday'));
  await account.addPassword('Banjo River Tuesday', 'Main');
  let failed = false;
  try { await account.addPassword('banjo river tuesday', 'Again'); } catch (e) { failed = e.kind === 'duplicate'; }
  ok(failed, 'the same password twice is refused');
  eq((await account.listPasswords()).length, 1);

  // 4. edits sync
  store.dispatch({ t: 'set', id: 's-a', set: { fav: true } });
  await store.syncNow();
  remote = await remoteLibrary(auth.libKey);
  eq(remote.index.songs['s-a'].fav, true);

  // 5. another device adds a song while this one edits: both survive
  await otherDeviceAdds(auth.libKey, makeSong({ id: 's-c', title: 'Gamma', artist: 'Three', content: 'from the phone' }));
  store.dispatch({ t: 'set', id: 's-b', set: { notes: 'from the laptop' } });
  await store.syncNow();
  eq(store.store.lib.songs['s-c']?.content, 'from the phone');
  eq(store.store.lib.songs['s-b'].notes, 'from the laptop');
  remote = await remoteLibrary(auth.libKey);
  eq(remote.index.songs['s-b'].notes, 'from the laptop');
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
  eq(store.pendingCount(), 1);
  ok(!store.store.lib.songs['s-c'], 'the screen already shows it');
  MockRemote.offline = false;
  await store.syncNow();
  eq(store.pendingCount(), 0);
  remote = await remoteLibrary(auth.libKey);
  ok(!remote.index.songs['s-c'] && !remote.contents['s-c']);

  // 8. a second device signs in with the password (capitals and spaces don't matter)
  store.signOut({ keepSongs: false });
  eq(songs().length, 0);
  store.dispatch({ t: 'add', song: makeSong({ id: 's-phone', title: 'Phone Only', artist: 'P', content: 'p' }) });
  let wrong = '';
  try { await account.signInWithPassword('wrong password here'); } catch (e) { wrong = e.kind; }
  eq(wrong, 'badpassword');
  const a2 = await account.signInWithPassword('  banjo  RIVER tuesday ');
  eq(a2.via, 'password');
  eq(a2.libKey, auth.libKey);
  const titles = songs().map(s => s.title).sort();
  deepEq(titles, ['Alpha (live)', 'Beta', 'Delta', 'Phone Only'], 'remote songs plus the phone\'s own');
  remote = await remoteLibrary(auth.libKey);
  ok(remote.index.songs['s-phone'], 'the phone\'s song went up');

  // 9. a key that GitHub rejects
  MockRemote.badTokens.add('token-owner');
  await store.syncNow();
  eq(store.store.sync.state === 'error' || store.store.sync.state === 'saved', true);
  MockRemote.badTokens.clear();
  store.signOut({ keepSongs: true });
  eq(store.store.sync.state, 'local');
  ok(songs().length >= 4, 'signing out keeps the songs on the device');
});

test('serialize: songs spread over shards, index has no song text', () => {
  const lib = emptyLibrary();
  for (let i = 0; i < 40; i++) lib.songs[`s-${i}`] = makeSong({ id: `s-${i}`, title: `T${i}`, content: `text ${i}` });
  const files = store.serialize(lib);
  const index = JSON.parse(files['library/index.json']);
  eq(Object.keys(index.songs).length, 40);
  ok(!JSON.stringify(index).includes('text 1'));
  const shards = Object.keys(files).filter(p => p.startsWith('library/songs-'));
  eq(shards.length, 16);
  const used = shards.filter(p => files[p] !== '{}').length;
  ok(used >= 10, `only ${used} shards used`);
});

test('a wrong library key is detected, not silently accepted', async () => {
  const text = await encryptJSON({ a: 1 }, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'p');
  let threw = false;
  try { await decryptJSON(text, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', 'p'); } catch { threw = true; }
  ok(threw);
  let threw2 = false;
  try { await decryptJSON(text, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'other/path'); } catch { threw2 = true; }
  ok(threw2, 'a file moved to another path won\'t open');
  void wait;
});

// Another device changes the index directly (rename, delete…).
async function otherDeviceEdits(libKey, edit) {
  const st = MockRemote.state();
  const tree = st.commits[st.head].tree;
  const index = await decryptJSON(st.blobs[tree['library/index.json']], libKey, 'library/index.json');
  edit(index);
  const files = { 'library/index.json': await encryptJSON(index, libKey, 'library/index.json') };
  await new MockRemote(cfg, 'other').commit({ parent: st.head, files, message: 'from other device' });
}

async function freshOwner(songList = []) {
  MockRemote.reset();
  MockRemote.badTokens.clear();
  store.signOut({ keepSongs: false });
  await store.init();
  store.replaceLocal(emptyLibrary());
  for (const s of songList) store.dispatch({ t: 'add', song: makeSong(s) });
  return account.setupWithKey('token-owner');
}

test('signing out while a sync is running: that sync stops, nothing here is lost', async () => {
  await freshOwner([{ id: 's-x', title: 'X', content: 'x' }]);
  store.dispatch({ t: 'set', id: 's-x', set: { notes: 'before' } });
  const running = store.syncNow();
  await wait(30); // waiting on "GitHub"
  store.signOut({ keepSongs: true });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-after', title: 'After', content: 'a' }) });
  await running;
  ok(store.store.lib.songs['s-after'], 'the song added after signing out is still here');
  eq(store.store.lib.songs['s-x'].notes, 'before');
  eq(store.store.sync.state, 'local');
  eq(store._state.rev, null, 'no commit remembered while signed out');
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
  const auth = await freshOwner(['s-1', 's-2', 's-3', 's-4'].map(id => ({ id, title: id, content: `text ${id}` })));
  store.dispatch({ t: 'list', id: 'l-gig', set: { name: 'Gig', songs: ['s-1', 's-4'] } });
  await account.addPassword('banjo river tuesday', 'Me');
  await store.syncNow();
  // GitHub stops accepting the key: these wait
  MockRemote.badTokens.add('token-owner');
  store.dispatch({ t: 'set', id: 's-1', set: { notes: 'from this device' } });
  store.dispatch({ t: 'del', id: 's-2' });
  await store.syncNow();
  eq(store.store.sync.kind, 'auth');
  store.signOut({ keepSongs: true });
  // signed out
  store.dispatch({ t: 'set', id: 's-3', set: { fav: true } });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-5', title: 'New here', content: 'n' }) });
  // meanwhile another device deletes a song and the setlist
  await otherDeviceEdits(auth.libKey, index => { delete index.songs['s-4']; delete index.setlists['l-gig']; });
  MockRemote.badTokens.clear();
  await account.signInWithPassword('banjo river tuesday');
  const lib = store.store.lib;
  eq(lib.songs['s-1']?.notes, 'from this device', 'an edit that hadn’t synced at sign-out');
  ok(!lib.songs['s-2'], 'a delete that hadn’t synced at sign-out');
  eq(lib.songs['s-3']?.fav, true, 'an edit made while signed out');
  ok(lib.songs['s-5'], 'a song added while signed out');
  ok(!lib.songs['s-4'], 'the song deleted on the other device stays deleted');
  ok(!lib.setlists['l-gig'], 'and so does the setlist');
  const remote = await remoteLibrary(auth.libKey);
  eq(remote.index.songs['s-1'].notes, 'from this device');
  ok(!remote.index.songs['s-2'] && !remote.index.songs['s-4'] && remote.index.songs['s-5'] && remote.index.songs['s-3'].fav);
  eq(remote.contents['s-5'], 'n', 'the new song’s text went up too');
});

test('joining from a device that was never signed in adds its songs, as before', async () => {
  const auth = await freshOwner([{ id: 's-own', title: 'Owner', content: 'o' }]);
  await account.addPassword('banjo river tuesday', 'Me');
  store.signOut({ keepSongs: false });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-phone', title: 'Phone', content: 'p' }) });
  await account.signInWithPassword('banjo river tuesday');
  ok(store.store.lib.songs['s-own'] && store.store.lib.songs['s-phone']);
  ok((await remoteLibrary(auth.libKey)).index.songs['s-phone']);
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
    const journal = JSON.parse(localStorage.getItem('tabit.journal'));
    ok(journal.some(op => op.song?.id === 's-j'), 'still in the journal');
  } finally {
    db.faults.writes = false;
  }
  await store._flush();
  deepEq(JSON.parse(localStorage.getItem('tabit.journal')), [], 'trimmed once the library is saved');
  const saved = await db.get('lib.state');
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
  eq(Object.values(store.store.lib.songs).filter(s => s.title === 'Other Song').length, 1, 'no duplicate');

  // two versions of one song, both favorites, both in through the first worker:
  // one at the right address, the other at a third version's
  store.dispatch({ t: 'add', song: makeSong({ id: 's-b1', title: 'Bars', artist: 'E', content: 'some other version', src: { site: 'ug', url: url + 'Bx' } }) });
  store.dispatch({ t: 'add', song: makeSong({ id: 's-b2', title: 'Bars', artist: 'E', content: 'v5', src: { site: 'ug', url: url + 'B5' } }) });
  const v2 = makeSong({ id: 'f-2', title: 'Bars', artist: 'E', content: 'v2', src: { site: 'ug', url: url + 'B2' }, shapes: { A: [[0, 0, 2, 2, 2, 0]] } });
  const v5 = makeSong({ id: 'f-5', title: 'Bars', artist: 'E', content: 'v5', src: { site: 'ug', url: url + 'B5' }, shapes: { D: [[-1, -1, 0, 2, 3, 2]] } });
  addSongs([v2, v5], [], { upgrade: true });
  const bars = Object.values(store.store.lib.songs).filter(s => s.title === 'Bars').map(s => [s.src.url.slice(-2), s.content, Object.keys(s.shapes || {})[0]]).sort();
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
    other.postMessage({ t: 'op', op: { t: 'add', song: makeSong({ id: 's-there', title: 'There', content: 't' }) } });
    await wait(150);
    ok(store.store.lib.songs['s-there'], 'the other tab’s song is here');
    ok(heard.some(m => m.t === 'op' && m.op.song?.id === 's-here'), 'this tab’s song was passed on');
    ok(!heard.some(m => m.t === 'op' && m.op.song?.id === 's-there'), 'and not sent back');
  } finally {
    other.close();
  }
});
