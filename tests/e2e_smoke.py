"""Opens every screen of the real app on a phone and a laptop and reports any
error in the console. With the local corpus it first loads songs into the
library (through the app's own import code), so the screens have content.

    python tests/e2e_smoke.py
    python tests/e2e_smoke.py --shots      # also save screenshots to tests/out/
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

from util import ROOT, context_for, launch, start_server

ROUTES = ['#/', '#/?filter=artists', '#/chords', '#/tuner', '#/settings', '#/import', '#/edit/new']

SEED = """async (n) => {
  const store = await import('/js/store.js');
  const ug = await import('/js/ug.js');
  const index = await (await fetch('/tests/corpus/index.json')).json();
  const keys = Object.keys(index).slice(0, n);
  const ops = [];
  for (const k of keys) {
    const rec = await (await fetch('/tests/corpus/songs/' + k + '.json')).json();
    if (!rec.content) continue;
    const meta = rec.meta || {};
    const song = ug.songFromTab(rec.match, { content: rec.content, meta: { capo: meta.capo, tonality: meta.tonality, tuning: meta.tuning }, applicature: rec.applicature, strummings: rec.strummings }, { fav: true, added: rec.entry.date });
    ops.push({ t: 'add', song });
  }
  store.dispatch({ t: 'many', ops });
  return ops.length;
}"""


def visible_text(page):
    return page.evaluate("() => (document.querySelector('main')?.innerText || '').slice(0, 140).split('\\n').join(' | ')")


def main():
    shots = '--shots' in sys.argv
    base = start_server()
    out = os.path.join(ROOT, 'tests', 'out')
    os.makedirs(out, exist_ok=True)
    failures = 0
    with sync_playwright() as p:
        for engine, dev in [('webkit', 'iphone-15'), ('chromium', 'laptop')]:
            browser = launch(p, engine)
            ctx = context_for(p, browser, dev)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
            page.goto(base + '/?mock#/')
            page.wait_for_selector('main', timeout=15000)
            n = page.evaluate(SEED, 40) if os.path.exists(os.path.join(ROOT, 'tests', 'corpus', 'index.json')) else 0
            print(f'[{dev}] seeded {n} songs')
            time.sleep(0.5)  # the library is written to IndexedDB a moment later
            for route in ROUTES:
                page.goto(base + '/?mock' + route)
                time.sleep(0.9)
                print(f'[{dev}] {route:18} {visible_text(page)}')
                if shots:
                    page.screenshot(path=os.path.join(out, f'app-{dev}-{route.strip("#/").replace("/", "_").replace("?", "_") or "library"}.png'))
            # open the first song
            page.goto(base + '/?mock#/')
            time.sleep(0.6)
            page.locator('.row').first.click()
            time.sleep(1.2)
            print(f'[{dev}] song: {visible_text(page)}')
            if shots:
                page.screenshot(path=os.path.join(out, f'app-{dev}-song.png'))
            for e in errors:
                print(f'   {e}')
            failures += len(errors)
            browser.close()
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
