"""Two devices syncing through the UI, against a fake GitHub (tests/fakegithub.py):

  1. the laptop (Edge) has a few songs, sets up sync with a GitHub key, adds a password
  2. the iPhone (WebKit) signs in with that password and gets the library
  3. edits on either side reach the other
  4. the phone loses GitHub, both edit, the phone comes back: nothing is lost
  5. what's stored on "GitHub" is encrypted (no song titles or lyrics in it)

    python tests/e2e_sync.py
"""
import sys
import time

from playwright.sync_api import sync_playwright, expect

from fakegithub import FakeGitHub
from util import context_for, launch, start_server

SEED = """async (songs) => {
  const store = await import('/js/store.js');
  const model = await import('/js/model.js');
  store.dispatch({ t: 'many', ops: songs.map(s => ({ t: 'add', song: model.makeSong(s) })) });
  return Object.keys(store.store.lib.songs).length;
}"""

SONGS = [
    {'id': 's-one', 'title': 'Sunrise Waltz', 'artist': 'The Testers', 'content': '[ch]G[/ch]    [ch]C[/ch]\nMorning comes so slow', 'fav': True},
    {'id': 's-two', 'title': 'River Bend', 'artist': 'The Testers', 'content': '[ch]D[/ch]\nDown by the water', 'fav': True},
    {'id': 's-three', 'title': 'Highway Hymn', 'artist': 'Ana Example', 'content': '[ch]Am[/ch]   [ch]F[/ch]\nMiles and miles of road'},
    {'id': 's-four', 'title': 'Porch Light', 'artist': 'Ana Example', 'content': '[ch]E[/ch]\nLeave it on for me'},
]


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def song_state(page, sid):
    return page.evaluate("async id => { const s = await import('/js/store.js'); return s.store.lib.songs[id] || null; }", sid)


def wait_synced(page, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = page.evaluate("async () => { const s = await import('/js/store.js'); return [s.store.sync.state, s.pendingCount()]; }")
        if st[0] in ('saved', 'idle') and st[1] == 0:
            return
        time.sleep(0.25)
    raise AssertionError(f'never synced: {st}')


def sync_now(page):
    page.evaluate("async () => { const s = await import('/js/store.js'); await s.syncNow(); }")


def main():
    gh = FakeGitHub(tokens={'tok-owner-123'})
    api = gh.start()
    base = start_server()
    errors = []
    with sync_playwright() as p:
        edge = launch(p, 'chromium')
        webkit = launch(p, 'webkit')
        lctx = context_for(p, edge, 'laptop')
        pctx = context_for(p, webkit, 'iphone-15')
        for ctx in (lctx, pctx):
            ctx.add_init_script(f"localStorage.setItem('tabit.dev.api', {api!r})")
        laptop, phone = lctx.new_page(), pctx.new_page()
        for name, pg in (('laptop', laptop), ('phone', phone)):
            pg.on('pageerror', lambda e, n=name: errors.append(f'{n}: {e}'))
            pg.on('console', lambda m, n=name: errors.append(f'{n}: {m.text}') if m.type == 'error' else None)

        try:
            run(laptop, phone, gh, api, base)
        except Exception:
            laptop.screenshot(path='tests/out/sync-fail-laptop.png')
            phone.screenshot(path='tests/out/sync-fail-phone.png')
            for e in errors:
                print('  console:', e)
            raise
        edge.close()
        webkit.close()
    gh.stop()
    if errors:
        print('Console errors:')
        for e in errors:
            print('  ', e)
        sys.exit(1)
    print('Sync works between the two devices.')


def run(laptop, phone, gh, api, base):
    if True:
        print('1. laptop: songs, then owner setup with a key')
        laptop.goto(base + '/#/')
        laptop.wait_for_selector('main .page')
        check(laptop.evaluate(SEED, SONGS) == 4, 'four songs on the laptop')
        laptop.goto(base + '/#/settings')
        laptop.get_by_text('First time? Set up sync').click()
        laptop.get_by_placeholder('github_pat_…').fill('tok-owner-123')
        laptop.get_by_role('button', name='Set up sync').click()
        expect(laptop.get_by_role('heading', name='Passwords')).to_be_visible(timeout=20000)
        wait_synced(laptop)
        files = gh.files_at()
        check('access.json' in files and 'library/index.json' in files, 'sign-in file and library on GitHub')
        blob = ''.join(files.values())
        check(not any(w in blob for w in ['Sunrise', 'Morning comes', 'Testers', 'Highway']), 'no titles, artists or lyrics in plain text on GitHub')

        laptop.get_by_placeholder('e.g. banjo river tuesday').fill('too short')
        laptop.get_by_placeholder('e.g. banjo river tuesday').fill('banjo river tuesday')
        laptop.get_by_placeholder('Label (not secret), e.g. Me').fill('Me')
        laptop.get_by_role('button', name='Add password').click()
        expect(laptop.get_by_text('Added 20', exact=False).first).to_be_visible(timeout=20000)
        check('banjo' not in gh.files_at()['access.json'], 'the password itself is not stored')

        print('2. phone: sign in with the password')
        phone.goto(base + '/#/settings')
        phone.get_by_placeholder('Your TabIt password').fill('wrong password')
        phone.get_by_role('button', name='Sign in').click()
        expect(phone.get_by_text('That password didn’t work', exact=False)).to_be_visible(timeout=20000)
        phone.get_by_placeholder('Your TabIt password').fill('  Banjo River TUESDAY ')
        phone.get_by_role('button', name='Sign in').click()
        expect(phone.get_by_role('heading', name='Passwords')).to_be_visible(timeout=30000)
        wait_synced(phone)
        phone.goto(base + '/#/')
        expect(phone.locator('h1.page-title')).to_contain_text('4 songs', timeout=10000)
        check(phone.get_by_text('Sunrise Waltz').is_visible(), 'the phone has the laptop\'s songs')

        print('3. an edit on the phone reaches the laptop')
        row = phone.locator('.row', has_text='Highway Hymn')
        row.get_by_role('button', name='Add to favorites').click()
        wait_synced(phone)
        sync_now(laptop)
        check(song_state(laptop, 's-three').get('fav') is True, 'favorite made on the phone shows on the laptop')

        print('4. the phone loses GitHub; both edit; it comes back')
        phone.context.route(api + '/**', lambda r: r.abort())
        phone.locator('.row', has_text='River Bend').get_by_role('button', name='Remove from favorites').click()
        for _ in range(60):
            st = phone.evaluate("async () => { const s = await import('/js/store.js'); return [s.store.sync.state, s.pendingCount()]; }")
            if st[0] in ('offline', 'error'):
                break
            time.sleep(0.25)
        check(st == ['offline', 1], f'phone keeps the change while GitHub is unreachable ({st})')
        laptop.goto(base + '/#/song/s-four')
        laptop.get_by_role('button', name='More').click()
        laptop.get_by_text('Notes', exact=True).click()
        laptop.locator('.drawer textarea').fill('Capo 2, slow')
        laptop.locator('.drawer').get_by_role('button', name='Save').click()
        wait_synced(laptop)
        phone.context.unroute(api + '/**')
        sync_now(phone)
        wait_synced(phone)
        sync_now(laptop)
        check(song_state(phone, 's-four').get('notes') == 'Capo 2, slow', 'the laptop\'s note reached the phone')
        check(song_state(laptop, 's-two').get('fav') is None, 'the phone\'s offline change reached the laptop')
        check(song_state(phone, 's-two').get('fav') is None, 'and stayed on the phone')

        print('5. delete on the laptop, undo on the laptop')
        laptop.goto(base + '/#/')
        laptop.get_by_text('Porch Light').click()
        laptop.get_by_role('button', name='More').click()
        laptop.get_by_text('Delete song').click()
        laptop.get_by_role('button', name='Undo').click()
        wait_synced(laptop)
        sync_now(phone)
        check(song_state(phone, 's-four') is not None, 'undo brought it back everywhere')

        commits = [c['message'] for c in gh.commits.values()]
        check(any('from iPhone' in m for m in commits) and any('from Windows' in m for m in commits), f'commits name the device ({len(commits)} commits)')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
