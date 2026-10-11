"""Tablature laid out on phones, tablets and laptops, in real pixels.

    python tests/e2e_tabs.py                  # every tab in tests/corpus/tabs, 3 sizes
    python tests/e2e_tabs.py --devices iphone-se,laptop

Uses local tabs (tests/corpus/tabs, see fetch_tabs.py). Each one is drawn by
the real renderer + stylesheet in tests/sheet.html and checked by
tests/tabcheck.js: every staff keeps all its rows in every part it's cut into,
nothing runs past the edge, the parts put together are the staff as written,
and no fret number is cut in two.
"""
import glob
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

from util import DEVICES, ROOT, context_for, launch, start_server

DEFAULT_DEVICES = ['iphone-se', 'iphone-15', 'ipad-mini', 'pixel-7', 'laptop']


def main():
    args = sys.argv[1:]
    devices = args[args.index('--devices') + 1].split(',') if '--devices' in args else DEFAULT_DEVICES
    names = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(ROOT, 'tests', 'corpus', 'tabs', '*.json')))
    if not names:
        print('No tabs in tests/corpus/tabs. Run tests/fetch_tabs.py first.')
        sys.exit(1)
    sizes = [16, 20, 28]
    base = start_server()
    total = 0
    t0 = time.time()
    with sync_playwright() as p:
        browsers = {}
        for dev in devices:
            engine = DEVICES[dev][0]
            browsers.setdefault(engine, launch(p, engine))
            ctx = context_for(p, browsers[engine], dev)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'{base}/tests/sheet.html?nodev=1')
            page.wait_for_function('window.__ready', timeout=60_000)
            problems = []
            stats = {'staves': 0, 'oneRow': 0, 'rows': 0, 'smaller': 0, 'notesAbove': 0}
            for name in names:
                page.evaluate('n => window.__tabit.loadTab(n)', name)
                for fs in sizes:
                    r = page.evaluate('fs => { window.__tabit.set({ fs }); return window.__tabit.checkTabs(); }', fs)
                    for k, v in r['stats'].items():
                        stats[k] += v
                    problems += [{'tab': name, 'fs': fs, **x} for x in r['problems']]
            total += len(problems)
            status = 'OK  ' if not problems and not errors else 'FAIL'
            print(f"[{dev:12}] {status} {stats['staves']} staves: {stats['oneRow'] / max(1, stats['staves']):.0%} in one row, "
                  f"{stats['rows'] / max(1, stats['staves']):.2f} rows each, {stats['smaller']} made smaller, "
                  f"{stats['notesAbove']} with their notes above; {len(problems)} problems" + (f', {len(errors)} page errors' if errors else ''), flush=True)
            for x in problems[:8]:
                print('     ', x)
            for e in errors[:3]:
                print('      page error:', e)
            total += len(errors)
            ctx.close()
        for b in browsers.values():
            b.close()
    print(f'{len(names)} tabs × {len(sizes)} sizes on {len(devices)} devices in {time.time() - t0:.0f}s: {total} problems')
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
