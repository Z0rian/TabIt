"""Pinching a song on a phone: the text itself grows or shrinks and re-wraps
to the screen as the fingers move (nothing runs off the right edge), the page
itself never zooms, and the size is kept with the song.

    python tests/e2e_pinch.py
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

from util import ROOT, launch, start_server

KEY = '001-zach-bryan-something-in-the-orange-v1'
SEED = """async (rec) => {
  const store = await import('/js/store.js');
  const ug = await import('/js/ug.js');
  const meta = rec.meta || {};
  store.dispatch({ t: 'add', song: ug.songFromTab(rec.match, { content: rec.content, meta: { capo: meta.capo, tonality: meta.tonality, tuning: meta.tuning }, applicature: rec.applicature, strummings: rec.strummings }, { id: 's-p' }) });
}"""
STATE = """() => {
  const sheet = document.querySelector('.sheet');
  const right = Math.max(...[...sheet.querySelectorAll('.blk:not(.tab)')].map(b => b.getBoundingClientRect().right));
  return { fs: parseFloat(getComputedStyle(sheet).fontSize), right, width: innerWidth, scroll: document.documentElement.scrollWidth, zoom: visualViewport.scale };
}"""


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
        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, rec)
        page.goto(base + '/#/song/s-p')
        page.wait_for_selector('.sheet .pair')
        page.evaluate('scrollTo(0, 700)')
        page.wait_for_timeout(300)
        cdp = ctx.new_cdp_session(page)
        start = page.evaluate(STATE)

        def touch(kind, a, b_):
            pts = [] if kind == 'touchEnd' else [{'x': 195, 'y': a, 'id': 1}, {'x': 195, 'y': b_, 'id': 2}]
            cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': pts})

        # fingers apart: bigger
        touch('touchStart', 380, 420)
        mid = []
        for step in range(1, 11):
            touch('touchMove', 380 - step * 12, 420 + step * 12)
            page.wait_for_timeout(40)
            mid.append(page.evaluate(STATE))
        touch('touchEnd', 0, 0)
        page.wait_for_timeout(500)
        end = page.evaluate(STATE)
        check(end['fs'] > start['fs'] * 1.5, f"pinching out makes the text bigger ({start['fs']:.0f} → {end['fs']:.0f} px)")
        check(any(m['fs'] > start['fs'] for m in mid[:5]), 'it grows while the fingers move, not only after')
        check(all(m['right'] <= m['width'] + 1 and m['scroll'] <= m['width'] for m in mid + [end]), 'the lines re-wrap to the screen: nothing runs off the right edge')
        check(all(m['zoom'] == 1 for m in mid + [end]), 'the page itself never zooms')
        saved = page.evaluate("async () => (await import('/js/store.js')).store.lib.songs['s-p'].view?.fs")
        check(saved == round(end['fs'] / 0.84) or saved == round(end['fs']), f'the size is kept with the song ({saved} px)')
        r = page.evaluate("""async () => { const { checkSheet } = await import('/tests/align.js'); await document.fonts.ready; return checkSheet(document.querySelector('.sheet')); }""")
        check(not r['problems'], f"and every chord is still over its word ({r['checked']} checked)")
        # fingers together: smaller
        touch('touchStart', 300, 500)
        for step in range(1, 9):
            touch('touchMove', 300 + step * 12, 500 - step * 12)
            page.wait_for_timeout(40)
        touch('touchEnd', 0, 0)
        page.wait_for_timeout(400)
        small = page.evaluate(STATE)
        check(small['fs'] < end['fs'], f"pinching in makes it smaller again ({end['fs']:.0f} → {small['fs']:.0f} px)")
        # anywhere else in the app, a pinch does nothing
        page.goto(base + '/#/settings')
        page.wait_for_selector('.page')
        touch('touchStart', 380, 420)
        for step in range(1, 8):
            touch('touchMove', 380 - step * 15, 420 + step * 15)
        touch('touchEnd', 0, 0)
        page.wait_for_timeout(300)
        check(page.evaluate('visualViewport.scale') == 1, 'pinching other screens doesn’t zoom the page')
        if errors:
            raise AssertionError(errors)
        b.close()
    print('Pinching works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
