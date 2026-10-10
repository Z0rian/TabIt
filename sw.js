// TabIt's service worker: the whole app is cached when it installs, so TabIt
// starts with no connection at all. Songs live in IndexedDB (not here).
//
// Only caches named "tabit-…" are ever touched: other apps on the same site
// (z0rian.github.io/ranch-projects) keep theirs.
//
// The list below is written by scripts/build.py. Run it before committing.

// BUILD-START
const BUILD = '52d2255334';
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'manifest.json',
  'js/account.js',
  'js/app.js',
  'js/audio.js',
  'js/autoscroll.js',
  'js/covers.js',
  'js/crypto.js',
  'js/db.js',
  'js/diagram.js',
  'js/importer.js',
  'js/migrate.js',
  'js/model.js',
  'js/parse.js',
  'js/pitch.js',
  'js/prefs.js',
  'js/puns.js',
  'js/remote.js',
  'js/session.js',
  'js/sheet.js',
  'js/splash.js',
  'js/store.js',
  'js/strum.js',
  'js/theory.js',
  'js/ug.js',
  'js/ui.js',
  'js/version.js',
  'js/voicings.js',
  'js/youtube.js',
  'js/views/chords.js',
  'js/views/chordsheet.js',
  'js/views/common.js',
  'js/views/editor.js',
  'js/views/import.js',
  'js/views/library.js',
  'js/views/settings.js',
  'js/views/song.js',
  'js/views/strum.js',
  'js/views/tuner.js',
  'fonts/bricolage-grotesque.woff2',
  'fonts/jetbrains-mono.woff2',
  'fonts/source-serif-4.woff2',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];
// BUILD-END

const CACHE = `tabit-app-${BUILD}`;
const IMAGES = 'tabit-images';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const before = await caches.keys();
    const cache = await caches.open(CACHE);
    // straight from the network, not the browser's HTTP cache
    await cache.addAll(PRECACHE.map(p => new Request(p, { cache: 'reload' })));
    // First install, or taking over from the old TabIt (whose worker would
    // otherwise keep serving the old app): start right away. Later updates
    // wait for the app to say when (see app.js).
    if (!before.some(k => k.startsWith('tabit-app-'))) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('tabit-app-') && k !== CACHE) await caches.delete(k);
      // the old TabIt's cache
      if (k === 'tabit-v2' || k === 'tabit-v1') await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // the app itself: from the cache, instantly, online or not
    if (req.mode === 'navigate') {
      event.respondWith(caches.match('index.html', { cacheName: CACHE }).then(hit => hit || fetch(req)));
      return;
    }
    event.respondWith(caches.match(req, { cacheName: CACHE }).then(hit => hit || fetch(req)));
    return;
  }

  // album covers: keep a copy so the library looks the same offline
  if (req.destination === 'image' && /ultimate-guitar\.com$|ytimg\.com$|mzstatic\.com$/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // everything else (Ultimate Guitar, GitHub, YouTube) goes straight to the network
});

// Covers are fetched with CORS (both hosts allow it): an opaque copy would
// count as several megabytes against the storage quota this site shares.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(req.url);
  const fresh = fetch(req.url, { mode: 'cors', credentials: 'omit' }).then(res => {
    if (res.ok) cache.put(req.url, res.clone()).then(() => trim(cache));
    return res;
  }).catch(() => hit || fetch(req));
  return hit || fresh;
}

async function trim(cache, max = 400) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
