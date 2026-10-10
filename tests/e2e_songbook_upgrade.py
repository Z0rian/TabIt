"""Upgrading devices that sync with the TabIt from before the shared songbook
(one library, everyone's favorites in it): the owner's laptop and phone run
the old app, signed in, then the new one is deployed at the same address.
Nothing may be lost: the favorites end up in the owner's own part, the
songbook on GitHub is written again without them, and the old password still
lets a device in.

    git worktree add ../tabit-prev 8ce0f1c
    python tests/e2e_songbook_upgrade.py ../tabit-prev
"""
import sys
import time

from playwright.sync_api import sync_playwright, expect

from e2e_upgrade import Switchable
from fakegithub import FakeGitHub
from util import ROOT, context_for, launch

SEED = """async (songs) => {
  const store = await import('/js/store.js');
  const model = await import('/js/model.js');
  store.dispatch({ t: 'many', ops: songs.map(s => ({ t: 'add', song: model.makeSong(s) })) });
}"""

SONGS = [
    {'id': 's-one', 'title': 'Sunrise Waltz', 'artist': 'The Testers', 'content': '[ch]G[/ch]\nMorning', 'fav': True, 'notes': 'slow'},
    {'id': 's-two', 'title': 'River Bend', 'artist': 'The Testers', 'content': '[ch]D[/ch]\nWater', 'fav': True},
    {'id': 's-three', 'title': 'Highway Hymn', 'artist': 'Ana Example', 'content': '[ch]Am[/ch]\nRoad'},
]

# what's in the songbook's index on GitHub
INDEX = """async () => {
  const s = await import('/js/store.js');
  const c = await import('/js/crypto.js');
  const r = s.remote();
  const files = await r.files(await r.head());
  const index = await c.decryptJSON(await r.blob(files['library/index.json']), s.getAuth().libKey, 'library/index.json');
  return { favs: Object.values(index.songs).filter(x => x.fav).length, notes: Object.values(index.songs).filter(x => x.notes).length, setlists: Object.keys(index.setlists || {}).length };
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def call(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def wait_synced(page, timeout=30):
    t0 = time.time()
    st = None
    while time.time() - t0 < timeout:
        st = call(page, "async () => { const s = await import('/js/store.js'); return [s.store.sync.state, s.pendingCount()]; }")
        if st[0] in ('saved', 'idle') and st[1] == 0:
            return
        time.sleep(0.25)
    raise AssertionError(f'never synced: {st}')


def favorites(page):
    return call(page, "async () => Object.values((await import('/js/store.js')).store.lib.songs).filter(s => s.fav).map(s => s.id).sort()")


def is_new(page):
    return call(page, "async () => !!(await import('/js/store.js')).book")


def until_new(page):
    for attempt in range(8):
        page.reload()
        page.wait_for_selector('main .page', timeout=30000)
        if is_new(page):
            return attempt + 1
        time.sleep(1.5)
    raise AssertionError('the new app never ran')


def main():
    old_dir = sys.argv[1]
    gh = FakeGitHub(tokens={'tok-1'})
    api = gh.start()
    site = Switchable(old_dir)
    with sync_playwright() as p:
        edge = launch(p, 'chromium')
        webkit = launch(p, 'webkit')
        lctx, pctx, fctx = context_for(p, edge, 'laptop'), context_for(p, webkit, 'iphone-15'), context_for(p, edge, 'pixel-7')
        for ctx in (lctx, pctx, fctx):
            ctx.add_init_script(f"localStorage.setItem('tabit.dev.api', {api!r})")
        laptop, phone, friend = lctx.new_page(), pctx.new_page(), fctx.new_page()

        print('1. the old app: the laptop sets up sync, the phone signs in with the password')
        for pg in (laptop, phone):
            pg.goto(site.base + '/?sw#/')
            pg.wait_for_selector('main .page', timeout=30000)
        check(not is_new(laptop), 'it is the old app')
        call(laptop, SEED, SONGS)
        call(laptop, "async () => { const a = await import('/js/account.js'); await a.setupWithKey('tok-1'); await a.addPassword('banjo river tuesday', 'Me'); }")
        wait_synced(laptop)
        call(phone, "async () => (await import('/js/account.js')).signInWithPassword('banjo river tuesday')")
        wait_synced(phone)
        check(favorites(phone) == ['s-one', 's-two'], 'the phone has the favorites, synced the old way')
        check(call(laptop, INDEX)['favs'] == 2, 'which are in the songbook’s index on GitHub')
        for pg in (laptop, phone):  # let the old service worker take over, as on a real phone
            for _ in range(20):
                if call(pg, 'navigator.serviceWorker.controller !== null'):
                    break
                pg.reload()
                pg.wait_for_selector('main .page', timeout=30000)
                time.sleep(0.5)

        print('2. the new app is deployed; the laptop opens it first')
        site.root = ROOT
        n = until_new(laptop)
        check(True, f'the laptop runs the new app after {n} reload(s)')
        wait_synced(laptop)
        call(laptop, "async () => (await import('/js/store.js')).syncNow()")
        check(favorites(laptop) == ['s-one', 's-two'], 'its favorites are all there')
        check(call(laptop, "async () => (await import('/js/store.js')).store.lib.songs['s-one'].notes") == 'slow', 'and its notes')
        idx = call(laptop, INDEX)
        check(idx == {'favs': 0, 'notes': 0, 'setlists': 0}, f'the songbook on GitHub no longer has them ({idx})')

        print('3. the phone, still on the old app, syncs before updating')
        call(phone, "async () => (await import('/js/store.js')).syncNow()")
        check(favorites(phone) == [], 'the old app loses them from its own copy (they’re safe on the laptop)')
        n = until_new(phone)
        check(True, f'the phone runs the new app after {n} reload(s)')
        wait_synced(phone)

        print('4. the owner makes an account on the laptop, and uses it on the phone')
        laptop.goto(site.base + '/?sw#/settings')
        laptop.get_by_label('Your name').fill('Owner')
        laptop.get_by_label('Your password').fill('the owners own words')
        laptop.get_by_role('button', name='Make my account').click()
        expect(laptop.get_by_text('You’re signed in as Owner')).to_be_visible(timeout=20000)
        wait_synced(laptop)
        phone.goto(site.base + '/?sw#/settings')
        phone.get_by_text('Made your account on another device? Use it here').click()
        phone.get_by_label('Account password').fill('The Owners Own Words')
        phone.get_by_role('button', name='Use my account').click()
        expect(phone.get_by_text('You’re signed in as Owner')).to_be_visible(timeout=20000)
        wait_synced(phone)
        check(favorites(phone) == ['s-one', 's-two'], 'the phone has the favorites back')
        check(call(phone, "async () => (await import('/js/store.js')).store.lib.songs['s-one'].notes") == 'slow', 'and the notes')

        print('5. a friend’s device, new app only, signs in with the old password')
        friend.goto(site.base + '/?sw#/')
        friend.wait_for_selector('main .page', timeout=30000)
        call(friend, "async () => (await import('/js/account.js')).signInWithPassword('banjo river tuesday')")
        wait_synced(friend)
        check(len(call(friend, "async () => Object.keys((await import('/js/store.js')).store.lib.songs)")) == 3, 'it gets the songbook')
        check(favorites(friend) == [], 'not the owner’s favorites')
        for _ in range(40):
            if all('"pub"' in e for e in [gh.files_at()['access.json']]) and call(friend, "async () => !!(await import('/js/store.js')).getAuth().priv"):
                break
            time.sleep(0.25)
        check(call(friend, "async () => !!(await import('/js/store.js')).getAuth().priv"), 'and the old password is sealed again the new way')
        edge.close()
        webkit.close()
    gh.stop()
    print('Upgrading to the shared songbook loses nothing.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
