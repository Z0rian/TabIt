// Settings: sign-in and sync, look and feel, autoscroll, library tools, about.

import { h, icon, button, toast, toggle, seg, confirmSheet, relTime, fmtTime, fill } from '../ui.js';
import { store, subscribe, signedIn, getAuth, syncNow, signOut, pendingCount, cfg, useMock } from '../store.js';
import { setupWithKey, signInWithPassword, addPassword, removePassword, listPasswords, tokenUrl, repoUrl, passwordProblem, replaceKey } from '../account.js';
import { prefs, applyTheme, autoFontSize } from '../prefs.js';
import { exportLibrary, addSongs } from '../importer.js';
import { oldGist, fetchOldGist } from '../migrate.js';
import { searchUG, PROXY } from '../ug.js';
import { persistent } from '../db.js';
import { field } from './common.js';

export const VERSION = '2.0.0';

export function view(route, { go }) {
  const el = h('div', { class: 'page' });
  const syncBox = h('div', {});
  const draw = () => {
    fill(el, 
      h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, h('small', {}, `TabIt ${VERSION}`), 'Settings')),
      syncBox,
      appearance(),
      playback(),
      library(go),
      about());
    drawSync();
  };

  // ---------- sync ----------
  let busyText = '';
  // the password list, read once per visit to this page (and after a change):
  // the page redraws on every sync step
  let pwCache = null;
  const passwordList = (fresh = false) => {
    if (fresh || !pwCache) pwCache = listPasswords().catch(e => { pwCache = null; throw e; });
    return pwCache;
  };
  function drawSync() {
    fill(syncBox, signedIn() ? syncedCard() : signInCard());
  }

  function signInCard() {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Your TabIt password', 'aria-label': 'Password', enterkeyhint: 'go' });
    const err = h('p', { class: 'error', role: 'alert' });
    const btn = button('Sign in', null, { cls: 'btn-primary', type: 'submit' });
    const form = h('form', { onSubmit: async e => {
      e.preventDefault();
      if (!pw.value.trim()) { err.textContent = 'Type your password first.'; pw.focus(); return; }
      btn.disabled = true;
      btn.lastChild.textContent = 'Signing in…';
      err.textContent = '';
      try {
        await signInWithPassword(pw.value);
        toast(`Signed in. ${Object.keys(store.lib.songs).length} songs on this device.`);
        drawSync();
      } catch (ex) {
        err.textContent = ex.kind === 'offline' ? 'No connection right now. Try again when you’re online.' : ex.message;
        btn.disabled = false;
        btn.lastChild.textContent = 'Sign in';
      }
    } }, h('div', { style: { display: 'flex', gap: '8px' } }, pw, btn), err);
    return h('section', { class: 'card' },
      h('h2', {}, icon('cloud', { size: 20 }), ' Sync your songs'),
      h('p', {}, 'Sign in once on each device (iPhone, iPad, laptop) and your library, favorites and setlists stay the same everywhere. Songs are always on the device too, so they work offline.'),
      form,
      ownerSetup(),
      useMock ? h('p', { class: 'hint' }, 'Test mode: GitHub is simulated in this browser; any text works as a key.') : null);
  }

  function ownerSetup() {
    const key = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'github_pat_…', 'aria-label': 'GitHub key', spellcheck: 'false' });
    const err = h('p', { class: 'error', role: 'alert' });
    const btn = button('Set up sync', null, { cls: 'btn', type: 'submit' });
    return h('details', { class: 'sub-panel', open: route.query.has('setup') },
      h('summary', {}, 'First time? Set up sync (once, on your main device)'),
      h('p', { class: 'hint' }, `Sync keeps your library on GitHub, encrypted, in a repository of its own (${cfg.owner}/${cfg.repo}), with a key that can only reach that repository. Signed in to GitHub:`),
      h('ol', { class: 'steps' },
        h('li', {}, 'Make the repository: open ', h('a', { href: repoUrl(), target: '_blank', rel: 'noopener' }, 'this pre-filled page'), ` (name `, h('b', {}, cfg.repo), ', ', h('b', {}, 'Public'), ': everything in it is encrypted) and press ', h('b', {}, 'Create repository'), '.'),
        h('li', {}, 'Make the key: open ', h('a', { href: tokenUrl(), target: '_blank', rel: 'noopener' }, 'this pre-filled key page'), '. Under ', h('b', {}, 'Repository access'), ' choose ', h('b', {}, 'Only select repositories'), ` → ${cfg.repo}, and check that `, h('b', {}, 'Contents'), ' is ', h('b', {}, 'Read and write'), '.'),
        h('li', {}, 'Press ', h('b', {}, 'Generate token'), ', copy it, paste it here.'),
        h('li', {}, 'Then add a password. Every other device signs in with just that password.')),
      h('form', { onSubmit: async e => {
        e.preventDefault();
        btn.disabled = true;
        btn.lastChild.textContent = 'Checking…';
        err.textContent = '';
        try {
          await setupWithKey(key.value);
          toast('Sync is on. Now add a password for your other devices.');
          drawSync();
        } catch (ex) {
          err.textContent = ex.kind === 'offline' ? 'No connection right now.' : ex.message;
          btn.disabled = false;
          btn.lastChild.textContent = 'Set up sync';
        }
      } }, field('GitHub key', key), err, btn));
  }

  function syncedCard() {
    const a = getAuth();
    const s = store.sync;
    const status = s.state === 'saving' ? 'Syncing…' : s.state === 'pending' ? `${pendingCount()} change${pendingCount() === 1 ? '' : 's'} waiting to sync` : s.state === 'offline' ? s.message : s.state === 'error' ? s.message : s.at ? `Synced ${relTime(s.at)}` : 'Synced';
    const dot = s.state === 'error' ? 'err' : s.state === 'saving' || s.state === 'pending' ? 'busy' : s.state === 'offline' ? '' : 'ok';
    const passwords = h('div', { class: 'set-list', style: { marginTop: '8px' } }, h('div', { class: 'set-row' }, h('span', { class: 'spinner' }), h('span', { class: 'lbl' }, 'Loading passwords…')));
    const loadPw = (fresh = false) => passwordList(fresh).then(list => {
      fill(passwords, ...(list.length ? list.map(p => h('div', { class: 'set-row' },
        icon('key'),
        h('span', { class: 'lbl' }, h('b', {}, p.label), h('small', {}, `Added ${p.added}${p.device ? ` on ${p.device}` : ''}`)),
        button('Remove', async () => {
          if (!(await confirmSheet('Remove this password?', 'Devices already signed in stay signed in. New devices can’t use it anymore.', { confirm: 'Remove', danger: true }))) return;
          try { await removePassword(p.id); toast('Password removed'); loadPw(true); } catch (e) { toast(e.message); }
        }, { cls: 'btn-small btn-ghost' }))) : [h('div', { class: 'set-row' }, h('span', { class: 'lbl' }, h('b', {}, 'No passwords yet'), h('small', {}, 'Add one so your other devices can sign in.')))]));
    }).catch(e => fill(passwords, h('div', { class: 'set-row' }, h('span', { class: 'lbl error' }, e.message))));
    loadPw();
    const pwIn = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'e.g. banjo river tuesday', 'aria-label': 'New password' });
    const labelIn = h('input', { class: 'input', placeholder: 'Label (not secret), e.g. Me', 'aria-label': 'Label' });
    const pwErr = h('p', { class: 'error', role: 'alert' });
    const addForm = h('form', { onSubmit: async e => {
      e.preventDefault();
      const problem = passwordProblem(pwIn.value);
      if (problem) { pwErr.textContent = problem; return; }
      pwErr.textContent = 'Saving…';
      try {
        await addPassword(pwIn.value, labelIn.value);
        pwIn.value = labelIn.value = '';
        pwErr.textContent = '';
        toast('Password added. Use it to sign in on your other devices.');
        loadPw(true);
      } catch (ex) { pwErr.textContent = ex.message; }
    } }, h('div', { class: 'field-row' }, field('New password', pwIn), field('Label', labelIn)), pwErr, button('Add password', null, { type: 'submit', cls: 'btn-small' }));

    return h('section', { class: 'card' },
      h('h2', {}, icon('cloud', { size: 20 }), ' Sync'),
      h('p', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('span', { class: `status-dot ${dot}` }), status),
      h('p', { class: 'hint' }, `${Object.keys(store.lib.songs).length} songs. Signed in ${a.via === 'key' ? `with the GitHub key${a.login ? ` (${a.login})` : ''}` : `with a password${a.label ? ` (${a.label})` : ''}`}${a.since ? `, ${relTime(a.since)}` : ''}.`),
      h('div', { class: 'btn-row' },
        button('Sync now', () => syncNow(), { cls: 'btn-small', iconName: 'sync' }),
        button('Sign out on this device', async () => {
          const n = pendingCount();
          const ok = await confirmSheet('Sign out on this device?', `${n ? `${n} change${n === 1 ? ' hasn’t' : 's haven’t'} synced yet. ` : ''}Your songs stay on this device but stop syncing; when you sign in again, what you changed here in the meantime is added to your library. Other devices aren’t affected.`, { confirm: 'Sign out', danger: n > 0 });
          if (ok) { signOut({ keepSongs: true }); drawSync(); }
        }, { cls: 'btn-small btn-ghost' })),
      h('h3', { style: { margin: '18px 0 0', fontSize: '15px' } }, 'Passwords'),
      h('p', { class: 'hint' }, 'Any of these signs a device in. Capitals and spaces don’t matter.'),
      passwords,
      h('div', { style: { marginTop: '12px' } }, addForm),
      a.via === 'key' || s.kind === 'auth' ? replaceKeyPanel() : null);
  }

  function replaceKeyPanel() {
    const key = h('input', { class: 'input', type: 'password', placeholder: 'New github_pat_…', 'aria-label': 'New GitHub key', autocomplete: 'off', spellcheck: 'false' });
    const err = h('p', { class: 'error', role: 'alert' });
    // one box per password on the list (they're never stored, so they're typed again)
    const boxes = h('div', {}, h('p', { class: 'hint' }, 'Loading your passwords…'));
    let inputs = [];
    passwordList().then(list => {
      inputs = list.map(p => ({ id: p.id, input: h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Type it again to keep it', 'aria-label': `Password “${p.label}”` }) }));
      if (!inputs.length) inputs = [{ id: null, input: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'A password for signing in', 'aria-label': 'Password' }) }];
      fill(boxes, ...inputs.map((x, i) => field(list[i] ? `Password “${list[i].label}”` : 'A password for your devices', x.input)));
    }).catch(e => fill(boxes, h('p', { class: 'error' }, e.message)));
    return h('details', { class: 'sub-panel' }, h('summary', {}, 'Replace the GitHub key'),
      h('p', { class: 'hint' }, 'If the key expired or you deleted it on GitHub. Make a new one the same way (step 2 above), then type each password you want to keep: they’re locked again with the new key. Any left empty stop working.'),
      h('form', { onSubmit: async e => {
        e.preventDefault();
        const typed = inputs.map(x => ({ id: x.id, password: x.input.value }));
        for (const t of typed) {
          const pr = t.password.trim() && passwordProblem(t.password);
          if (pr) { err.textContent = pr; return; }
        }
        err.textContent = 'Saving…';
        try {
          await replaceKey(key.value, typed);
          pwCache = null;
          err.textContent = '';
          toast('Key replaced');
          drawSync();
        } catch (ex) { err.textContent = ex.message; }
      } }, field('New GitHub key', key), boxes, err, button('Replace key', null, { type: 'submit', cls: 'btn-small' })));
  }

  // ---------- look ----------
  function appearance() {
    const theme = seg([['system', 'Auto'], ['light', 'Paper'], ['dark', 'Stage'], ['black', 'Black']], prefs.get('theme'), v => { prefs.set('theme', v); applyTheme(v); }, { label: 'Theme' });
    const font = seg([['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Mono']], prefs.get('lyricFont'), v => prefs.set('lyricFont', v), { label: 'Lyrics font' });
    const size = h('input', { type: 'range', min: '12', max: '32', step: '1', value: String(prefs.get('fontSize') || autoFontSize()), 'aria-label': 'Text size', style: { width: '100%', accentColor: 'var(--accent)' } });
    const sizeOut = h('span', { class: 'val' }, prefs.get('fontSize') ? `${prefs.get('fontSize')} px` : `Auto (${autoFontSize()})`);
    size.addEventListener('input', () => { prefs.set('fontSize', +size.value); sizeOut.textContent = `${size.value} px`; });
    return group('Look', [
      row('Theme', 'Paper is warm and light; Stage and Black are for dim rooms', theme, true),
      row('Lyrics font', 'Mono looks like Ultimate Guitar', font, true),
      h('div', { class: 'set-row', style: { flexWrap: 'wrap' } }, h('span', { class: 'lbl' }, h('b', {}, 'Text size'), h('small', {}, 'For every song; a song can have its own. Pinch to zoom inside a song.')), sizeOut, size,
        prefs.get('fontSize') ? button('Auto', () => { prefs.set('fontSize', 0); draw(); }, { cls: 'btn-small btn-ghost' }) : null),
      row('Chord diagrams above songs', '', toggle(prefs.get('diagrams'), v => prefs.set('diagrams', v), 'Chord diagrams')),
      row('Left-handed diagrams', 'Mirror the chord boxes', toggle(prefs.get('leftHanded'), v => prefs.set('leftHanded', v), 'Left-handed')),
    ]);
  }

  function playback() {
    const len = seg([['0', 'Estimate'], ['150', '2:30'], ['180', '3:00'], ['210', '3:30'], ['240', '4:00']], String(prefs.get('defaultLength') || 0), v => prefs.set('defaultLength', +v), { label: 'Default song length' });
    return group('Autoscroll', [
      row('Song length', 'Used until a song has its own (from YouTube or set by you). “Estimate” goes by the number of lines: about 2 to 3 minutes for most songs.', len, true),
      row('Follow the YouTube video', 'While it plays, the song scrolls with the video', toggle(prefs.get('followVideo'), v => prefs.set('followVideo', v), 'Follow video')),
      row('Keep the screen on', 'While a song is open', toggle(prefs.get('keepAwake'), v => prefs.set('keepAwake', v), 'Keep screen on')),
    ]);
  }

  function library(goTo) {
    const gist = oldGist();
    const rows = [
      clickRow('import', 'Import from Tabs & Chords', 'Paste your “My tabs” list', () => goTo('#/import')),
      clickRow('upload', 'Open a backup file', 'Add songs from a TabIt backup', () => goTo('#/import?tab=file')),
      clickRow('download', 'Export a backup', 'All songs and setlists as a .json file', () => {
        const blob = new Blob([exportLibrary()], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `TabIt backup ${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }),
    ];
    if (gist) rows.push(clickRow('cloud', 'Old TabIt GitHub backup', 'Bring in songs from the old app’s Gist', async () => {
      try {
        const lib = await fetchOldGist(gist);
        const { added, skipped } = addSongs(Object.values(lib?.songs || {}));
        toast(`${added} added from the old backup${skipped ? `, ${skipped} already here` : ''}`);
      } catch (e) { toast(e.message); }
    }));
    const storeInfo = h('small', {}, 'Checking…');
    persistent().then(ok => {
      const n = Object.keys(store.lib.songs).length;
      storeInfo.textContent = `${n} songs saved on this device${ok ? '' : ' (this browser can’t keep them after closing)'}.`;
      navigator.storage?.estimate?.().then(e => { if (e?.usage) storeInfo.textContent += ` ${(e.usage / 1048576).toFixed(1)} MB used.`; });
    });
    rows.push(h('div', { class: 'set-row' }, icon('info'), h('span', { class: 'lbl' }, h('b', {}, 'On this device'), storeInfo)));
    return group('Library', rows);
  }

  function about() {
    const ug = h('small', {}, 'Not checked');
    const check = button('Check', async () => {
      ug.textContent = 'Checking…';
      try {
        const r = await searchUG('wonderwall');
        const v2 = r.some(x => x.cover || x.key);
        ug.textContent = r.length ? `Working${v2 ? '' : '. Update the worker to get capo, key and chord shapes with every tab (see ug-proxy/README in the repository).'}` : 'Answered, but found nothing.';
      } catch (e) { ug.textContent = e.message; }
    }, { cls: 'btn-small btn-ghost' });
    return group('About', [
      h('div', { class: 'set-row' }, icon('guitar'), h('span', { class: 'lbl' }, h('b', {}, 'Ultimate Guitar connection'), ug, h('small', {}, PROXY.replace('https://', ''))), check),
      h('div', { class: 'set-row' }, icon('info'), h('span', { class: 'lbl' }, h('b', {}, `TabIt ${VERSION}`), h('small', {}, 'Works offline once opened. Your songs never leave your devices and your own GitHub repository.'))),
      clickRow('sync', 'Check for an update', '', checkForUpdate),
    ]);
  }

  const unsub = subscribe(() => { if (!document.activeElement?.closest('form')) drawSync(); });
  draw();
  void busyText; void fmtTime;
  return { el, title: 'Settings', tab: 'settings', destroy: unsub };
}

function group(title, rows) {
  return h('section', { class: 'set-group' }, h('h2', {}, title), h('div', { class: 'set-list' }, rows));
}
function row(label, sub, control, stacked = false) {
  return h('div', { class: 'set-row', style: stacked ? { flexWrap: 'wrap' } : null }, h('span', { class: 'lbl', style: stacked ? { flexBasis: '100%' } : null }, h('b', {}, label), sub ? h('small', {}, sub) : null), stacked ? h('div', { style: { flex: '1 1 100%' } }, control) : control);
}
function clickRow(ic, label, sub, onClick) {
  return h('div', { class: 'set-row click', role: 'button', tabindex: '0', onClick, onKeydown: e => e.key === 'Enter' && onClick() }, icon(ic), h('span', { class: 'lbl' }, h('b', {}, label), sub ? h('small', {}, sub) : null), icon('forward'));
}

// An update that's already downloaded goes in now (the app reloads); otherwise
// look for one.
async function checkForUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  if (!reg) { toast('Updates install by themselves.'); return; }
  if (reg.waiting) { reg.waiting.postMessage('skip-waiting'); return; }
  toast('Checking…', { ms: 1500 });
  try { await reg.update(); } catch { toast('Couldn’t check right now. Are you online?'); return; }
  if (reg.waiting) reg.waiting.postMessage('skip-waiting');
  else if (reg.installing) toast('Downloading an update. TabIt will offer it in a moment.');
  else toast('You have the latest version.');
}
