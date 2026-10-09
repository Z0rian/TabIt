"""The Tabs & Chords import, through the UI: paste a list, watch it work, get
the same versions as favorites with their dates. Ultimate Guitar's answers come
from the local corpus. Also: closing the app halfway and coming back resumes.

    python tests/e2e_import.py
"""
import json
import os
import sys
import time
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect

from util import ROOT, context_for, launch, start_server

PROXY = 'https://ug-proxy.zorian.workers.dev'
KEYS = ['001-zach-bryan-something-in-the-orange-v1', '012-john-prine-angel-from-montgomery-v2', '050-vance-joy-riptide-v2',
        '109-jovi-greene-two-tone-top-v1', '110-jovi-greene-two-tone-top-v1', '170-kansas-dust-in-the-wind-v1']


def load(key):
    return json.load(open(os.path.join(ROOT, 'tests', 'corpus', 'songs', key + '.json'), encoding='utf-8'))


def tc_list(recs):
    lines = ['My tabs', 'Artist\tSong\tDate\tType\t']
    prev = None
    for r in recs:
        e = r['entry']
        if e['artist'] != prev:
            lines.append(e['artist'] + '\t')
            prev = e['artist']
        lines.append(e['title'] + (f" (ver {e['version']})" if e['version'] > 1 else ''))
        lines.append(f"{e['date']} \t{e['type']}\t")
    return '\n'.join(lines + ['Per page'])


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def main():
    recs = [load(k) for k in KEYS]
    by_url = {}
    for r in recs:
        for res in r['results']:
            by_url.setdefault(res['url'], None)
        by_url[r.get('fallback', r['match'])['url']] = r
        by_url[r['match']['url']] = r
    calls = {'search': 0, 'tab': 0}

    def proxy(route):
        q = parse_qs(urlparse(route.request.url).query)
        action = q.get('action', [''])[0]
        calls[action] = calls.get(action, 0) + 1
        if action == 'search':
            text = q['q'][0].lower()
            for r in recs:
                e = r['entry']
                if e['title'].lower() in text:
                    # what the deployed worker sends: no versions
                    res = [{k: x[k] for k in ('title', 'artist', 'type', 'rating', 'votes', 'url')} for x in r['results'] if x['type'] in ('Chords', 'Pro')]
                    return route.fulfill(content_type='application/json', body=json.dumps({'results': res}))
            return route.fulfill(content_type='application/json', body=json.dumps({'results': []}))
        if action == 'tab':
            r = by_url.get(q['url'][0])
            if not r or not r.get('content'):
                return route.fulfill(status=404, content_type='application/json', body=json.dumps({'error': 'Tab content not found on page'}))
            return route.fulfill(content_type='application/json', body=json.dumps({'content': r['content']}))
        return route.fulfill(content_type='application/json', body='{"error":"no"}')

    base = start_server()
    with sync_playwright() as p:
        b = launch(p, 'webkit')
        ctx = context_for(p, b, 'iphone-15')
        ctx.route(PROXY + '/**', proxy)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '/#/import')
        page.get_by_role('textbox', name='Your Tabs & Chords list').fill(tc_list(recs))
        expect(page.get_by_text('6 songs by 5 artists', exact=False)).to_be_visible()
        check(True, 'the pasted list is understood (6 songs, 5 artists)')
        page.get_by_role('button', name='Import 6 songs').click()
        expect(page.get_by_text('Import finished')).to_be_visible(timeout=60000)
        summary = page.locator('.card p').first.inner_text()
        print('   ', summary)
        songs = page.evaluate("async () => Object.values((await import('/js/store.js')).store.lib.songs)")
        titles = sorted(s['title'] for s in songs)
        check(len(songs) == 5, f'5 songs (the duplicate counted once): {titles}')
        check(all(s.get('fav') for s in songs), 'all marked as favorites')
        riptide = next(s for s in songs if s['title'] == 'Riptide')
        check(riptide['src']['url'] == load('050-vance-joy-riptide-v2')['match']['url'], 'Riptide (ver 2) is version 2, not the most popular one')
        dust = next(s for s in songs if s['title'] == 'Dust In The Wind')
        check(dust['src']['type'] == 'Chords' and dust['content'], 'the Guitar Pro favorite came in as its best Chords version')
        check(next(s for s in songs if s['title'] == 'Something In The Orange')['added'].startswith('2024-07-16'), 'the date it was favorited is kept')
        check('already' in summary or 'there' in summary, 'the duplicate entry is reported as already there')

        print('[resume] closing the app in the middle of an import')
        calls_before = calls.get('tab', 0)
        page.evaluate("async () => { const s = await import('/js/store.js'); for (const x of Object.values(s.store.lib.songs)) s.dispatch({ t: 'del', id: x.id }); }")
        page.goto(base + '/#/import')
        page.get_by_role('button', name='Import another list').click()
        page.get_by_role('textbox', name='Your Tabs & Chords list').fill(tc_list(recs))
        # slow Ultimate Guitar down so the import is still running when the app closes
        ctx.unroute(PROXY + '/**')
        ctx.route(PROXY + '/**', lambda route: (time.sleep(0.6), proxy(route)))
        page.get_by_role('button', name='Import 6 songs').click()
        time.sleep(1.5)
        page.close()
        page = ctx.new_page()
        page.goto(base + '/#/import')
        expect(page.get_by_text('Import finished')).to_be_visible(timeout=60000)
        n = page.evaluate("async () => Object.keys((await import('/js/store.js')).store.lib.songs).length")
        check(n == 5, f'after reopening it finished the job ({n} songs)')
        log = page.evaluate("JSON.parse(localStorage.getItem('tabit.import')).entries.map(e => e.status)")
        check('working' not in log and 'waiting' not in log, f'nothing left half done ({log})')
        if errors:
            raise AssertionError(errors)
        b.close()
    print('Importing works.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
