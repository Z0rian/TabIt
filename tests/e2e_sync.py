"""The shared songbook through the UI, against a fake GitHub (tests/fakegithub.py)
that starts as a brand-new, empty data repository. Three devices: the owner's
laptop (Edge), and a friend's iPhone and iPad (WebKit).

  1. the laptop has a few songs (two favorites); the owner sets up the songbook
     with a GitHub key, makes an invite for friends and an account of their own
  2. the friend's phone signs in with the invite: the songs, none of the
     owner's favorites; the friend makes an account (no GitHub)
  3. the friend's favorite stays theirs; a songbook edit reaches the laptop
  4. the friend's iPad signs in with their account: their favorites come along
  5. the phone loses GitHub, both edit, the phone comes back: nothing is lost
  6. delete for everyone, and undo; what's stored on "GitHub" is encrypted
  7. signing out with a change that hasn't synced, then back in, keeps it
  8. the key is revoked: the laptop pastes a new one (no passwords typed), the
     friend's devices pick it up by themselves

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

INVITE = 'banjo river tuesday'
OWNER_PW = 'the owners own words'
SAM_PW = 'sams very own password'


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def song_state(page, sid):
    return page.evaluate("async id => { const s = await import('/js/store.js'); return s.store.lib.songs[id] || null; }", sid)


def sync_state(page):
    return page.evaluate("async () => { const s = await import('/js/store.js'); return [s.store.sync.state, s.pendingCount()]; }")


def wait_synced(page, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = sync_state(page)
        if st[0] in ('saved', 'idle') and st[1] == 0:
            return
        time.sleep(0.25)
    raise AssertionError(f'never synced: {st}')


def wait_offline(page):
    for _ in range(60):
        st = sync_state(page)
        if st[0] in ('offline', 'error'):
            return st
        time.sleep(0.25)
    return st


def sync_now(page):
    page.evaluate("async () => { const s = await import('/js/store.js'); await s.syncNow(); }")


def edit(page, op):
    page.evaluate("async op => (await import('/js/store.js')).dispatch(op)", op)


def sign_in(page, base, password):
    page.goto(base + '/#/settings')
    page.get_by_placeholder('Your TabIt password').fill(password)
    page.get_by_role('button', name='Sign in').click()
    expect(page.get_by_role('heading', name='Invites')).to_be_visible(timeout=30000)
    wait_synced(page)


def favorites(page):
    return page.evaluate("async () => Object.values((await import('/js/store.js')).store.lib.songs).filter(s => s.fav).map(s => s.id).sort()")


# from step 8 on, GitHub rightly refuses the revoked key; the browser logs those
EXPECTED = {'401': False}


def main():
    gh = FakeGitHub(tokens={'tok-owner-123'})
    api = gh.start()
    base = start_server()
    errors = []
    with sync_playwright() as p:
        edge = launch(p, 'chromium')
        webkit = launch(p, 'webkit')
        ctxs = [context_for(p, edge, 'laptop'), context_for(p, webkit, 'iphone-15'), context_for(p, webkit, 'ipad-mini')]
        for ctx in ctxs:
            ctx.add_init_script(f"localStorage.setItem('tabit.dev.api', {api!r})")
        laptop, phone, ipad = (c.new_page() for c in ctxs)
        for name, pg in (('laptop', laptop), ('phone', phone), ('ipad', ipad)):
            pg.on('pageerror', lambda e, n=name: errors.append(f'{n}: {e}'))
            pg.on('console', lambda m, n=name: errors.append(f'{n}: {m.text}') if m.type == 'error' and not (EXPECTED['401'] and 'status of 401' in m.text) else None)

        try:
            run(laptop, phone, ipad, gh, api, base)
        except Exception:
            for name, pg in (('laptop', laptop), ('phone', phone), ('ipad', ipad)):
                pg.screenshot(path=f'tests/out/sync-fail-{name}.png')
            for e in errors:
                print('  console:', e)
            raise
        edge.close()
        webkit.close()
    gh.stop()
    other_default_branch(base)
    key_mistakes(base)
    if errors:
        print('Console errors:')
        for e in errors:
            print('  ', e)
        sys.exit(1)
    print('The shared songbook works between the three devices.')


def other_default_branch(base):
    print('9. a data repository whose default branch is "master"')
    gh = FakeGitHub(tokens={'tok-1'}, default_branch='master')
    api = gh.start()
    with sync_playwright() as p:
        b = launch(p, 'chromium')
        ctx = context_for(p, b, 'laptop')
        ctx.add_init_script(f"localStorage.setItem('tabit.dev.api', {api!r})")
        page = ctx.new_page()
        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, SONGS[:2])
        page.evaluate("async () => { const a = await import('/js/account.js'); await a.setupWithKey('tok-1'); }")
        wait_synced(page)
        b.close()
    gh.stop()
    check('main' in gh.refs and {'access.json', 'library/index.json'} <= set(gh.files_at('main')), 'setup still keeps everything on "main"')


def key_mistakes(base):
    print('10. each kind of wrong key gets its own explanation, with where to fix it')
    gh = FakeGitHub(tokens={'github_pat_good'}, blind={'github_pat_blind'}, readonly={'github_pat_readonly'})
    gh.exists = False
    api = gh.start()
    with sync_playwright() as p:
        b = launch(p, 'chromium')
        ctx = context_for(p, b, 'laptop')
        ctx.add_init_script(f"localStorage.setItem('tabit.dev.api', {api!r})")
        page = ctx.new_page()
        crashes = []
        page.on('pageerror', lambda e: crashes.append(str(e)))
        page.goto(base + '/#/settings?setup')
        key = page.get_by_placeholder('github_pat_…')
        err = page.locator('.sub-panel .error')

        def attempt(token, says, link, what):
            key.fill(token)
            page.get_by_role('button', name='Set up sync').click()
            expect(err).to_contain_text(says, timeout=15000)
            expect(err.get_by_role('link', name=link)).to_be_visible()
            check(True, f'{what}: “{says}…” with a link to {link}')

        attempt('github_pat_typo', 'GitHub doesn’t recognize this key', 'Make a new key', 'a key GitHub doesn’t know')
        attempt('github_pat_good', 'GitHub has no public repository called tabit-data', 'Make tabit-data', 'the repository isn’t made yet')
        gh.exists, gh.private = True, True
        attempt('github_pat_good', 'repository is private', 'tabit-data settings', 'a private repository')
        gh.private = False
        attempt('github_pat_blind', 'is there, but this key can’t reach it', 'Your keys on GitHub', 'a key without the repository')
        attempt('github_pat_readonly', 'can read tabit-data but not save to it', 'Your keys on GitHub', 'a read-only key')
        check(not gh.refs, 'nothing was saved by any of them')
        # the key typed into the password box, the first box on the screen
        page.get_by_placeholder('Your TabIt password').fill('github_pat_good')
        page.get_by_role('button', name='Sign in').click()
        expect(page.get_by_role('heading', name='Invites')).to_be_visible(timeout=20000)
        check('access.json' in gh.files_at(), 'a key typed into the password box sets up the songbook too')
        if crashes:
            raise AssertionError(crashes)
        b.close()
    gh.stop()


def run(laptop, phone, ipad, gh, api, base):
    print('1. laptop: songs, then the owner sets up the songbook with a key')
    laptop.goto(base + '/#/')
    laptop.wait_for_selector('main .page')
    check(laptop.evaluate(SEED, SONGS) == 4, 'four songs on the laptop, two of them favorites')
    laptop.goto(base + '/#/settings')
    laptop.get_by_text('Starting a songbook of your own?').click()
    laptop.get_by_placeholder('github_pat_…').fill('tok-owner-123')
    laptop.get_by_role('button', name='Set up sync').click()
    expect(laptop.get_by_role('heading', name='Invites')).to_be_visible(timeout=20000)
    wait_synced(laptop)
    files = gh.files_at()
    check('access.json' in files and 'library/index.json' in files, 'sign-in file and songbook on GitHub')
    blob = ''.join(files.values())
    check(not any(w in blob for w in ['Sunrise', 'Morning comes', 'Testers', 'Highway']), 'no titles, artists or lyrics in plain text on GitHub')

    invite = laptop.get_by_placeholder('e.g. campfire songs 2026')
    invite.fill('short')
    laptop.get_by_role('button', name='Make an invite').click()
    expect(laptop.get_by_text('Use at least 8 characters')).to_be_visible()
    invite.fill(INVITE)
    laptop.get_by_placeholder('Not secret, e.g. Friends').fill('Friends')
    laptop.get_by_role('button', name='Make an invite').click()
    expect(laptop.locator('.set-row', has_text='Friends')).to_be_visible(timeout=20000)
    check('banjo' not in gh.files_at()['access.json'], 'the invite password itself is not stored')

    laptop.get_by_label('Your name').fill('Owner')
    laptop.get_by_label('Your password').fill(OWNER_PW)
    laptop.get_by_role('button', name='Make my account').click()
    expect(laptop.get_by_text('You’re signed in as Owner')).to_be_visible(timeout=20000)
    wait_synced(laptop)
    people = [p for p in gh.files_at() if p.startswith('people/')]
    check(len(people) == 1, 'the owner’s own part is a file of its own on GitHub')
    check(favorites(laptop) == ['s-one', 's-two'], 'the owner still has their favorites')

    print('2. the friend’s phone: signs in with the invite, then makes an account')
    phone.goto(base + '/#/settings')
    phone.get_by_placeholder('Your TabIt password').fill('wrong password')
    phone.get_by_role('button', name='Sign in').click()
    expect(phone.get_by_text('That password didn’t work', exact=False)).to_be_visible(timeout=20000)
    sign_in(phone, base, '  Banjo River TUESDAY ')
    phone.goto(base + '/#/')
    expect(phone.locator('h1.page-title')).to_contain_text('4 songs', timeout=10000)
    check(phone.get_by_text('Sunrise Waltz').is_visible(), 'the phone has the songbook')
    check(favorites(phone) == [], 'and none of the owner’s favorites')
    phone.goto(base + '/#/settings')
    phone.get_by_label('Your name').fill('Sam')
    phone.get_by_label('Your password').fill(SAM_PW)
    phone.get_by_role('button', name='Make my account').click()
    expect(phone.get_by_text('You’re signed in as Sam')).to_be_visible(timeout=20000)
    wait_synced(phone)
    check(len([p for p in gh.files_at() if p.startswith('people/')]) == 2, 'Sam’s part too, no GitHub needed')
    expect(phone.locator('.set-row', has_text='Owner')).to_be_visible()
    expect(phone.locator('.set-row', has_text='Sam')).to_contain_text('you')

    print('3. a favorite on the phone stays Sam’s; a songbook edit reaches the laptop')
    phone.goto(base + '/#/')
    phone.locator('.row', has_text='Highway Hymn').get_by_role('button', name='Add to favorites').click()
    edit(phone, {'t': 'set', 'id': 's-three', 'set': {'capo': 2}})
    wait_synced(phone)
    sync_now(laptop)
    check(song_state(laptop, 's-three').get('capo') == 2, 'the capo set on the phone shows on the laptop')
    check(song_state(laptop, 's-three').get('fav') is None, 'Sam’s favorite doesn’t')

    print('4. Sam’s iPad: signs in with Sam’s account')
    sign_in(ipad, base, SAM_PW)
    check(favorites(ipad) == ['s-three'], 'Sam’s favorites come along, nobody else’s')
    expect(ipad.get_by_text('You’re signed in as Sam')).to_be_visible()

    print('5. the phone loses GitHub; both edit; it comes back')
    phone.context.route(api + '/**', lambda r: r.abort())
    phone.locator('.row', has_text='Highway Hymn').get_by_role('button', name='Remove from favorites').click()
    edit(phone, {'t': 'set', 'id': 's-one', 'set': {'key': 'A'}})
    st = wait_offline(phone)
    check(st == ['offline', 2], f'the phone keeps both changes while GitHub is unreachable ({st})')
    laptop.goto(base + '/#/song/s-four')
    laptop.get_by_role('button', name='More').click()
    laptop.get_by_text('Notes', exact=True).click()
    laptop.locator('.drawer textarea').fill('Capo 2, slow')
    laptop.locator('.drawer').get_by_role('button', name='Save').click()
    edit(laptop, {'t': 'set', 'id': 's-two', 'set': {'key': 'D'}})
    wait_synced(laptop)
    phone.context.unroute(api + '/**')
    sync_now(phone)
    wait_synced(phone)
    sync_now(laptop)
    sync_now(ipad)
    check(song_state(laptop, 's-one').get('key') == 'A' and song_state(phone, 's-two').get('key') == 'D', 'both songbook edits are on both devices')
    check(favorites(ipad) == [], 'the phone’s offline unfavorite reached Sam’s iPad')
    check(song_state(laptop, 's-four').get('notes') == 'Capo 2, slow' and song_state(phone, 's-four').get('notes') is None, 'the owner’s note stays the owner’s')

    print('6. delete for everyone on the laptop, then undo')
    laptop.goto(base + '/#/song/s-four')
    laptop.get_by_role('button', name='More').click()
    laptop.get_by_text('Delete for everyone').click()
    laptop.locator('.drawer').get_by_role('button', name='Delete').click()
    laptop.get_by_role('button', name='Undo').click()
    wait_synced(laptop)
    sync_now(phone)
    check(song_state(phone, 's-four') is not None, 'undo brought it back everywhere')
    check(song_state(laptop, 's-four').get('notes') == 'Capo 2, slow', 'with the owner’s note')

    commits = [c['message'] for c in gh.commits.values()]
    check(any('from iPhone' in m for m in commits) and any('from Windows' in m for m in commits) and any('personal change' in m for m in commits),
          f'commits name the device ({len(commits)} commits)')
    blob = ''.join(gh.files_at().values())
    check(not any(w in blob for w in ['Capo 2, slow', 'Sunrise', 'Sam’s']), 'still nothing readable on GitHub')

    print('7. the phone signs out with a change that hasn\'t synced, then back in')
    phone.goto(base + '/#/')
    phone.context.route(api + '/**', lambda r: r.abort())
    phone.locator('.row', has_text='Porch Light').get_by_role('button', name='Add to favorites').click()
    wait_offline(phone)
    phone.goto(base + '/#/settings')
    phone.get_by_role('button', name='Sign out on this device').click()
    expect(phone.locator('.drawer')).to_contain_text('1 change hasn’t synced yet')
    phone.locator('.drawer').get_by_role('button', name='Sign out').click()
    expect(phone.get_by_placeholder('Your TabIt password')).to_be_visible()
    phone.context.unroute(api + '/**')
    sign_in(phone, base, SAM_PW)
    sync_now(ipad)
    fp, fi = favorites(phone), favorites(ipad)
    check(fp == ['s-four'] and fi == ['s-four'], f'the change made before signing out is kept, and reached the iPad ({fp}, {fi})')

    print('8. the GitHub key stops working; the laptop pastes a new one')
    EXPECTED['401'] = True
    gh.tokens.discard('tok-owner-123')
    gh.tokens.add('tok-owner-456')
    laptop.goto(base + '/#/settings')
    sync_now(laptop)
    expect(laptop.get_by_text('GitHub didn’t accept the sync key', exact=False)).to_be_visible(timeout=10000)
    laptop.get_by_text('Replace the GitHub key').click()
    check(laptop.locator('.sub-panel input[type=password]').count() == 1, 'no password to type, only the new key')
    laptop.get_by_placeholder('New github_pat_…').fill('tok-owner-456')
    laptop.get_by_role('button', name='Replace key').click()
    expect(laptop.get_by_text('Key replaced')).to_be_visible(timeout=20000)
    wait_synced(laptop)
    check('tok-owner' not in gh.files_at()['access.json'], 'the new key is stored only sealed')
    # the friend's devices still have the old key: they just carry on
    edit(phone, {'t': 'set', 'id': 's-three', 'set': {'key': 'Am'}})
    sync_now(phone)
    wait_synced(phone)
    check(phone.evaluate("async () => (await import('/js/store.js')).getAuth().token") == 'tok-owner-456', 'the phone picked up the new key by itself')
    sync_now(ipad)
    wait_synced(ipad)
    sync_now(laptop)
    check(song_state(laptop, 's-three').get('key') == 'Am' and song_state(ipad, 's-three').get('key') == 'Am', 'and everyone syncs with it')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
