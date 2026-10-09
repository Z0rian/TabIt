"""Screenshots of any page on the local server, per device.

    python tests/shot.py "/tests/sheet.html?song=001-...&nodev=1" iphone-15 ipad-pro-11 laptop
    python tests/shot.py "/#/library" iphone-15 --theme dark --full

Saves to tests/out/<device>-<theme>-<n>.png and prints the paths.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

from util import DEVICES, ROOT, context_for, launch, start_server

OUT = os.path.join(ROOT, 'tests', 'out')


def main():
    args = sys.argv[1:]
    theme = None
    full = '--full' in args
    if full:
        args.remove('--full')
    if '--theme' in args:
        i = args.index('--theme')
        theme = args[i + 1]
        del args[i:i + 2]
    wait = 1.2
    if '--wait' in args:
        i = args.index('--wait')
        wait = float(args[i + 1])
        del args[i:i + 2]
    path, devices = args[0], args[1:] or ['iphone-15']
    base = start_server()
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        browsers = {}
        for name in devices:
            engine = DEVICES[name][0]
            browsers.setdefault(engine, launch(p, engine))
            ctx = context_for(p, browsers[engine], name, color_scheme='dark' if theme in ('dark', 'black') else 'light')
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(base + path)
            if theme:
                page.evaluate(f"document.documentElement.dataset.theme = '{theme}'")
            time.sleep(wait)
            out = os.path.join(OUT, f"{name}-{theme or 'light'}-{int(time.time() * 1000) % 100000}.png")
            page.screenshot(path=out, full_page=full)
            print(out)
            for e in errors:
                print('   console:', e)
            ctx.close()
        for b in browsers.values():
            b.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
