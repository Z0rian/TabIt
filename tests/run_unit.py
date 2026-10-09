"""Run the browser unit tests (tests/unit.html) in WebKit and Edge.

    python tests/run_unit.py               # both engines
    python tests/run_unit.py webkit        # one engine
    python tests/run_unit.py --filter parse
"""
import json
import sys

from playwright.sync_api import sync_playwright

from util import start_server, launch


def main():
    args = sys.argv[1:]
    filt = ''
    if '--filter' in args:
        i = args.index('--filter')
        filt = args[i + 1]
        del args[i:i + 2]
    engines = args or ['webkit', 'chromium']
    base = start_server()
    failed = 0
    with sync_playwright() as p:
        for engine in engines:
            browser = launch(p, engine)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'{base}/tests/unit.html?filter={filt}')
            page.wait_for_function('window.__results', timeout=180_000)
            r = page.evaluate('window.__results')
            status = 'OK ' if not r['failed'] else 'FAIL'
            print(f"[{engine:8}] {status} {r['passed']}/{r['count']} passed ({r['durationMs']} ms)")
            for f in r['failures']:
                print(f"   ✗ [{f['file']}] {f['name']}\n     {f['error']}")
                if f.get('stack'):
                    print('     ' + f['stack'].replace('\n', '\n     '))
            for e in errors:
                print(f'   console: {e}')
            failed += r['failed']
            browser.close()
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
