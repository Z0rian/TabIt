// A song: the sheet, its chord shapes, autoscroll, transpose/capo, the YouTube
// player, and everything in the ⋯ menu.

import { h, icon, iconButton, button, drawer, toast, toggle, confirmSheet, promptSheet, fmtTime, parseTime, fill, initials } from '../ui.js';
import { coverOf, findCover, NO_COVER } from '../covers.js';
import { store, subscribe, dispatch, undoable, signedIn } from '../store.js';
import { newId } from '../model.js';
import { parseSong, toPlainText } from '../parse.js';
import { renderSheet, watchSheet } from '../sheet.js';
import { transposeChord, transposeKey, keyPrefersFlats, simplifyChord, detectKey } from '../theory.js';
import { AutoScroll, WakeLock, estimateDuration } from '../autoscroll.js';
import { Player } from '../youtube.js';
import { findVideo, videoIdFrom, searchUG, groupResults, fetchTab, songFromTab } from '../ug.js';
import { prefs, fontSize } from '../prefs.js';
import { session } from '../session.js';
import { openChord, chosenShape, diagram, tuningMidi } from './chordsheet.js';
import { strumCard } from './strum.js';
import { TUNINGS } from '../voicings.js';
import { savePreview, menuRow } from './library.js';

const TUNING_NAMES = { 'E A D G B E': 'standard', 'D A D G B E': 'dropD', 'Eb Ab Db Gb Bb Eb': 'halfDown', 'D# G# C# F# A# D#': 'halfDown', 'D G C F A D': 'fullDown', 'D G D G B D': 'openG', 'D A D F# A D': 'openD', 'D A D G A D': 'dadgad' };

export function view(route, { go, back }) {
  const id = route.args[0];
  const isPreview = id === 'preview';
  const getSong = () => (isPreview ? session.preview : store.lib.songs[id]);
  let song = getSong();
  if (!song) {
    return { el: h('div', { class: 'page' }, h('div', { class: 'empty' }, h('h3', {}, 'Song not found'), h('p', {}, 'It may have been deleted on another device.'), button('Back to the library', () => go('#/'), { cls: 'btn-primary' }))), title: 'Not found' };
  }
  const listId = route.query.get('list');
  const listIndex = +route.query.get('i') || 0;

  // per-song view settings (synced with the song; in memory for a preview)
  const vs = () => song.view || {};
  // applied here at once, so quick taps (transpose, transpose) add up even
  // before the store has passed the change back
  // (draw: false when the screen already shows it, like a pinched text size)
  const setView = (set, { draw = true } = {}) => {
    const view = { ...vs(), ...set };
    for (const k of Object.keys(view)) if (view[k] === null || view[k] === undefined) delete view[k];
    song = { ...song, view };
    if (isPreview) session.preview = song;
    else dispatch({ t: 'view', id, set });
    if (draw) redraw();
  };

  let doc = parseSong(song.content);
  const origCapo = () => +song.capo || 0;
  const capoNow = () => (vs().capo ?? null) === null ? origCapo() : +vs().capo;
  const shift = () => (+vs().tr || 0) + (origCapo() - capoNow());
  const baseKey = () => song.key || detectKey(doc.chords) || '';
  const tuningKey = () => TUNING_NAMES[(song.tuning || 'E A D G B E').replace(/\s+/g, ' ').trim()] || 'standard';
  const chordName = n => {
    const sh = shift();
    const key = baseKey();
    const flats = keyPrefersFlats(key ? transposeKey(key, sh) : 'C') || (!key && /b/.test(n.slice(1, 2)));
    let x = sh ? transposeChord(n, sh, flats) : n;
    if (vs().simplify) x = simplifyChord(x);
    return x;
  };
  // The tab author's shapes only fit while the chords are as written.
  const authorShapes = name => {
    if (shift() !== 0 || vs().simplify) return null;
    const list = [...(song.shapes?.[name] || [])];
    if (doc.meta.shapes?.[name]) list.push(doc.meta.shapes[name]);
    return list.length ? list : null;
  };

  // ---------- layout ----------
  const root = h('div', { class: 'song' });
  const fav = iconButton(song.fav ? 'heartFill' : 'heart', 'Favorite', () => {
    if (isPreview) { saveIt(true); return; }
    dispatch({ t: 'set', id, set: { fav: song.fav ? null : true } });
  }, { cls: song.fav ? 'on' : '' });
  const ttl = h('div', { class: 'ttl' }, song.title);
  const listNav = listId ? setlistNav() : null;
  const bar = h('div', { class: 'song-bar' },
    iconButton('back', 'Back', () => back(listId ? `#/?list=${listId}` : '#/')),
    ttl,
    listNav,
    isPreview ? button('Save', () => saveIt(false), { cls: 'btn-primary btn-small' }) : fav,
    iconButton('text', 'Display: transpose, capo, size', () => openTools()),
    iconButton('more', 'More', () => openMore()));
  const headEl = h('header', { class: 'song-head' });
  const strip = h('div', { class: 'chord-strip', role: 'list', 'aria-label': 'Chords in this song' });
  const sheetHolder = h('div', { class: 'sheet-holder' });
  root.append(bar, headEl, strip, sheetHolder);

  // the strumming pattern plays on the song's first chord, as it's shown now
  let strumMemo = null;
  const firstChord = () => {
    const orig = doc.chords[0];
    if (!orig) return null;
    const name = chordName(orig);
    const key = `${name}|${tuningKey()}|${vs().voicings?.[name] || ''}|${shift()}|${vs().simplify ? 1 : 0}`;
    if (strumMemo?.key !== key) strumMemo = { key, v: chosenShape(name, { author: authorShapes(orig), tuning: tuningKey(), pick: vs().voicings?.[name] })?.v || null };
    return strumMemo.v;
  };
  let strumEl = null;
  let strumOf;
  const strumBox = () => {
    if (strumOf !== song.strum) {
      strumEl?.destroy();
      strumOf = song.strum;
      strumEl = song.strum?.length ? strumCard(song.strum, { chord: firstChord, tuning: () => tuningMidi(tuningKey()).map(m => m + capoNow()) }) : null;
    }
    return strumEl;
  };

  let sheet = null;
  let stopWatch = null;
  let scroller = null;
  let player = null;
  let ytBox = null;
  const wake = new WakeLock();

  function drawHead() {
    const sh = shift();
    const key = baseKey();
    const chips = [];
    // the key, and next to it what opens the transpose menu (either one does)
    const tr = +vs().tr || 0;
    if (key) chips.push(h('button', { type: 'button', class: 'chip accent chip-btn', 'aria-label': `Key ${sh ? transposeKey(key, sh) : key}: transpose`, onClick: openTranspose }, `Key ${sh ? transposeKey(key, sh) : key}`));
    chips.push(h('button', { type: 'button', class: `chip chip-btn${tr ? ' accent' : ''}`, 'aria-label': tr ? `Transposed ${signed(tr)}: change` : 'Transpose', onClick: openTranspose },
      icon('transpose'), tr ? `${signed(tr)} semitone${Math.abs(tr) === 1 ? '' : 's'}` : 'Transpose'));
    if (capoNow()) chips.push(h('span', { class: 'chip accent' }, `Capo ${capoNow()}`));
    else if (origCapo()) chips.push(h('span', { class: 'chip' }, 'No capo'));
    if (song.tuning && song.tuning !== 'E A D G B E') chips.push(h('span', { class: 'chip', title: song.tuning }, tuningKey() !== 'standard' ? TUNINGS[tuningKey()].name : `Tuning ${song.tuning}`));
    if (song.bpm) chips.push(h('span', { class: 'chip' }, `${song.bpm} bpm`));
    if (song.src?.site === 'ug') chips.push(h('span', { class: 'chip' }, `UG ver ${song.src.version || 1}${song.src.rating ? ` · ★${(+song.src.rating).toFixed(1)}` : ''}`));
    const cover = coverOf(song);
    const tile = () => initials(song.artist || song.title);
    fill(headEl,
      h('div', { class: 'song-title-row' },
        h('div', { class: 'song-art', 'aria-hidden': 'true' }, cover ? h('img', { src: cover, alt: '', onError: e => e.target.replaceWith(tile()) }) : tile()),
        h('div', { class: 'song-title-text' },
          h('h1', {}, song.title),
          h('p', { class: 'by' }, song.artist ? h('a', { href: `#/?q=${encodeURIComponent(song.artist)}`, onClick: e => { e.preventDefault(); session.query = song.artist; go('#/'); } }, song.artist) : ''))),
      h('div', { class: 'song-meta' }, chips),
      isPreview ? h('div', { class: 'preview-banner' }, icon('cloud'), h('span', {}, 'From Ultimate Guitar. Save it to keep it offline and in sync.'), button('Save', () => saveIt(false), { cls: 'btn-primary btn-small' })) : null,
      song.notes ? h('p', { class: 'hint', style: { whiteSpace: 'pre-wrap', margin: '10px 0 0' } }, song.notes) : null,
      vs().hide ? null : strumBox());
    ttl.textContent = song.title;
    fill(fav, icon(song.fav ? 'heartFill' : 'heart'));
    fav.classList.toggle('on', !!song.fav);
  }

  function drawStrip() {
    if (!prefs.get('diagrams') || vs().hide) { strip.hidden = true; return; }
    strip.hidden = false;
    const names = [...new Set(doc.chords.map(chordName))];
    fill(strip, ...names.map(name => {
      const orig = doc.chords.find(c => chordName(c) === name);
      const shape = chosenShape(name, { author: authorShapes(orig), tuning: tuningKey(), pick: vs().voicings?.[name] });
      return h('button', { type: 'button', class: 'chord-card', role: 'listitem', 'aria-label': `${name} chord shapes`, onClick: () => chordTapped(name, orig) },
        h('b', {}, name), shape ? diagram(shape.v, name, { size: innerWidth >= 1100 ? 72 : 58, mini: true }) : h('span', { class: 'hint' }, '?'));
    }));
  }

  function drawSheet() {
    const fs = vs().fs || fontSize();
    root.style.setProperty('--fs', fs + 'px');
    const lyricFont = prefs.get('lyricFont');
    const mono = vs().mono ?? (lyricFont === 'mono');
    const next = renderSheet(doc, { chordName, mono, hideChords: !!vs().hide });
    if (lyricFont === 'sans' && !mono) next.style.fontFamily = 'var(--font-ui)';
    stopWatch?.();
    fill(sheetHolder, next);
    sheet = next;
    if (root.isConnected) stopWatch = watchSheet(sheet);
    scroller?.invalidate();
    if (scroller) scroller.sheet = sheet;
  }

  function redraw({ keepPlace = true } = {}) {
    // keep the line at the top of the screen where it is
    const anchor = keepPlace && sheet ? topBlock() : null;
    drawHead();
    drawStrip();
    drawSheet();
    if (anchor) restoreTop(anchor);
    deck.update();
  }

  function topBlock() {
    for (const [i, b] of [...sheet.children].entries()) {
      const r = b.getBoundingClientRect();
      if (r.bottom > 70) return { i, off: r.top };
    }
    return null;
  }
  function restoreTop({ i, off }) {
    const b = sheet.children[i];
    if (b) scrollTo(0, scrollY + b.getBoundingClientRect().top - off);
  }

  function chordTapped(name, orig) {
    openChord(name, {
      author: authorShapes(orig || name), tuning: tuningKey(), pick: vs().voicings?.[name],
      sub: capoNow() ? `Shape with capo on fret ${capoNow()}` : '',
      onPick: key => setView({ voicings: { ...(vs().voicings || {}), [name]: key || undefined } }),
    });
  }

  root.addEventListener('click', e => {
    const c = e.target.closest('.sheet [data-chord]');
    if (c) { e.preventDefault(); chordTapped(c.dataset.chord, c.dataset.orig || c.dataset.chord); }
  });

  // ---------- autoscroll deck ----------
  const deck = makeDeck();
  function duration() {
    if (song.duration) return song.duration;
    if (prefs.get('defaultLength')) return prefs.get('defaultLength');
    return sheet ? estimateDuration([...sheet.children].map(b => +b.dataset.w || 0)) : 165;
  }
  const lengthSource = () => (song.duration ? (song.durationFrom === 'you' ? 'set by you' : 'from YouTube') : prefs.get('defaultLength') ? 'your default' : 'estimated');

  function makeDeck() {
    const playBtn = h('button', { type: 'button', class: 'icon-btn play', 'aria-label': 'Start autoscroll' }, icon('play'));
    const time = h('button', { type: 'button', 'aria-label': 'Song length' });
    const speedOut = h('span', {});
    const slider = h('input', { type: 'range', class: 'deck-speed', min: '-1', max: '1', step: '0.01', value: String(Math.log2(vs().speed || 1)), 'aria-label': 'Autoscroll speed' });
    const prog = h('i', {});
    const grip = h('button', { type: 'button', class: 'deck-grip' }, h('i', {}));
    const more = h('div', { class: 'deck-more' },
      h('div', { class: 'deck-mid' }, h('div', { class: 'deck-time' }, time, speedOut), slider),
      iconButton('video', 'Play along on YouTube', () => toggleVideo()),
      iconButton('text', 'Display', () => openTools()));
    const el = h('div', { class: 'deck', role: 'region', 'aria-label': 'Autoscroll' },
      h('div', { class: 'deck-progress' }, prog), grip, playBtn, more);
    playBtn.addEventListener('click', () => { ensureScroller(); scroller.toggle(); });

    // Swipe it right (or tap the grip) and it tucks into the corner: just the
    // grip and play/pause. Swipe it left or tap the grip to bring it back.
    const tuck = on => {
      el.classList.toggle('tucked', on);
      more.inert = on;
      grip.setAttribute('aria-label', on ? 'Show the autoscroll controls' : 'Tuck the controls into the corner');
      grip.setAttribute('aria-expanded', String(!on));
      prefs.set('deckTucked', on);
    };
    tuck(!!prefs.get('deckTucked'));
    grip.addEventListener('click', () => tuck(!el.classList.contains('tucked')));
    let drag = null;
    let swiped = 0;
    el.addEventListener('pointerdown', e => {
      if (e.target.closest('.deck-speed')) return; // that one is for the speed
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false };
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.on) {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - drag.y)) return;
        drag.on = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
      }
      drag.dx = dx;
      // it follows the finger: rightwards to tuck it, leftwards to bring it out
      el.style.translate = `${el.classList.contains('tucked') ? Math.min(0, dx) : Math.max(0, dx)}px 0`;
    });
    const endDrag = () => {
      if (!drag) return;
      const { dx, on } = drag;
      drag = null;
      if (!on) return;
      el.classList.remove('dragging');
      el.style.translate = '';
      swiped = Date.now();
      const tucked = el.classList.contains('tucked');
      if (!tucked && dx > 50) tuck(true);
      else if (tucked && dx < -30) tuck(false);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    // a swipe that started on a button isn't a tap on it
    el.addEventListener('click', e => { if (Date.now() - swiped < 400) { e.stopPropagation(); e.preventDefault(); } }, true);
    time.addEventListener('click', () => openLength());
    slider.addEventListener('input', () => {
      const sp = Math.round(2 ** +slider.value * 100) / 100;
      ensureScroller().setSpeed(sp);
      update();
    });
    slider.addEventListener('change', () => setView({ speed: Math.abs(scroller.speed - 1) < 0.02 ? null : scroller.speed }));
    const update = st => {
      st ||= scroller ? scroller.state() : { playing: false, speed: vs().speed || 1, t: 0, fraction: 0 };
      const total = duration();
      fill(playBtn, icon(st.playing ? 'pause' : 'play'));
      playBtn.setAttribute('aria-label', st.playing ? 'Pause autoscroll' : 'Start autoscroll');
      fill(time, h('b', {}, fmtTime(st.t)), ` / ${fmtTime(total)}`);
      time.title = `Song length ${fmtTime(total)} (${lengthSource()}). Tap to change.`;
      speedOut.textContent = `${Math.round(st.speed * 100)}%`;
      prog.style.width = `${(st.fraction || 0) * 100}%`;
      el.classList.toggle('playing', st.playing);
    };
    return { el, update, slider };
  }

  function ensureScroller() {
    if (scroller) return scroller;
    scroller = new AutoScroll({
      sheet, duration,
      follow: () => (prefs.get('followVideo') && player?.playing() && player.duration() ? player.time() / player.duration() : null),
      onChange: st => {
        deck.update(st);
        if (st.playing) { wake.acquire(); root.classList.add('playing'); }
        else { root.classList.remove('playing'); if (!prefs.get('keepAwake')) wake.release(); }
        if (st.ended) ended();
      },
    });
    scroller.setSpeed(vs().speed || 1);
    return scroller;
  }

  function ended() {
    if (!listId) return;
    const l = store.lib.setlists[listId];
    const nextId = l?.songs[listIndex + 1];
    const next = nextId && store.lib.songs[nextId];
    if (next) toast(`Next: ${next.title}`, { action: 'Play', ms: 10000, onAction: () => go(`#/song/${next.id}?list=${listId}&i=${listIndex + 1}&auto=1`) });
  }

  function setlistNav() {
    const l = store.lib.setlists[listId];
    if (!l) return null;
    const prev = l.songs[listIndex - 1], next = l.songs[listIndex + 1];
    return h('span', { style: { display: 'flex' } },
      iconButton('back', 'Previous song in the setlist', () => prev && go(`#/song/${prev}?list=${listId}&i=${listIndex - 1}`), { cls: prev ? '' : 'disabled' }),
      h('span', { class: 'eyebrow', style: { alignSelf: 'center' } }, `${listIndex + 1}/${l.songs.length}`),
      iconButton('forward', 'Next song in the setlist', () => next && go(`#/song/${next}?list=${listId}&i=${listIndex + 1}`), { cls: next ? '' : 'disabled' }));
  }

  // ---------- tools: transpose, capo, size ----------
  function openTools() {
    const body = h('div', { class: 'tools-grid' });
    drawer({ title: 'Display', body });
    const draw = () => {
      const tr = +vs().tr || 0;
      const key = baseKey();
      fill(body, 
        toolRow('Transpose', key ? `Key ${transposeKey(key, tr)}${tr ? ` (was ${key})` : ''}` : 'Moves every chord up or down',
          stepper(tr === 0 ? '0' : (tr > 0 ? `+${tr}` : String(tr)), () => { setView({ tr: wrap(tr - 1) || null }); draw(); }, () => { setView({ tr: wrap(tr + 1) || null }); draw(); })),
        capoRow(draw),
        toolRow('Text size', 'Or pinch the song to zoom',
          stepper(String(vs().fs || fontSize()), () => { setView({ fs: Math.max(12, (vs().fs || fontSize()) - 1) }); draw(); }, () => { setView({ fs: Math.min(40, (vs().fs || fontSize()) + 1) }); draw(); })),
        toolRow('Simplify chords', 'Cmaj7 → C, Am7 → Am, Dsus4 → D', toggle(vs().simplify, v => { setView({ simplify: v || null }); })),
        toolRow('Chord diagrams', 'Above the song', toggle(prefs.get('diagrams'), v => { prefs.set('diagrams', v); drawStrip(); })),
        toolRow('Lyrics only', 'Hide the chords', toggle(vs().hide, v => { setView({ hide: v || null }); })),
        toolRow('Classic layout', 'Monospace text, like Ultimate Guitar', toggle(vs().mono ?? prefs.get('lyricFont') === 'mono', v => { setView({ mono: v === (prefs.get('lyricFont') === 'mono') ? null : v }); })),
        toolRow('Left-handed diagrams', 'Mirror the chord boxes', toggle(prefs.get('leftHanded'), v => { prefs.set('leftHanded', v); drawStrip(); })),
        (tr || vs().capo != null || vs().fs || vs().simplify) ? button('Reset to the original', () => { setView({ tr: null, capo: null, fs: null, simplify: null }); draw(); }, { cls: 'btn-ghost' }) : null);
    };
    draw();
  }
  const wrap = n => ((n + 17) % 12 + 12) % 12 - 5; // keep within -5..+6
  const signed = n => (n > 0 ? `+${n}` : String(n));

  function capoRow(redrawMenu) {
    const set = c => { setView({ capo: c === origCapo() ? null : c }); redrawMenu(); };
    return toolRow('Capo', capoNow() !== origCapo() ? `Shapes change, it sounds the same (tab: ${origCapo() ? `capo ${origCapo()}` : 'no capo'})` : 'Change it and the chord shapes follow',
      stepper(capoNow() ? `Fret ${capoNow()}` : 'None', () => set(Math.max(0, capoNow() - 1)), () => set(Math.min(11, capoNow() + 1))));
  }

  // ---------- transpose ----------
  // Up or down a semitone at a time, or straight to a key; the chords and
  // their shapes follow.
  function openTranspose() {
    const body = h('div', { class: 'transpose' });
    drawer({ title: 'Transpose', body });
    const draw = () => {
      const tr = +vs().tr || 0;
      const key = baseKey();
      const capoShift = shift() - tr; // shapes move when the capo does
      const keyAt = n => transposeKey(key, n + capoShift);
      const to = n => { setView({ tr: n || null }); draw(); };
      fill(body,
        h('p', { class: 'transpose-now' }, key
          ? (tr ? h('span', {}, 'Key ', h('b', {}, keyAt(tr)), `, ${signed(tr)} from ${keyAt(0)}`) : h('span', {}, 'Key ', h('b', {}, keyAt(0)), ', as written'))
          : (tr ? `${signed(tr)} semitone${Math.abs(tr) === 1 ? '' : 's'}` : 'As written')),
        toolRow('Up or down', 'A semitone at a time', stepper(tr ? signed(tr) : '0', () => to(wrap(tr - 1)), () => to(wrap(tr + 1)))),
        h('div', { class: 'key-grid', role: 'group', 'aria-label': key ? 'Pick a key' : 'Pick how far' },
          ...Array.from({ length: 12 }, (_, i) => i - 5).map(n => h('button', {
            type: 'button', class: n === 0 ? 'orig' : '', 'aria-pressed': String(n === tr),
            'aria-label': key ? `${keyAt(n)}${n === 0 ? ' (as written)' : ` (${signed(n)})`}` : `${signed(n)} semitones`,
            onClick: () => to(n),
          }, key ? keyAt(n) : signed(n), h('small', {}, n === 0 ? 'written' : signed(n))))),
        capoRow(draw),
        tr ? button('Back to the original key', () => to(0), { cls: 'btn-ghost' }) : null);
    };
    draw();
  }

  // ---------- more ----------
  function openMore() {
    const d = drawer({ title: song.title });
    const close = () => d.close();
    const rows = [];
    if (!isPreview) {
      rows.push(menuRow('edit', 'Edit song', 'Text, title, key, capo', () => { close(); go(`#/edit/${id}`); }));
      rows.push(menuRow('note', 'Notes', song.notes ? song.notes.slice(0, 60) : 'Your own reminders for this song', async () => { close(); editNotes(); }));
      rows.push(menuRow('list', 'Add to setlist', '', () => { close(); addToSetlist(); }));
    }
    rows.push(menuRow('clock', 'Song length', `${fmtTime(duration())} (${lengthSource()}). Sets the autoscroll pace.`, () => { close(); openLength(); }));
    rows.push(menuRow('video', 'YouTube video', song.yt ? 'Change the video' : 'Find or paste one', () => { close(); chooseVideo(); }));
    rows.push(menuRow('repeat', 'Other versions', 'Every version of this song on Ultimate Guitar', () => { close(); otherVersions(); }));
    rows.push(menuRow('share', 'Copy as text', 'Chords over lyrics, to paste anywhere', () => { close(); copyText(); }));
    if (song.src?.url) rows.push(menuRow('link', 'Open on Ultimate Guitar', '', () => { close(); window.open(song.src.url, '_blank', 'noopener'); }));
    if (!isPreview) {
      rows.push(coverOf(song)
        ? menuRow('image', 'Remove the album cover', 'If it’s the wrong one. It won’t be looked up again.', () => { close(); dispatch({ t: 'set', id, set: { cover: NO_COVER } }); })
        : menuRow('image', 'Find the album cover', 'On Ultimate Guitar, then Apple Music', async () => {
          close();
          toast('Looking for the cover…', { ms: 2000 });
          try {
            const cover = await findCover(song);
            if (cover) dispatch({ t: 'set', id, set: { cover } });
            else toast('No cover found for this song.');
          } catch { toast('Couldn’t look right now. Are you online?'); }
        }));
    }
    if (!isPreview) rows.push(menuRow('trash', signedIn() ? 'Delete for everyone' : 'Delete song', signedIn() ? 'From the shared songbook' : '', async () => {
      close();
      if (signedIn() && !(await confirmSheet(`Delete “${song.title}” for everyone?`, 'It goes from the shared songbook, on everyone’s devices. (To have it out of your way only, unfavorite it.)', { confirm: 'Delete', danger: true }))) return;
      const undo = undoable({ t: 'del', id });
      toast(`Deleted “${song.title}”`, { action: 'Undo', onAction: () => { undo(); go(`#/song/${id}`); } });
      go('#/');
    }, { danger: true }));
    d.set(h('div', { class: 'set-list' }, rows));
  }

  async function editNotes() {
    const ta = h('textarea', { class: 'textarea', rows: '6', placeholder: 'Strumming pattern, who sings what, where to breathe…' }, song.notes || '');
    const d = drawer({
      title: 'Notes', body: [ta, h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' } },
        button('Cancel', () => d.close(), { cls: 'btn-ghost' }),
        button('Save', () => { dispatch({ t: 'set', id, set: { notes: ta.value.trim() || null } }); d.close(); }, { cls: 'btn-primary' }))],
    });
    setTimeout(() => ta.focus(), 60);
  }

  function addToSetlist() {
    const lists = Object.values(store.lib.setlists);
    const d = drawer({ title: 'Add to setlist' });
    const add = l => {
      if (l.songs.includes(id)) { toast(`Already in “${l.name}”`); d.close(); return; }
      dispatch({ t: 'list', id: l.id, set: { songs: [...l.songs, id], updated: new Date().toISOString() } });
      toast(`Added to “${l.name}”`);
      d.close();
    };
    d.set(h('div', { class: 'set-list' },
      lists.map(l => menuRow('list', l.name, `${l.songs.length} songs${l.songs.includes(id) ? ' · already in it' : ''}`, () => add(l))),
      menuRow('plus', 'New setlist', '', async () => {
        d.close();
        const name = await promptSheet('New setlist', { label: 'Name', placeholder: 'Sunday practice', confirm: 'Create' });
        if (!name?.trim()) return;
        const lid = newId('l');
        dispatch({ t: 'list', id: lid, set: { name: name.trim(), songs: [id], created: new Date().toISOString(), updated: new Date().toISOString() } });
        toast(`Added to “${name.trim()}”`);
      })));
  }

  function openLength() {
    const cur = duration();
    const input = h('input', { class: 'input', inputmode: 'numeric', value: fmtTime(cur), 'aria-label': 'Length (minutes:seconds)', style: { maxWidth: '140px' } });
    const set = (sec, from) => {
      if (isPreview) { song.duration = sec || undefined; song.durationFrom = from; } else dispatch({ t: 'set', id, set: { duration: sec || null, durationFrom: sec ? from : null } });
      scroller?.invalidate();
      deck.update();
      d.close();
    };
    const presets = [150, 180, 210, 240, 300].map(s => button(fmtTime(s), () => set(s, 'you'), { cls: 'btn-small' }));
    const d = drawer({
      title: 'Song length',
      body: [
        h('p', {}, 'The autoscroll gets through the whole song in this time at 100%. The slider still speeds it up or slows it down.'),
        h('div', { class: 'btn-row', style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' } }, presets),
        h('form', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px' }, onSubmit: e => { e.preventDefault(); const s = parseTime(input.value); if (s && s >= 20 && s < 3600) set(s, 'you'); else toast('Type it like 3:15'); } },
          input, button('Set', null, { type: 'submit', cls: 'btn-primary btn-small' })),
        h('div', { class: 'set-list' },
          menuRow('video', 'Use the YouTube video’s length', song.yt ? 'Opens the player once to read it' : 'Finds the song on YouTube first', () => { d.close(); toggleVideo(true); }),
          menuRow('wand', 'Estimate from the song', `${fmtTime(sheet ? estimateDuration([...sheet.children].map(b => +b.dataset.w || 0)) : 165)}, from the number of lines`, () => set(null, null))),
        h('div', { class: 'tool-row' }, h('span', {}, 'Follow the video', h('small', {}, 'While it plays, the song scrolls with it')), toggle(prefs.get('followVideo'), v => prefs.set('followVideo', v))),
      ],
    });
  }

  // ---------- YouTube ----------
  async function toggleVideo(forLength = false) {
    if (ytBox && !forLength) { closeVideo(); return; }
    let vid = song.yt;
    // a video the tab's author linked in their notes is the version they tabbed
    if (!vid) {
      const linked = videoIdFrom((/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/\S+|youtu\.be\/\S+)/.exec(song.content) || [])[0]);
      if (linked) {
        vid = linked;
        if (isPreview) song.yt = vid; else dispatch({ t: 'set', id, set: { yt: vid } });
        toast('Playing the video linked in the tab’s notes');
      }
    }
    if (!vid) {
      const done = toast('Looking on YouTube…', { ms: 15000 });
      try {
        const found = await findVideo(song.title, song.artist);
        vid = found.id;
        if (isPreview) song.yt = vid; else dispatch({ t: 'set', id, set: { yt: vid } });
        if (found.duration && !song.duration) setDuration(found.duration);
      } catch (e) {
        done();
        toast(e.message === 'No video found.' ? 'No video found. Paste a link in ⋯ → YouTube video.' : e.message);
        return;
      }
      done();
    }
    openVideo(vid);
  }

  function setDuration(sec) {
    if (song.duration && song.durationFrom === 'you') return;
    if (isPreview) { song.duration = sec; song.durationFrom = 'yt'; } else dispatch({ t: 'set', id, set: { duration: sec, durationFrom: 'yt' } });
    scroller?.invalidate();
    deck.update();
  }

  function openVideo(vid) {
    closeVideo();
    const frame = h('div', { class: 'yt-frame' });
    const followBtn = iconButton('repeat', 'Scroll with the video', () => {
      prefs.set('followVideo', !prefs.get('followVideo'));
      followBtn.classList.toggle('on', prefs.get('followVideo'));
      toast(prefs.get('followVideo') ? 'The song scrolls with the video while it plays' : 'Autoscroll runs on its own');
    }, { cls: prefs.get('followVideo') ? 'on' : '' });
    const miniBtn = iconButton('down', 'Shrink', () => ytBox.classList.toggle('mini'));
    // (closes as the finger lifts, too: Safari can drop the tap itself while the
    // page is busy scrolling; and no stray tap lands on what was under it)
    const closeBtn = iconButton('close', 'Close video', () => closeVideo());
    closeBtn.addEventListener('touchend', e => {
      const t = e.changedTouches[0];
      const r = closeBtn.getBoundingClientRect();
      if (!t || t.clientX < r.left - 12 || t.clientX > r.right + 12 || t.clientY < r.top - 12 || t.clientY > r.bottom + 12) return; // slid off: no
      e.preventDefault();
      closeVideo();
    }, { passive: false });
    ytBox = h('div', { class: 'yt', role: 'region', 'aria-label': 'YouTube player' },
      h('div', { class: 'yt-bar' }, h('span', {}, song.title), followBtn, miniBtn, closeBtn),
      frame);
    document.body.append(ytBox);
    dragBox(ytBox);
    player = new Player(frame, vid, {
      onDuration: d => setDuration(d),
      onState: s => { if (s === 1 && prefs.get('followVideo')) { ensureScroller().play(); } },
      onError: () => toast('That video can’t be played here. Pick another in ⋯ → YouTube video.'),
    });
  }

  function closeVideo() {
    const box = ytBox;
    ytBox = null;
    box?.remove();
    player?.pause(); // the sound stops at once, whatever happens next
    player?.destroy();
    player = null;
  }

  async function chooseVideo() {
    const link = await promptSheet('YouTube video', { label: 'Paste a YouTube link', value: song.yt ? `https://youtu.be/${song.yt}` : '', placeholder: 'https://youtu.be/…', confirm: 'Use it', hint: 'Leave it empty to look it up again.' });
    if (link === null) return;
    const vid = videoIdFrom(link);
    if (link.trim() && !vid) { toast('That doesn’t look like a YouTube link.'); return; }
    const set = { yt: vid || null };
    if (song.durationFrom === 'yt') { set.duration = null; set.durationFrom = null; }
    if (isPreview) Object.assign(song, set); else dispatch({ t: 'set', id, set });
    closeVideo();
    if (vid) openVideo(vid); else toggleVideo();
  }

  // ---------- other versions ----------
  async function otherVersions() {
    const d = drawer({ title: 'Other versions', body: h('div', { class: 'row' }, h('span', { class: 'spinner' }), 'Searching Ultimate Guitar…') });
    try {
      const groups = groupResults(await searchUG(`${song.artist} ${song.title}`));
      const g = groups.find(x => x.title.toLowerCase() === song.title.toLowerCase()) || groups[0];
      if (!g) { d.set(h('p', {}, 'Nothing found.')); return; }
      d.set(h('div', { class: 'set-list' }, g.versions.filter(v => v.type !== 'Pro').map(v => menuRow(v.url === song.src?.url ? 'check' : 'note',
        `${v.type} · version ${v.version}`, `★ ${v.rating.toFixed(1)} from ${v.votes} votes${v.url === song.src?.url ? ' · this one' : ''}`,
        async () => {
          if (v.url === song.src?.url) { d.close(); return; }
          d.set(h('div', { class: 'row' }, h('span', { class: 'spinner' }), 'Loading…'));
          try {
            const fresh = songFromTab({ ...v, title: g.title, artist: g.artist }, await fetchTab(v.url));
            d.close();
            if (isPreview) { session.preview = fresh; go('#/song/preview'); return; }
            if (await confirmSheet('Switch to this version?', `Replaces the chords and lyrics of “${song.title}” with version ${v.version}. Your favorite, notes and setlists stay.`, { confirm: 'Switch' })) {
              const { title, artist, content, src, key, capo, tuning, bpm, shapes, strum, kind } = fresh;
              const undo = undoable({ t: 'set', id, set: { title, artist, content, src, key: key || null, capo: capo || null, tuning: tuning || null, bpm: bpm || null, shapes: shapes || null, strum: strum || null, kind, edited: new Date().toISOString() } });
              toast(`Now showing version ${v.version}`, { action: 'Undo', onAction: undo });
            }
          } catch (e) { d.set(h('p', { class: 'error' }, e.message)); }
        }))));
    } catch (e) {
      d.set(h('p', { class: 'error' }, e.message));
    }
  }

  function copyText() {
    const text = `${song.title}${song.artist ? ` — ${song.artist}` : ''}\n${capoNow() ? `Capo ${capoNow()}\n` : ''}\n${toPlainText(song.content)}`;
    navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy on this device.'));
  }

  function saveIt(favorite) {
    const sid = savePreview({ ...song, fav: favorite || song.fav || undefined });
    session.preview = null;
    toast(favorite ? 'Saved to your favorites' : 'Saved to your library');
    go(`#/song/${sid}`, { replace: true });
  }

  // ---------- pinch to zoom ----------
  // The text itself gets bigger or smaller as you pinch, and the lines wrap to
  // the screen as it does (nothing runs off the edge); the line between your
  // fingers stays where it is. Saved with the song when you let go.
  let pinch = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const midY = t => (t[0].clientY + t[1].clientY) / 2;
  sheetHolder.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    const fs = vs().fs || fontSize();
    pinch = { d0: dist(e.touches), fs0: fs, fs, cy: midY(e.touches), frame: 0 };
  }, { passive: true });
  sheetHolder.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.cy = midY(e.touches);
    const fs = Math.max(12, Math.min(40, Math.round(pinch.fs0 * dist(e.touches) / pinch.d0)));
    if (fs === pinch.fs) return;
    pinch.fs = fs;
    pinch.frame ||= requestAnimationFrame(() => {
      if (!pinch) return;
      pinch.frame = 0;
      sizeTo(pinch.fs, pinch.cy);
    });
  }, { passive: false });
  // the text at this size now, keeping the line at height y on the screen in place
  function sizeTo(fs, y) {
    const el = document.elementFromPoint(innerWidth / 2, y)?.closest('.sheet > .blk');
    const before = el?.getBoundingClientRect();
    root.style.setProperty('--fs', fs + 'px');
    if (el && before) {
      const after = el.getBoundingClientRect();
      const at = before.height ? (y - before.top) / before.height : 0;
      scrollBy(0, after.top + at * after.height - y);
    }
    scroller?.invalidate();
  }
  const endPinch = () => {
    if (!pinch) return;
    const { fs, fs0, frame } = pinch;
    pinch = null;
    if (frame) cancelAnimationFrame(frame);
    if (fs !== fs0) {
      sizeTo(fs, innerHeight / 2);
      setView({ fs }, { draw: false });
    }
  };
  sheetHolder.addEventListener('touchend', endPinch);
  sheetHolder.addEventListener('touchcancel', endPinch);

  // ctrl + wheel / ctrl + plus on a computer changes the text size too
  const onWheel = e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const fs = Math.max(12, Math.min(40, (vs().fs || fontSize()) + (e.deltaY < 0 ? 1 : -1)));
    setView({ fs });
  };
  addEventListener('wheel', onWheel, { passive: false });

  const onKey = e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.drawer')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); ensureScroller().toggle(); }
    else if ((e.key === '+' || e.key === '=') && (e.ctrlKey || e.metaKey || !e.altKey)) { e.preventDefault(); setView({ fs: Math.min(40, (vs().fs || fontSize()) + 1) }); }
    else if (e.key === '-' && !e.altKey) { e.preventDefault(); setView({ fs: Math.max(12, (vs().fs || fontSize()) - 1) }); }
    else if (e.key === 'Escape') back('#/');
    else if (e.key === 't') setView({ tr: wrap((+vs().tr || 0) + 1) || null });
    else if (e.key === 'T') setView({ tr: wrap((+vs().tr || 0) - 1) || null });
    else if (e.key === 'ArrowRight' && listId) bar.querySelector('[aria-label^="Next song"]')?.click();
    else if (e.key === 'ArrowLeft' && listId) bar.querySelector('[aria-label^="Previous song"]')?.click();
  };
  addEventListener('keydown', onKey);

  // the title moves into the bar once the big heading scrolls away
  const onScroll = () => root.classList.toggle('scrolled', scrollY > 90);
  addEventListener('scroll', onScroll, { passive: true });

  // changes from elsewhere (another device, the editor)
  function redrawFromStore() {
    const next = getSong();
    if (!next) { if (!isPreview) go('#/'); return; }
    if (next === song) return;
    const contentChanged = next.content !== song.content;
    const shown = s => JSON.stringify([s.view || {}, s.fav, s.title, s.artist, s.key, s.capo, s.tuning, s.bpm, s.notes, s.duration, s.yt, s.cover, s.shapes || null, s.strum || null, s.src?.version]);
    const same = !contentChanged && shown(next) === shown(song);
    song = next;
    if (same) { deck.update(); return; } // only a play count or the like
    if (contentChanged) doc = parseSong(song.content);
    redraw();
  }
  const unsub = subscribe(redrawFromStore);

  drawHead();
  drawStrip();
  drawSheet();
  deck.update();
  if (!isPreview) dispatch({ t: 'set', id, set: { played: new Date().toISOString(), plays: (song.plays || 0) + 1 } }, { lazy: true });
  if (prefs.get('keepAwake')) wake.acquire();

  return {
    el: h('div', {}, root, deck.el),
    title: song.title,
    tab: 'library',
    immersive: true,
    mounted() {
      stopWatch = watchSheet(sheet);
      if (route.query.get('auto') === '1') setTimeout(() => ensureScroller().play(), 600);
    },
    destroy() {
      unsub();
      strumEl?.destroy();
      stopWatch?.();
      scroller?.destroy();
      closeVideo();
      wake.release();
      removeEventListener('keydown', onKey);
      removeEventListener('wheel', onWheel);
      removeEventListener('scroll', onScroll);
    },
  };
}

function toolRow(label, sub, control) {
  return h('div', { class: 'tool-row' }, h('span', {}, label, sub ? h('small', {}, sub) : null), control);
}

function stepper(value, onMinus, onPlus) {
  return h('div', { class: 'stepper' }, iconButton('minus', 'Less', onMinus), h('output', {}, value), iconButton('plus', 'More', onPlus));
}

// The mini player can be dragged out of the way.
function dragBox(box) {
  const handle = box.querySelector('.yt-bar');
  let start = null;
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = box.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moving: false };
  });
  handle.addEventListener('pointermove', e => {
    if (!start) return;
    // only a real drag takes the finger (a tap stays a tap)
    if (!start.moving) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      start.moving = true;
      handle.setPointerCapture(e.pointerId);
    }
    const left = Math.max(4, Math.min(innerWidth - box.offsetWidth - 4, start.left + e.clientX - start.x));
    const top = Math.max(4, Math.min(innerHeight - 60, start.top + e.clientY - start.y));
    Object.assign(box.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
  });
  const end = () => { start = null; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
