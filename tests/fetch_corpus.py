"""Builds a local test corpus from a Tabs & Chords "My tabs" list.

    python tests/fetch_corpus.py                      # reads tests/corpus/tc-favorites.txt
    python tests/fetch_corpus.py --limit 20

For each entry it searches Ultimate Guitar, picks the same version and type,
and saves the tab page data to tests/corpus/songs/<n>-<slug>.json. Also writes
tests/corpus/index.json (entry -> match) and keeps the raw search results so the
app's own matcher can be tested against them.

The corpus is copyrighted song text: it stays in tests/corpus/ (gitignored) and
is only used by the local tests. One request every ~1.2 s, resumable.
"""
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(ROOT, 'corpus')
SONGS = os.path.join(CORPUS, 'songs')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
DELAY = 1.2

DATE_RX = re.compile(r'^\s*((?:[A-Z][a-z]{2} \d{1,2}, \d{4})|(?:\d+ (?:days?|hours?|minutes?|weeks?|months?) ago)|today|yesterday)\s*\t?\s*([A-Za-z][A-Za-z ]*?)?\s*\t?\s*$', re.I)


def parse_tc(text):
    lines = [l.rstrip('\r') for l in text.split('\n')]
    try:
        start = next(i for i, l in enumerate(lines) if re.match(r'^\s*Artist\s*\tSong\s*\tDate', l)) + 1
    except StopIteration:
        start = 0
    out, artist = [], ''
    for i in range(start, len(lines)):
        m = DATE_RX.match(lines[i])
        if not m or i - 1 < start:
            continue
        title = lines[i - 1].strip()
        prev = lines[i - 2] if i - 2 >= start else ''
        if prev.strip() and not DATE_RX.match(prev):
            artist = prev.strip()
        ver = 1
        vm = re.search(r'\s*\(ver (\d+)\)\s*$', title, re.I)
        if vm:
            ver = int(vm.group(1))
            title = title[:vm.start()].strip()
        out.append({'artist': artist, 'title': title, 'version': ver, 'type': (m.group(2) or 'Chords').strip(), 'date': m.group(1)})
    return out


def norm(s):
    s = html.unescape(s or '').lower().replace('&', 'and')
    s = re.sub(r"[’'`.]", '', s)
    s = re.sub(r'\(.*?\)', ' ', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,*/*'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode('utf-8', 'replace')


def store(page):
    m = re.search(r'class="js-store"\s+data-content="([^"]+)"', page)
    if not m:
        raise RuntimeError('no js-store')
    return json.loads(html.unescape(m.group(1)))


def search(q):
    url = 'https://www.ultimate-guitar.com/search.php?' + urllib.parse.urlencode({'search_type': 'title', 'value': q})
    data = store(get(url))['store']['page']['data']
    res = data.get('results') or []
    return [{'title': r.get('song_name', ''), 'artist': r.get('artist_name', ''), 'type': r.get('type', ''), 'version': r.get('version'),
             'rating': r.get('rating') or 0, 'votes': r.get('votes') or 0, 'url': r.get('tab_url', '')}
            for r in res if r.get('type')]


TYPE_MAP = {'chords': 'Chords', 'guitar pro': 'Pro', 'tab': 'Tabs', 'tabs': 'Tabs', 'bass': 'Bass Tabs', 'ukulele': 'Ukulele Chords'}


def pick(entry, results):
    want_type = TYPE_MAP.get(entry['type'].lower(), entry['type'])
    a, t = norm(entry['artist']), norm(entry['title'])
    same = [r for r in results if norm(r['title']) == t and (norm(r['artist']) == a or a in norm(r['artist']) or norm(r['artist']) in a)]
    typed = [r for r in same if r['type'] == want_type]
    for r in typed:
        if r['version'] == entry['version']:
            return r, 'exact'
    if typed:
        return max(typed, key=lambda r: r['votes']), 'type'
    chords = [r for r in same if r['type'] == 'Chords']
    if chords:
        return max(chords, key=lambda r: r['votes']), 'chords-fallback'
    return None, 'none'


def fetch_tab(url):
    pd = store(get(url))['store']['page']['data']
    tv, tab = pd.get('tab_view', {}), pd.get('tab', {})
    return {
        'tab': {k: tab.get(k) for k in ['id', 'song_name', 'artist_name', 'type', 'version', 'votes', 'rating', 'tonality_name', 'difficulty', 'tab_url']},
        'meta': tv.get('meta'),
        'content': (tv.get('wiki_tab') or {}).get('content', ''),
        'applicature': tv.get('applicature'),
        'strummings': tv.get('strummings'),
        'versions': [{'version': v.get('version'), 'type': v.get('type'), 'url': v.get('tab_url'), 'rating': v.get('rating'), 'votes': v.get('votes')} for v in tv.get('versions') or []],
    }


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:60]


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    os.makedirs(SONGS, exist_ok=True)
    entries = parse_tc(open(os.path.join(CORPUS, 'tc-favorites.txt'), encoding='utf-8').read())
    print(f'{len(entries)} entries', flush=True)
    idx_path = os.path.join(CORPUS, 'index.json')
    index = json.load(open(idx_path, encoding='utf-8')) if os.path.exists(idx_path) else {}
    for n, e in enumerate(entries[:limit] if limit else entries):
        key = f"{n:03d}-{slug(e['artist'] + ' ' + e['title'])}-v{e['version']}"
        path = os.path.join(SONGS, key + '.json')
        if os.path.exists(path):
            continue
        try:
            results = search(f"{e['artist']} {e['title']}")
            time.sleep(DELAY)
            match, how = pick(e, results)
            if not match:
                results2 = search(e['title'])
                time.sleep(DELAY)
                match, how = pick(e, results2)
                results = results + results2
            rec = {'entry': e, 'how': how, 'match': match, 'results': results}
            if match and match['type'] != 'Pro':
                rec.update(fetch_tab(match['url']))
                time.sleep(DELAY)
            json.dump(rec, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            index[key] = {'entry': e, 'how': how, 'url': match and match['url'], 'version': match and match['version']}
            json.dump(index, open(idx_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print(f"{n:3d} {how:16} {e['artist']} — {e['title']} (ver {e['version']}) -> {match and match['url']}", flush=True)
        except Exception as ex:  # keep going; rerun to retry
            print(f"{n:3d} ERROR {e['artist']} — {e['title']}: {ex}", flush=True)
            time.sleep(5)


if __name__ == '__main__':
    main()
