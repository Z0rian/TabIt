"""The loading screen: logo, strumming strings and a pun before the app is
ready; it stays long enough to read, then fades away over the working app.
Settings can turn the pun off.

    python tests/e2e_splash.py
"""
import sys
import time

from playwright.sync_api import sync_playwright, expect

from util import context_for, launch, start_server


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def main():
    base = start_server()
    with sync_playwright() as p:
        for engine, device in [('chromium', 'laptop'), ('webkit', 'iphone-15')]:
            b = launch(p, engine)
            ctx = context_for(p, b, device)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            print(f'[{device}]')
            page.goto(base + '/?splash#/', wait_until='commit')
            expect(page.locator('#root.splash .splash-strings')).to_be_visible()
            pun = page.locator('.splash-pun')
            expect(pun).not_to_be_empty()
            puns = page.evaluate("import('/js/puns.js').then(m => m.PUNS)")
            check(pun.inner_text() in puns, f'the loading screen shows a pun: “{pun.inner_text()}”')
            page.wait_for_selector('#root', state='detached', timeout=8000)
            gone = page.evaluate('performance.now()')
            check(gone >= 1300, f'it stays long enough to read ({gone / 1000:.1f} s after the page started)')
            page.get_by_role('link', name='Settings').click()
            expect(page.get_by_role('heading', name='Settings')).to_be_visible()
            check(True, 'then the app is there and works')
            # (a different address each time, so the page really loads again)
            last = page.evaluate("localStorage.getItem('tabit.lastPun')")
            page.goto(base + '/?splash&again#/', wait_until='commit')
            expect(page.locator('.splash-pun')).not_to_be_empty()
            check(page.evaluate("localStorage.getItem('tabit.lastPun')") != last, 'a different pun the next time')
            page.wait_for_selector('#root', state='detached', timeout=8000)
            page.goto(base + '/?splash&settings#/settings')
            page.wait_for_selector('#root', state='detached', timeout=8000)
            page.get_by_role('switch', name='Loading screen').uncheck(force=True)
            page.goto(base + '/?splash&off#/', wait_until='commit')
            expect(page.locator('#root.splash')).to_be_attached()
            words = page.locator('.splash-pun').inner_text()
            page.wait_for_selector('main .page')
            ready = page.evaluate('performance.now()')
            page.wait_for_selector('#root', state='detached', timeout=8000)
            gap = page.evaluate('performance.now()') - ready
            check(words == '' and gap < 700, f'with it switched off: no pun, and no waiting once the app is ready ({gap:.0f} ms)')
            if errors:
                raise AssertionError(errors)
            b.close()
    print('The loading screen works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
