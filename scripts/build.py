"""Stamps the service worker with the list of app files and a hash of them.

    python scripts/build.py           # update sw.js and js/version.js
    python scripts/build.py --check   # exit 1 if they're out of date (tests run this)

GitHub Pages serves the repository as it is, so the stamped files are
committed. A changed hash is what makes phones download the new version.
Also refuses to go on if anything private could end up published.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(ROOT, 'sw.js')
VERSION = os.path.join(ROOT, 'js', 'version.js')


def app_files():
    files = ['index.html', 'styles.css', 'manifest.json']
    for d in ['js', 'js/views']:
        for f in sorted(os.listdir(os.path.join(ROOT, d))):
            if f.endswith('.js'):
                files.append(f'{d}/{f}')
    for f in sorted(os.listdir(os.path.join(ROOT, 'fonts'))):
        if f.endswith('.woff2'):
            files.append(f'fonts/{f}')
    # (the big install icons are fetched by the system when installing, not needed offline)
    for f in ['icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png']:
        if os.path.exists(os.path.join(ROOT, f)):
            files.append(f)
    return files


def digest(files):
    h = hashlib.sha256()
    for f in files:
        if f == 'js/version.js':
            continue  # it holds the hash itself
        h.update(f.encode())
        data = open(os.path.join(ROOT, f), 'rb').read()
        h.update(data.replace(b'\r\n', b'\n'))
    return h.hexdigest()[:10]


def stamped_sw(build, files):
    sw = open(SW, encoding='utf-8').read()
    block = "// BUILD-START\nconst BUILD = '%s';\nconst PRECACHE = %s;\n// BUILD-END" % (build, json.dumps(['./'] + files, indent=2).replace('"', "'"))
    return re.sub(r'// BUILD-START.*?// BUILD-END', lambda m: block, sw, flags=re.S)


def stamped_version(build):
    return f"// Written by scripts/build.py.\nexport const BUILD = '{build}';\n"


def safety():
    # copyrighted song text and personal lists must never be committed
    out = subprocess.run(['git', '-C', ROOT, 'ls-files', 'tests/corpus'], capture_output=True, text=True).stdout.split()
    leaked = [f for f in out if not f.endswith('.gitignore')]
    if leaked:
        sys.exit(f'Refusing to build: these local test files are tracked by git: {leaked[:5]}')
    staged = subprocess.run(['git', '-C', ROOT, 'diff', '--cached', '--name-only'], capture_output=True, text=True).stdout.split()
    leaked = [f for f in staged if f.startswith('tests/corpus/') and not f.endswith('.gitignore')]
    if leaked:
        sys.exit(f'Refusing to build: local test files are staged: {leaked[:5]}')


def main():
    check = '--check' in sys.argv
    safety()
    files = app_files()
    build = digest(files)
    sw_new = stamped_sw(build, files)
    ver_new = stamped_version(build)
    sw_old = open(SW, encoding='utf-8').read()
    ver_old = open(VERSION, encoding='utf-8').read() if os.path.exists(VERSION) else ''
    if check:
        if sw_new != sw_old or ver_new != ver_old:
            sys.exit('sw.js / js/version.js are out of date: run python scripts/build.py')
        print(f'Build {build} is up to date ({len(files)} files).')
        return
    with open(SW, 'w', encoding='utf-8', newline='\n') as f:
        f.write(sw_new)
    with open(VERSION, 'w', encoding='utf-8', newline='\n') as f:
        f.write(ver_new)
    size = sum(os.path.getsize(os.path.join(ROOT, f)) for f in files)
    print(f'Build {build}: {len(files)} files, {size / 1024:.0f} KB cached for offline.')


if __name__ == '__main__':
    main()
