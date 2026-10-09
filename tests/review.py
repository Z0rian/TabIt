"""Screenshots of every screen for a design review, on several devices and themes.

    python tests/review.py                       # all
    python tests/review.py iphone-15 --only song,library --themes dark

Writes tests/out/review/<device>-<theme>-<screen>.png
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

from util import ROOT, context_for, launch, DEVICES, start_server

OUT = os.path.join(ROOT, 'tests', 'out', 'review')

SEED = """async (n) => {
  const store = await import('/js/store.js');
  const ug = await import('/js/ug.js');
  const model = await import('/js/model.js');
  const index = await (await fetch('/tests/corpus/index.json')).json();
  const ops = [];
  let i = 0;
  for (const k of Object.keys(index).slice(0, n)) {
    const rec = await (await fetch('/tests/corpus/songs/' + k + '.json')).json();
    if (!rec.content) continue;
    const meta = rec.meta || {};
    const song = ug.songFromTab(rec.fallback || rec.match, { content: rec.content, meta: { capo: meta.capo, tonality: meta.tonality, tuning: meta.tuning }, applicature: rec.applicature, strummings: rec.strummings }, { id: 's-' + (i++), fav: i % 3 !== 0 || undefined, added: rec.entry.date, played: i < 6 ? new Date(Date.now() - i * 3600e3).toISOString() : undefined });
    ops.push({ t: 'add', song });
  }
  ops.push({ t: 'list', id: 'l-1', set: { name: 'Friday at the Grange', songs: ['s-1', 's-3', 's-5', 's-8'], created: new Date().toISOString() } });
  store.dispatch({ t: 'many', ops });
  return ops.length;
}"""

SCREENS = {
    'library': ('#/', None),
    'artists': ('#/', "document.querySelector('.seg button:nth-child(4)').click()"),
    'search': ('#/', "const i = document.querySelector('.search input'); i.value = 'zach'; i.dispatchEvent(new Event('input'))"),
    'setlist': ('#/?list=l-1', None),
    'song': ('#/song/s-1', None),
    'song-scrolled': ('#/song/s-1', "scrollTo(0, 900)"),
    'chord': ('#/song/s-1', "document.querySelector('.sheet .pair .cn').click()"),
    'tools': ('#/song/s-1', "document.querySelector('[aria-label^=\"Display\"]').click()"),
    'more': ('#/song/s-1', "document.querySelector('[aria-label=\"More\"]').click()"),
    'chords': ('#/chords', None),
    'tuner': ('#/tuner', None),
    'settings': ('#/settings', None),
    'import': ('#/import', None),
    'editor': ('#/edit/s-2', None),
    'empty': ('#/', 'EMPTY'),
}


def main():
    args = sys.argv[1:]
    only = None
    themes = ['light', 'dark']
    if '--only' in args:
        i = args.index('--only'); only = args[i + 1].split(','); del args[i:i + 2]
    if '--themes' in args:
        i = args.index('--themes'); themes = args[i + 1].split(','); del args[i:i + 2]
    devices = args or ['iphone-15', 'ipad-pro-11', 'laptop']
    os.makedirs(OUT, exist_ok=True)
    base = start_server()
    with sync_playwright() as p:
        browsers = {}
        for dev in devices:
            engine = DEVICES[dev][0]
            browsers.setdefault(engine, launch(p, engine))
            for theme in themes:
                ctx = context_for(p, browsers[engine], dev, color_scheme='dark' if theme != 'light' else 'light')
                page = ctx.new_page()
                page.goto(base + '/#/')
                page.wait_for_selector('main .page')
                if theme == 'black':
                    page.evaluate("localStorage.setItem('tabit.prefs', JSON.stringify({ theme: 'black' }))")
                page.evaluate(SEED, 24)
                time.sleep(0.5)
                for name, (route, action) in SCREENS.items():
                    if only and name not in only:
                        continue
                    if action == 'EMPTY':
                        ctx2 = context_for(p, browsers[engine], dev, color_scheme='dark' if theme != 'light' else 'light')
                        pg2 = ctx2.new_page()
                        pg2.goto(base + '/#/')
                        pg2.wait_for_selector('main .page')
                        time.sleep(0.6)
                        pg2.screenshot(path=os.path.join(OUT, f'{dev}-{theme}-{name}.png'))
                        ctx2.close()
                        continue
                    page.goto(base + '/' + route)
                    page.wait_for_selector('main .page, main .song', timeout=10000)
                    time.sleep(0.5)
                    if action:
                        page.evaluate(action)
                        time.sleep(0.7)
                    page.screenshot(path=os.path.join(OUT, f'{dev}-{theme}-{name}.png'))
                    page.keyboard.press('Escape') if action and ('click' in action) else None
                print(f'{dev} {theme} done')
                ctx.close()
        for b in browsers.values():
            b.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
