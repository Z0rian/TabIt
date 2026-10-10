// One encrypted document kept in step with GitHub and edited with ops: the
// shared songbook, or one person's own part of it (store.js keeps one of each
// and shows them as one library).
//
// "base" is the copy as last synced and "pending" the edits made here that
// haven't been saved yet; the screen shows base + pending. Edits show at once
// and save in the background; offline they wait and retry. Without a
// connection (not signed in, or no account for your own part), edits go
// straight into the base.

import * as db from './db.js';
import { encryptJSON, decryptJSON } from './crypto.js';

// Same library, same text, so a file that didn't change isn't saved again.
export const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

export class Doc {
  // name: what its records are called on this device.
  // layout: { has(files, conn), files(lib, conn) → { path: text }, load(read, conn) → raw,
  //   skip(path, text): not worth writing on a first save, legacy(lib): in an older form }.
  // apply(lib, op), empty(), normalize(raw), connect() → { remote, key, id (whose key), … } | null,
  // message(n) → commit message, upgrade(lib) → lib in the new form, or null to
  // leave it (for a copy in an older form; upgraded() once that's saved). The
  // store sets onUpdate, onSynced, wantSync(ms) and onStorageError(e).
  constructor(o) {
    Object.assign(this, o);
    this.base = this.empty();
    this.lib = this.base;
    this.rev = null;
    this.pending = [];
    this.journal = [];
    this.journalGen = 0;
    this.baseDirty = false;
    this.persistTimer = null;
    this.session = 0; // bumps on joining and leaving: a sync from before stops
    this.syncing = false;
    this.retryDelay = 4000;
    this.lastPull = 0;
    this.status = { state: 'local', message: '', at: '' };
    this.cache = null;
    this.sinceRec = null; // { lib: whose, base } signed out: the copy it had synced
  }

  k(x) { return `${this.name}.${x}`; }
  applyAll(lib, ops) { return ops.reduce(this.apply, lib); }
  recompute() { this.lib = this.applyAll(this.base, this.pending); }

  // ---------- on this device ----------
  //
  // Pending edits are written at once (they're small); the whole document a
  // moment later, and straight away when the app is hidden or closed. Not
  // connected, the document itself is the only copy, and Safari doesn't
  // finish a write that starts as the page goes away: each edit also goes into
  // a small journal, written at once, that start-up replays (ops are safe to
  // replay). The journal is only trimmed once the document holding its edits
  // is really saved. Small queues also go to localStorage, which is written
  // synchronously; big ones (an import of hundreds of songs) only to IndexedDB.

  saveQueue(which, ops) {
    db.set(this.k(which), ops).catch(e => this.onStorageError?.(e));
    const key = `tabit.${this.name}.${which}`;
    try {
      const text = JSON.stringify(ops);
      if (text.length < 250_000) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {
      try { localStorage.removeItem(key); } catch { /* no storage */ }
    }
  }

  readQueue(which, fromDb) {
    try {
      const v = JSON.parse(localStorage.getItem(`tabit.${this.name}.${which}`));
      if (Array.isArray(v)) return v;
    } catch { /* fall back */ }
    return Array.isArray(fromDb) ? fromDb : [];
  }

  // The document, the commit it matches and whose it is are one record, so a
  // half-finished save can never pair a document with the wrong commit.
  // (Signed out, the record also keeps the copy it had synced: `since`.)
  writeBase() {
    clearTimeout(this.persistTimer);
    if (!this.baseDirty) return Promise.resolve();
    this.baseDirty = false;
    const n = this.journal.length;
    const gen = this.journalGen;
    const conn = this.connect();
    return db.set(this.k('state'), { base: this.base, rev: conn ? this.rev : null, of: conn?.id || null, since: this.sinceRec }).then(() => {
      if (!n || gen !== this.journalGen) return;
      this.journal = this.journal.slice(n);
      this.saveQueue('journal', this.journal);
    }, e => {
      // not saved (storage full?): keep the journal, try again in a while
      this.baseDirty = true;
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.writeBase(), 5000);
      this.onStorageError?.(e);
    });
  }

  clearJournal() {
    this.journal = [];
    this.journalGen++;
    this.saveQueue('journal', this.journal);
  }

  persist({ base = false } = {}) {
    this.saveQueue('pending', this.pending);
    if (base) {
      this.baseDirty = true;
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.writeBase(), 80);
    }
  }

  // (reading fails → this throws: never start from nothing when the real
  // document just couldn't be read, the next save would replace it)
  async init() {
    const [saved, pending, logged0, syncedAt] = await Promise.all(['state', 'pending', 'journal', 'syncedAt'].map(x => db.get(this.k(x))));
    const conn = this.connect();
    this.base = this.normalize(saved?.base);
    this.rev = conn ? saved?.rev || null : null;
    this.sinceRec = saved?.since || null;
    if (!conn && saved?.rev && saved.of && !this.sinceRec) {
      // signed out, but the app closed before that was saved: the copy here is
      // still the synced one (the edits since are in the journal)
      this.sinceRec = { lib: saved.of, base: saved.base };
      this.baseDirty = true;
    }
    this.pending = this.readQueue('pending', pending);
    const logged = this.readQueue('journal', logged0);
    if (logged.length && !conn) {
      // edits that may not have reached the saved document before the app closed
      this.base = this.applyAll(this.base, logged);
      this.journal = logged;
      this.baseDirty = true;
      this.writeBase();
    }
    if (!conn && this.pending.length) {
      // not connected any more, with edits left over: keep them here
      this.base = this.applyAll(this.base, this.pending);
      this.pending = [];
      this.baseDirty = true;
      this.writeBase();
      this.saveQueue('pending', this.pending);
    }
    this.recompute();
    this.status = conn ? { state: this.pending.length ? 'pending' : 'idle', message: '', at: syncedAt || '' } : { state: 'local', message: '', at: '' };
    return { saved: !!saved || this.journal.length > 0 };
  }

  // Replaces the whole document here (first run, imports). Not synced by itself.
  replace(lib) {
    this.base = this.normalize(lib);
    this.pending = [];
    this.clearJournal();
    this.recompute();
    this.persist({ base: true });
    return this.writeBase();
  }

  // ---------- editing ----------

  // Lazy ops (play counts) ride along with the next save instead of causing one.
  dispatch(op, { lazy = false } = {}) {
    if (!this.connect()) {
      this.rev = null;
      this.base = this.apply(this.base, op);
      this.journal.push(op);
      this.saveQueue('journal', this.journal);
      this.recompute();
      this.persist({ base: true });
      return;
    }
    this.coalesce(op);
    this.lib = this.apply(this.lib, op);
    this.persist();
    if (this.status.state !== 'saving') this.status = { ...this.status, state: 'pending', message: '' };
    if (!lazy) this.wantSync?.(1500);
  }

  // Repeated view changes of the same song (tapping transpose five times) keep
  // only the last value in the queue.
  coalesce(op) {
    const last = this.pending.at(-1);
    if (last && op.t === 'view' && last.t === 'view' && last.id === op.id && !this.syncing) {
      last.set = { ...last.set, ...op.set };
      return;
    }
    this.pending.push(op);
  }

  // ---------- GitHub ----------

  serialized(conn) {
    if (!this.cache || this.cache.base !== this.base) this.cache = { base: this.base, files: this.layout.files(this.base, conn) };
    return this.cache.files;
  }

  // The newest copy on GitHub (only the files that changed since the last
  // load are read). → { lib, rev, legacy } or { lib: null } when there's none yet.
  async pull(conn) {
    const r = conn.remote;
    const head = await r.head();
    if (!head) return { lib: null, rev: null };
    if (this.rev?.commit === head) return { lib: this.base, rev: this.rev, legacy: !!this.layout.legacy?.(this.base) };
    const files = await r.files(head);
    if (!this.layout.has(files, conn)) return { lib: null, rev: { commit: head, files } };
    // (files is null when the list couldn't be loaded after a save: read them all)
    const old = this.rev?.files;
    const known = old ? this.serialized(conn) : null;
    const read = async path => {
      if (!files[path]) return null;
      if (known && old[path] === files[path] && known[path] !== undefined) return JSON.parse(known[path]);
      return decryptJSON(await r.blob(files[path]), conn.key, path);
    };
    const lib = this.normalize(await this.layout.load(read, conn));
    return { lib, rev: { commit: head, files }, legacy: !!this.layout.legacy?.(lib) };
  }

  // Encrypted texts of the files that differ between two copies.
  async changedFiles(before, after, conn) {
    const a = before ? this.layout.files(before, conn) : {};
    const b = this.layout.files(after, conn);
    const out = {};
    for (const [path, text] of Object.entries(b)) {
      if (a[path] === text) continue;
      if (!before && this.layout.skip?.(path, text)) continue;
      out[path] = await encryptJSON(JSON.parse(text), conn.key, path);
    }
    return out;
  }

  // One round: load the newest copy, put the pending edits on top, save that
  // in one commit (again on top of a newer copy if another device saved first).
  async sync() {
    const conn = this.connect();
    if (!conn) return;
    const my = this.session;
    const live = () => my === this.session;
    this.syncing = true;
    this.status = { ...this.status, state: 'saving', message: '' };
    this.onUpdate?.();
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { lib: remoteLib, rev, legacy } = await this.pull(conn);
        if (!live()) return;
        this.lastPull = Date.now();
        if (remoteLib && rev) {
          this.base = remoteLib;
          this.rev = rev;
        }
        const batch = this.pending.slice();
        const upgraded = legacy && remoteLib ? this.upgrade?.(remoteLib) : null;
        const next = this.applyAll(upgraded || remoteLib || this.base, batch);
        const files = await this.changedFiles(remoteLib, next, conn);
        if (!live()) return;
        if (!Object.keys(files).length && remoteLib) {
          this.base = next;
          this.pending = this.pending.slice(batch.length);
          break;
        }
        let commit;
        try {
          commit = await conn.remote.commit({ parent: rev?.commit || null, files, message: this.message(batch.length) });
        } catch (e) {
          if (e.kind !== 'conflict' || attempt === 4) throw e;
          continue; // another device saved first: load theirs and rebuild ours on top
        }
        if (!live()) return;
        // Saved. Whatever fails after this, the batch is part of the synced copy.
        const saved = { commit, files: null };
        this.base = next;
        this.rev = saved;
        this.pending = this.pending.slice(batch.length);
        if (upgraded) this.upgraded?.();
        try { saved.files = await conn.remote.files(commit); } catch { /* the next load reads every file */ }
        if (!live()) return;
        this.onSynced?.();
        break;
      }
      this.retryDelay = 4000;
      this.recompute();
      this.persist({ base: true });
      const at = new Date().toISOString();
      db.set(this.k('syncedAt'), at).catch(() => {});
      this.status = { state: this.pending.length ? 'pending' : 'saved', message: '', at };
      if (this.pending.length) this.wantSync?.(800);
    } catch (e) {
      if (!live()) return;
      this.recompute();
      this.persist({ base: true });
      this.status = e.kind === 'offline' ? { ...this.status, state: 'offline', message: '' } : { ...this.status, state: 'error', message: e.message || 'Sync failed.', kind: e.kind };
      if (!['auth', 'forbidden'].includes(e.kind) && !(e instanceof SyntaxError) && e.name !== 'OperationError') {
        this.wantSync?.(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 120_000);
      }
    } finally {
      this.syncing = false;
    }
  }

  // ---------- joining and leaving ----------

  // Connected from now on: the copy from GitHub, with these edits to save on top.
  begin({ remoteLib = null, rev = null, ops = [] }) {
    this.session++;
    this.clearJournal();
    this.base = remoteLib || this.empty();
    this.rev = remoteLib ? rev : null;
    this.pending = ops;
    this.recompute();
    this.persist({ base: true });
    this.status = { state: 'pending', message: '', at: '' };
    return this.writeBase();
  }

  // Not connected any more. keep: the document stays here as it is; since: whose
  // it was (signing back in to the same can then tell what changed here).
  end({ keep = true, since = null } = {}) {
    const lib = this.lib;
    const unsynced = this.pending;
    this.session++;
    this.sinceRec = keep && since ? { lib: since, base: this.base } : null;
    this.clearJournal();
    this.base = keep ? lib : this.empty();
    this.rev = null;
    this.pending = [];
    if (keep && unsynced.length) {
      // (now only in the document: kept in the journal too until that's saved)
      this.journal = unsynced.slice();
      this.saveQueue('journal', this.journal);
    }
    this.recompute();
    this.persist({ base: true });
    db.del(this.k('syncedAt')).catch(() => {});
    this.status = { state: 'local', message: '', at: '' };
    return this.writeBase();
  }

  since() { return Promise.resolve(this.sinceRec); }
  forgetSince() {
    if (!this.sinceRec) return;
    this.sinceRec = null;
    this.persist({ base: true });
  }
}
