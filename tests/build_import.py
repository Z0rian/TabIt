"""Turns the local corpus (your Tabs & Chords favorites, fetched with full
Ultimate Guitar data) into a TabIt backup file you can open in the app
(Library → + → Open a TabIt backup). Uses the app's own code to build the songs.

    python tests/build_import.py "C:/path/TabIt favorites.json"

The file holds song text: keep it private (it's written outside the repo by default).
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

from util import ROOT, launch, start_server

BUILD = """async () => {
  const ug = await import('/js/ug.js');
  const index = await (await fetch('/tests/corpus/index.json')).json();
  const songs = [];
  const seen = new Set();
  for (const k of Object.keys(index)) {
    const rec = await (await fetch('/tests/corpus/songs/' + k + '.json')).json();
    if (!rec.content) continue;
    const result = { ...(rec.fallback || rec.match), cover: rec.cover || '' };
    if (!result || seen.has(result.url)) continue;
    seen.add(result.url);
    const meta = rec.meta || {};
    const tab = { content: rec.content, meta: { capo: meta.capo, tonality: meta.tonality, tuning: meta.tuning }, applicature: rec.applicature, strummings: rec.strummings };
    const song = ug.songFromTab(result, tab, { fav: true, added: rec.entry.date });
    songs.push(song);
  }
  return JSON.stringify({ app: 'tabit', v: 1, exported: new Date().toISOString(), note: 'Tabs & Chords favorites with their Ultimate Guitar versions, capo, key, tuning and chord shapes.', songs, setlists: [] }, null, 1);
}"""


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), 'TabIt favorites (import me).json')
    base = start_server()
    with sync_playwright() as p:
        b = launch(p, 'chromium')
        page = b.new_page()
        page.goto(base + '/tests/unit.html?filter=__none__')
        text = page.evaluate(BUILD)
        b.close()
    data = json.loads(text)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(text)
    capo = sum(1 for s in data['songs'] if s.get('capo'))
    shapes = sum(1 for s in data['songs'] if s.get('shapes'))
    print(f"{len(data['songs'])} songs ({capo} with a capo, {shapes} with the author's chord shapes) → {out}")


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
