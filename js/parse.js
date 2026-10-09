// Song text → a document the sheet renderer can lay out.
//
// Accepts three kinds of input, even mixed in one song:
//  - Ultimate Guitar markup: [ch]Am[/ch] chords, [tab]…[/tab] blocks around
//    chord/lyric pairs and tablature. Columns are counted with the tags removed,
//    which is how the author lined chords up.
//  - Plain chords-over-lyrics text (pasted from a site), chord lines detected.
//  - Inline ChordPro chords: "[G]Mama take this [D]badge".
//
// The key output is the 'pair' block: a lyric line plus chords anchored to
// character positions in it. The renderer keeps each chord glued to its
// character, so wrapping and zooming can't move a chord off its word.

import { isChord } from './theory.js';

// Tokens allowed on a chord line besides chords: bars, repeats, rhythm slashes.
const JUNK_RX = /^(?:\|+|\|\||:?\|:?|-+|–+|\/+|\\+|\.+|x\d+|\d+x|\(x?\d+x?\)|\[x?\d+x?\]|\*+|\(\*+\)|\(|\)|%|N\.?C\.?|n\.c\.?|\d+\.|→|>+|~+|\^|,|:|riff\d*|\(riff\d*\)|fill\d*|\(fill\d*\)|repeat|\(repeat\)|hold|\(hold\)|stop|tacet|\(\d+\)|\d)$/i;

const SECTION_WORDS = 'intro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|bridge|outro|solo|interlude|instrumental|refrain|hook|ending|coda|break|tag|riff|turnaround|middle\\s*8|breakdown|vamp|prelude';
const PLAIN_SECTION_RX = new RegExp(`^\\s*(?:(${SECTION_WORDS})(?:\\s*\\d+)?|(?:${SECTION_WORDS})\\s*\\(.*\\))\\s*:?\\s*$`, 'i');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#039': "'", '#39': "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(8 - (out.length % 8));
    else out += ch;
  }
  return out;
}

// Chord names some sheets wrap in parentheses on chord lines: "(G)".
function chordToken(tok) {
  if (isChord(tok)) return tok;
  const m = /^\((.+)\)$/.exec(tok);
  if (m && isChord(m[1])) return m[1];
  return null;
}

// Reads the chord markers of one line.
//  kept:   the line with markers removed but chord names left in place
//          (UG semantics; also how a chord-only line of [G] [D] is laid out)
//  lyric:  the line with chord names removed (ChordPro semantics)
//  chords: [{ name, col (in kept), at (in lyric), ug }]
function readMarkers(line) {
  const rx = /\[ch\]([^[\]]*?)\[\/ch\]|\[([^[\]]{1,16})\]/g;
  let kept = '', lyric = '', last = 0, m;
  const chords = [];
  while ((m = rx.exec(line))) {
    const before = line.slice(last, m.index);
    kept += before;
    lyric += before;
    if (m[1] !== undefined) {
      const name = m[1].trim();
      chords.push({ name, col: kept.length, at: lyric.length, ug: true });
      kept += name;
      lyric += name; // UG chords occupy their columns either way
    } else if (isChord(m[2].trim())) {
      const name = m[2].trim();
      chords.push({ name, col: kept.length, at: lyric.length, ug: false });
      kept += name;
    } else {
      kept += m[0];
      lyric += m[0];
    }
    last = m.index + m[0].length;
  }
  kept += line.slice(last);
  lyric += line.slice(last);
  return { kept, lyric, chords };
}

// Splits text into tokens with their columns.
function tokens(text) {
  const out = [];
  const rx = /\S+/g;
  let m;
  while ((m = rx.exec(text))) out.push({ text: m[0], col: m.index });
  return out;
}

// A chord line: every token is a chord, chord-line junk or part of a note in
// parentheses ("(let ring)"), with at least one chord.
function chordLineItems(text) {
  const toks = tokens(text);
  if (!toks.length) return null;
  const items = [];
  let chords = 0;
  let inParen = false;
  for (const t of toks) {
    // a footnote mark glued to a chord ("Am*") belongs to it but isn't part of its name
    const mm = /^(.*?)([*'"]+)$/.exec(t.text);
    const base = mm && chordToken(mm[1]) ? mm[1] : t.text;
    const c = !inParen && chordToken(base);
    if (c) {
      const paren = c !== base;
      items.push({ col: t.col + (paren ? 1 : 0), chord: c, mark: base === t.text ? '' : mm[2], raw: t.text, rawCol: t.col });
      chords++;
    } else if (inParen || JUNK_RX.test(t.text) || /^\(/.test(t.text)) {
      if (/^\(/.test(t.text) && !/\)$/.test(t.text)) inParen = true;
      else if (/\)$/.test(t.text)) inParen = false;
      items.push({ col: t.col, text: t.text, raw: t.text, rawCol: t.col });
    } else {
      return null;
    }
  }
  return chords ? mergeNotes(items, text) : null;
}

// "(let" "ring)" → one note "(let ring)".
function mergeNotes(items, line) {
  const out = [];
  for (const x of items) {
    const prev = out.at(-1);
    if (x.text && prev && prev.text && prev.text.startsWith('(') && !prev.text.includes(')')) {
      prev.text = prev.raw = line.slice(prev.col, x.col + x.text.length);
      continue;
    }
    out.push(x);
  }
  return out;
}

const isNote = t => JUNK_RX.test(t) || /^\(.*\)$/.test(t);

// Items of a line whose chords were explicitly marked: the chords exactly where
// the markup says, everything else split into notes. Words among them
// ("Intro: G D G (x2)") make it an annotated line, which never pairs with the
// lyric below; marks glued to a chord ("Am*") belong to that chord.
function markedChordLine(kept, chords) {
  const items = [];
  let pos = 0;
  for (const c of chords) {
    if (c.col > pos) pushText(items, kept.slice(pos, c.col), pos);
    if (isChord(c.name)) items.push({ col: c.col, chord: c.name, mark: '', raw: c.name, rawCol: c.col });
    else pushText(items, c.name, c.col);
    pos = c.col + c.name.length;
  }
  if (pos < kept.length) pushText(items, kept.slice(pos), pos);
  // the markup sometimes misses a chord: on a marked line, a chord is a chord
  for (const x of items) {
    if (x.text && isChord(x.text) && /^[A-G]/.test(x.text)) {
      x.chord = x.text;
      x.mark = '';
      delete x.text;
    }
  }
  items.splice(0, items.length, ...mergeNotes(items, kept));
  for (let i = items.length - 1; i > 0; i--) {
    const x = items[i], prev = items[i - 1];
    if (!x.text || !prev.chord || prev.col + prev.chord.length + (prev.mark || '').length !== x.col) continue;
    if (!prev.mark && !/^[*'"]+$/.test(x.text) && isChord(prev.chord + x.text)) {
      prev.chord += x.text; // "[ch]B[/ch]+" is B+
      prev.raw += x.text;
      items.splice(i, 1);
    } else if (/^[*'"]+$/.test(x.text)) {
      prev.mark = (prev.mark || '') + x.text;
      prev.raw += x.text;
      items.splice(i, 1);
    }
  }
  const annotated = items.some(x => x.text && !isNote(x.text));
  return { items, annotated };
}

function pushText(items, s, col) {
  const rx = /\S+/g;
  let m;
  while ((m = rx.exec(s))) items.push({ col: col + m.index, text: m[0], raw: m[0], rawCol: col + m.index });
}

// Words in what's left after removing chords (anything with two letters in a row).
const hasWords = s => /[\p{L}]{2,}|[\p{L}]['’][\p{L}]/u.test(s.replace(/\b(?:x\d+|\d+x|N\.?C\.?|riff|fill|repeat)\b/gi, ''));

// A tablature staff line: "e|---3---|", "D|-2--0--|  / = slide", "|--5h7--|".
// An optional string name, then mostly dashes, digits and bar lines up to the
// last bar; notes after it are allowed.
function isTabLine(s) {
  const t = s.trim();
  if (t.length < 6) return false;
  const core = t.replace(/^[A-Ga-g][#b]?\s?(?=[|:\-–])/, '');
  if (!/^[|:\-–0-9]/.test(core)) return false;
  const lastBar = core.lastIndexOf('|');
  const staff = lastBar >= 4 ? core.slice(0, lastBar + 1) : core;
  if (staff.length < core.length * 0.5) return false;
  const dashes = (staff.match(/[-–—]/g) || []).length;
  if (dashes < 4) return false;
  if (!/^[-–—0-9hpbrsxX/\\~|*.()<>=^vt: ]*$/.test(staff)) return false;
  const tabby = (staff.match(/[-–—0-9|]/g) || []).length;
  return tabby / staff.replace(/\s/g, '').length >= 0.7;
}

function sectionOf(line) {
  const m = /^\s*\[([^[\]]+)\]\s*(.*?)\s*$/.exec(line);
  if (m && !isChord(m[1].trim()) && !/^\/?(ch|tab)$/i.test(m[1].trim())) {
    return { label: m[1].trim(), rest: m[2] };
  }
  const p = PLAIN_SECTION_RX.exec(line);
  if (p) return { label: line.trim().replace(/:$/, '').trim(), rest: '' };
  return null;
}

const META_RX = {
  capo: /^\s*capo\s*[:\-]?\s*(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\b|^\s*capo\s*[:\-]?\s*(?:on\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh)\b/i,
  key: /^\s*key\s*[:\-]?\s*([A-G][#b]?m?)\b/i,
  tuning: /^\s*tuning\s*[:\-]\s*(.+?)\s*$/i,
  bpm: /^\s*(?:tempo|bpm)\s*[:\-]?\s*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/i,
};
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11 };

// A chord legend line: "D/F#   200232", "Cadd9: x32033", "Bm x-2-4-4-3-2",
// "E7/B (no 3rd)*  x22430". The author's own shape, offered first in the picker.
const SHAPE_RX = /^\s*([A-G]\S*?)\*?\s*(?:\([^)]*\)\s*)?\*?\s*[:=–-]?\s*((?:[x0-9]){6}|(?:(?:x|X|\d{1,2})[\s\-–.,]+){5}(?:x|X|\d{1,2}))\s*(?:\(.*\))?\s*$/;

function readShape(line, meta) {
  const m = SHAPE_RX.exec(line.replace(/\[\/?ch\]/g, ''));
  if (!m || !isChord(m[1])) return;
  const raw = m[2];
  const frets = /^[x0-9]{6}$/i.test(raw) ? [...raw] : raw.split(/[\s\-–.,]+/);
  if (frets.length !== 6) return;
  const f = frets.map(x => (/x/i.test(x) ? -1 : +x));
  if (f.some(x => x > 24) || f.every(x => x < 0)) return;
  (meta.shapes ||= {})[m[1]] ||= f;
}

function readMeta(line, meta) {
  let m;
  if (meta.capo === undefined && (m = META_RX.capo.exec(line))) meta.capo = m[1] ? +m[1] : ORDINAL[m[2].toLowerCase()];
  if (meta.key === undefined && (m = META_RX.key.exec(line))) meta.key = m[1];
  if (meta.tuning === undefined && (m = META_RX.tuning.exec(line))) meta.tuning = m[1];
  if (meta.bpm === undefined && (m = META_RX.bpm.exec(line))) meta.bpm = +(m[1] || m[2]);
}

// Classifies every line, then pairs chord lines with the lyric line below.
export function parseSong(text) {
  const raw = decodeEntities(String(text || '')).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const lines = raw.split('\n');
  const rows = [];
  const meta = {};
  let inTab = false;
  let tabGroup = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = expandTabs(lines[i]);
    const opens = /\[tab\]/i.test(line);
    if (opens) { inTab = true; tabGroup++; }
    const closes = /\[\/tab\]/i.test(line);
    line = line.replace(/\[\/?tab\]/gi, '');
    const group = inTab ? tabGroup : 0;
    if (closes) inTab = false;

    if (!line.trim()) { rows.push({ kind: 'blank', group }); continue; }

    const sec = sectionOf(line);
    if (sec) {
      rows.push({ kind: 'section', label: sec.label, note: '', group });
      if (sec.rest) {
        const r = classify(sec.rest, group);
        if (r.kind === 'lyric') rows[rows.length - 1].note = sec.rest.trim();
        else rows.push(r);
      }
      continue;
    }
    rows.push(classify(line, group));
    readShape(line, meta);
    if (rows.length <= 40) readMeta(line, meta);
  }

  // A [tab] block that holds tablature keeps all its lines together in monospace.
  const tabGroups = new Set(rows.filter(r => r.kind === 'tabline' && r.group).map(r => r.group));

  const blocks = [];
  // Outside [tab] markup, a staff runs over consecutive staff lines, plus a chord
  // line right above one (chord names over the tab keep their columns).
  const staffish = (x, next) => x.kind === 'tabline' || (x.kind === 'chords' && next?.kind === 'tabline');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const inTabGroup = r.group && tabGroups.has(r.group) && r.kind !== 'section';
    if (inTabGroup || (!r.group && staffish(r, rows[i + 1]))) {
      const tab = { type: 'tab', lines: [] };
      const g = inTabGroup ? r.group : 0;
      while (i < rows.length) {
        const x = rows[i];
        const sameGroup = g ? x.group === g && x.kind !== 'section' : !x.group && staffish(x, rows[i + 1]);
        if (!sameGroup) break;
        tab.lines.push(tabRow(x));
        i++;
      }
      i--;
      // trim blank lines at the edges of the block
      while (tab.lines.length && !tab.lines[0].text.trim() && !tab.lines[0].chords.length) tab.lines.shift();
      while (tab.lines.length && !tab.lines.at(-1).text.trim() && !tab.lines.at(-1).chords.length) tab.lines.pop();
      if (tab.lines.length) blocks.push(tab);
      continue;
    }
    if (r.kind === 'chords') {
      const next = rows[i + 1];
      if (!r.annotated && next && next.kind === 'lyric' && (!r.group || next.group === r.group || !next.group)) {
        blocks.push(makePair(next.text, r.items));
        i++;
        continue;
      }
      blocks.push({ type: 'chords', items: r.items });
      continue;
    }
    if (r.kind === 'inline') { blocks.push({ type: 'pair', lyric: r.lyric, chords: r.chords }); continue; }
    if (r.kind === 'lyric') { blocks.push({ type: 'lyric', text: r.text }); continue; }
    if (r.kind === 'section') { blocks.push({ type: 'section', label: r.label, note: r.note }); continue; }
    if (r.kind === 'blank') {
      if (blocks.length && blocks.at(-1).type !== 'blank') blocks.push({ type: 'blank' });
      continue;
    }
  }
  while (blocks.length && blocks[0].type === 'blank') blocks.shift();
  while (blocks.length && blocks.at(-1).type === 'blank') blocks.pop();

  return { blocks, chords: uniqueChords(blocks), meta };
}

function classify(line, group) {
  const { kept, lyric, chords } = readMarkers(line);
  const anyUg = chords.some(c => c.ug);
  if (!chords.length) {
    if (isTabLine(line)) return { kind: 'tabline', text: line.replace(/\s+$/, ''), chords: [], group };
    const items = chordLineItems(line);
    if (items) return { kind: 'chords', items, group };
    return { kind: 'lyric', text: line.replace(/\s+$/, ''), group };
  }
  if (isTabLine(kept)) return { kind: 'tabline', text: kept.replace(/\s+$/, ''), chords: [], group };
  if (anyUg) {
    // UG chords sit in their own columns; words besides them are notes.
    const { items, annotated } = markedChordLine(kept, chords);
    return { kind: 'chords', items, annotated, group };
  }
  // [G]-style brackets
  const rest = lyric.replace(/\s+/g, ' ');
  if (hasWords(rest)) {
    const text = lyric.replace(/\s+$/, '');
    return { kind: 'inline', lyric: text, chords: snapAnchors(text, chords.map(c => ({ at: c.at, name: c.name }))), group };
  }
  const plain = chordLineItems(kept);
  if (plain) return { kind: 'chords', items: plain, group };
  const { items, annotated } = markedChordLine(kept, chords);
  return { kind: 'chords', items, annotated, group };
}

function tabRow(r) {
  if (r.kind === 'tabline') return { text: r.text, chords: r.chords || [] };
  if (r.kind === 'chords') {
    // chord names above a staff: keep their columns
    const chords = r.items.filter(x => x.chord).map(x => ({ col: x.col, name: x.chord }));
    let text = '';
    for (const x of r.items) {
      const col = x.rawCol ?? x.col;
      if (col > text.length) text += ' '.repeat(col - text.length);
      text += x.raw ?? x.chord ?? x.text;
    }
    return { text, chords };
  }
  if (r.kind === 'blank') return { text: '', chords: [] };
  if (r.kind === 'inline') return { text: r.lyric, chords: [] };
  return { text: r.text || r.label || '', chords: [] };
}

// Chord-over-lyric pair from a chord line's items.
function makePair(lyricLine, items) {
  const lyric = lyricLine.replace(/\s+$/, '');
  const chords = [];
  for (const it of items) {
    if (it.chord) chords.push(it.mark ? { at: it.col, name: it.chord, mark: it.mark } : { at: it.col, name: it.chord });
    else if (!/^[|:.\-–/\\]+$/.test(it.text)) chords.push({ at: it.col, text: it.text }); // notes, not bar lines
  }
  return { type: 'pair', lyric, chords: snapAnchors(lyric, chords) };
}

// Authors often put a chord one column before the word it belongs to (over the
// space). Move those onto the word; a chord over a longer gap (a pause) stays.
export function snapAnchors(lyric, chords) {
  const out = chords.map(c => ({ ...c }));
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const at = c.at;
    if (at < lyric.length && lyric[at] === ' ' && at + 1 < lyric.length && lyric[at + 1] !== ' ' && (at === 0 || lyric[at - 1] !== ' ')) {
      const nextAt = out[i + 1]?.at;
      if (nextAt === undefined || nextAt > at + 1) c.at = at + 1;
    }
  }
  // two chords can't share a character
  out.sort((a, b) => a.at - b.at);
  for (let i = 1; i < out.length; i++) if (out[i].at <= out[i - 1].at) out[i].at = out[i - 1].at + 1;
  return out;
}

function uniqueChords(blocks) {
  const seen = new Set();
  const list = [];
  const add = n => { if (n && !seen.has(n)) { seen.add(n); list.push(n); } };
  for (const b of blocks) {
    if (b.type === 'pair') b.chords.forEach(c => add(c.name));
    else if (b.type === 'chords') b.items.forEach(x => add(x.chord));
    else if (b.type === 'tab') b.lines.forEach(l => l.chords.forEach(c => add(c.name)));
  }
  return list;
}

// ---------- plain text ↔ UG markup (for the editor) ----------

// What the editor shows: UG tags removed, columns kept.
export function toPlainText(text) {
  return decodeEntities(String(text || ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\[ch\]([^[\]]*?)\[\/ch\]/g, '$1')
    .replace(/\[\/?tab\]/g, '');
}

// Marks detected chord lines with [ch] so they're explicit from now on.
export function fromPlainText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    if (/\[ch\]/.test(line) || sectionOf(line) || isTabLine(line)) return line;
    const l = expandTabs(line);
    const items = chordLineItems(l);
    if (!items) return line;
    let out = '';
    let pos = 0;
    for (const it of items) {
      out += l.slice(pos, it.rawCol);
      out += it.chord ? it.raw.replace(it.chord, `[ch]${it.chord}[/ch]`) : it.raw;
      pos = it.rawCol + it.raw.length;
    }
    return out + l.slice(pos);
  }).join('\n');
}
