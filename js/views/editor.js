// Writing or editing a song. The text is plain chords-over-lyrics (or [C]
// inline chords); chord lines are recognized when saving.

import { h, iconButton, button, toast, confirmSheet, fmtTime, parseTime, debounce, fill } from '../ui.js';
import { store, dispatch } from '../store.js';
import { makeSong } from '../model.js';
import { parseSong, toPlainText, fromPlainText } from '../parse.js';
import { renderSheet, watchSheet } from '../sheet.js';
import { detectKey } from '../theory.js';
import { videoIdFrom } from '../ug.js';
import { fontSize } from '../prefs.js';
import { field } from './common.js';

const EXAMPLE = `[Verse 1]
G              D
Write chords on the line above
Em              C
and the words right underneath

[Chorus]
[G]Or put them [D]inline like [Em]this`;

export function view(route, { go, back }) {
  const id = route.args[0];
  const isNew = !id || id === 'new';
  const song = isNew ? null : store.lib.songs[id];
  if (!isNew && !song) return { el: h('div', { class: 'page' }, h('div', { class: 'empty' }, h('h3', {}, 'Song not found'))) };

  const title = h('input', { class: 'input', value: song?.title || '', placeholder: 'Song title', autocapitalize: 'words' });
  const artist = h('input', { class: 'input', value: song?.artist || '', placeholder: 'Artist', autocapitalize: 'words' });
  const key = h('input', { class: 'input', value: song?.key || '', placeholder: 'Auto', maxlength: '4', style: { maxWidth: '110px' } });
  const capo = h('select', { class: 'select', style: { maxWidth: '130px' } }, h('option', { value: '0' }, 'None'), ...Array.from({ length: 11 }, (_, i) => h('option', { value: String(i + 1) }, `Fret ${i + 1}`)));
  capo.value = String(song?.capo || 0);
  const tuning = h('input', { class: 'input', value: song?.tuning || '', placeholder: 'E A D G B E' });
  const length = h('input', { class: 'input', value: song?.duration ? fmtTime(song.duration) : '', placeholder: 'm:ss', inputmode: 'numeric', style: { maxWidth: '110px' } });
  const yt = h('input', { class: 'input', value: song?.yt ? `https://youtu.be/${song.yt}` : '', placeholder: 'YouTube link (optional)' });
  const text = h('textarea', { class: 'textarea editor-area', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: EXAMPLE, wrap: 'off' }, song ? toPlainText(song.content) : '');
  const preview = h('div', { class: 'song', style: { padding: 0, '--fs': `${Math.max(15, fontSize() - 2)}px` } });
  let stop = null;
  const draw = () => {
    const sheet = renderSheet(parseSong(fromPlainText(text.value) || EXAMPLE));
    stop?.();
    fill(preview, sheet);
    if (sheet.isConnected) stop = watchSheet(sheet);
  };
  text.addEventListener('input', debounce(draw, 250));

  let dirty = false;
  for (const inp of [title, artist, key, capo, tuning, length, yt, text]) inp.addEventListener('input', () => { dirty = true; });

  const save = () => {
    const t = title.value.trim();
    if (!t) { toast('Give the song a title.'); title.focus(); return; }
    const content = fromPlainText(text.value.replace(/\s+$/, ''));
    if (!content.trim()) { toast('The song has no text yet.'); text.focus(); return; }
    const doc = parseSong(content);
    const dur = length.value.trim() ? parseTime(length.value) : null;
    if (length.value.trim() && !dur) { toast('Type the length like 3:15'); length.focus(); return; }
    const vid = yt.value.trim() ? videoIdFrom(yt.value) : null;
    if (yt.value.trim() && !vid) { toast('That doesn’t look like a YouTube link.'); yt.focus(); return; }
    const fields = {
      title: t, artist: artist.value.trim(), content,
      key: key.value.trim() || detectKey(doc.chords) || null,
      capo: +capo.value || null,
      tuning: tuning.value.trim() && tuning.value.trim() !== 'E A D G B E' ? tuning.value.trim() : null,
      duration: dur || null, durationFrom: dur ? 'you' : null,
      yt: vid,
      edited: new Date().toISOString(),
    };
    if (isNew) {
      const s = makeSong({ ...fields, src: { site: 'manual' } });
      dispatch({ t: 'add', song: s });
      dirty = false;
      go(`#/song/${s.id}`, { replace: true });
    } else {
      if (song.durationFrom === 'yt' && !length.value.trim()) { fields.duration = song.duration; fields.durationFrom = 'yt'; }
      dispatch({ t: 'set', id, set: fields });
      dirty = false;
      toast('Saved');
      back(`#/song/${id}`);
    }
  };

  const cancel = async () => {
    if (dirty && !(await confirmSheet('Leave without saving?', 'Your changes to this song will be lost.', { confirm: 'Leave', danger: true }))) return;
    dirty = false;
    back(isNew ? '#/' : `#/song/${id}`);
  };

  const el = h('div', { class: 'page wide' },
    h('header', { class: 'page-head' },
      iconButton('close', 'Cancel', cancel),
      h('h1', { class: 'page-title', style: { fontSize: '26px' } }, isNew ? 'New song' : 'Edit song'),
      button('Save', save, { cls: 'btn-primary' })),
    h('div', { class: 'editor-grid' },
      h('div', {},
        h('div', { class: 'field-row' }, field('Title', title), field('Artist', artist)),
        h('div', { class: 'field-row' }, field('Key', key), field('Capo', capo), field('Length', length)),
        h('details', { class: 'more-fields' }, h('summary', {}, 'Tuning and video'), field('Tuning', tuning, 'Leave empty for standard tuning'), field('YouTube', yt)),
        field('Chords and lyrics', text, 'Chord lines go above the words, like on Ultimate Guitar. Use [Verse], [Chorus] for sections.')),
      h('div', { class: 'editor-preview' }, h('div', { class: 'eyebrow', style: { margin: '6px 0 4px' } }, 'Preview'), preview)));

  const onKey = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } };
  const beforeUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('keydown', onKey);
  addEventListener('beforeunload', beforeUnload);
  return {
    el, title: isNew ? 'New song' : `Edit ${song.title}`, tab: 'library',
    mounted() { draw(); if (isNew) title.focus(); },
    destroy() { stop?.(); removeEventListener('keydown', onKey); removeEventListener('beforeunload', beforeUnload); },
  };
}
