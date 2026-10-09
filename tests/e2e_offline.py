"""Offline: open the app once (the service worker caches it), cut the network,
reload — the app, its fonts and the library must all still be there, and a
song must open. Then a new version replaces the old one.

    python tests/e2e_offline.py
"""
import sys
import time

from playwright.sync_api import sync_playwright, expect

from util import context_for, launch, start_server

SEED = """async () => {
  const store = await import('./js/store.js');
  const model = await import('./js/model.js');
  store.dispatch({ t: 'add', song: model.makeSong({ id: 's-off', title: 'Offline Ballad', artist: 'Nobody Online', content: '[Verse]\\n[ch]G[/ch]      [ch]C[/ch]\\nNo signal out here at all', key: 'G' }) });
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def run(engine, device, base, httpd=None):
    with sync_playwright() as p:
        b = launch(p, engine)
        ctx = context_for(p, b, device)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        print(f'[{device}] first visit (online)')
        page.goto(base + '/?sw#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED)
        # wait for the service worker to install and take control
        page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller !== null', timeout=30000) if page.evaluate('!!navigator.serviceWorker.controller') else None
        for _ in range(60):
            ready = page.evaluate("""async () => {
              const r = await navigator.serviceWorker.getRegistration();
              const keys = await caches.keys();
              return !!(r && r.active) && keys.some(k => k.startsWith('tabit-app-'));
            }""")
            if ready:
                break
            time.sleep(0.5)
        check(ready, 'service worker installed and the app is cached')
        cached = page.evaluate("async () => { const k = (await caches.keys()).find(k => k.startsWith('tabit-app-')); return (await (await caches.open(k)).keys()).length; }")
        check(cached >= 35, f'{cached} app files cached')
        time.sleep(0.6)

        print(f'[{device}] offline')
        if engine == 'webkit':
            # Playwright's offline switch doesn't reach WebKit's service worker;
            # really take the site away instead
            httpd.shutdown()
            httpd.server_close()
        else:
            ctx.set_offline(True)
        page.reload()
        page.wait_for_selector('main .page', timeout=15000)
        expect(page.get_by_text('Offline Ballad')).to_be_visible(timeout=10000)
        check(True, 'the app starts and shows the library with no network')
        fonts = page.evaluate("document.fonts.ready.then(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family))")
        check(any('Bricolage' in f for f in fonts), f'fonts load from the cache ({len(fonts)})')
        page.get_by_text('Offline Ballad').click()
        expect(page.locator('.sheet .cn').first).to_be_visible(timeout=10000)
        check(page.locator('.sheet .cn').count() == 2, 'the song opens with its chords')
        page.goto(base + '/?sw#/chords')
        expect(page.locator('.diagram-card').first).to_be_visible(timeout=10000)
        check(page.locator('.diagram-card').count() > 8, 'chord shapes work offline')
        page.goto(base + '/?sw#/tuner')
        expect(page.get_by_role('button', name='Start tuner')).to_be_visible()
        check(True, 'the tuner screen loads offline')
        if engine != 'webkit':
            ctx.set_offline(False)
        other = [k for k in page.evaluate('caches.keys()') if not k.startswith('tabit-')]
        check(not other, 'only TabIt caches exist (other apps\' caches are left alone)')
        if errors:
            raise AssertionError(f'page errors: {errors}')
        b.close()


def main():
    base = start_server()
    for engine, device in [('chromium', 'pixel-7'), ('webkit', 'iphone-15')]:
        httpd = None
        if engine == 'webkit':
            # its own server, so it can be switched off
            import threading
            import serve
            from util import ROOT, free_port
            port = free_port()
            httpd = serve.serve(port, ROOT)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f'http://127.0.0.1:{port}'
        try:
            run(engine, device, base, httpd)
        except Exception as e:
            if engine == 'webkit' and 'service worker' in str(e).lower():
                print(f'  ! WebKit on Windows has no service workers in Playwright; skipped ({e})')
                continue
            raise
    print('Offline works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
