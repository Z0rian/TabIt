// Ultimate Guitar, through the owner's Cloudflare Worker (ug-proxy/worker.js):
// search, fetch a tab, find a YouTube video. The worker that's deployed today
// only returns the tab text; the newer one in this repo also returns the
// metadata (capo, key, tuning, the author's chord shapes, strumming and tempo),
// which is used whenever it's there.
//
// Also: reading a Tabs & Chords "My tabs" list and matching every entry to the
// same version on Ultimate Guitar.

import { parseSong } from './parse.js';
import { detectKey, isChord } from './theory.js';
import { fold, makeSong } from './model.js';
import { readStrumming } from './strum.js';

export const PROXY = 'https://ug-proxy.zorian.workers.dev';

async function call(params, { signal, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  let res;
  try {
    res = await fetch(`${PROXY}/?${new URLSearchParams(params)}`, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    if (signal?.aborted) throw e;
    throw new Error(navigator.onLine === false ? 'You’re offline.' : 'Couldn’t reach Ultimate Guitar.');
  }
  clearTimeout(t);
  let data;
  try { data = await res.json(); } catch { throw new Error(`Ultimate Guitar answered with an error (${res.status}).`); }
  // (the first worker couldn't read some pages: curly quotes in a reader's comment broke them)
  if (data.error) throw new Error(/JSON/.test(data.error) ? 'Ultimate Guitar’s page for it couldn’t be read. Updating the TabIt worker fixes this.' : data.error);
  return data;
}

const TYPE_ORDER = { Chords: 0, Tabs: 1, Tab: 1, Pro: 2 };

// Search results, each numbered with its version (the worker may not send it:
// Ultimate Guitar lists versions of a song in order, so count them).
export async function searchUG(q, opts) {
  const data = await call({ action: 'search', q }, opts);
  return numberVersions((data.results || []).map(r => ({
    title: r.title || '', artist: r.artist || '', type: r.type || '', rating: +r.rating || 0, votes: +r.votes || 0, url: r.url || '',
    version: r.version ?? null, id: r.id ?? idFromUrl(r.url), key: r.key || r.tonality || '', difficulty: r.difficulty || '', cover: r.cover || '',
  })).filter(r => r.url));
}

export const idFromUrl = url => +(/-(\d+)(?:$|[?#])/.exec(url || '')?.[1] || 0) || null;

export function numberVersions(results) {
  const seen = new Map();
  return results.map(r => {
    const k = `${fold(r.artist)}|${fold(r.title)}|${r.type}`;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return { ...r, version: r.version ?? n };
  });
}

// Groups results into songs with their versions, best-voted song first.
export function groupResults(results) {
  const groups = new Map();
  for (const r of results) {
    if (!(r.type in TYPE_ORDER)) continue;
    const k = `${fold(r.artist)}|${fold(r.title)}`;
    if (!groups.has(k)) groups.set(k, { title: r.title, artist: r.artist, versions: [], votes: 0, order: groups.size });
    const g = groups.get(k);
    g.versions.push(r);
    g.votes += r.votes;
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.versions.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.version - b.version);
    const chords = g.versions.filter(v => v.type === 'Chords');
    g.best = (chords.length ? chords : g.versions).reduce((a, b) => (score(b) > score(a) ? b : a));
  }
  // keep Ultimate Guitar's relevance order, but drop near-empty duplicates down
  return list.sort((a, b) => a.order - b.order);
}

// Rating that doesn't let a 5.0 from 3 votes beat a 4.8 from 30,000.
export const score = r => (r.rating || 0) * (1 - 1 / Math.sqrt((r.votes || 0) + 1));

export async function fetchTab(url, opts) {
  const data = await call({ action: 'tab', url }, opts);
  if (!data.content) throw new Error('That tab came back empty.');
  return data;
}

// A library song from a search result and the fetched tab.
export function songFromTab(result, tab, extra = {}) {
  const doc = parseSong(tab.content);
  const meta = tab.meta || {};
  const capo = num(meta.capo) ?? num(doc.meta.capo) ?? 0;
  const key = meta.key || meta.tonality || result.key || doc.meta.key || detectKey(doc.chords) || '';
  const tuning = typeof meta.tuning === 'string' ? meta.tuning : meta.tuning?.value || doc.meta.tuning || '';
  const bpm = num(tab.strumming?.[0]?.bpm) ?? num(tab.strummings?.[0]?.bpm) ?? num(doc.meta.bpm);
  const shapes = tab.shapes || shapesFromApplicature(tab.applicature);
  return makeSong({
    title: tab.song?.title || result.title,
    artist: tab.song?.artist || result.artist,
    kind: result.type === 'Tabs' || result.type === 'Tab' ? 'tab' : 'chords',
    content: tab.content,
    src: { site: 'ug', url: result.url, id: result.id || idFromUrl(result.url), version: result.version || tab.song?.version || 1, type: result.type || 'Chords', rating: result.rating, votes: result.votes },
    key, capo: capo || undefined, tuning: tuning && tuning !== 'E A D G B E' ? tuning : undefined, bpm: bpm || undefined,
    cover: result.cover || tab.song?.cover || undefined,
    shapes: shapes && Object.keys(shapes).length ? shapes : undefined,
    strum: readStrumming(tab.strumming || tab.strummings),
    ...extra,
  });
}

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(+v) ? null : +v);

// Ultimate Guitar's chord shapes (strings listed high e first, absolute frets,
// barres as "capos") → { name: [[6 frets, low E first], ...] }.
export function shapesFromApplicature(app) {
  if (!app || typeof app !== 'object') return null;
  const out = {};
  for (const [name, list] of Object.entries(app)) {
    if (!isChord(name) || !Array.isArray(list)) continue;
    const shapes = list.slice(0, 4).map(v => (Array.isArray(v.frets) && v.frets.length === 6 ? [...v.frets].reverse().map(f => (f < 0 ? -1 : f)) : null)).filter(Boolean);
    if (shapes.length) out[name] = shapes;
  }
  return out;
}

// ---------- YouTube ----------

export async function findVideo(title, artist, opts) {
  const data = await call({ action: 'youtube-search', q: `${artist} ${title}`.trim() }, opts);
  if (!data.videoId) throw new Error('No video found.');
  return { id: data.videoId, duration: num(data.duration), title: data.title || '' };
}

export function videoIdFrom(text) {
  const s = String(text || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(s);
  return m ? m[1] : null;
}

// ---------- Tabs & Chords "My tabs" list ----------

const DATE_RX = /^\s*((?:[A-Z][a-z]{2} \d{1,2}, \d{4})|(?:\d+ (?:days?|hours?|minutes?|weeks?|months?|years?) ago)|today|yesterday)\s*\t?\s*([A-Za-z][A-Za-z ]*?)?\s*\t?\s*$/i;

// The text you get by selecting the "My tabs" table on ultimate-guitar.com (or
// in Tabs & Chords) and copying it. Artists appear once, above their songs.
export function parseTCList(text, now = new Date()) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let start = lines.findIndex(l => /^\s*Artist\s*\t\s*Song\s*\t\s*Date/i.test(l));
  start = start < 0 ? 0 : start + 1;
  const out = [];
  let artist = '';
  for (let i = start; i < lines.length; i++) {
    const m = DATE_RX.exec(lines[i]);
    if (!m || i - 1 < start) continue;
    let title = lines[i - 1].trim();
    const prev = i - 2 >= start ? lines[i - 2] : '';
    if (prev.trim() && !DATE_RX.test(prev)) artist = prev.trim();
    if (!title || DATE_RX.test(title)) continue;
    let version = 1;
    const vm = /\s*\(ver (\d+)\)\s*$/i.exec(title);
    if (vm) {
      version = +vm[1];
      title = title.slice(0, vm.index).trim();
    }
    out.push({ artist, title, version, type: (m[2] || 'Chords').trim(), date: toDate(m[1], now) });
  }
  return out;
}

function toDate(s, now) {
  const rel = /^(\d+) (day|hour|minute|week|month|year)s? ago$/i.exec(s);
  if (rel) {
    const ms = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2].toLowerCase()];
    return new Date(now.getTime() - +rel[1] * ms).toISOString();
  }
  if (/^today$/i.test(s)) return now.toISOString();
  if (/^yesterday$/i.test(s)) return new Date(now.getTime() - 864e5).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? now.toISOString() : new Date(t + 12 * 36e5).toISOString();
}

const UG_TYPE = { chords: 'Chords', 'guitar pro': 'Pro', tab: 'Tabs', tabs: 'Tabs', bass: 'Bass Tabs', ukulele: 'Ukulele Chords' };
const sameArtist = (a, b) => { const x = fold(a), y = fold(b); return x === y || x.includes(y) || y.includes(x); };
const sameTitle = (a, b) => fold(a).replace(/\(.*?\)/g, '').trim() === fold(b).replace(/\(.*?\)/g, '').trim();

// The search result for a list entry: same artist, title, type and version.
// Guitar Pro files can't be shown, so those fall back to the best Chords version.
export function matchEntry(entry, results) {
  const want = UG_TYPE[entry.type.toLowerCase()] || entry.type;
  const same = numberVersions(results).filter(r => sameTitle(r.title, entry.title) && sameArtist(r.artist, entry.artist));
  const typed = same.filter(r => r.type === want && want !== 'Pro');
  const exact = typed.find(r => r.version === entry.version);
  if (exact) return { result: exact, how: 'exact' };
  if (typed.length) return { result: typed.reduce((a, b) => (score(b) > score(a) ? b : a)), how: 'closest' };
  const chords = same.filter(r => r.type === 'Chords');
  if (chords.length) return { result: chords.reduce((a, b) => (score(b) > score(a) ? b : a)), how: want === 'Pro' ? 'chords-for-pro' : 'chords' };
  return { result: null, how: 'none' };
}

export async function findEntry(entry, opts) {
  let results = await searchUG(`${entry.artist} ${entry.title}`, opts);
  let m = matchEntry(entry, results);
  if (!m.result) {
    results = await searchUG(entry.title, opts);
    m = matchEntry(entry, results);
  }
  return m;
}
