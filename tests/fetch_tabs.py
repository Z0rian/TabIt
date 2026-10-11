"""Builds the local tabs corpus used by tests/e2e_tabs.py and e2e_tab_song.py:
the most-voted Ultimate Guitar tabs of some bluegrass standards (guitar,
banjo-style and fiddle tunes, in many different ways of writing tablature).

    python tests/fetch_tabs.py
    python tests/fetch_tabs.py --per 5

Saved to tests/corpus/tabs/<the tab's address>.json, as the TabIt worker
answers (content, meta, song) plus the search result. Copyrighted: it stays
in tests/corpus/ (gitignored). One request every ~1.2 s, resumable.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'corpus', 'tabs')
PROXY = 'https://ug-proxy.zorian.workers.dev'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
DELAY = 1.2
TUNES = [
    'foggy mountain breakdown', 'cripple creek', 'blackberry blossom', 'salt creek', 'wildwood flower', 'soldiers joy',
    'old joe clark', 'red haired boy', 'whiskey before breakfast', 'shady grove', 'billy in the lowground',
    'black mountain rag', 'clinch mountain backstep', 'dueling banjos', 'man of constant sorrow', 'rocky top',
]


def call(**params):
    url = PROXY + '/?' + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Origin': 'http://localhost'})
            return json.load(urllib.request.urlopen(req, timeout=40))
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(3)
    raise err


def main():
    args = sys.argv[1:]
    per = int(args[args.index('--per') + 1]) if '--per' in args else 3
    os.makedirs(OUT, exist_ok=True)
    got = 0
    for q in TUNES:
        try:
            results = [r for r in call(action='search', q=q).get('results', []) if r.get('type') == 'Tabs']
        except Exception as e:  # noqa: BLE001
            print(f'{q}: search failed ({e})')
            continue
        time.sleep(DELAY)
        for r in sorted(results, key=lambda r: -(r.get('votes') or 0))[:per]:
            name = r['url'].rstrip('/').split('/')[-1]
            path = os.path.join(OUT, name + '.json')
            if os.path.exists(path):
                continue
            try:
                t = call(action='tab', url=r['url'])
            except Exception as e:  # noqa: BLE001
                print(f'  {name}: failed ({e})')
                continue
            t['result'] = r
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(t, f)
            got += 1
            print(f'  {name}')
            time.sleep(DELAY)
    print(f'{got} new tabs in {OUT}')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
