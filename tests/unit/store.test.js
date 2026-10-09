// The whole sign-in and sync flow against a fake GitHub (MockRemote): owner
// setup, passwords, a second device, edits from two places, conflicts, offline.
import { test, eq, ok, deepEq } from '../harness.js';
import { MockRemote } from '../../js/remote.js';
import * as store from '../../js/store.js';
import * as account from '../../js/account.js';
import { decryptJSON, encryptJSON } from '../../js/crypto.js';
import { makeSong, emptyLibrary } from '../../js/model.js';

const cfg = { owner: 'me', repo: 'TabIt', branch: 'tabit-data' };
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
