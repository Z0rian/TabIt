"""Getting around the library like a person would, on a phone and a laptop:
a search is a step of its own (Back from a song goes back to its results,
Back again or the Library tab leaves it, the clear button doesn't leave an
empty step behind), and the favorites played in shuffled order.

    python tests/e2e_library_nav.py
"""
import sys
import time

from playwright.sync_api import sync_playwright, expect

from util import context_for, launch, start_server

SONGS = [
    {'id': 's-sun', 'title': 'Sunrise Waltz', 'artist': 'The Testers', 'content': '[ch]G[/ch]\nMorning comes slow', 'fav': True},
    {'id': 's-river', 'title': 'River Bend', 'artist': 'The Testers', 'content': '[ch]D[/ch]\nDown by the water', 'fav': True},
    {'id': 's-road', 'title': 'Highway Hymn', 'artist': 'Ana Example', 'content': '[ch]Am[/ch]\nMiles of road', 'fav': True},
    {'id': 's-porch', 'title': 'Porch Light', 'artist': 'Ana Example', 'content': '[ch]E[/ch]\nLeave it on', 'fav': True},
    {'id': 's-rain', 'title': 'Rain Song', 'artist': 'Nobody', 'content': '[ch]C[/ch]\nDrip drop'},
]
FAVS = {s['id'] for s in SONGS if s.get('fav')}

SEED = """async (songs) => {
  const store = await import('/js/store.js');
  const model = await import('/js/model.js');
  store.dispatch({ t: 'many', ops: songs.map(s => ({ t: 'add', song: model.makeSong(s) })) });
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def hash_of(page):
    return page.evaluate('location.hash')


def settle(page):
    time.sleep(0.35)


def run(engine, device, base):
    with sync_playwright() as p:
        b = launch(p, engine)
        ctx = context_for(p, b, device)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, SONGS)
        page.evaluate("async () => (await import('/js/prefs.js')).prefs.set('filter', 'all')")
        page.goto(base + '/#/?x=1')
        page.goto(base + '/#/')
        page.wait_for_selector('.row')
        box = page.get_by_placeholder('Search your songs or Ultimate Guitar')
        library_tab = page.locator('.tabbar .tab-btn', has_text='Library')

        print(f'[{device}] a search is a step of its own')
        box.fill('sun')
        settle(page)
        check(hash_of(page) == '#/?q=sun', 'typing makes the search part of the address')
        expect(page.locator('.list .row', has_text='Sunrise Waltz')).to_be_visible()
        page.locator('.list .row', has_text='Sunrise Waltz').click()
        page.wait_for_selector('.sheet')
        page.go_back()
        page.wait_for_selector('.search')
        check(hash_of(page) == '#/?q=sun' and box.input_value() == 'sun', 'Back from the song: the search and its results again')
        check(page.locator('.group-head', has_text='In your library').is_visible(), 'with its results')
        page.go_back()
        page.wait_for_selector('.search')
        settle(page)
        check(hash_of(page) in ('', '#/') and box.input_value() == '', 'Back again: out of the search')
        check(page.locator('.lib-count').is_visible() and page.locator('.list .row').count() == len(SONGS), 'the whole library')

        box.fill('riv')
        settle(page)
        library_tab.click()
        page.wait_for_selector('.lib-count')
        settle(page)
        check(hash_of(page) in ('', '#/') and box.input_value() == '', 'the Library tab, pressed on a search: out of it')
        page.go_back()
        settle(page)
        check(not page.evaluate('location.hash').startswith('#/?q='), 'and that search isn’t a step Back goes to')

        box.fill('road')
        settle(page)
        page.evaluate("document.querySelector('.search input').dataset.mark = '1'")
        page.locator('.search .clear').click()
        settle(page)
        same = page.evaluate("document.querySelector('.search input').dataset.mark === '1' && document.activeElement === document.querySelector('.search input')")
        check(hash_of(page) in ('', '#/') and box.input_value() == '' and same, 'the clear button: empty, still typing in the same box')
        box.fill('porch')
        settle(page)
        page.go_back()
        settle(page)
        check(hash_of(page) in ('', '#/') and box.input_value() == '', 'a new search after it is one step, no empty one before it')

        # the artist on a song searches for them, and Back returns to the song
        page.goto(base + '/#/song/s-porch')
        page.wait_for_selector('.sheet')
        page.locator('.song-head .by a').click()
        page.wait_for_selector('.search')
        settle(page)
        check(box.input_value() == 'Ana Example' and page.locator('.list .row').count() == 2, 'the artist’s name: their songs')
        page.go_back()
        page.wait_for_selector('.sheet')
        check(hash_of(page) == '#/song/s-porch', 'Back: the song again')

        if device == 'laptop':
            # a song opened from a search; the Library tab (beside it on a big screen) goes to the library
            page.goto(base + '/#/')
            box = page.get_by_placeholder('Search your songs or Ultimate Guitar')
            box.fill('river')
            settle(page)
            page.locator('.list .row', has_text='River Bend').click()
            page.wait_for_selector('.sheet')
            library_tab.click()
            page.wait_for_selector('.lib-count')
            settle(page)
            check(hash_of(page) in ('', '#/') and box.input_value() == '', 'the Library tab on a song: the library, without the search')

        print(f'[{device}] favorites, shuffled')
        page.goto(base + '/#/')
        page.wait_for_selector('.lib-filter')
        page.locator('.lib-filter').get_by_role('button', name='Favorites').click()
        shuffle = page.get_by_role('button', name='Shuffle')
        expect(shuffle).to_be_visible()
        shuffle.click()
        page.wait_for_selector('.sheet')
        seen = []
        for k in range(len(FAVS)):
            h = hash_of(page)
            sid = h.split('/song/')[1].split('?')[0]
            seen.append(sid)
            check(f'list=shuffle&i={k}' in h and sid in FAVS, f'song {k + 1}: a favorite ({sid})')
            counter = page.locator('.song-bar .list-nav .eyebrow').inner_text().strip()
            check(counter == f'{k + 1}/{len(FAVS)}', f'with {counter} in the bar')
            if k < len(FAVS) - 1:
                page.locator('.song-bar').get_by_role('button', name='Next song').click()
                page.wait_for_function(f"document.querySelector('.song-bar .list-nav .eyebrow')?.textContent.trim() === '{k + 2}/{len(FAVS)}'")
        check(sorted(seen) == sorted(FAVS), 'every favorite once, the others not at all')
        check('disabled' in (page.locator('.song-bar').get_by_role('button', name='Next song').get_attribute('class') or ''), 'nothing after the last one')
        page.locator('.song-bar').get_by_role('button', name='Previous song').click()
        page.wait_for_function(f"document.querySelector('.song-bar .list-nav .eyebrow')?.textContent.trim() === '{len(FAVS) - 1}/{len(FAVS)}'")
        check(seen[-2] in hash_of(page), 'Previous: the one before')
        page.reload()
        page.wait_for_selector('.sheet')
        check(page.locator('.song-bar .list-nav .eyebrow').inner_text().strip() == f'{len(FAVS) - 1}/{len(FAVS)}', 'still in the shuffle after reloading')
        page.locator('.song-bar').get_by_role('button', name='Back').click()
        page.wait_for_selector('.lib-count')
        check(hash_of(page) in ('', '#/'), 'Back: straight to the library, not through each song')
        check(page.locator('.lib-filter').get_by_role('button', name='Favorites').get_attribute('aria-pressed') == 'true', 'on the favorites')
        orders = set()
        for _ in range(6):
            page.evaluate("async () => { const l = await import('/js/views/library.js'); const s = await import('/js/store.js'); l.shufflePlay(Object.values(s.store.lib.songs).filter(x => x.fav), h => { location.hash = h; }); }")
            page.wait_for_function("location.hash.includes('list=shuffle')")
            orders.add(tuple(page.evaluate("JSON.parse(sessionStorage.getItem('tabit.shuffle'))")))
            page.goto(base + '/#/')
        check(len(orders) > 1, f'a new order each time ({len(orders)} different in 6)')
        if errors:
            raise AssertionError(errors)
        b.close()


def main():
    base = start_server()
    run('webkit', 'iphone-15', base)
    run('chromium', 'laptop', base)
    print('Getting around the library works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
