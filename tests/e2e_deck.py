"""The autoscroll bar on a phone, with real touches: it tucks into the corner
(tap the grip, or swipe it right) leaving the grip and play/pause, comes back
(tap or swipe left), remembers how you left it, and the speed slider still
just sets the speed. And the YouTube player closes at a tap while the song and
the video play, without the tap landing on what's underneath.

    python tests/e2e_deck.py
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright, expect

from util import ROOT, launch, start_server

KEY = '001-zach-bryan-something-in-the-orange-v1'
SEED = """async (rec) => {
  const store = await import('/js/store.js');
  const ug = await import('/js/ug.js');
  const meta = rec.meta || {};
  store.dispatch({ t: 'add', song: ug.songFromTab(rec.match, { content: rec.content, meta: { capo: meta.capo, tonality: meta.tonality, tuning: meta.tuning }, applicature: rec.applicature, strummings: rec.strummings }, { id: 's-d', yt: 'Lw7Q19mtly0', duration: 90, durationFrom: 'you' }) });
}"""
FAKE_YT = """() => {
  window.YT = { Player: class {
    constructor(el, opts) {
      this.opts = opts; this.state = -1; this.t0 = 0; window.__fakePlayer = this;
      const box = document.createElement('div'); box.className = 'fake-yt'; el.replaceWith(box);
      setTimeout(() => opts.events.onReady({ target: this }), 50);
    }
    getDuration() { return 90; }
    getCurrentTime() { return this.state === 1 ? (performance.now() - this.t0) / 1000 : 0; }
    getPlayerState() { return this.state; }
    playVideo() { this.state = 1; this.t0 = performance.now(); this.opts.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.state = 2; window.__paused = true; }
    seekTo() {}
    destroy() { window.__destroyed = true; }
  } };
}"""
DECK = """() => { const d = document.querySelector('.deck'); const r = d.getBoundingClientRect();
  return { tucked: d.classList.contains('tucked'), left: r.left, right: r.right, width: r.width, top: r.top, h: r.height, vw: innerWidth,
           inert: document.querySelector('.deck-more').inert, play: document.querySelector('.deck .play').getAttribute('aria-label') }; }"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def main():
    rec = json.load(open(os.path.join(ROOT, 'tests', 'corpus', 'songs', KEY + '.json'), encoding='utf-8'))
    base = start_server()
    with sync_playwright() as p:
        b = launch(p, 'chromium')
        ctx = b.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=3, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        cdp = ctx.new_cdp_session(page)

        def touch(points):  # [(x, y), ...] start, moves..., end
            (x, y), *rest = points
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
            for x2, y2 in rest:
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x2, 'y': y2}]})
                page.wait_for_timeout(16)
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            page.wait_for_timeout(450)  # the slide

        def tap(locator):
            r = locator.bounding_box()
            touch([(r['x'] + r['width'] / 2, r['y'] + r['height'] / 2)])

        def deck():
            return page.evaluate(DECK)

        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, rec)
        page.goto(base + '/#/song/s-d')
        page.wait_for_selector('.sheet .pair')
        d = deck()
        check(not d['tucked'] and d['width'] > 300, 'the bar starts out full width')
        check(page.locator('.deck-grip').get_attribute('aria-label') == 'Tuck the controls into the corner', 'with a grip on its left')

        tap(page.locator('.deck-grip'))
        d = deck()
        check(d['tucked'] and d['width'] < 100 and abs(d['vw'] - 12 - d['right']) < 2, f"tapping the grip tucks it into the bottom-right corner ({d['width']:.0f} px wide)")
        check(d['inert'], 'leaving only the grip and play/pause')
        tap(page.locator('.deck .play'))
        check(deck()['play'] == 'Pause autoscroll', 'play works while it’s tucked')
        tap(page.locator('.deck .play'))
        check(deck()['play'] == 'Start autoscroll', 'and pause')
        tap(page.locator('.deck-grip'))
        check(not deck()['tucked'] and deck()['width'] > 300, 'tapping the grip brings it back')

        d = deck()
        y = d['top'] + d['h'] / 2
        touch([(d['left'] + 12 + i * 20, y) for i in range(12)])
        check(deck()['tucked'], 'swiping it right from the grip tucks it away')
        d = deck()
        touch([(d['left'] + 40 - i * 15, y) for i in range(8)])
        check(not deck()['tucked'], 'swiping it left brings it back')
        t = page.locator('.deck-time').bounding_box()
        touch([(t['x'] + 10 + i * 20, t['y'] + t['height'] / 2) for i in range(10)])
        check(deck()['tucked'], 'a swipe across the time works too')
        tap(page.locator('.deck-grip'))

        slider = page.locator('.deck-speed').bounding_box()
        before = page.locator('.deck-time').inner_text()
        touch([(slider['x'] + slider['width'] * 0.5 + i * 8, slider['y'] + slider['height'] / 2) for i in range(10)])
        check(not deck()['tucked'] and page.locator('.deck-time').inner_text() != before, 'dragging the speed slider sets the speed, and doesn’t tuck the bar')

        tap(page.locator('.deck-grip'))
        page.reload()
        page.wait_for_selector('.sheet .pair')
        check(deck()['tucked'], 'it stays the way you left it')
        tap(page.locator('.deck-grip'))

        print('the YouTube player closes at a tap while everything plays')
        page.evaluate(FAKE_YT)
        tap(page.locator('.deck').get_by_role('button', name='Play along on YouTube'))
        expect(page.locator('.yt .fake-yt')).to_be_attached()
        page.wait_for_timeout(200)
        page.evaluate('window.__fakePlayer.playVideo()')
        page.wait_for_timeout(1200)
        check(deck()['play'] == 'Pause autoscroll', 'the video plays and the song scrolls with it')
        tap(page.get_by_role('button', name='Close video'))
        check(page.locator('.yt').count() == 0, 'one tap on ✕ closes it')
        check(page.evaluate('window.__paused === true && window.__destroyed === true'), 'and the sound stops')
        check(page.locator('.drawer').count() == 0, 'the tap doesn’t land on the song underneath')
        if errors:
            raise AssertionError(errors)
        b.close()
    print('The autoscroll bar works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
