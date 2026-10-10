# TabIt: notes for Claude

A personal Tabs & Chords (Ultimate Guitar) replacement, published at
https://z0rian.github.io/TabIt/ (GitHub Pages, deploy from branch `main`, root).
Rebuilt from scratch in October 2026 (the single-file React version is in git
history before commit `e972b56`).

## Layout

- `index.html`, `styles.css`, `js/`: vanilla ES modules, no framework, no build step, no CDN.
  - `theory.js`: notes, chord symbols (`parseChord` → root, bass, required/optional tones), transposing, keys, simplify.
  - `parse.js`: song text → blocks. Accepts UG markup (`[ch]`, `[tab]`), plain chords-over-lyrics, inline `[G]` chords. The `pair` block holds a lyric and chords anchored to character positions. Also reads capo/key/tuning/bpm and chord-legend lines ("D/F#  200232") into `doc.meta`.
  - `sheet.js`: blocks → DOM. Each chord + its syllable is one inline-block unit, so wrapping can't separate them. Chords hang over following text (absolutely positioned) and `fitChords()` gives a unit a min-width only where a chord would touch the next one or the edge. Tab staves wrap all lines at the same column. `watchSheet()` re-lays out on width/font-size change and when fonts finish loading.
  - `voicings.js`: chord voicing generator (any chord, any tuning, ~16 shapes, canonical open shapes first), `fromFrets()` for author shapes. `diagram.js`: SVG chord boxes. `audio.js`: Karplus-Strong strum.
  - `pitch.js`: YIN pitch detection + `PitchTracker` (one-pole low-pass on the pitch, tau 0.25 s; a new note must hold 70 ms; note-name hysteresis).
  - `autoscroll.js`: time-based autoscroll over line weights (`data-w` on sheet blocks), reading line at 36% of the screen, hand-scroll takeover. `youtube.js`: IFrame API player (duration, follow-video).
  - `model.js`: the library and its ops (`add`, `set`, `view`, `del`, `list`, `list-del`, `prefs`, `many`), `applyOp`, `invertOp` (undo). Ops set values, never toggle, so they replay safely. Also the split between the **shared songbook** and **your part** (`PERSONAL_FIELDS`: fav, view, played, plays, notes; plus setlists and prefs): `splitOp` routes each op, `joinLibrary` makes the one library the screens see.
  - `doc.js`: one synced, encrypted document (`Doc`): base (last synced) + pending ops; IndexedDB persistence (`db.js`: base, its commit, whose key it was and, signed out, the copy it had synced (`since`) are one record, `<name>.state`; writes reject on failure and the journal is only trimmed after a real save, including the unsynced edits that signing out folds in); the sync engine (pull changed files, replay the pending batch, one commit, retry on non-fast-forward). A `session` counter stops a sync from an older sign-in touching state. Not connected = ops go straight into base.
  - `store.js`: two Docs, `book` (the songbook: `library/index.json` + 16 shards, the songbook key) and `mine` (your part: `people/<id>.json`, your account's own key; local-only without an account), joined for the screens; `dispatch` splits ops between them. Signing back in applies this device's changes field by field (`diffOps` against `since`) without bringing back songs deleted elsewhere. Migration from the single library (`lib.*`). An index from before the split still holds its owner's part: it's carried unseen until a device that was signed in when it migrated (`book.claim`) takes it into its own part (`claimLegacy`) and rewrites the index. On a 401 it looks for a replaced key (`account.pickUpNewKey`). Tabs share ops over a `BroadcastChannel`.
  - `remote.js`: GitHub Git Data API on `main` of a separate public repository, `<owner>/tabit-data` (so the key the passwords unlock can't touch the app's repository). First commit in an empty repository goes through the Contents API. Plus `MockRemote` for `?mock`; `localStorage['tabit.dev.api']` points at a fake GitHub (`tests/fakegithub.py`) on localhost only.
  - `account.js`: owner setup with a fine-grained key; entries in `access.json`, invites and accounts, each sealing `{libKey, priv, person?}` with PBKDF2-600k → AES-GCM (one salt per file, so a sign-in stretches once); the GitHub key is sealed to each entry's ECDH public key (`tok`), so replacing it needs no passwords and devices pick it up. Entries from before key pairs (`{token, libKey}`, no `pub`) still open and are resealed at sign-in. `crypto.js`: the primitives; library files are gzip → AES-GCM with the path as associated data.
  - `ug.js`: the Cloudflare Worker client (search, tab, YouTube), version numbering, the Tabs & Chords list parser and matcher. `importer.js`: background import queue, backup files. `migrate.js`: the old app's localStorage songs, once.
  - `views/*.js`: one file per screen; `ui.js`: `h()`, `fill()`, icons, drawers, toasts, swipe-to-delete.
- `sw.js`: precaches the app; `scripts/build.py` stamps its file list and hash (and `js/version.js`). **Run it before committing.** It only deletes caches named `tabit-app-*` (same origin as ranch-projects!).
- `ug-proxy/worker.js`: the Cloudflare Worker (v2, backward compatible). The user deploys it by pasting it in the Cloudflare dashboard.
- `tests/`: browser unit tests (`run_unit.py`, files listed in `tests/all.js`) and Playwright e2e scripts (`e2e_*.py`). `tests/util.py` has the device matrix and corrects for Playwright WebKit on Windows (display scaling inflates DPR; mobile mode mis-sizes the layout).

## Rules

- **Never commit song text.** `tests/corpus/` (the owner's library, fetched by `tests/fetch_corpus.py`) and the import file are copyrighted and personal; `build.py` refuses to run if corpus files are tracked. Test fixtures in the repo use invented lyrics.
- Never write the GitHub key, the library key or a password into a file, a commit or a URL.
- Never use `innerHTML` with data. `h()` and `fill()` (skips null, flattens arrays) build DOM; `replaceChildren(null)` writes the text "null".
- Everything the app stores is prefixed `tabit` (localStorage, IndexedDB, Cache Storage): the origin is shared with other apps.
- Every library change is an op through `dispatch()`; ops must make sense replayed on a newer library.
- Shell heredocs halve backslashes on this machine; edit regex-heavy JS with the Edit tool, not `python - <<EOF` replacements. The Write tool turns ` ` into a literal character: use `String.fromCharCode(160)`.
- WebKit on Windows (Playwright) ignores variable-font axes (renders everything in the heavy default instance) and has no Web Audio; judge typography in Edge. `font-stretch` is not used for the same reason.

## Testing

`python tests/run_unit.py` (≈135 tests, both engines) and the e2e scripts listed in README.md. After touching sync or migration, also `tests/e2e_songbook_upgrade.py ../tabit-prev` (a worktree of the release before the shared songbook, `8ce0f1c`). After touching the parser or the sheet, run `tests/e2e_align.py` (quick) and `--full` (≈17 min, ~1.7 M chord placements) before deploying.

## Deploy

Merge to `main` and push; Pages rebuilds in about a minute. Phones pick up the new service worker on their next start (or tap *Update* in the toast).
