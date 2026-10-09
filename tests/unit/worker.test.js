// The Cloudflare Worker's parsing, against fake Ultimate Guitar / YouTube pages.
import { test, eq, ok, deepEq } from '../harness.js';
import { search, tab, youtube, seconds, decodeEntities, corsFor } from '../../ug-proxy/worker.js';

const encode = obj => JSON.stringify(obj).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const page = data => `<html><body><div class="js-store" data-content="${encode({ store: { page: { data } } })}"></div></body></html>`;

async function withFetch(body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('worker: search keeps versions, key, cover', async () => {
  const html = page({ results: [
    { song_name: 'Song', artist_name: 'Band', type: 'Chords', rating: 4.8214, votes: 50, tab_url: 'https://tabs.ultimate-guitar.com/tab/band/song-chords-1', version: 2, id: 1, tonality_name: 'G', difficulty: 'novice', album_cover: { web_album_cover: { small: 'https://x/c.jpg' } } },
    { song_name: 'Song', artist_name: 'Band', type: 'Bass Tabs', tab_url: 'b' },
    { song_name: 'Official', type: undefined },
  ] });
  const r = await withFetch(html, () => search('song'));
  eq(r.body.results.length, 1);
  deepEq(r.body.results[0], { title: 'Song', artist: 'Band', type: 'Chords', rating: 4.82, votes: 50, url: 'https://tabs.ultimate-guitar.com/tab/band/song-chords-1', version: 2, id: 1, key: 'G', difficulty: 'novice', cover: 'https://x/c.jpg' });
  eq((await search('')).status, 400);
});

test('worker: tab returns text, capo, key, tuning, shapes (low E first), strumming', async () => {
  const html = page({
    tab: { song_name: 'Song', artist_name: 'Band', version: 3, rating: 4.9, votes: 10, id: 7, type: 'Chords', tonality_name: 'G', difficulty: 'intermediate' },
    tab_view: {
      wiki_tab: { content: '[tab][ch]G[/ch]\nla & la[/tab]' },
      meta: { capo: 2, tonality: 'G', tuning: { value: 'Eb Ab Db Gb Bb Eb' } },
      applicature: { C: [{ frets: [3, 5, 5, 5, 3, -1] }], bad: 'x' },
      strummings: [{ part: 'Verse', bpm: 120, denuminator: 8, is_triplet: 0, measures: [{ measure: 1 }, { measure: 101 }] }],
    },
  });
  const r = await withFetch(html, () => tab('https://tabs.ultimate-guitar.com/tab/band/song-chords-7'));
  eq(r.body.content, '[tab][ch]G[/ch]\nla & la[/tab]');
  deepEq(r.body.meta, { capo: 2, key: 'G', tuning: 'Eb Ab Db Gb Bb Eb', difficulty: 'intermediate' });
  deepEq(r.body.shapes, { C: [[-1, 3, 5, 5, 5, 3]] });
  deepEq(r.body.strumming, [{ part: 'Verse', bpm: 120, denominator: 8, triplet: false, measures: [1, 101] }]);
  eq(r.body.song.version, 3);
  eq((await tab('https://evil.example.com/x')).status, 400, 'only ultimate-guitar.com');
});

test('worker: YouTube search gets the first video and its length', async () => {
  const data = { contents: { list: [{ adSlot: {} }, { videoRenderer: { videoId: 'Lw7Q19mtly0', lengthText: { simpleText: '3:52' }, title: { runs: [{ text: 'Song (Official)' }] } } }] } };
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  const r = await withFetch(html, () => youtube('song'));
  deepEq(r.body, { videoId: 'Lw7Q19mtly0', duration: 232, title: 'Song (Official)' });
  eq(seconds('1:02:03'), 3723);
  eq(seconds(''), null);
});

// what Ultimate Guitar really sends: every character it has a name for as an
// entity, curly quotes too, and readers' comments on the same page
const ugEncode = obj => encode(obj).replace(/[“”‘’éñÉ]/g, c => ({ '“': '&ldquo;', '”': '&rdquo;', '‘': '&lsquo;', '’': '&rsquo;', 'é': '&eacute;', 'ñ': '&ntilde;', 'É': '&Eacute;' })[c]);

test('worker: a page with curly quotes in a comment, and accented names', async () => {
  const data = {
    tab: { song_name: 'Café', artist_name: 'Niño', type: 'Chords', version: 1 },
    tab_view: { wiki_tab: { content: '[ch]G[/ch]\nIt’s “here”' }, comments: [{ text: 'Lyrics are off. It’s “learnin’ that the le…”' }] },
  };
  const html = `<div class="js-store" data-content="${ugEncode({ store: { page: { data } } })}"></div>`;
  const r = await withFetch(html, () => tab('https://tabs.ultimate-guitar.com/tab/nino/cafe-chords-1'));
  ok(!r.body.error, r.body.error);
  eq(r.body.content, '[ch]G[/ch]\nIt’s “here”');
  deepEq([r.body.song.title, r.body.song.artist], ['Café', 'Niño']);
  eq(decodeEntities('&Eacute;&eacute;&ntilde; &hellip; &bogus; &#233;&#xE9;'), 'Ééñ … &bogus; éé');
});

test('worker: entities and CORS', () => {
  eq(decodeEntities('a &amp; b &quot;c&quot; &#039;d&#039; &#x41;'), 'a & b "c" \'d\' A');
  ok(corsFor('https://z0rian.github.io')['Access-Control-Allow-Origin']);
  ok(corsFor('http://localhost:8090')['Access-Control-Allow-Origin']);
  deepEq(corsFor('https://evil.example.com'), {});
});
