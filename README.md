# TabIt

A guitar songbook: chords over lyrics from Ultimate Guitar, every chord shape,
autoscroll, transpose and capo, a tuner, setlists. No ads. Works offline.
Live at **https://z0rian.github.io/TabIt/**. Add it to the home screen
(Safari → Share → Add to Home Screen) and it runs like an app.

## What's in it

- **Library**: favorites, recently played (on any device), by artist, setlists,
  album covers (found by themselves, from Ultimate Guitar or Apple's catalog).
  One search box looks through your songs first, then Ultimate Guitar with
  every version of a song.
- **Songs**: each chord sits exactly over the syllable it belongs to, at any
  width, zoom or font. Tap a chord to swipe through its shapes (the tab
  author's own first) and hear it. Transpose with the button next to the key
  (a semitone at a time, or straight to any key), capo (the shapes change, the
  pitch stays), simplify chords, lyrics only, classic monospace layout,
  pinch or Ctrl+wheel to zoom. Notes per song. The tab author's strumming
  patterns, with the count under each stroke, and Play strums them in time on
  the song's first chord.
- **Autoscroll** paced by the song's length: from the YouTube video once
  you've played it there, otherwise estimated (most songs come out at 2 to
  3 minutes), at one steady speed from the song's first line. The slider
  makes it faster or slower; scroll by hand and it carries on from there.
  With *Follow the video* on, it scrolls along with the YouTube player. Swipe
  the bar right (or tap its grip) to tuck it into the corner as just
  play/pause.
- **Chords** tab: any chord you can type, every shape, in any tuning.
- **Tuner**: steady needle (the pitch is low-pass filtered over a quarter
  second), any tuning, A4 calibration, reference notes.
- **A shared songbook** with your friends, and an account of your own that keeps your favorites and setlists on all your devices (below). Only the owner needs GitHub.

## Bringing your Tabs & Chords favorites

Either:

- open **TabIt favorites (import me).json** (made for you, in the folder above
  this repository) with *Library → + → Open a TabIt backup*: all 232 songs in
  the same versions, with capo, key, tuning, the authors' chord shapes and
  strumming patterns, and album covers; or
- on ultimate-guitar.com open *My tabs*, select the whole table, copy, and
  paste it into *Library → + → Import from Tabs & Chords*. Each song is fetched
  in the same version. Songs already in the library are skipped, so pasting
  the list again later only adds the new ones.

Songs from the old TabIt come over by themselves the first time the new one opens.

## The shared songbook and accounts

TabIt works on its own, on one device, without signing in. Signed in, everyone
shares one songbook: a song anyone adds is there for everyone. What's yours
stays yours: favorites, transpose and capo, chosen shapes, notes, what you
played, and your setlists. Only the owner needs GitHub, once.

1. The owner, on their main device: *Settings → Shared songbook → Starting
   a songbook of your own?*, and follow the two links there: one makes a public
   repository called `tabit-data` (it holds the songbook, encrypted), the
   other a fine-grained key for just that repository (Contents: Read and
   write). Paste the key, press *Set up sync*.
2. Still there: *Your account* (a name and a password), and an invite
   password for friends under *Invites*.
3. A friend opens the app, types the invite under *Shared songbook*, *Sign
   in*, then makes their own account. No GitHub.
4. On each of your other devices, sign in with your account's password. (A
   device already in with an invite: *Your account → Made your account on
   another device? Use it here*.)

After that everything saves by itself, and changes made offline sync when
there's a connection again. If two devices change things at the same time,
both changes are kept. Signing out keeps the songs on the device; signing back
in adds whatever was changed there in the meantime. Without an account, your
favorites and setlists are kept on the device only.

How it's stored: in its own repository, `tabit-data`, not this one, so
syncing never rebuilds the website, and the key the passwords unlock can't
change the app. The songbook is encrypted (AES-GCM) with a random key; each
account's part is a file of its own, `people/<id>.json`, encrypted with a key
only that account's password opens. `access.json` holds, once per password
(PBKDF2, 600,000 rounds), the keys it opens, and the GitHub key sealed to
that password's own key pair. It's safe in a public repository as long as the
passwords are not easy to guess. To lock everyone out, delete the key on
GitHub. To change it: *Settings → Shared songbook → Replace the GitHub key*;
every password gets the new one, nobody types anything, and devices pick it
up by themselves. A removed invite or account doesn't get it.

From TabIt 2.0: the first of your devices to open 2.1 takes your favorites,
notes and setlists out of the songbook's index into its own part. Make your
account there, then use it on your other devices; they get them back.

## The Ultimate Guitar worker

TabIt reaches Ultimate Guitar through a Cloudflare Worker,
`ug-proxy.zorian.workers.dev`. The version in `ug-proxy/worker.js` also
returns each tab's capo, key, tuning, chord shapes, strumming and tempo, the
version numbers, and YouTube video lengths. The app works with the old one,
but some songs then come in without their capo. To update it: Cloudflare
dashboard → Workers & Pages → `ug-proxy` → *Edit code* → paste
`ug-proxy/worker.js` → *Deploy*. *Settings → About → Check* says which one is
running.

## Working on it

Plain ES modules, no build step, no dependencies. Fonts are self-hosted
(OFL, in `fonts/`).

```
python scripts/serve.py               # http://127.0.0.1:8090, ?mock = fake GitHub in the browser
python scripts/build.py               # stamp sw.js before committing (tests check it)
python tests/run_unit.py              # unit tests in WebKit and Edge
python tests/e2e_align.py [--full]    # chord placement on 11 phones/tablets/laptops
python tests/e2e_sync.py              # owner and a friend's two devices, through a fake GitHub
python tests/e2e_songbook_upgrade.py ../tabit-prev   # from 2.0 (git worktree add ../tabit-prev 8ce0f1c)
python tests/e2e_offline.py           # starts with no network
python tests/e2e_autoscroll.py        # keeps time
python tests/e2e_song.py              # the song screen, used like a person would
python tests/e2e_tuner.py             # the tuner with a known signal
```

The alignment and corpus tests use your own library as test data
(`tests/fetch_corpus.py` puts it in `tests/corpus/`, which is never committed:
it's copyrighted song text). Playwright for Python and its WebKit browser are
needed (`python -m playwright install webkit`); Edge stands in for Chrome.
See `CLAUDE.md` for how the code fits together.
