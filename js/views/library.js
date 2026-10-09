// The library: your songs, favorites, recently played, by artist, setlists.
// One search box looks through the library first and Ultimate Guitar second.

import { h, icon, iconButton, button, toast, swipeToDelete, seg, drawer, promptSheet, confirmSheet, relTime, initials, debounce, fill } from '../ui.js';
import { store, subscribe, dispatch, undoable, signedIn } from '../store.js';
import { searchSongs, sortSongs, groupByArtist, SORTS, newId, findDuplicate } from '../model.js';
import { searchUG, groupResults, fetchTab, songFromTab } from '../ug.js';
import { prefs } from '../prefs.js';
import { session } from '../session.js';
import { syncPill } from './common.js';

const FILTERS = [['all', 'All'], ['fav', 'Favorites'], ['recent', 'Recent'], ['artists', 'Artists'], ['lists', 'Setlists']];

export function view(route, { go }) {
  const listId = route.query.get('list');
  if (listId) return setlistView(listId, { go });

  let filter = prefs.get('filter');
  let sort = prefs.get('sort');
  let q = session.query || '';
  let ugCtrl = null;

  const count = h('small', {});
  const head = h('header', { class: 'page-head' },
    h('h1', { class: 'page-title' }, count, 'Library'),
    syncPill(),
    iconButton('plus', 'Add a song', () => addMenu(go), { cls: 'filled' }));

  const input = h('input', {
    class: 'input', type: 'search', placeholder: 'Search your songs or Ultimate Guitar', value: q, enterkeyhint: 'search',
    'aria-label': 'Search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
  });
  const clear = iconButton('close', 'Clear search', () => { input.value = ''; q = ''; session.query = ''; session.ug = null; draw(); input.focus(); }, { cls: 'clear' });
  const search = h('div', { class: 'search' }, icon('search'), input, clear);
  const filterSeg = seg(FILTERS, filter, v => { filter = v; prefs.set('filter', v); draw(); }, { label: 'Show' });
  const sortBtn = iconButton('sort', 'Sort', () => sortMenu());
  const tools = h('div', { class: 'lib-tools' }, search, h('div', { class: 'lib-filter' }, filterSeg, sortBtn));
  const body = h('div', { class: 'lib-body' });
  const el = h('div', { class: 'page' }, head, tools, body);

  const runLocal = debounce(() => { session.query = q; draw(); }, 80);
  input.addEventListener('input', () => {
    q = input.value;
    if (session.ug && session.ug.q !== q.trim()) session.ug = null;
    runLocal();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing && q.trim()) { e.preventDefault(); input.blur(); searchOnline(); }
  });

  function sortMenu() {
    const d = drawer({
      title: 'Sort by',
      body: h('div', { class: 'set-list' }, ...Object.entries(SORTS).map(([k, s]) => h('div', {
        class: 'set-row click', role: 'button', tabindex: '0',
        onClick: () => { sort = k; prefs.set('sort', k); d.close(); draw(); },
      }, h('span', { class: 'lbl' }, h('b', {}, s.label)), sort === k ? icon('check', { cls: 'on' }) : null))),
    });
  }

  async function searchOnline() {
    const query = q.trim();
    if (!query) return;
    ugCtrl?.abort();
    ugCtrl = new AbortController();
    session.ug = { q: query, loading: true };
    draw();
    try {
      const results = await searchUG(query, { signal: ugCtrl.signal });
      session.ug = { q: query, groups: groupResults(results) };
    } catch (e) {
      if (e.name === 'AbortError') return;
      session.ug = { q: query, error: e.message };
    }
    if (q.trim() === query) draw();
  }

  function draw() {
    const all = Object.values(store.lib.songs);
    count.textContent = `${all.length} song${all.length === 1 ? '' : 's'}`;
    const query = q.trim();
    if (query) return drawSearch(all, query);
    if (!all.length) return drawEmpty();
    if (filter === 'artists') return drawArtists(all);
    if (filter === 'lists') return drawLists();
    let songs = all;
    if (filter === 'fav') songs = songs.filter(s => s.fav);
    if (filter === 'recent') songs = sortSongs(songs.filter(s => s.played), 'played').slice(0, 50);
    else songs = sortSongs(songs, sort);
    const note = filter === 'fav' ? `${songs.length} favorite${songs.length === 1 ? '' : 's'}` : filter === 'recent' ? 'Recently played on any device' : SORTS[sort].label;
    fill(body, 
      h('div', { class: 'lib-count' }, h('span', {}, note)),
      songs.length ? h('div', { class: 'list' }, songs.map(s => songRow(s, { go }))) : h('div', { class: 'empty' }, h('p', {}, filter === 'fav' ? 'No favorites yet. Tap the heart on a song.' : 'Songs you open show up here.')),
    );
  }

  function drawSearch(all, query) {
    const local = searchSongs(all, query).slice(0, 60);
    const parts = [];
    if (local.length) parts.push(h('div', { class: 'group-head' }, 'In your library'), h('div', { class: 'list' }, local.map(s => songRow(s, { go }))));
    const ug = session.ug && session.ug.q === query ? session.ug : null;
    parts.push(h('div', { class: 'group-head' }, 'Ultimate Guitar'));
    if (!ug) {
      parts.push(h('div', { class: 'row ug-row', role: 'button', tabindex: '0', onClick: searchOnline, onKeydown: e => e.key === 'Enter' && searchOnline() },
        h('div', { class: 'row-art' }, icon('search')),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, `Search for “${query}”`), h('div', { class: 'row-sub' }, navigator.onLine ? 'Chords and tabs, with every version' : 'You’re offline right now'))));
    } else if (ug.loading) {
      parts.push(h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'row-sub' }, 'Searching…')));
    } else if (ug.error) {
      parts.push(h('div', { class: 'empty' }, h('p', {}, ug.error), button('Try again', searchOnline)));
    } else if (!ug.groups.length) {
      parts.push(h('div', { class: 'empty' }, h('p', {}, 'Nothing on Ultimate Guitar for that. Try the artist and song name.')));
    } else {
      parts.push(h('div', { class: 'list' }, ug.groups.slice(0, 30).map(g => resultRow(g, { go }))));
    }
    fill(body, ...parts);
  }

  function drawEmpty() {
    fill(body, h('div', { class: 'empty' },
      h('div', { class: 'art' }, icon('note', { size: 44 })),
      h('h3', {}, 'Your songbook is empty'),
      h('p', {}, 'Bring over your Tabs & Chords favorites, search Ultimate Guitar above, or paste a song.'),
      h('div', { style: { display: 'grid', gap: '8px', maxWidth: '320px', margin: '0 auto' } },
        button('Import from Tabs & Chords', () => go('#/import'), { cls: 'btn-primary', iconName: 'import' }),
        button('Paste or write a song', () => go('#/edit/new'), { iconName: 'edit' }),
        signedIn() ? null : button('Sign in to sync', () => go('#/settings'), { iconName: 'cloud', cls: 'btn-ghost' }))));
  }

  function drawArtists(all) {
    const groups = groupByArtist(all);
    fill(body, 
      h('div', { class: 'lib-count' }, h('span', {}, `${groups.length} artists`)),
      ...groups.map(g => [h('div', { class: 'group-head' }, `${g.artist} · ${g.songs.length}`), h('div', { class: 'list' }, g.songs.map(s => songRow(s, { go, artist: false })))]).flat());
  }

  function drawLists() {
    const lists = Object.values(store.lib.setlists).sort((a, b) => (b.updated || b.created || '').localeCompare(a.updated || a.created || ''));
    fill(body, 
      h('div', { class: 'lib-count' }, h('span', {}, 'Setlists: songs in the order you play them'), button('New setlist', newSetlist, { cls: 'btn-small', iconName: 'plus' })),
      lists.length ? h('div', { class: 'list' }, lists.map(l => swipeToDelete(h('div', { class: 'row', role: 'button', tabindex: '0', onClick: () => go(`#/?list=${l.id}`) },
        h('div', { class: 'row-art' }, icon('list')),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, l.name), h('div', { class: 'row-sub' }, `${l.songs.length} song${l.songs.length === 1 ? '' : 's'}`)),
        icon('forward', { cls: 'row-meta' })), {
        onDelete: () => {
          const undo = undoable({ t: 'list-del', id: l.id });
          toast(`Deleted “${l.name}”`, { action: 'Undo', onAction: undo });
        },
      }))) : h('div', { class: 'empty' }, h('p', {}, 'Make a setlist for a gig or a practice session, then add songs from each song’s menu.')));
  }

  async function newSetlist() {
    const name = await promptSheet('New setlist', { label: 'Name', placeholder: 'Friday at the bar', confirm: 'Create' });
    if (!name?.trim()) return;
    const id = newId('l');
    dispatch({ t: 'list', id, set: { name: name.trim(), songs: [], created: new Date().toISOString(), updated: new Date().toISOString() } });
    go(`#/?list=${id}`);
  }

  const unsub = subscribe(() => { if (!q.trim() || !session.ug?.loading) draw(); });
  draw();
  return {
    el, title: 'Library', tab: 'library', scrollY: session.libraryScroll,
    mounted() { if (route.query.has('search')) input.focus(); },
    destroy() { session.libraryScroll = scrollY; unsub(); ugCtrl?.abort(); },
  };
}

export function songRow(s, { go, artist = true, onOpen } = {}) {
  const art = h('div', { class: 'row-art', 'aria-hidden': 'true' }, s.cover ? h('img', { src: s.cover, alt: '', loading: 'lazy', onError: e => e.target.replaceWith(initials(s.artist || s.title)) }) : initials(s.artist || s.title));
  const fav = h('button', {
    type: 'button', class: `icon-btn ${s.fav ? 'fav' : ''}`, 'aria-label': s.fav ? 'Remove from favorites' : 'Add to favorites', 'aria-pressed': String(!!s.fav),
    onClick: e => { e.stopPropagation(); dispatch({ t: 'set', id: s.id, set: { fav: s.fav ? null : true } }); },
  }, icon(s.fav ? 'heartFill' : 'heart'));
  const sub = [artist ? s.artist : null, s.played ? `played ${relTime(s.played)}` : null].filter(Boolean).join(' · ');
  const row = h('div', { class: 'row', role: 'link', tabindex: '0', onClick: () => (onOpen ? onOpen(s) : go(`#/song/${s.id}`)), onKeydown: e => { if (e.key === 'Enter') (onOpen ? onOpen(s) : go(`#/song/${s.id}`)); } },
    art,
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, s.title), h('div', { class: 'row-sub' }, sub || ' ')),
    h('div', { class: 'row-meta' }, s.key || s.capo ? h('span', { class: 'row-key', title: [s.key && `Key ${s.key}`, s.capo && `capo ${s.capo}`].filter(Boolean).join(', ') }, s.key ? h('span', { class: 'chip key' }, s.key) : null, s.capo ? h('small', {}, `capo ${s.capo}`) : null) : null, fav));
  return swipeToDelete(row, {
    onDelete: () => {
      const undo = undoable({ t: 'del', id: s.id });
      toast(`Deleted “${s.title}”`, { action: 'Undo', onAction: undo });
    },
  });
}

function resultRow(g, { go }) {
  const inLib = Object.values(store.lib.songs).filter(s => s.src?.url && g.versions.some(v => v.url === s.src.url));
  const chords = g.versions.filter(v => v.type === 'Chords');
  const shown = (chords.length ? chords : g.versions).slice(0, 8);
  const best = g.best;
  return h('div', { class: 'row', style: { alignItems: 'flex-start' } },
    h('div', { class: 'row-art', 'aria-hidden': 'true' }, best.cover ? h('img', { src: best.cover, alt: '', loading: 'lazy' }) : initials(g.artist)),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, g.title),
      h('div', { class: 'row-sub' }, g.artist, inLib.length ? ' · in your library' : ''),
      h('div', { class: 'result-ver' }, shown.map(v => h('button', {
        type: 'button', class: `ver-btn ${v === best ? 'best' : ''}`,
        'aria-label': `${v.type} version ${v.version}, rated ${v.rating.toFixed(1)} by ${v.votes}`,
        onClick: () => openResult(v, g, { go }),
      }, `${v.type === 'Chords' ? 'Ver' : v.type} ${v.version}`, v.votes ? h('span', { class: 'stars' }, `★${v.rating.toFixed(1)}`) : null, v.votes ? h('span', { class: 'votes' }, compact(v.votes)) : null)))));
}

const compact = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export async function openResult(v, g, { go }) {
  const have = Object.values(store.lib.songs).find(s => s.src?.url === v.url);
  if (have) return go(`#/song/${have.id}`);
  if (v.type === 'Pro') { toast('Guitar Pro files can’t be shown here. Pick a Chords or Tab version.'); return; }
  const close = toast('Opening…', { ms: 20000 });
  try {
    const tab = await fetchTab(v.url);
    close();
    session.preview = songFromTab({ ...v, title: g.title, artist: g.artist }, tab);
    go('#/song/preview');
  } catch (e) {
    close();
    toast(e.message || 'Couldn’t open that tab.');
  }
}

// Saves the previewed song; returns its id.
export function savePreview(song) {
  const dup = findDuplicate(store.lib, song);
  if (dup) return dup.id;
  dispatch({ t: 'add', song: { ...song, added: new Date().toISOString() } });
  return song.id;
}

function addMenu(go) {
  const d = drawer({
    title: 'Add songs',
    body: h('div', { class: 'set-list' },
      menuRow('search', 'Search Ultimate Guitar', 'Type in the search box on the Library', () => { d.close(); go('#/?search=1'); setTimeout(() => document.querySelector('.search input')?.focus(), 80); }),
      menuRow('import', 'Import from Tabs & Chords', 'Paste your “My tabs” list: every song, same versions', () => { d.close(); go('#/import'); }),
      menuRow('edit', 'Paste or write a song', 'Chords over lyrics, or [C] inline chords', () => { d.close(); go('#/edit/new'); }),
      menuRow('upload', 'Open a TabIt backup', 'A .json file exported from TabIt', () => { d.close(); go('#/import?tab=file'); })),
  });
}

export function menuRow(ic, title, sub, onClick, { danger = false } = {}) {
  return h('div', { class: 'set-row click', role: 'button', tabindex: '0', onClick, onKeydown: e => e.key === 'Enter' && onClick() },
    icon(ic, { cls: danger ? 'danger' : '' }),
    h('span', { class: 'lbl' }, h('b', { style: danger ? { color: 'var(--danger)' } : null }, title), sub ? h('small', {}, sub) : null));
}

// ---------- one setlist ----------

function setlistView(id, { go }) {
  const el = h('div', { class: 'page' });
  const draw = () => {
    const l = store.lib.setlists[id];
    if (!l) { fill(el, h('div', { class: 'empty' }, h('h3', {}, 'Setlist not found'), button('Back to the library', () => go('#/')))); return; }
    const songs = l.songs.map(sid => store.lib.songs[sid]).filter(Boolean);
    const rows = songs.map((s, i) => {
      const up = iconButton('back', 'Move up', e => { e.stopPropagation(); move(i, -1); });
      up.style.transform = 'rotate(90deg)';
      const down = iconButton('back', 'Move down', e => { e.stopPropagation(); move(i, 1); });
      down.style.transform = 'rotate(-90deg)';
      return swipeToDelete(h('div', { class: 'row', role: 'link', tabindex: '0', onClick: () => { session.list = { id, index: i }; go(`#/song/${s.id}?list=${id}&i=${i}`); } },
        h('div', { class: 'row-art' }, String(i + 1)),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, s.title), h('div', { class: 'row-sub' }, s.artist)),
        h('div', { class: 'row-meta' }, i > 0 ? up : null, i < songs.length - 1 ? down : null)), {
        label: 'Remove',
        onDelete: () => {
          const undo = undoable({ t: 'list', id, set: { songs: l.songs.filter(x => x !== s.id), updated: new Date().toISOString() } });
          toast(`Removed “${s.title}” from the setlist`, { action: 'Undo', onAction: undo });
        },
      });
    });
    fill(el, 
      h('header', { class: 'page-head' },
        iconButton('back', 'Back', () => go('#/')),
        h('h1', { class: 'page-title' }, h('small', {}, 'Setlist'), l.name),
        iconButton('edit', 'Rename', async () => {
          const name = await promptSheet('Rename setlist', { value: l.name, label: 'Name' });
          if (name?.trim()) dispatch({ t: 'list', id, set: { name: name.trim(), updated: new Date().toISOString() } });
        }),
        iconButton('trash', 'Delete setlist', async () => {
          if (await confirmSheet('Delete this setlist?', `“${l.name}” goes away; the songs stay in your library.`, { confirm: 'Delete', danger: true })) {
            dispatch({ t: 'list-del', id });
            go('#/');
          }
        })),
      songs.length
        ? h('div', {}, button('Play from the top', () => { session.list = { id, index: 0 }; go(`#/song/${songs[0].id}?list=${id}&i=0`); }, { cls: 'btn-primary', iconName: 'play' }), h('div', { class: 'list', style: { marginTop: '12px' } }, rows))
        : h('div', { class: 'empty' }, h('p', {}, 'No songs yet. Open a song, tap ⋯ and choose “Add to setlist”.')));
  };
  const move = (i, d) => {
    const l = store.lib.setlists[id];
    const songs = [...l.songs];
    const j = i + d;
    if (j < 0 || j >= songs.length) return;
    [songs[i], songs[j]] = [songs[j], songs[i]];
    dispatch({ t: 'list', id, set: { songs, updated: new Date().toISOString() } });
  };
  const unsub = subscribe(draw);
  draw();
  return { el, title: 'Setlist', tab: 'library', destroy: unsub };
}

