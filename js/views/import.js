// Importing: a Tabs & Chords list, a TabIt backup file, or an old TabIt export.

import { h, icon, iconButton, button, toast, seg, fill } from '../ui.js';
import { parseTCList } from '../ug.js';
import { startImport, cancelImport, clearImport, importJob, subscribeImport, resumeImport, retryImport, readBackup, addSongs } from '../importer.js';
import { store } from '../store.js';

const STATUS = { waiting: ['clock', 'Waiting'], working: ['sync', 'Finding…'], done: ['check', ''], close: ['check', ''], skipped: ['check', ''], notfound: ['close', ''], failed: ['close', ''] };

export function view(route, { go, back }) {
  let tab = route.query.get('tab') || 'tc';
  const body = h('div', {});
  const tabs = seg([['tc', 'Tabs & Chords'], ['file', 'Backup file']], tab, v => { tab = v; draw(); }, { label: 'Import from' });
  const el = h('div', { class: 'page' },
    h('header', { class: 'page-head' }, iconButton('back', 'Back', () => back('#/')), h('h1', { class: 'page-title' }, h('small', {}, 'Bring your songs'), 'Import')),
    tabs, h('div', { style: { height: '14px' } }), body);

  let unsub = null;
  function draw() {
    unsub?.();
    unsub = null;
    if (tab === 'file') return drawFile();
    const job = importJob();
    if (job) return drawJob();
    drawPaste();
  }

  function drawPaste() {
    const ta = h('textarea', { class: 'textarea', rows: '9', placeholder: 'Artist\tSong\tDate\tType\nZach Bryan\nSomething In The Orange\nJul 16, 2024\tChords\n…', 'aria-label': 'Your Tabs & Chords list' });
    const fav = h('input', { type: 'checkbox', checked: true });
    const found = h('p', { class: 'hint' });
    const go2 = button('Import', () => {
      const entries = parseTCList(ta.value);
      if (!entries.length) { toast('No songs found in that text. Copy the whole “My tabs” table.'); return; }
      startImport(entries, { favorite: fav.checked });
      draw();
    }, { cls: 'btn-primary', iconName: 'import', disabled: true });
    ta.addEventListener('input', () => {
      const e = parseTCList(ta.value);
      const artists = new Set(e.map(x => x.artist));
      found.textContent = e.length ? `${e.length} song${e.length === 1 ? '' : 's'} by ${artists.size} artist${artists.size === 1 ? '' : 's'}${e.some(x => x.version > 1) ? ', with their versions' : ''}.` : ta.value.trim() ? 'No songs recognized yet.' : '';
      go2.disabled = !e.length;
      go2.lastChild.textContent = e.length ? `Import ${e.length} songs` : 'Import';
    });
    fill(body, 
      h('div', { class: 'card' },
        h('h2', {}, 'Your Tabs & Chords favorites'),
        h('ol', { style: { margin: '0 0 12px', paddingLeft: '20px', color: 'var(--ink-2)' } },
          h('li', {}, 'On a computer, open ', h('a', { href: 'https://www.ultimate-guitar.com/user/mytabs', target: '_blank', rel: 'noopener' }, 'ultimate-guitar.com → My tabs'), ' (the same list as in the app).'),
          h('li', {}, 'Set “Per page” to the most, select the whole list from the first artist to the last date, and copy it.'),
          h('li', {}, 'Paste it here. Each song is fetched from Ultimate Guitar in the same version.')),
        ta, found,
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0 14px' } }, fav, 'Mark them all as favorites'),
        go2),
      h('p', { class: 'hint' }, 'Already imported songs are skipped, so it’s safe to paste the list again later to pick up new favorites.'));
  }

  function drawJob() {
    const render = () => {
      const job = importJob();
      if (!job) return draw();
      const n = job.entries.length;
      const finished = job.entries.filter(e => !['waiting', 'working'].includes(e.status)).length;
      const ok = job.entries.filter(e => ['done', 'close'].includes(e.status)).length;
      const skipped = job.entries.filter(e => e.status === 'skipped').length;
      const bad = job.entries.filter(e => ['notfound', 'failed'].includes(e.status));
      const notFound = bad.filter(e => e.status === 'notfound').length;
      const failed = bad.length - notFound;
      const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(n), 'aria-valuenow': String(finished) }, h('i', { style: { width: `${(finished / n) * 100}%` } }));
      // once it's done, the ones that didn't come in are listed first
      const order = job.done ? [...bad, ...job.entries.filter(e => !bad.includes(e))] : job.entries;
      const list = h('ul', { class: 'import-log' }, order.map(e => {
        const [ic, label] = STATUS[e.status] || STATUS.waiting;
        return h('li', { class: ['notfound', 'failed'].includes(e.status) ? 'bad' : '' }, icon(ic, { size: 16 }),
          h('span', { style: { flex: 1 } }, `${e.artist} — ${e.title}${e.version > 1 ? ` (ver ${e.version})` : ''}`),
          h('span', { class: 'hint', style: { margin: 0 } }, e.note || label));
      }));
      fill(body, h('div', { class: 'card' },
        h('h2', {}, job.done ? (job.cancelled ? 'Import stopped' : 'Import finished') : `Importing ${finished + 1 > n ? n : finished + 1} of ${n}…`),
        h('p', {}, `${ok} added${skipped ? `, ${skipped} already there` : ''}${failed ? `, ${failed} couldn’t be loaded` : ''}${notFound ? `, ${notFound} not found` : ''}.${job.paused === 'offline' ? ' Waiting for a connection…' : ''}`),
        bar,
        h('div', { class: 'btn-row', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '14px 0 4px' } },
          job.done ? button('Done', () => { clearImport(); go('#/'); }, { cls: 'btn-primary' }) : button('Stop', () => cancelImport(), { cls: 'btn-danger' }),
          job.done && bad.length ? button(`Try ${bad.length === 1 ? 'it' : `these ${bad.length}`} again`, () => retryImport(), { iconName: 'sync' }) : null,
          job.done ? button('Import another list', () => { clearImport(); draw(); }, { cls: 'btn-ghost' }) : button('Browse while it works', () => go('#/'), { cls: 'btn-ghost' })),
        list));
    };
    unsub = subscribeImport(render);
    resumeImport();
    render();
  }

  function drawFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const { songs, setlists, upgrade } = readBackup(await f.text());
        const res = addSongs(songs, setlists, { upgrade });
        toast(addedText(res));
        if (res.added || res.lists || res.filled) go('#/');
      } catch (e) {
        toast(e.message || 'Couldn’t read that file.');
      }
      input.value = '';
    });
    const drop = h('div', { class: 'card', style: { textAlign: 'center', borderStyle: 'dashed' } },
      icon('upload', { size: 36 }),
      h('h2', { style: { marginTop: '8px' } }, 'Open a backup'),
      h('p', {}, 'A TabIt backup (Settings → Export) or a song file from the old TabIt.'),
      button('Choose a file', () => input.click(), { cls: 'btn-primary' }), input);
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
    drop.addEventListener('drop', async e => {
      e.preventDefault();
      drop.style.borderColor = '';
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      try {
        const { songs, setlists, upgrade } = readBackup(await f.text());
        const res = addSongs(songs, setlists, { upgrade });
        toast(addedText(res));
        if (res.added || res.lists || res.filled) go('#/');
      } catch (err) { toast(err.message); }
    });
    fill(body, drop, h('p', { class: 'hint' }, `Your library has ${Object.keys(store.lib.songs).length} songs. Nothing is replaced; songs you already have are skipped.`));
  }

  draw();
  return { el, title: 'Import', tab: 'library', destroy() { unsub?.(); } };
}

function addedText({ added, skipped, lists, filled }) {
  const parts = [`${added} song${added === 1 ? '' : 's'} added`];
  if (lists) parts.push(`${lists} setlist${lists === 1 ? '' : 's'}`);
  if (skipped) parts.push(`${skipped} already there${filled ? ` (${filled} given their capo, chord shapes and so on)` : ''}`);
  return parts.join(', ');
}
