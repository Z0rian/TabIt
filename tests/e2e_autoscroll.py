"""Autoscroll keeps time: a song set to N seconds scrolls through in N seconds,
twice as fast at 2×, holds still when paused, and carries on from wherever you
scroll to by hand.

    python tests/e2e_autoscroll.py
"""
import sys
import time

from playwright.sync_api import sync_playwright

from util import context_for, launch, start_server

LINES = '\n'.join(f'[ch]G[/ch]          [ch]C[/ch]         [ch]D[/ch]\nLine number {i} of a song that goes on and on for a while' for i in range(60))
SONG = {'id': 's-scroll', 'title': 'Long Road', 'artist': 'Test', 'content': '[Verse]\n' + LINES}

SEED = """async (song) => {
  const store = await import('/js/store.js');
  const model = await import('/js/model.js');
  store.dispatch({ t: 'add', song: model.makeSong(song) });
}"""

READ = """() => {
  const sheet = document.querySelector('.sheet');
  const blocks = [...sheet.querySelectorAll('.pair')];
  const line = innerHeight * 0.36;
  // index of the lyric line at the reading position, as a fraction of all lines
  let i = blocks.findIndex(b => b.getBoundingClientRect().bottom > line);
  if (i < 0) i = blocks.length - 1;
  return { y: scrollY, max: document.documentElement.scrollHeight - innerHeight, frac: i / (blocks.length - 1) };
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def play_for(page, seconds, step=0.5):
    out = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        out.append((time.time() - t0, page.evaluate(READ)))
        time.sleep(step)
    return out


def run(engine, device, base):
    with sync_playwright() as p:
        b = launch(p, engine)
        page = context_for(p, b, device).new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, {**SONG, 'duration': 16, 'durationFrom': 'you'})
        page.goto(base + '/#/song/s-scroll')
        page.wait_for_selector('.sheet .pair')
        time.sleep(0.5)
        play = page.locator('.deck .play')

        print(f'[{device}] 16-second song at 100%')
        play.click()
        samples = play_for(page, 18.5)
        ys = [s[1]['y'] for s in samples]
        check(all(b >= a - 1 for a, b in zip(ys, ys[1:])), 'only ever scrolls forward')
        mid = min(samples, key=lambda s: abs(s[0] - 8))[1]['frac']
        check(0.38 <= mid <= 0.62, f'halfway through the song after half the time (line {mid:.0%} at 8 s)')
        end_t = next((t for t, s in samples if s['y'] >= s['max'] - 2), None)
        check(end_t is not None and 12 <= end_t <= 17.5, f'reaches the end on time ({end_t and round(end_t, 1)} s of 16)')
        check('Pause' not in page.locator('.deck .play').get_attribute('aria-label'), 'stops by itself at the end')

        print(f'[{device}] 2× speed')
        page.evaluate('scrollTo(0, 0)')
        page.locator('.deck-speed').fill('1')  # log2(2)
        play.click()
        samples = play_for(page, 10.5)
        end_t = next((t for t, s in samples if s['y'] >= s['max'] - 2), None)
        check(end_t is not None and 5.5 <= end_t <= 9.2, f'twice as fast ({end_t and round(end_t, 1)} s of 8)')

        print(f'[{device}] pause, and taking over by hand')
        page.evaluate('scrollTo(0, 0)')
        page.locator('.deck-speed').fill('0')
        play.click()
        time.sleep(4)
        play.click()
        y1 = page.evaluate('scrollY')
        time.sleep(1.5)
        check(abs(page.evaluate('scrollY') - y1) < 2, 'holds still while paused')
        play.click()
        time.sleep(2)
        before = page.evaluate('scrollY')
        # a finger drags the page back up (touch on the phone, wheel on the laptop)
        page.evaluate("dispatchEvent(new Event('touchstart')); scrollBy(0, -500)")
        time.sleep(0.3)
        page.evaluate("scrollBy(0, -100); dispatchEvent(new Event('touchend'))")
        time.sleep(0.1)
        after_drag = page.evaluate('scrollY')
        check(after_drag < before - 450, f'a hand scroll back up wins ({before:.0f} → {after_drag:.0f})')
        time.sleep(2)
        later = page.evaluate('scrollY')
        check(after_drag < later < before, f'and it carries on from there ({after_drag:.0f} → {later:.0f}) instead of jumping back to {before:.0f}')
        play.click()
        if errors:
            raise AssertionError(errors)
        b.close()


def main():
    base = start_server()
    for engine, device in [('chromium', 'laptop'), ('webkit', 'iphone-15')]:
        run(engine, device, base)
    print('Autoscroll keeps time.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
