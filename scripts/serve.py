"""Local dev server for TabIt.

    python scripts/serve.py            # http://127.0.0.1:8090, serves the repo root
    python scripts/serve.py 8091

Sends Cache-Control: no-store so edits show up on reload, and forces the right
MIME types (Python on Windows reads them from the registry, which can say
text/plain for .js and break ES modules).
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get('TABIT_SERVE_LOG'):
            super().log_message(fmt, *args)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Browsers drop connections all the time (favicon probes, navigations).
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve(port=8090, root=ROOT):
    return Server(('127.0.0.1', port), functools.partial(Handler, directory=root))


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    print(f'TabIt dev server: http://127.0.0.1:{port}/  (root {ROOT})', flush=True)
    serve(port).serve_forever()
