// Reading and writing the synced library on GitHub.
//
// The library lives on its own branch ("tabit-data") of the app's repository,
// so saving never rebuilds the website. Every save is one commit made with the
// Git Data API (all changed files at once), and the branch only moves forward:
// if another device saved first, the update is refused and sync.js rebuilds
// its changes on top of the newer copy.

export class RemoteError extends Error {
  constructor(message, status = 0, kind = 'server') {
    super(message);
    this.status = status;
    this.kind = kind; // offline | auth | forbidden | notfound | conflict | rate | server
  }
}

const DEFAULTS = { owner: 'Z0rian', repo: 'TabIt', branch: 'tabit-data' };

// On <owner>.github.io/<repo>/ the repository is the one serving the app.
export function repoConfig(loc = location) {
  const cfg = { ...DEFAULTS };
  const m = loc.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (m) {
    cfg.owner = m[1];
    const first = loc.pathname.split('/').filter(Boolean)[0];
    if (first && !first.includes('.')) cfg.repo = first;
  }
  return cfg;
}

const b64ToText = b64 => {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

// Local testing only: point the app at a fake GitHub (tests/fakegithub.py).
const API = (() => {
  try {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return localStorage.getItem('tabit.dev.api') || 'https://api.github.com';
  } catch { /* no storage */ }
  return 'https://api.github.com';
})();
const isFakeApi = API !== 'https://api.github.com';

export class GitHubRemote {
  constructor(cfg, token = '') {
    this.cfg = cfg;
    this.token = token;
  }

  get base() { return `${API}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`; }

  async request(url, { method = 'GET', body, auth = true } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      throw new RemoteError('No connection', 0, 'offline');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* not JSON */ }
    const s = res.status;
    if (s === 401) throw new RemoteError('GitHub didn’t accept the sync key (it may have expired or been deleted).', s, 'auth');
    if (s === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new RemoteError('GitHub’s rate limit was reached. Sync will try again in a few minutes.', s, 'rate');
    if (s === 403) throw new RemoteError('This key isn’t allowed to save here. It needs Contents: Read and write on the repository.', s, 'forbidden');
    if (s === 404) throw new RemoteError(msg || 'Not found', s, 'notfound');
    if (s === 409 || s === 422) throw new RemoteError(msg || 'Someone else saved at the same moment.', s, 'conflict');
    throw new RemoteError(msg || `GitHub error ${s}`, s, 'server');
  }

  // Latest commit on the data branch, or null when it doesn't exist yet.
  // (matching-refs answers [] instead of a 404 for a branch that isn't there)
  async head() {
    try {
      const list = await this.request(`${this.base}/git/matching-refs/heads/${encodeURIComponent(this.cfg.branch)}`);
      const ref = (list || []).find(r => r.ref === `refs/heads/${this.cfg.branch}`);
      return ref ? ref.object.sha : null;
    } catch (e) {
      if (e.kind === 'notfound' || (e.kind === 'conflict' && /empty/i.test(e.message))) return null;
      throw e;
    }
  }

  // path → blob sha for every file in a commit.
  async files(commit) {
    const j = await this.request(`${this.base}/git/trees/${commit}?recursive=1`);
    const out = {};
    for (const t of j.tree || []) if (t.type === 'blob') out[t.path] = t.sha;
    return out;
  }

  async blob(sha) {
    const j = await this.request(`${this.base}/git/blobs/${sha}`);
    return b64ToText(j.content);
  }

  // One commit with every change. files: { path: text | null (delete) }.
  // Moves the branch only if it still points at `parent`.
  async commit({ parent, files, message }) {
    const tree = Object.entries(files).map(([path, text]) => (text === null
      ? { path, mode: '100644', type: 'blob', sha: null }
      : { path, mode: '100644', type: 'blob', content: text }));
    const body = parent ? { base_tree: (await this.request(`${this.base}/git/commits/${parent}`)).tree.sha, tree } : { tree: tree.filter(t => t.content !== undefined) };
    const t = await this.request(`${this.base}/git/trees`, { method: 'POST', body });
    const c = await this.request(`${this.base}/git/commits`, { method: 'POST', body: { message, tree: t.sha, parents: parent ? [parent] : [] } });
    if (parent) {
      await this.request(`${this.base}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, { method: 'PATCH', body: { sha: c.sha, force: false } });
    } else {
      await this.request(`${this.base}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${this.cfg.branch}`, sha: c.sha } });
    }
    return c.sha;
  }

  // The passwords file is public (each entry only opens with its password), so
  // a device that isn't signed in yet can read it without a key.
  async readPublic(path) {
    try {
      const j = await this.request(`${this.base}/contents/${path}?ref=${encodeURIComponent(this.cfg.branch)}`, { auth: false });
      return b64ToText(j.content);
    } catch (e) {
      if (e.kind === 'notfound') return null;
      if (e.kind === 'offline') throw e;
    }
    // API limits for anonymous use are low; the raw file CDN is the fallback
    if (isFakeApi) return null;
    let res;
    try {
      res = await fetch(`https://raw.githubusercontent.com/${this.cfg.owner}/${this.cfg.repo}/${this.cfg.branch}/${path}?t=${Date.now()}`, { cache: 'no-store' });
    } catch {
      throw new RemoteError('No connection', 0, 'offline');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new RemoteError(`Couldn’t read ${path} (${res.status}).`, res.status, 'server');
    return res.text();
  }

  async whoami() {
    try { return (await this.request(`${API}/user`)).login || ''; } catch { return ''; }
  }

  async canWrite() {
    const j = await this.request(this.base);
    return { push: !!j.permissions?.push, private: !!j.private };
  }
}

// Stand-in for GitHub while testing locally (?mock on localhost). Keeps a tiny
// git in localStorage — commits, trees, a branch — and refuses non-fast-forward
// updates just like GitHub, so conflicts and offline mode can be tested.
const MOCK_KEY = 'tabit.mock.git';
export class MockRemote {
  constructor(cfg, token = '') {
    this.cfg = cfg;
    this.token = token;
  }

  static state() {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY)) || { head: null, commits: {}, blobs: {} }; } catch { return { head: null, commits: {}, blobs: {} }; }
  }

  static save(st) { localStorage.setItem(MOCK_KEY, JSON.stringify(st)); }

  async wait(ms = 120) {
    await new Promise(r => setTimeout(r, ms));
    if (MockRemote.offline) throw new RemoteError('No connection', 0, 'offline');
    if (this.token && MockRemote.badTokens.has(this.token)) throw new RemoteError('GitHub didn’t accept the sync key.', 401, 'auth');
  }

  async head() { await this.wait(); return MockRemote.state().head; }

  async files(commit) {
    await this.wait();
    const c = MockRemote.state().commits[commit];
    if (!c) throw new RemoteError('Not found', 404, 'notfound');
    return { ...c.tree };
  }

  async blob(sha) {
    await this.wait(60);
    const b = MockRemote.state().blobs[sha];
    if (b === undefined) throw new RemoteError('Not found', 404, 'notfound');
    return b;
  }

  async commit({ parent, files, message }) {
    await this.wait(200);
    if (!this.token) throw new RemoteError('GitHub didn’t accept the sync key.', 401, 'auth');
    const st = MockRemote.state();
    if ((st.head || null) !== (parent || null)) throw new RemoteError('Update is not a fast forward', 422, 'conflict');
    const tree = parent ? { ...st.commits[parent].tree } : {};
    for (const [path, text] of Object.entries(files)) {
      if (text === null) { delete tree[path]; continue; }
      const sha = 'b' + Math.random().toString(36).slice(2, 12);
      st.blobs[sha] = text;
      tree[path] = sha;
    }
    const sha = 'c' + Math.random().toString(36).slice(2, 12);
    st.commits[sha] = { tree, parent: parent || null, message };
    st.head = sha;
    MockRemote.save(st);
    MockRemote.log.push(message);
    return sha;
  }

  async readPublic(path) {
    await this.wait();
    const st = MockRemote.state();
    if (!st.head) return null;
    const sha = st.commits[st.head].tree[path];
    return sha ? st.blobs[sha] : null;
  }

  async whoami() { return 'test-owner'; }
  async canWrite() { await this.wait(); return { push: true, private: false }; }

  // test helper: another device edits the library
  static reset() { localStorage.removeItem(MOCK_KEY); MockRemote.log = []; }
}
MockRemote.offline = false;
MockRemote.badTokens = new Set();
MockRemote.log = [];
