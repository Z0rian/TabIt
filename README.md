# TabIt

A guitar songbook: chords over lyrics from Ultimate Guitar, every chord shape,
autoscroll, transpose and capo, a tuner, setlists. No ads. Works offline.
Live at **https://z0rian.github.io/TabIt/**. Add it to the home screen
(Safari → Share → Add to Home Screen) and it runs like an app.

## What's in it

- **Library**: favorites, recently played (on any device), by artist, setlists.
  One search box looks through your songs first, then Ultimate Guitar with
  every version of a song.
- **Songs**: each chord sits exactly over the syllable it belongs to, at any
  width, zoom or font. Tap a chord to swipe through its shapes (the tab
  author's own first) and hear it. Transpose, capo (the shapes change, the
  pitch stays), simplify chords, lyrics only, classic monospace layout,
  pinch or Ctrl+wheel to zoom. Notes per song. The tab author's strumming
  patterns, with the count under each stroke, and Play strums them in time on
  the song's first chord.
- **Autoscroll** paced by the song's length: from the YouTube video once
  you've played it there, otherwise estimated (most songs come out at 2 to
  3 minutes). The slider makes it faster or slower; scroll by hand and it
  carries on from there. With *Follow the video* on, it scrolls along with
  the YouTube player.
- **Chords** tab: any chord you can type, every shape, in any tuning.
- **Tuner**: steady needle (the pitch is low-pass filtered over a quarter
  second), any tuning, A4 calibration, reference notes.
- **Sync** between your devices with a password (below).

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

## Sync and signing in

Like the Ranch app: a GitHub key is set up once, and every device signs in with
a password.

1. On your main device: *Settings → Sync → First time? Set up sync*, and
   follow the two links there: one makes a public repository called
   `tabit-data` (it holds the library, encrypted), the other a fine-grained key
   for just that repository (Contents: Read and write). Paste the key, press
   *Set up sync*. Your library goes up.
2. Still there, add a password (a few words is easiest).
3. On each other device: *Settings → Sync*, type the password, *Sign in*.

After that everything saves by itself, and changes made offline sync when
there's a connection again. If two devices change things at the same time,
both changes are kept. Signing out keeps the songs on the device; signing back
in adds whatever was changed there in the meantime.

How it's stored: in its own repository, `tabit-data`, not this one, so
syncing never rebuilds the website, and the key the passwords unlock can't
change the app. The library is encrypted (AES-GCM) with a random key;
`access.json` holds that key and the GitHub key, encrypted once per password
(PBKDF2, 600,000 rounds), so it's safe in a public repository as long as the
passwords are not easy to guess. To lock everyone out, delete the key on
GitHub; to change it, use *Settings → Sync → Replace the GitHub key* (each
password is typed again there).

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
python tests/e2e_sync.py              # two devices syncing through a fake GitHub
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
