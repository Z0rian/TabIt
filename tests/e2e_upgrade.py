"""Upgrading a phone that has the old TabIt: the old app (from git history)
runs first, with songs saved its way and its service worker caching it; then
the new app is "deployed" at the same address. Within a reload or two the new
app must be running, with the old songs brought over, and other apps' caches on
the same site left alone.

    python tests/e2e_upgrade.py OLD_CHECKOUT_DIR
    (e.g. git worktree add ../tabit-old 629037d)
"""
import functools
import http.server
import os
import sys
import threading
import time

from playwright.sync_api import sync_playwright

from util import ROOT, free_port, context_for, launch

sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import serve  # noqa: E402

OLD_SONGS = """localStorage.setItem('tabit_songs_v3', JSON.stringify([
  { id: 1720000000000, title: 'Old Favorite', artist: 'Somebody', key: 'G', capo: 2, tempo: 100, liked: true, cover: null,
    content: '[Verse 1]\\n     [G]        [D]\\nThese words are from the old app' },
  { id: 1720000500000, title: 'Another Old One', artist: 'Somebody Else', key: 'C', capo: 0, tempo: 92, liked: false, cover: null,
    content: '[C]Inline [G]chords from [Am]before' },
]));
localStorage.setItem('tabit_theme_v2', 'dark');"""


class Switchable:
    """One port, and the folder it serves can be swapped (a 'deploy')."""
    def __init__(self, root):
        self.root = root
        self.port = free_port()
        outer = self

        class H(serve.Handler):
            def __init__(self, *a, **k):
                super().__init__(*a, directory=outer.root, **k)

            def end_headers(self):
                # like GitHub Pages: short caching, not no-store
                self.send_header('Cache-Control', 'max-age=0, must-revalidate')
                http.server.SimpleHTTPRequestHandler.end_headers(self)

        self.httpd = serve.Server(('127.0.0.1', self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f'http://localhost:{self.port}'


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def main():
    old_dir = sys.argv[1]
    site = Switchable(old_dir)
    with sync_playwright() as p:
        b = launch(p, 'chromium')
        ctx = context_for(p, b, 'pixel-7')
        page = ctx.new_page()
        print('the old app, with songs saved its way')
        page.goto(site.base + '/')
        page.wait_for_function("document.body.innerText.includes('TabIt')", timeout=30000)
        page.evaluate(OLD_SONGS)
        # another app on the same site keeps its caches
        page.evaluate("caches.open('ranch-app-123').then(c => c.put('/ranch-test', new Response('ranch')))")
        for _ in range(40):
            if page.evaluate("navigator.serviceWorker.controller !== null"):
                break
            page.reload()
            time.sleep(0.5)
        check(page.evaluate("caches.keys()").count('tabit-v2') == 1, 'the old service worker cached the old app')

        print('deploy the new app at the same address')
        site.root = ROOT
        new_app = False
        for attempt in range(6):
            page.reload()
            time.sleep(2)
            if page.evaluate("!!document.querySelector('.app .tabbar')"):
                new_app = True
                break
        check(new_app, f'the new app runs after {attempt + 1} reload(s)')
        page.wait_for_selector('.row', timeout=10000)
        titles = page.locator('.row-title').all_inner_texts()
        check(sorted(titles) == ['Another Old One', 'Old Favorite'], f'the old songs came over: {titles}')
        page.get_by_text('Old Favorite').click()
        page.wait_for_selector('.sheet .pair')
        cn = page.locator('.sheet .pair .cn').all_inner_texts()
        check(cn == ['G', 'D'], f'with their chords in the right places ({cn})')
        fav = page.evaluate("async () => Object.values((await import('./js/store.js')).store.lib.songs).find(s => s.title === 'Old Favorite')")
        check(fav.get('fav') is True and fav.get('capo') == 2, 'favorite and capo kept')
        check(page.evaluate("document.documentElement.dataset.theme") == 'dark', 'the dark theme was kept')
        keys = page.evaluate("caches.keys()")
        check('tabit-v2' not in keys and any(k.startswith('tabit-app-') for k in keys), f'old cache replaced ({keys})')
        check('ranch-app-123' in keys, 'the other app\'s cache is untouched')
        b.close()
    print('Upgrading from the old app works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
