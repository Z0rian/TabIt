"""Following a YouTube video, used like a person would, on a phone and a
laptop, with a stand-in for YouTube's player whose clock the test sets:

  - a long tab riff at the top gets its time by its length, so once the video
    is past it the words are on screen, not still the riff;
  - scrolled by hand while the video plays (the line you hear put at the
    marker), it stays there and follows on from there, and remembers it the
    next time the song is opened; it can be told to forget;
  - pausing the video pauses the scrolling.

    python tests/e2e_follow.py
"""
import sys
import time

from playwright.sync_api import sync_playwright

from util import context_for, launch, start_server

RIFF = ['e|' + '-' * 96 + '|', 'B|' + '--3--1--0' * 10 + '-' * 6 + '|', 'G|' + '-0---2---' * 10 + '-' * 6 + '|',
        'D|' + '-' * 96 + '|', 'A|' + '-' * 96 + '|', 'E|' + '-' * 96 + '|']
LINES = [f'[ch]G[/ch]          [ch]C[/ch]         [ch]D[/ch]\nLine number {i} of a song that goes on for a while' for i in range(40)]
CONTENT = '\n'.join(['Tabbed by me. Play it with feeling.', '', '[Intro]', *[f'[tab]{chr(10).join(RIFF)}[/tab]\n' for _ in range(4)], '[Verse]', *LINES])
SONG = {'id': 's-follow', 'title': 'Follow Me', 'artist': 'Test', 'content': CONTENT, 'yt': 'aaaaaaaaaaa', 'duration': 120, 'durationFrom': 'yt'}

SEED = """async (song) => {
  const store = await import('/js/store.js');
  const model = await import('/js/model.js');
  store.dispatch({ t: 'add', song: model.makeSong(song) });
}"""

# Just enough of YouTube's IFrame API, with a clock the test can set.
FAKE_YT = """() => {
  window.YT = { Player: class {
    constructor(el, opts) {
      this.opts = opts; this.state = -1; this.base = 0; this.t0 = 0; window.__fakePlayer = this;
      const box = document.createElement('div'); box.className = 'fake-yt'; box.textContent = 'video'; el.replaceWith(box);
      setTimeout(() => opts.events.onReady({ target: this }), 50);
    }
    getDuration() { return 120; }
    getCurrentTime() { return this.state === 1 ? this.base + (performance.now() - this.t0) / 1000 : this.base; }
    getPlayerState() { return this.state; }
    playVideo() { this.base = this.getCurrentTime(); this.t0 = performance.now(); this.state = 1; this.opts.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.base = this.getCurrentTime(); this.state = 2; this.opts.events.onStateChange({ data: 2 }); }
    seekTo(t) { this.base = t; this.t0 = performance.now(); }
    destroy() {}
  } };
}"""

# the block at the reading line, and where it is
AT_LINE = """() => {
  const y = innerHeight * 0.36;
  const blocks = [...document.querySelector('.sheet').children];
  // (the block there, or the next one if it's in the space between two)
  let i = blocks.findIndex(b => { const r = b.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
  if (i < 0) i = blocks.findIndex(b => b.getBoundingClientRect().top > y);
  return { i, kind: i >= 0 ? blocks[i].classList[1] : null, scroll: scrollY, following: !!document.querySelector('.read-line.on') };
}"""

RIFF_SHARE = """() => {
  const music = [...document.querySelector('.sheet').children].filter(b => !b.classList.contains('pre'));
  const w = b => +b.dataset.w || 0;
  return music.filter(b => b.classList.contains('tab')).reduce((a, b) => a + w(b), 0) / music.reduce((a, b) => a + w(b), 0);
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def video_to(page, t):
    page.evaluate('t => window.__fakePlayer.seekTo(t)', t)


def open_song(page, base):
    page.goto(base + '/#/song/s-follow')
    page.wait_for_selector('.sheet .tab')
    page.evaluate(FAKE_YT)
    page.locator('.deck').get_by_role('button', name='Play along on YouTube').click(force=True)
    page.wait_for_function('window.__fakePlayer && window.__fakePlayer.opts')
    time.sleep(0.3)


def run(engine, device, base):
    with sync_playwright() as p:
        b = launch(p, engine)
        ctx = context_for(p, b, device)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '/#/')
        page.wait_for_selector('main .page')
        page.evaluate(SEED, SONG)
        open_song(page, base)

        print(f'[{device}] the riff at the top gets its time by its length')
        share = page.evaluate(RIFF_SHARE)
        video_to(page, 120 * share + 2)
        page.evaluate('window.__fakePlayer.playVideo()')
        time.sleep(2.5)  # (the glide into place)
        at = page.evaluate(AT_LINE)
        check(at['kind'] in ('pair', 'sec', 'gap'), f'{share:.0%} of the way in, past the riff: the words are at the marker ({at["kind"]})')
        check(page.locator('.read-line.on').count() == 1, 'with the marker at the left, showing the line it’s at')

        print(f'[{device}] moved by hand, it follows on from there')
        video_to(page, 40)
        time.sleep(2.5)
        before = page.evaluate(AT_LINE)
        page.mouse.move(200, 300)
        page.mouse.wheel(0, 320)
        time.sleep(1.6)  # (it lets go 0.7 s after the last scroll)
        after = page.evaluate(AT_LINE)
        check(after['scroll'] > before['scroll'] + 220, f'it stays where it was put ({before["scroll"]:.0f} → {after["scroll"]:.0f}), instead of going back')
        time.sleep(3)
        later = page.evaluate(AT_LINE)
        check(later['scroll'] > after['scroll'] + 5, f'and goes on from there with the video ({after["scroll"]:.0f} → {later["scroll"]:.0f})')
        sync = page.evaluate("async () => (await import('/js/store.js')).store.lib.songs['s-follow'].view?.sync")
        check(sync and len(sync['pts']) == 1 and 39 <= sync['pts'][0][0] <= 43 and sync['v'] == SONG['yt'], f'remembered for this song and video ({sync and sync["pts"]})')
        synced_block = sync['pts'][0][1]

        page.evaluate('window.__fakePlayer.pauseVideo()')
        time.sleep(0.8)
        check(page.locator('.deck .play').get_attribute('aria-label') == 'Start autoscroll', 'pausing the video pauses the scrolling')
        held = page.evaluate('scrollY')
        time.sleep(1)
        check(abs(page.evaluate('scrollY') - held) < 2, 'and it holds still')

        print(f'[{device}] the next time, it’s lined up already')
        page.goto(base + '/#/')
        open_song(page, base)
        video_to(page, sync['pts'][0][0])
        page.evaluate('window.__fakePlayer.playVideo()')
        time.sleep(2.5)
        again = page.evaluate(AT_LINE)
        check(abs(again['i'] - synced_block) <= 1, f'at that moment of the video, the same line at the marker (block {again["i"]}, synced at {synced_block})')
        page.evaluate('window.__fakePlayer.pauseVideo()')
        page.locator('.deck').get_by_role('button', name='Song length').click(force=True)
        page.get_by_text('Forget where it’s synced to the video').click()
        time.sleep(0.4)
        sync = page.evaluate("async () => (await import('/js/store.js')).store.lib.songs['s-follow'].view?.sync")
        check(not sync, 'and it can forget it')
        if errors:
            raise AssertionError(errors)
        b.close()


def main():
    base = start_server()
    run('webkit', 'iphone-15', base)
    run('chromium', 'laptop', base)
    print('Following the video works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
