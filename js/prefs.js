// Settings that belong to this device (theme, text size, left-handed…), kept
// in localStorage under one key. Song-specific choices (transpose, capo) are
// stored on the song and sync with it.

const KEY = 'tabit.prefs';

export const DEFAULTS = {
  theme: 'system', // system | light | dark | black
  lyricFont: 'serif', // serif | sans | mono
  fontSize: 0, // 0 = automatic for this screen
  diagrams: true, // chord diagrams above the song
  leftHanded: false,
  keepAwake: true,
  sort: 'added',
  filter: 'all',
  a4: 440,
  tuning: 'standard',
  followVideo: true,
  defaultLength: 0, // seconds; 0 = estimate from the song
};

let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { cache = { ...DEFAULTS }; }
  return cache;
}

export const prefs = {
  get(k) { return load()[k]; },
  set(k, v) {
    load()[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full */ }
    listeners.forEach(fn => fn(k, v));
  },
  all() { return { ...load() }; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

export function autoFontSize() {
  const w = innerWidth;
  if (w >= 700) return 20;
  if (w <= 360) return 16;
  return 17;
}

export const fontSize = () => prefs.get('fontSize') || autoFontSize();

export function applyTheme(t = prefs.get('theme')) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  const dark = t === 'dark' || t === 'black' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const color = t === 'black' ? '#000000' : dark ? '#12100e' : '#f3eee6';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());
