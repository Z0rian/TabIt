"""The song screen, used like a person would, on a phone and a laptop:
chord shapes (open, swipe, keep one), transpose, capo, text size, simplify,
lyrics only — with the chord-alignment check run after every change — and
searching Ultimate Guitar, previewing and saving a song (the proxy's answers
come from the local corpus, so nothing goes over the network).

    python tests/e2e_song.py
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright, expect

from util import ROOT, context_for, launch, start_server

KEY = '001-zach-bryan-something-in-the-orange-v1'
PROXY = 'https://ug-proxy.zorian.workers.dev'

SEED = """async (rec) => {
  const store = await import('/js/store.js');
  const ug = await import('/js/ug.js');
  const meta = rec.meta || {};
  const song = ug.songFromTab(rec.match, { content: rec.content, meta: { capo: meta.capo, tonality: meta.tonality, tuning: meta.tuning }, applicature: rec.applicature, strummings: rec.strummings }, { id: 's-orange' });
  store.dispatch({ t: 'add', song });
}"""

ALIGN = """async () => {
  const { checkSheet } = await import('/tests/align.js');
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return checkSheet(document.querySelector('.sheet'));
}"""

NAMES = "() => [...document.querySelectorAll('.sheet .pair .cn:not(.ann)')].map(e => e.dataset.chord)"

# Just enough of YouTube's IFrame API: ready after a moment, a 3:52 video.
FAKE_YT = """() => {
  window.YT = { Player: class {
    constructor(el, opts) {
      this.opts = opts; this.state = -1; this.t0 = 0; window.__fakePlayer = this;
      const box = document.createElement('div'); box.className = 'fake-yt'; box.textContent = 'video'; el.replaceWith(box);
      setTimeout(() => opts.events.onReady({ target: this }), 100);
    }
    getDuration() { return 232; }
    getCurrentTime() { return this.state === 1 ? (performance.now() - this.t0) / 1000 : 0; }
    getPlayerState() { return this.state; }
    playVideo() { this.state = 1; this.t0 = performance.now(); this.opts.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.state = 2; this.opts.events.onStateChange({ data: 2 }); }
    seekTo() {}
    destroy() {}
  } };
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def aligned(page, label):
    r = page.evaluate(ALIGN)
    check(not r['problems'] and r['checked'] > 20, f'{label}: {r["checked"]} chords exactly over their words')


def run(engine, device, base, rec):
    with sync_playwright() as p:
        b = launch(p, engine)
        ctx = context_for(p, b, device)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        # Ultimate Guitar, as the proxy would answer, from the corpus
        results = [{k: r[k] for k in ('title', 'artist', 'type', 'rating', 'votes', 'url')} for r in rec['results'] if r['type'] in ('Chords', 'Pro')]
        ctx.route(PROXY + '/**', lambda route: route.fulfill(content_type='application/json', body=json.dumps(
            {'results': results} if 'action=search' in route.request.url else
            {'content': rec['content']} if 'action=tab' in route.request.url else {'error': 'No video found'})))

        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, rec)
        page.goto(base + '/#/song/s-orange')
        page.wait_for_selector('.sheet .pair')
        print(f'[{device}] song screen')
        aligned(page, 'as written')
        first = page.evaluate(NAMES)
        check('Em7' in first and 'G' in first, 'chords as written (Em7, G, …)')

        # the strumming pattern: shown, playable, and the author's other one to pick
        row = page.locator('.strum .strum-row')
        check(row.get_attribute('aria-label') == 'down (accent), rest, rest, up, down, up', 'the strumming pattern is shown')
        page.get_by_role('button', name='Play the strumming pattern').click()
        expect(page.locator('.stroke.on')).to_have_count(1, timeout=3000)
        page.get_by_role('button', name='Stop the strumming pattern').click()
        expect(page.locator('.stroke.on')).to_have_count(0)
        check(True, 'Play strums it in time, and stops')
        page.locator('.strum-pick').select_option('1')
        check(row.get_attribute('aria-label') == 'down (accent), rest, down, up, down, up', 'the other pattern can be picked')

        # chord shapes
        page.locator('.sheet .pair .cn', has_text='Em7').first.click()
        drawer = page.locator('.drawer')
        expect(drawer.locator('h2')).to_have_text('Em7')
        expect(drawer.locator('.voicing-count')).to_contain_text(' / ')
        count = drawer.locator('.voicing-count').inner_text()
        n = int(count.split('/')[1])
        check(count.startswith('1 /') and n >= 8, f'Em7 has {n} shapes to swipe through')
        drawer.get_by_role('button', name='Next shape').click()
        expect(drawer.locator('.voicing-count')).to_have_text(f'2 / {n}')
        frets2 = drawer.locator('.voicing-slide').nth(1).locator('.frets').inner_text()
        drawer.get_by_role('button', name='Use this shape in this song').click()
        page.keyboard.press('Escape')
        strip_label = page.locator('.chord-card', has_text='Em7').locator('svg').get_attribute('aria-label')
        check(frets2.replace(' ', '') in strip_label.replace(' ', ''), f'the chosen shape ({frets2}) is shown for Em7 above the song')

        # transpose and capo
        page.get_by_role('button', name='Display: transpose, capo, size').click()
        tools = page.locator('.drawer')
        tools.locator('.tool-row', has_text='Transpose').get_by_role('button', name='More').click()
        tools.locator('.tool-row', has_text='Transpose').get_by_role('button', name='More').click()
        names = page.evaluate(NAMES)
        check(names[:3] == [n_ for n_ in ['F#m7', 'E/G#', 'A']] or 'F#m7' in names, f'transposed up a tone: {names[:3]}')
        expect(page.locator('.song-meta')).to_contain_text('Key A')
        aligned(page, 'transposed')
        tools.locator('.tool-row', has_text='Capo').get_by_role('button', name='More').click()
        names = page.evaluate(NAMES)
        check('Fm7' in names or 'F#m7' not in names, f'capo 1 changes the shapes: {names[:3]}')
        expect(page.locator('.song-meta')).to_contain_text('Capo 1')
        # text size
        for _ in range(6):
            tools.locator('.tool-row', has_text='Text size').get_by_role('button', name='More').click()
        aligned(page, 'bigger text')
        tools.locator('.tool-row', has_text='Simplify').get_by_role('switch').check()
        names = page.evaluate(NAMES)
        check(not any('7' in x for x in names), f'simplified: {sorted(set(names))}')
        tools.get_by_role('button', name='Reset to the original').click()
        check(page.evaluate(NAMES)[:2] == first[:2], 'reset brings the written chords back')
        page.keyboard.press('Escape')

        # the Transpose button next to the key
        page.locator('.song-meta').get_by_role('button', name='Transpose', exact=True).click()
        menu = page.locator('.drawer')
        expect(menu.locator('h2')).to_have_text('Transpose')
        expect(menu.locator('.transpose-now')).to_contain_text('Key G, as written')
        menu.locator('.tool-row', has_text='Up or down').get_by_role('button', name='More').click()
        menu.locator('.tool-row', has_text='Up or down').get_by_role('button', name='More').click()
        expect(menu.locator('.transpose-now')).to_contain_text('Key A, +2 from G')
        expect(page.locator('.song-meta')).to_contain_text('Key A')
        check('F#m7' in page.evaluate(NAMES), 'the Transpose button next to the key moves the chords (+2: Em7 → F#m7)')
        menu.get_by_role('button', name='C (+5)').click()
        expect(page.locator('.song-meta')).to_contain_text('Key C')
        check('Am7' in page.evaluate(NAMES), 'tapping a key goes straight there (C: Em7 → Am7)')
        aligned(page, 'in another key')
        menu.get_by_role('button', name='Back to the original key').click()
        expect(page.locator('.song-meta')).to_contain_text('Key G')
        check(page.evaluate(NAMES)[:2] == first[:2], 'and back to the original key')
        page.keyboard.press('Escape')
        expect(page.locator('.drawer')).to_have_count(0)
        page.locator('.song-meta').get_by_role('button', name='Key G: transpose').click()
        expect(page.locator('.drawer h2')).to_have_text('Transpose')
        check(True, 'tapping the key opens the same menu')
        page.keyboard.press('Escape')
        expect(page.locator('.drawer')).to_have_count(0)  # (closed before the next one opens)
        page.get_by_role('button', name='Display: transpose, capo, size').click()
        tools = page.locator('.drawer')
        tools.locator('.tool-row', has_text='Lyrics only').get_by_role('switch').check()
        check(page.locator('.sheet .cn').first.is_hidden(), 'lyrics only hides the chords')
        tools.locator('.tool-row', has_text='Lyrics only').get_by_role('switch').uncheck()
        page.keyboard.press('Escape')
        view = page.evaluate("async () => (await import('/js/store.js')).store.lib.songs['s-orange'].view || {}")
        check('voicings' in view and 'tr' not in view, f'per-song settings saved with the song ({sorted(view)})')

        # search Ultimate Guitar → preview → save
        print(f'[{device}] search and save')
        page.goto(base + '/#/')
        page.get_by_role('searchbox', name='Search').fill('nirvana something in the way')
        page.keyboard.press('Enter')
        ver = page.locator('.ver-btn').first
        expect(ver).to_be_visible(timeout=10000)
        groups = page.locator('.result-ver').count()
        check(groups >= 1, f'{groups} songs found on Ultimate Guitar, with versions')
        page.locator('.row', has=page.locator('.ver-btn')).filter(has_text='Nirvana').first.locator('.ver-btn').first.click()
        expect(page.locator('.preview-banner')).to_be_visible(timeout=10000)
        check(page.locator('.sheet .pair').count() > 10, 'the preview shows the whole song before saving')
        page.locator('.preview-banner').get_by_role('button', name='Save').click()
        expect(page.locator('.preview-banner')).to_have_count(0)
        lib = page.evaluate("async () => Object.values((await import('/js/store.js')).store.lib.songs).map(s => s.title)")
        check(len(lib) == 2, f'saved to the library ({lib})')

        # the YouTube player (a stand-in for YouTube's own API) sets the song length
        print(f'[{device}] YouTube length and follow-the-video')
        page.evaluate(FAKE_YT)
        page.evaluate("async () => (await import('/js/store.js')).dispatch({ t: 'set', id: 's-orange', set: { yt: 'Lw7Q19mtly0' } })")
        page.goto(base + '/#/song/s-orange')
        page.wait_for_selector('.sheet .pair')
        before = page.locator('.deck-time').inner_text()
        page.get_by_role('button', name='Play along on YouTube').click()
        expect(page.locator('.yt')).to_be_visible()
        expect(page.locator('.deck-time')).to_contain_text('3:52', timeout=10000)
        song = page.evaluate("async () => (await import('/js/store.js')).store.lib.songs['s-orange']")
        check(song.get('duration') == 232 and song.get('durationFrom') == 'yt', f"the video's length becomes the song's ({before.strip()} → 3:52)")
        page.evaluate('window.__fakePlayer.playVideo()')
        expect(page.locator('.deck .play')).to_have_attribute('aria-label', 'Pause autoscroll', timeout=5000)
        check(True, 'pressing play in the video starts the autoscroll (follow the video)')
        # (force: Playwright's WebKit counts the page scrolling under a fixed
        # button as the button moving; it doesn't, see tests/e2e_deck.py for taps)
        page.get_by_role('button', name='Close video').click(force=True)
        check(page.locator('.yt').count() == 0, 'the player closes while the song plays')
        if errors:
            raise AssertionError(errors)
        b.close()


def main():
    rec = json.load(open(os.path.join(ROOT, 'tests', 'corpus', 'songs', KEY + '.json'), encoding='utf-8'))
    base = start_server()
    for engine, device in [('chromium', 'laptop'), ('webkit', 'iphone-15')]:
        run(engine, device, base, rec)
    print('The song screen works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
