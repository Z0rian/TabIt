"""Shared helpers for the Playwright test scripts: a local server in a thread and
the device matrix (WebKit stands in for iPhone/iPad Safari, Edge for Chrome)."""
import os
import socket
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import serve  # noqa: E402

_server = None


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def start_server(root=ROOT):
    """Serve the repo root on a free port, once per process. Returns the base URL."""
    global _server
    if _server:
        return _server[1]
    port = int(os.environ.get('TABIT_PORT') or free_port())
    httpd = serve.serve(port, root)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    _server = (httpd, f'http://127.0.0.1:{port}')
    return _server[1]


# name -> (engine, Playwright device name or None, overrides)
DEVICES = {
    'iphone-se': ('webkit', 'iPhone SE', {}),
    'iphone-15': ('webkit', 'iPhone 15', {}),
    'iphone-15-pro-max': ('webkit', 'iPhone 15 Pro Max', {}),
    'iphone-15-landscape': ('webkit', 'iPhone 15 landscape', {}),
    'ipad-mini': ('webkit', 'iPad Mini', {}),
    'ipad-pro-11': ('webkit', 'iPad Pro 11', {}),
    'ipad-pro-11-landscape': ('webkit', 'iPad Pro 11 landscape', {}),
    'pixel-7': ('chromium', 'Pixel 7', {}),
    'laptop': ('chromium', None, {'viewport': {'width': 1440, 'height': 900}, 'device_scale_factor': 1.5}),
    'laptop-small': ('chromium', None, {'viewport': {'width': 1280, 'height': 720}, 'device_scale_factor': 1}),
    'laptop-safari': ('webkit', None, {'viewport': {'width': 1440, 'height': 900}, 'device_scale_factor': 2}),
}


def launch(p, engine):
    if engine == 'webkit':
        return p.webkit.launch()
    return p.chromium.launch(channel='msedge')


_webkit_scale = {}


def webkit_scale(browser):
    """Playwright's WebKit on Windows multiplies the device pixel ratio by the
    system display scaling (e.g. 125%), which shrinks the CSS viewport. Measure
    that factor once so contexts can be corrected to the real device size."""
    key = id(browser)
    if key not in _webkit_scale:
        ctx = browser.new_context(viewport={'width': 400, 'height': 400}, device_scale_factor=1)
        page = ctx.new_page()
        page.set_content('<meta name="viewport" content="width=device-width,initial-scale=1">')
        w = page.evaluate('innerWidth')
        ctx.close()
        _webkit_scale[key] = 400 / w if w else 1
    return _webkit_scale[key]


def context_for(p, browser, device_name, **extra):
    engine, dev, overrides = DEVICES[device_name]
    opts = dict(p.devices[dev]) if dev else {}
    opts.pop('default_browser_type', None)
    opts.update(overrides)
    opts.update(extra)
    if engine == 'webkit':
        f = webkit_scale(browser)
        if abs(f - 1) > 0.01:
            vp = opts.get('viewport') or {'width': 1280, 'height': 720}
            opts['viewport'] = {'width': round(vp['width'] * f), 'height': round(vp['height'] * f)}
            # (screen stays in CSS pixels: mobile WebKit uses it as device-width)
            opts['device_scale_factor'] = opts.get('device_scale_factor', 1) / f
            # Its mobile mode then takes the uncorrected size as device-width and
            # lays pages out 25% too wide; desktop mode with touch is faithful.
            opts['is_mobile'] = False
    return browser.new_context(**opts)
