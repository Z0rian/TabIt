// Real songs (the owner's library, fetched by tests/fetch_corpus.py into the
// gitignored tests/corpus/). Skipped when the corpus isn't there.
import { test, ok, eq } from '../harness.js';
import { parseSong } from '../../js/parse.js';
import { expectedAnchors } from '../align.js';

let corpus = null;
async function load() {
  if (corpus) return corpus;
  try {
    const index = await (await fetch('corpus/index.json')).json();
    corpus = [];
    for (const key of Object.keys(index)) {
      const rec = await (await fetch(`corpus/songs/${key}.json`)).json();
      if (rec.content) corpus.push({ key, rec });
    }
  } catch {
    corpus = [];
  }
  return corpus;
}

test('every corpus song parses, and every chord over a lyric is where the author put it', async () => {
  const songs = await load();
  if (!songs.length) return; // no local corpus
  const bad = [];
  let checked = 0;
  for (const { key, rec } of songs) {
    const doc = parseSong(rec.content);
    ok(doc.blocks.length > 0, `${key}: no blocks`);
    // index the parsed pairs by lyric text
    const byLyric = new Map();
    for (const b of doc.blocks) if (b.type === 'pair') {
      const list = byLyric.get(b.lyric.replace(/\s+$/, '')) || [];
      list.push(b);
      byLyric.set(b.lyric.replace(/\s+$/, ''), list);
    }
    for (const e of expectedAnchors(rec.content)) {
      const lyric = e.line.replace(/\s+$/, '');
      const pairs = byLyric.get(lyric);
      if (!pairs) { bad.push(`${key}: no pair for "${lyric.slice(0, 40)}"`); continue; }
      // (a suffix glued on outside the tag, "[ch]B[/ch]+", belongs to the chord)
      const hit = pairs.some(p => p.chords.some(c => c.name && c.name.startsWith(e.name) && (c.at === e.col || (c.at === e.col + 1 && lyric[e.col] === ' '))));
      checked++;
      if (!hit) bad.push(`${key}: ${e.name} expected at ${e.col} ("${lyric.slice(Math.max(0, e.col - 8), e.col)}|${lyric.slice(e.col, e.col + 8)}")`);
    }
  }
  ok(checked > 2000, `only ${checked} anchors checked`);
  eq(bad.length, 0, `${bad.length} misplaced chords, e.g.\n${bad.slice(0, 12).join('\n')}`);
});

test('corpus: no song has chords left in the lyric text or unparsed markup', async () => {
  const songs = await load();
  if (!songs.length) return;
  const bad = [];
  for (const { key, rec } of songs) {
    const doc = parseSong(rec.content);
    for (const b of doc.blocks) {
      const text = b.type === 'pair' ? b.lyric : b.type === 'lyric' ? b.text : '';
      if (/\[\/?ch\]|\[\/?tab\]/.test(text)) bad.push(`${key}: markup in "${text.slice(0, 50)}"`);
    }
  }
  eq(bad.length, 0, bad.slice(0, 8).join('\n'));
});
