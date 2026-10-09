/**
 * TabIt — Ultimate Guitar proxy (Cloudflare Worker), version 2.
 *
 * Same endpoints as version 1, with more in every answer (older TabIt
 * versions ignore the extra fields):
 *   ?action=search&q=QUERY      → { results: [{ title, artist, type, rating, votes, url,
 *                                    version, id, key, difficulty, cover }] }
 *   ?action=tab&url=TAB_URL     → { content, meta: { capo, key, tuning, difficulty },
 *                                    shapes: { chord: [[6 frets, low E first], …] },
 *                                    strumming: [{ part, bpm, … }], song: { … } }
 *   ?action=youtube-search&q=Q  → { videoId, duration (seconds), title }
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → ug-proxy → Edit code →
 * paste this file → Deploy. Nothing else changes.
 */

// Pages allowed to call the proxy from a browser (anything else gets no CORS headers).
const ALLOWED_ORIGINS = [
  'https://z0rian.github.io',
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

const UG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// How long answers are cached at Cloudflare's edge (kinder to Ultimate Guitar).
const TTL = { search: 3600, tab: 86400, 'youtube-search': 86400 };
const TYPES = new Set(['Chords', 'Tabs', 'Pro', 'Ukulele Chords']);

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsFor(origin);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, cors);

    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    if (!TTL[action]) return json({ error: 'Unknown action. Use action=search, action=tab, or action=youtube-search' }, 400, cors);

    // edge cache, keyed by the request without the Origin
    const cache = caches.default;
    const key = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return withCors(hit, cors);

    let res;
    try {
      if (action === 'search') res = await search(url.searchParams.get('q'));
      else if (action === 'tab') res = await tab(url.searchParams.get('url'));
      else res = await youtube(url.searchParams.get('q'));
    } catch (e) {
      return json({ error: e.message || String(e) }, 502, cors);
    }
    const out = json(res.body, res.status || 200, { 'Cache-Control': `public, max-age=${TTL[action]}` });
    if ((res.status || 200) === 200) ctx.waitUntil(cache.put(key, out.clone()));
    return withCors(out, cors);
  },
};

async function search(q) {
  if (!q) return { status: 400, body: { error: 'Missing q param' } };
  const page = await fetchText(`https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(q)}`);
  const data = store(page)?.store?.page?.data ?? {};
  const results = (data.results ?? [])
    .filter(r => TYPES.has(r.type))
    .map(r => ({
      title: r.song_name ?? '',
      artist: r.artist_name ?? '',
      type: r.type ?? '',
      rating: +(+(r.rating ?? 0)).toFixed(2),
      votes: r.votes ?? 0,
      url: r.tab_url ?? '',
      version: r.version ?? null,
      id: r.id ?? null,
      key: r.tonality_name || '',
      difficulty: r.difficulty || '',
      cover: r.album_cover?.web_album_cover?.small || '',
    }));
  return { body: { results } };
}

async function tab(tabUrl) {
  if (!tabUrl) return { status: 400, body: { error: 'Missing url param' } };
  let u;
  try { u = new URL(tabUrl); } catch { return { status: 400, body: { error: 'Bad url' } }; }
  if (!/(^|\.)ultimate-guitar\.com$/.test(u.hostname)) return { status: 400, body: { error: 'Only ultimate-guitar.com tabs' } };
  const page = await fetchText(u.toString());
  const data = store(page)?.store?.page?.data ?? {};
  const view = data.tab_view ?? {};
  const t = data.tab ?? {};
  const content = view.wiki_tab?.content ?? data.tab?.content ?? '';
  if (!content) return { status: 404, body: { error: 'Tab content not found on page' } };
  const meta = view.meta ?? {};
  const shapes = {};
  for (const [name, list] of Object.entries(view.applicature ?? {})) {
    if (!Array.isArray(list)) continue;
    const s = list.slice(0, 4).filter(v => Array.isArray(v.frets) && v.frets.length === 6).map(v => [...v.frets].reverse().map(f => (f < 0 ? -1 : f)));
    if (s.length) shapes[name] = s;
  }
  return {
    body: {
      content,
      meta: { capo: meta.capo ?? null, key: meta.tonality || t.tonality_name || '', tuning: meta.tuning?.value || '', difficulty: t.difficulty || '' },
      shapes,
      strumming: (view.strummings ?? []).map(s => ({ part: s.part, bpm: s.bpm, denominator: s.denuminator, triplet: !!s.is_triplet, measures: (s.measures ?? []).map(m => m.measure) })),
      song: { title: t.song_name || '', artist: t.artist_name || '', version: t.version ?? null, rating: t.rating ?? null, votes: t.votes ?? null, id: t.id ?? null, type: t.type || '' },
    },
  };
}

async function youtube(q) {
  if (!q) return { status: 400, body: { error: 'Missing q param' } };
  const page = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, false);
  // the first real video in the search page's data
  const m = page.match(/var ytInitialData = (\{.+?\});<\/script>/s);
  if (m) {
    try {
      const d = JSON.parse(m[1]);
      const v = findVideo(d);
      if (v) return { body: v };
    } catch { /* fall back to the plain match below */ }
  }
  const id = page.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (id) return { body: { videoId: id[1], duration: null, title: '' } };
  return { status: 404, body: { error: 'No video found' } };
}

function findVideo(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (node.videoRenderer?.videoId) {
    const r = node.videoRenderer;
    return { videoId: r.videoId, duration: seconds(r.lengthText?.simpleText), title: r.title?.runs?.[0]?.text || '' };
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const found = findVideo(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function seconds(t) {
  if (!t) return null;
  const parts = String(t).split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

async function fetchText(url, ug = true) {
  const resp = await fetch(url, { headers: UG_HEADERS, cf: { cacheTtl: 300 } });
  if (!resp.ok) throw new Error(`${ug ? 'Ultimate Guitar' : 'YouTube'} returned HTTP ${resp.status}`);
  return resp.text();
}

function store(html) {
  // all page state is HTML-encoded JSON in data-content
  const match = html.match(/class="js-store"\s+data-content="([^"]+)"/);
  if (!match) throw new Error('Could not find js-store data on page — UG may have changed structure');
  return JSON.parse(decodeEntities(match[1]));
}

// One pass, every entity to its own character (a curly quote stays curly: a
// plain " would end the JSON string it's in, which is how the first worker
// broke on pages with quotes in a comment).
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const ENTITIES = {
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCharCode(160 + i)])),
  quot: '"', amp: '&', lt: '<', gt: '>', apos: "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„', ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  trade: '™', euro: '€', prime: '′', Prime: '″', dagger: '†', Dagger: '‡', permil: '‰', lsaquo: '‹', rsaquo: '›',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
};
function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

function corsFor(origin) {
  const ok = ALLOWED_ORIGINS.some(o => (typeof o === 'string' ? o === origin : o.test(origin)));
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
}

function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// for tests (tests/unit/worker.test.js)
export { search, tab, youtube, findVideo, seconds, decodeEntities, corsFor };
