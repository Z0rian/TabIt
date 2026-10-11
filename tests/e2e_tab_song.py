"""Tabs, used like a person would, on a phone and a laptop: search Ultimate
Guitar, show only its tabs, open one, read it, autoscroll it, save it. The
proxy's answers come from the local tabs (tests/corpus/tabs, see
fetch_tabs.py), so nothing goes over the network.

    python tests/e2e_tab_song.py
"""
import glob
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright, expect

from util import ROOT, context_for, launch, start_server

PROXY = 'https://ug-proxy.zorian.workers.dev'
TUNE = 'foggy-mountain-breakdown'

CHECK = """async () => {
  const { checkTabs } = await import('/tests/tabcheck.js');
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return checkTabs(document.querySelector('.sheet'));
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def run(engine, device, base, tabs):
    by_url = {t['result']['url']: t for t in tabs}
    tab_results = [t['result'] for t in tabs]
    first = tab_results[0]
    # what Ultimate Guitar lists for the tune: its tabs, a chords version, a Guitar Pro file, and a song only in Guitar Pro
    results = tab_results + [
        {**first, 'type': 'Chords', 'url': first['url'].replace('-tabs-', '-chords-'), 'version': 1, 'votes': 3},
        {**first, 'type': 'Pro', 'url': first['url'].replace('-tabs-', '-guitar-pro-'), 'version': 1},
        {**first, 'title': 'Something Else', 'type': 'Pro', 'url': 'https://tabs.ultimate-guitar.com/tab/x/something-else-guitar-pro-1'},
    ]

    def proxy(route):
        url = route.request.url
        if 'action=search' in url:
            body = {'results': results}
        elif 'action=tab' in url:
            from urllib.parse import urlparse, parse_qs
            t = by_url.get(parse_qs(urlparse(url).query)['url'][0])
            body = {k: t[k] for k in ('content', 'meta', 'song')} if t else {'content': '[ch]G[/ch]\nA chords version'}
        else:
            body = {'error': 'No video found'}
        route.fulfill(content_type='application/json', body=json.dumps(body))

    with sync_playwright() as p:
        b = launch(p, engine)
        ctx = context_for(p, b, device)
        ctx.route(PROXY + '/**', proxy)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        print(f'[{device}] searching')
        box = page.get_by_placeholder('Search your songs or Ultimate Guitar')
        box.fill('foggy mountain breakdown')
        box.press('Enter')
        expect(page.locator('.result-ver .ver-btn').first).to_be_visible(timeout=10000)
        labels = page.locator('.result-ver .ver-btn').all_inner_texts()
        check(any(l.startswith('Chords 1') for l in labels) and sum(l.startswith('Tab ') for l in labels) >= 3, f'chords and tab versions side by side ({len(labels)} buttons)')
        check(not any('Pro' in l for l in labels), 'no Guitar Pro buttons')
        expect(page.get_by_text('only on Ultimate Guitar as Guitar Pro files')).to_be_visible()
        check(True, 'a song only in Guitar Pro is mentioned, not listed')
        page.locator('.ug-types').get_by_role('button', name='Tabs').click()
        labels = page.locator('.result-ver .ver-btn').all_inner_texts()
        check(labels and all(l.startswith('Tab ') for l in labels), f'“Tabs” shows only tabs ({len(labels)})')

        print(f'[{device}] a tab')
        page.locator('.result-ver .ver-btn').first.click()
        page.wait_for_selector('.sheet .tab .sys', timeout=10000)
        r = page.evaluate(CHECK)
        check(not r['problems'], f"{r['stats']['staves']} staves laid out right ({r['stats']['oneRow']} on one row)")
        meta = page.locator('.song-meta').inner_text()
        check('Transpose' not in meta and 'UG tab ver' in meta, f'no Transpose for a tab, and it says it’s a tab ({meta.strip()!r})')
        check(page.locator('.chord-strip').is_hidden(), 'no empty chord diagrams strip')
        page.get_by_role('button', name='Display: transpose, capo, size').click()
        tools = page.locator('.drawer').inner_text()
        check('Text size' in tools and 'Transpose' not in tools and 'Simplify' not in tools, 'its display menu has only what applies')
        page.keyboard.press('Escape')
        expect(page.locator('.drawer')).to_have_count(0)

        # autoscroll plays through it (and scrolls, where the tab is longer than the screen)
        y0 = page.evaluate('scrollY')
        room = page.evaluate('document.scrollingElement.scrollHeight - innerHeight')
        page.locator('.deck .play').click(force=True)
        time.sleep(6)  # (on a big screen the first staff starts above the reading line: it waits for it)
        page.locator('.deck .play').click(force=True)
        played = page.locator('.deck-time').inner_text()
        check(not played.startswith('0:00'), f'autoscroll plays ({played.split("/")[0].strip()} in)')
        if room > 200:
            check(page.evaluate('scrollY') > y0, 'and moves down the tab')

        # saved, it's a tab in the library
        page.locator('.song-bar').get_by_role('button', name='Save').click()
        expect(page.get_by_role('button', name='Favorite')).to_be_visible(timeout=5000)
        kind = page.evaluate("async () => Object.values((await import('/js/store.js')).store.lib.songs)[0]?.kind")
        check(kind == 'tab', 'saved as a tab')
        page.goto(base + '/#/')
        page.locator('.search .clear').click()
        expect(page.locator('.row', has_text='Foggy Mountain Breakdown').locator('.row-sub')).to_contain_text('Tab')
        check(True, 'the library says “Tab”')
        if errors:
            raise AssertionError(errors)
        b.close()


def main():
    files = sorted(glob.glob(os.path.join(ROOT, 'tests', 'corpus', 'tabs', f'{TUNE}-tabs-*.json')))
    if not files:
        print(f'No {TUNE} tabs in tests/corpus/tabs. Run tests/fetch_tabs.py first.')
        sys.exit(1)
    tabs = [json.load(open(f, encoding='utf-8')) for f in files]
    tabs.sort(key=lambda t: -(t['result'].get('votes') or 0))
    base = start_server()
    run('webkit', 'iphone-15', base, tabs)
    run('chromium', 'laptop', base, tabs)
    print('Tabs work.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
