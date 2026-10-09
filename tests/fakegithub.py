"""A fake GitHub REST API: just the calls TabIt makes, with the same rules (a
branch only moves forward, writes need a valid key, anyone can read a public
file). Lets several browsers — a "phone" and a "laptop" — sync through the
real GitHub client code in js/remote.js.

    from fakegithub import FakeGitHub
    gh = FakeGitHub(tokens={'tok-owner'}); url = gh.start()
    # in the app: localStorage['tabit.dev.api'] = url
"""
import base64
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


class FakeGitHub:
    def __init__(self, tokens=(), login='test-owner'):
        self.tokens = set(tokens)
        self.login = login
        self.blobs = {}  # sha -> bytes
        self.trees = {}  # sha -> {path: blob sha}
        self.commits = {}  # sha -> {tree, parents, message}
        self.refs = {}  # branch -> commit sha
        self.lock = threading.Lock()
        self.log = []
        self.offline = False

    # ---------- git objects ----------
    def _sha(self, kind, data):
        return hashlib.sha1(kind.encode() + b'\0' + data).hexdigest()

    def put_blob(self, data):
        sha = self._sha('blob', data)
        self.blobs[sha] = data
        return sha

    def put_tree(self, files):
        sha = self._sha('tree', json.dumps(files, sort_keys=True).encode())
        self.trees[sha] = dict(files)
        return sha

    def files_at(self, branch='tabit-data'):
        c = self.refs.get(branch)
        if not c:
            return {}
        tree = self.trees[self.commits[c]['tree']]
        return {p: self.blobs[s].decode() for p, s in tree.items()}

    # ---------- server ----------
    def start(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _cors(self):
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-GitHub-Api-Version, Accept')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, OPTIONS')

            def _send(self, status, obj=None):
                body = json.dumps(obj if obj is not None else {}).encode()
                self.send_response(status)
                self._cors()
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.end_headers()

            def _authed(self):
                a = self.headers.get('Authorization', '')
                return a.startswith('Bearer ') and a[7:] in fake.tokens

            def _body(self):
                n = int(self.headers.get('Content-Length') or 0)
                return json.loads(self.rfile.read(n) or b'{}')

            def do_GET(self):
                self._route('GET')

            def do_POST(self):
                self._route('POST')

            def do_PATCH(self):
                self._route('PATCH')

            def _route(self, method):
                if fake.offline:
                    self.close_connection = True
                    return
                path = urlparse(self.path).path
                a = self.headers.get('Authorization', '')
                if a and not self._authed():
                    return self._send(401, {'message': 'Bad credentials'})
                with fake.lock:
                    fake.log.append((method, path))
                    try:
                        self._handle(method, path)
                    except KeyError:
                        self._send(404, {'message': 'Not Found'})

            def _handle(self, method, path):
                if path == '/user':
                    return self._send(200 if self._authed() else 401, {'login': fake.login} if self._authed() else {'message': 'Requires authentication'})
                m = re.match(r'^/repos/([^/]+)/([^/]+)(/.*)?$', path)
                if not m:
                    return self._send(404, {'message': 'Not Found'})
                rest = m.group(3) or ''
                if rest == '' and method == 'GET':
                    return self._send(200, {'private': False, 'permissions': {'push': self._authed(), 'pull': True}})
                if rest.startswith('/git/matching-refs/heads/') and method == 'GET':
                    b = rest[len('/git/matching-refs/heads/'):]
                    return self._send(200, [{'ref': f'refs/heads/{k}', 'object': {'sha': v, 'type': 'commit'}} for k, v in fake.refs.items() if k.startswith(b)])
                if rest.startswith('/git/ref/heads/') and method == 'GET':
                    b = rest[len('/git/ref/heads/'):]
                    if b not in fake.refs:
                        return self._send(404, {'message': 'Not Found'})
                    return self._send(200, {'ref': f'refs/heads/{b}', 'object': {'sha': fake.refs[b], 'type': 'commit'}})
                if rest.startswith('/git/trees/') and method == 'GET':
                    sha = rest[len('/git/trees/'):]
                    tree = fake.trees[fake.commits[sha]['tree']] if sha in fake.commits else fake.trees[sha]
                    return self._send(200, {'sha': sha, 'tree': [{'path': p, 'type': 'blob', 'sha': s, 'mode': '100644'} for p, s in tree.items()]})
                if rest.startswith('/git/blobs/') and method == 'GET':
                    data = fake.blobs[rest[len('/git/blobs/'):]]
                    return self._send(200, {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
                if rest.startswith('/git/commits/') and method == 'GET':
                    c = fake.commits[rest[len('/git/commits/'):]]
                    return self._send(200, {'tree': {'sha': c['tree']}, 'parents': [{'sha': p} for p in c['parents']], 'message': c['message']})
                if rest.startswith('/contents/') and method == 'GET':
                    p = rest[len('/contents/'):]
                    files = fake.files_at('tabit-data')
                    if p not in files:
                        return self._send(404, {'message': 'Not Found'})
                    return self._send(200, {'content': base64.b64encode(files[p].encode()).decode(), 'encoding': 'base64'})
                # writes need a key
                if method in ('POST', 'PATCH') and not self._authed():
                    return self._send(401, {'message': 'Requires authentication'})
                if rest == '/git/trees' and method == 'POST':
                    body = self._body()
                    base = dict(fake.trees[body['base_tree']]) if body.get('base_tree') else {}
                    for e in body['tree']:
                        if e.get('sha', 'x') is None:
                            base.pop(e['path'], None)
                        elif 'content' in e:
                            base[e['path']] = fake.put_blob(e['content'].encode())
                        else:
                            base[e['path']] = e['sha']
                    return self._send(201, {'sha': fake.put_tree(base)})
                if rest == '/git/commits' and method == 'POST':
                    body = self._body()
                    sha = fake._sha('commit', json.dumps(body, sort_keys=True).encode() + str(len(fake.commits)).encode())
                    fake.commits[sha] = {'tree': body['tree'], 'parents': body.get('parents', []), 'message': body.get('message', '')}
                    return self._send(201, {'sha': sha})
                if rest == '/git/refs' and method == 'POST':
                    body = self._body()
                    b = body['ref'].replace('refs/heads/', '')
                    if b in fake.refs:
                        return self._send(422, {'message': 'Reference already exists'})
                    fake.refs[b] = body['sha']
                    return self._send(201, {'ref': body['ref'], 'object': {'sha': body['sha']}})
                if rest.startswith('/git/refs/heads/') and method == 'PATCH':
                    b = rest[len('/git/refs/heads/'):]
                    body = self._body()
                    new = body['sha']
                    if b in fake.refs and not body.get('force'):
                        # fast-forward only: the new commit must descend from the current one
                        if fake.refs[b] not in fake.commits[new]['parents']:
                            return self._send(422, {'message': 'Update is not a fast forward'})
                    fake.refs[b] = new
                    return self._send(200, {'ref': f'refs/heads/{b}', 'object': {'sha': new}})
                return self._send(404, {'message': 'Not Found'})

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return f'http://127.0.0.1:{self.httpd.server_address[1]}'

    def stop(self):
        self.httpd.shutdown()
