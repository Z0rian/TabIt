"""Chord alignment across devices, zoom levels and layouts, in real pixels.

    python tests/e2e_align.py              # quick: a sample of songs, 2 sizes
    python tests/e2e_align.py --full       # every song, 4 sizes, both layouts
    python tests/e2e_align.py --devices iphone-se,ipad-pro-11

Uses the local corpus (tests/corpus, see fetch_corpus.py). Each song is drawn
by the real renderer + stylesheet in tests/sheet.html and measured by
tests/align.js: every chord must start exactly over its character, sit on the
line right above it, and never touch another chord or cover lyrics.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

from util import DEVICES, ROOT, context_for, launch, start_server

DEFAULT_DEVICES = ['iphone-se', 'iphone-15', 'iphone-15-pro-max', 'iphone-15-landscape', 'ipad-mini', 'ipad-pro-11',
                   'ipad-pro-11-landscape', 'pixel-7', 'laptop', 'laptop-small', 'laptop-safari']


def main():
    args = sys.argv[1:]
    full = '--full' in args
    devices = DEFAULT_DEVICES
    if '--devices' in args:
        devices = args[args.index('--devices') + 1].split(',')
    index = json.load(open(os.path.join(ROOT, 'tests', 'corpus', 'index.json'), encoding='utf-8'))
    keys = [k for k in index if os.path.exists(os.path.join(ROOT, 'tests', 'corpus', 'songs', k + '.json'))]
    if not full:
        keys = keys[::6]
    sizes = [14, 18, 26, 34] if full else [16, 28]
    modes = [False, True] if full else [False]
    base = start_server()
    report = {}
    total_problems = 0
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
            checked = 0
            problems = []
            for key in keys:
                page.evaluate('k => window.__tabit.load(k)', key)
                for mono in modes:
                    for fs in sizes:
                        r = page.evaluate('o => { window.__tabit.set(o); return window.__tabit.check(); }', {'fs': fs, 'mono': mono})
                        checked += r['checked']
                        for prob in r['problems']:
                            problems.append({'song': key, 'fs': fs, 'mono': mono, **prob})
            report[dev] = {'checked': checked, 'problems': problems, 'errors': errors}
            total_problems += len(problems)
            status = 'OK  ' if not problems and not errors else 'FAIL'
            print(f'[{dev:22}] {status} {checked:6d} chords measured, {len(problems)} problems' + (f', {len(errors)} page errors' if errors else ''), flush=True)
            for prob in problems[:6]:
                print('     ', prob)
            for e in errors[:3]:
                print('      page error:', e)
            ctx.close()
        for b in browsers.values():
            b.close()
    os.makedirs(os.path.join(ROOT, 'tests', 'out'), exist_ok=True)
    json.dump(report, open(os.path.join(ROOT, 'tests', 'out', 'align-report.json'), 'w'), indent=1)
    print(f'{len(keys)} songs × {len(sizes)} sizes × {len(modes)} layouts on {len(devices)} devices in {time.time() - t0:.0f}s: {total_problems} problems')
    sys.exit(1 if total_problems else 0)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
