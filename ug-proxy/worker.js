/**
 * TabIt — Ultimate Guitar CORS Proxy
 * Cloudflare Worker
 *
 * Endpoints:
 *   ?action=search&q=QUERY      → search results JSON
 *   ?action=tab&url=TAB_URL     → tab content JSON
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    try {
      // ── SEARCH ────────────────────────────────────────────────────────────
      if (action === 'search') {
        const q = url.searchParams.get('q');
        if (!q) return json({ error: 'Missing q param' }, 400);

        const searchUrl = `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(q)}`;
        const html = await fetchUG(searchUrl);
        const store = extractStore(html);

        const raw = store?.store?.page?.data?.results ?? [];
        const results = raw
          .filter(r => r.type === 'Chords' || r.type === 'Tab' || r.type === 'Pro')
          .map(r => ({
            title: r.song_name ?? '',
            artist: r.artist_name ?? '',
            type: r.type ?? '',
            rating: +(r.rating ?? 0).toFixed(2),
            votes: r.votes ?? 0,
            url: r.tab_url ?? '',
          }));

        return json({ results });
      }

      // ── FETCH TAB ─────────────────────────────────────────────────────────
      if (action === 'tab') {
        const tabUrl = url.searchParams.get('url');
        if (!tabUrl) return json({ error: 'Missing url param' }, 400);

        const html = await fetchUG(tabUrl);
        const store = extractStore(html);

        // UG nests the content a few different ways depending on tab type
        const pageData = store?.store?.page?.data ?? {};
        const content =
          pageData?.tab_view?.wiki_tab?.content ??
          pageData?.tab?.content ??
          '';

        if (!content) return json({ error: 'Tab content not found on page' }, 404);
        return json({ content });
      }

      return json({ error: 'Unknown action. Use action=search or action=tab' }, 400);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchUG(url) {
  const resp = await fetch(url, { headers: UG_HEADERS });
  if (!resp.ok) throw new Error(`UG returned HTTP ${resp.status} for ${url}`);
  return resp.text();
}

function extractStore(html) {
  // UG embeds all page state as HTML-entity-encoded JSON in data-content
  const match = html.match(/class="js-store"\s+data-content="([^"]+)"/);
  if (!match) throw new Error('Could not find js-store data on page — UG may have changed structure');
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&hellip;/g, '...')
    .replace(/&nbsp;/g, ' ');
  return JSON.parse(decoded);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
