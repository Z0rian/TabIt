// Start-up, routing and the frame around every screen.

import { h, icon, toast } from './ui.js';
import * as store from './store.js';
import { prefs, applyTheme } from './prefs.js';
import { oldLibrary, markMigrated, oldTheme, shrinkCovers } from './migrate.js';
import { requestPersist } from './db.js';
import { startCovers } from './covers.js';

const VIEWS = {
  library: () => import('./views/library.js'),
  song: () => import('./views/song.js'),
  edit: () => import('./views/editor.js'),
  chords: () => import('./views/chords.js'),
  tuner: () => import('./views/tuner.js'),
  settings: () => import('./views/settings.js'),
  import: () => import('./views/import.js'),
};

const TABS = [
  ['library', 'Library', 'library', '#/'],
  ['chords', 'Chords', 'chords', '#/chords'],
  ['tuner', 'Tuner', 'tuner', '#/tuner'],
  ['settings', 'Settings', 'settings', '#/settings'],
];

// "#/song/s-abc?t=1" → { name: 'song', args: ['s-abc'], query }
export function parseRoute(hash = location.hash) {
  const [path, qs] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const name = parts[0] || 'library';
  return { name: VIEWS[name] ? name : 'library', args: parts.slice(1), query: new URLSearchParams(qs || '') };
}

// The screens visited in this session, so "back" can tell whether there's an
// in-app page to go back to (a song opened from a shared link has none).
const visited = [location.hash || '#/'];
function track() {
  const h = location.hash || '#/';
  if (visited.length > 1 && visited[visited.length - 2] === h) visited.pop();
  else if (visited.at(-1) !== h) visited.push(h);
}

export const go = (hash, { replace = false } = {}) => {
  if (location.hash === hash) return route();
  if (replace) location.replace(hash);
  else location.hash = hash;
};
export const back = (fallback = '#/') => {
  if (visited.length > 1) history.back();
  else go(fallback, { replace: true });
};

let current = null;
let routeSeq = 0;
const appEl = h('div', { class: 'app' });
const viewEl = h('main', { class: 'view', id: 'view' });
const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' });

function drawTabs(active) {
  tabbar.replaceChildren(
    h('div', { class: 'tab-brand' }, h('img', { src: 'icons/icon-192.png', alt: 'TabIt' })),
    ...TABS.map(([name, label, ic, href]) => h('a', {
      class: 'tab-btn', href, 'aria-current': name === active ? 'page' : undefined,
      onClick: e => { if (name === active && name === 'library') { e.preventDefault(); scrollTo({ top: 0, behavior: 'smooth' }); } },
    }, icon(ic), h('span', {}, label))));
}

async function route() {
  const seq = ++routeSeq;
  const r = parseRoute();
  const mod = await VIEWS[r.name]();
  if (seq !== routeSeq) return; // a newer navigation won
  const prev = current;
  const view = await mod.view(r, { go, back, route });
  if (seq !== routeSeq) { view.destroy?.(); return; }
  prev?.destroy?.();
  current = view;
  const tab = view.tab || r.name;
  drawTabs(TABS.some(t => t[0] === tab) ? tab : 'library');
  appEl.classList.toggle('immersive', !!view.immersive);
  document.title = view.title ? `${view.title} · TabIt` : 'TabIt';
  viewEl.replaceChildren(view.el);
  if (!view.keepScroll) scrollTo(0, view.scrollY || 0);
  view.mounted?.();
}

async function boot() {
  const t = prefs.get('theme');
  if (t === 'system' && !localStorage.getItem('tabit.prefs')) {
    const old = oldTheme();
    if (old) prefs.set('theme', old);
  }
  applyTheme();
  const { fresh } = await store.init();
  // first start after the old TabIt: bring its songs over
  if (fresh || !Object.keys(store.store.lib.songs).length) {
    const old = oldLibrary();
    if (old) {
      store.replaceLocal(old);
      const n = Object.keys(old.songs).length;
      setTimeout(() => toast(`Brought over ${n} song${n === 1 ? '' : 's'} from the old TabIt.`), 600);
    }
  }
  markMigrated();
  addEventListener('tabit-storage-error', () => toast('This device’s storage is full or not working, so your latest changes may not be kept after closing TabIt. Free up some space, or export a backup in Settings.', { ms: 12000 }));
  appEl.append(tabbar, viewEl);
  document.getElementById('root').replaceWith(appEl);
  addEventListener('hashchange', () => { track(); route(); });
  await route();
  store.maybePull(0);
  setInterval(() => { if (document.visibilityState === 'visible') store.maybePull(5 * 60_000); }, 60_000);
  requestPersist();
  registerServiceWorker();
  setTimeout(() => shrinkCovers(Object.values(store.store.lib.songs), op => store.dispatch(op, { lazy: true })), 3000);
  startCovers();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (store.isLocalDev && !new URLSearchParams(location.search).has('sw')) return;
  const started = Date.now();
  navigator.serviceWorker.register('sw.js').then(reg => {
    // An update that arrives while you're using the app waits for a tap; one
    // that's ready as the app starts goes in straight away (nothing to lose yet).
    let closeOffer = null;
    const offer = worker => {
      if (Date.now() - started < 4000) { worker.postMessage('skip-waiting'); return; }
      closeOffer?.();
      closeOffer = toast('A new version of TabIt is ready.', { action: 'Update', ms: 15000, onAction: () => worker.postMessage('skip-waiting') });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // look for updates when the app comes back to the front, and offer again
    // one that's waiting (its message may have been missed)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      reg.update().catch(() => {}).then(() => { if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting); });
    });
  }).catch(() => {});
  // reload into a new version, but not the very first time a worker takes over
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

boot().catch(e => {
  console.error(e);
  document.getElementById('root')?.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'TabIt couldn’t start'), h('p', {}, String(e?.message || e))));
});
