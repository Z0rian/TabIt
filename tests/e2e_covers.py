"""Album covers: songs without one get it in the background (Ultimate
Guitar's first, else Apple's iTunes catalog, which are stood in for here),
it shows in the library and on the song, and one removed by hand isn't looked
up again.

    python tests/e2e_covers.py
"""
import base64
import json
import sys
import time
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect

from util import context_for, launch, start_server

PROXY = 'https://ug-proxy.zorian.workers.dev'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
UG_URL = 'https://tabs.ultimate-guitar.com/tab/darius-rucker/wagon-wheel-chords-1'
UG_COVER = 'https://covers.test/ug/wagon-wheel.png'

SEED = """async () => {
  const store = await import('/js/store.js');
  const model = await import('/js/model.js');
  store.dispatch({ t: 'many', ops: [
    { t: 'add', song: model.makeSong({ id: 's-ug', title: 'Wagon Wheel', artist: 'Darius Rucker', content: '[ch]G[/ch]\\nHeading down south', src: { site: 'ug', url: '%s', type: 'Chords' } }) },
    { t: 'add', song: model.makeSong({ id: 's-it', title: 'Porch Light', artist: 'Ana Example', content: '[ch]E[/ch]\\nLeave it on' }) },
    { t: 'add', song: model.makeSong({ id: 's-none', title: 'Mystery Tune', artist: 'Nobody Knows', content: '[ch]C[/ch]\\nla la' }) },
  ] });
}""" % UG_URL

COVERS = "async () => Object.fromEntries(Object.values((await import('/js/store.js')).store.lib.songs).map(s => [s.id, s.cover || null]))"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def wait_for(page, fn, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = page.evaluate(COVERS)
        if fn(v):
            return v
        time.sleep(0.5)
    raise AssertionError(f'gave up waiting: {page.evaluate(COVERS)}')


def main():
    base = start_server()
    asked = {'ug': 0, 'itunes': 0}

    def proxy(route):
        q = parse_qs(urlparse(route.request.url).query)
        asked['ug'] += 1
        hit = 'darius rucker' in q.get('q', [''])[0].lower()
        res = [{'title': 'Wagon Wheel', 'artist': 'Darius Rucker', 'type': 'Chords', 'url': UG_URL, 'rating': 4.8, 'votes': 100, 'version': 1, 'cover': UG_COVER}] if hit else []
        route.fulfill(content_type='application/json', body=json.dumps({'results': res}))

    def itunes(route):
        asked['itunes'] += 1
        term = parse_qs(urlparse(route.request.url).query).get('term', [''])[0].lower()
        res = [{'trackName': 'Porch Light', 'artistName': 'Ana Example', 'collectionName': 'Porch Songs', 'artworkUrl100': 'https://covers.test/it/porch/100x100bb.png'},
               {'trackName': 'Porch Light', 'artistName': 'Karaoke Crew', 'collectionName': 'Karaoke Night', 'artworkUrl100': 'https://covers.test/it/karaoke/100x100bb.png'}] if 'ana example' in term else []
        route.fulfill(content_type='text/javascript', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps({'resultCount': len(res), 'results': res}))

    with sync_playwright() as p:
        for engine, device in [('chromium', 'laptop'), ('webkit', 'iphone-15')]:
            b = launch(p, engine)
            ctx = context_for(p, b, device)
            ctx.route(PROXY + '/**', proxy)
            ctx.route('https://itunes.apple.com/**', itunes)
            ctx.route('https://covers.test/**', lambda r: r.fulfill(content_type='image/png', body=PNG))
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            print(f'[{device}]')
            page.goto(base + '/?covers#/')
            page.wait_for_selector('main .page')
            page.evaluate(SEED)
            got = wait_for(page, lambda v: v.get('s-ug') and v.get('s-it'))
            check(got['s-ug'] == UG_COVER, 'a song from Ultimate Guitar gets its cover from there')
            check(got['s-it'] == 'https://covers.test/it/porch/300x300bb.png', 'another gets the right artist’s cover from iTunes (not the karaoke one), at 300 px')
            # (the third song's turn comes a couple of seconds later)
            page.wait_for_function("'s-none' in JSON.parse(localStorage.getItem('tabit.covers.tried') || '{}')", timeout=20000)
            check(page.evaluate(COVERS)['s-none'] is None, 'a song with no cover anywhere stays without one')
            check(True, 'and isn’t looked up again for a while')
            expect(page.locator('.row-art img')).to_have_count(2, timeout=5000)
            check(page.locator('.row', has_text='Mystery Tune').locator('.row-art').inner_text().strip() == 'NK', 'the library shows the covers, and initials where there’s none')

            page.goto(base + '/?covers#/song/s-ug')
            expect(page.locator('.song-art img')).to_have_attribute('src', UG_COVER)
            check(True, 'the song page shows its cover beside the title')
            page.get_by_role('button', name='More').click()
            page.get_by_text('Remove the album cover').click()
            expect(page.locator('.song-art img')).to_have_count(0)
            check(page.evaluate(COVERS)['s-ug'] == 'none', 'a wrong cover can be removed')
            n = asked['ug']
            page.goto(base + '/?covers#/')
            page.wait_for_selector('main .page')
            time.sleep(8)
            check(page.evaluate(COVERS)['s-ug'] == 'none' and asked['ug'] == n, 'and it isn’t looked up again')
            page.goto(base + '/?covers#/song/s-ug')
            page.get_by_role('button', name='More').click()
            page.get_by_text('Find the album cover').click()
            expect(page.locator('.song-art img')).to_have_attribute('src', UG_COVER, timeout=10000)
            check(True, '“Find the album cover” brings it back on request')
            if errors:
                raise AssertionError(errors)
            b.close()
    print('Album covers work.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
