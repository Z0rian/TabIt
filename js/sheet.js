// Lays a parsed song out as DOM.
//
// Chords over lyrics: each chord and the lyric text it's anchored to (from its
// character up to the next chord or the end of the word) form one unbreakable
// inline-block with the chord on top. The browser wraps lines between words,
// never inside a unit, so at any width, zoom level or font a chord stays exactly
// over the character it belongs to. A word that holds a chord can't break either.
//
// A chord name may be wider than the syllable under it. It hangs over the
// lyrics that follow (it's on its own row, so nothing is covered), which keeps
// the words evenly spaced. Only where it would run into the next chord or off
// the edge does its unit get a minimum width, found by measuring after layout
// (fitChords). Chords are positioned the same way either way, so every chord on
// a line sits on exactly the same baseline.
//
// Tablature is monospace; a staff that doesn't fit is cut into rows (all its
// lines at the same columns), at bar lines where it can.

const NBSP = String.fromCharCode(160);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// The chord name as shown (transposed, simplified…), cached per render.
function namer(fn) {
  const cache = new Map();
  return n => {
    if (!cache.has(n)) cache.set(n, fn ? fn(n) : n);
    return cache.get(n);
  };
}

function chordUnit(name, text, { mid = false, original } = {}) {
  const u = el('span', mid ? 'c mid' : 'c');
  const cn = el('b', 'cn', name);
  cn.dataset.chord = name;
  if (original && original !== name) cn.dataset.orig = original;
  const ct = el('span', 'ct');
  ct.append(el('span', 'tx', text));
  u.append(cn, ct);
  return u;
}

function annUnit(label, text) {
  const u = el('span', 'c');
  const ct = el('span', 'ct');
  ct.append(el('span', 'tx', text || NBSP));
  u.append(el('i', 'cn ann', label), ct);
  return u;
}

function pairLine(p, show) {
  const line = el('div', 'blk pair');
  const L = p.lyric;
  const all = p.chords;
  const inside = all.filter(c => c.at < L.length);
  const trailing = all.filter(c => c.at >= L.length);
  const unitFor = (c, text, mid) => {
    if (!c.name) return annUnit(c.text, text);
    const u = chordUnit(show(c.name) + (c.mark || ''), text, { mid, original: c.name });
    u.firstChild.dataset.chord = show(c.name);
    return u;
  };

  const runRx = /\S+|\s+/g;
  let m;
  let ai = 0;
  while ((m = runRx.exec(L))) {
    const start = m.index;
    const end = start + m[0].length;
    const mine = [];
    while (ai < inside.length && inside[ai].at < end) mine.push(inside[ai++]);
    if (!mine.length) { line.append(m[0]); continue; }
    const space = /^\s/.test(m[0]);
    // A word holding a chord doesn't break, unless it's a long held note
    // ("Sleeeeeeeep") that wouldn't fit a phone; its chords still can't move.
    const holder = space || m[0].length > 16 ? line : el('span', 'w');
    let pos = start;
    mine.forEach((c, k) => {
      if (c.at > pos) holder.append(L.slice(pos, c.at));
      const stop = k + 1 < mine.length ? mine[k + 1].at : end;
      // A chord over a pause keeps the spaces under it.
      const text = space ? L.slice(c.at, stop).replace(/ /g, NBSP) : L.slice(c.at, stop);
      holder.append(unitFor(c, text, !space && stop < end));
      pos = stop;
    });
    if (pos < end) holder.append(L.slice(pos, end));
    if (holder !== line) line.append(holder);
  }
  if (trailing.length) {
    if (L.length && !/\s$/.test(L)) line.append(' ');
    trailing.forEach((c, k) => {
      if (k) line.append(' ');
      line.append(unitFor(c, NBSP, false));
    });
  }
  if (!L.trim() && inside.length) line.classList.add('only-chords');
  return line;
}

function chordsLine(b, show) {
  const line = el('div', 'blk chords');
  let end = 0;
  b.items.forEach((x, k) => {
    const gap = k ? Math.max(1, x.col - end) : 0;
    if (gap) {
      const s = el('span', 'gap');
      s.style.setProperty('--n', String(Math.min(gap, 16)));
      line.append(s);
    }
    if (x.chord) {
      const name = show(x.chord);
      const c = el('b', 'cn solo', name);
      c.dataset.chord = name;
      if (name !== x.chord) c.dataset.orig = x.chord;
      line.append(c);
      end = x.col + x.chord.length;
    } else {
      line.append(el('span', 'ann', x.text));
      end = x.col + x.text.length;
    }
  });
  return line;
}

function sectionLine(b) {
  const s = el('div', 'blk sec');
  s.append(el('span', 'sec-label', b.label));
  if (b.note) s.append(el('span', 'sec-note', b.note));
  return s;
}

function tabBlock(b, show) {
  const t = el('div', 'blk tab');
  t._segs = tabSegments(b.lines.map(l => ({ text: l.text, staff: !!l.staff, chords: l.chords.map(c => ({ col: c.col, name: show(c.name), orig: c.name })) })));
  renderTab(t, Infinity);
  return t;
}

// ---------- tablature ----------
//
// A tab block holds staves, each with the rows that go with it (chord names,
// beat marks and measure numbers above it, picking fingers below), headings
// ("Part A", "Lick 1:") and notes. Each staff is laid out on its own: as
// written when it fits; a little smaller if that makes it take fewer rows;
// otherwise cut into rows of about equal length, at bar lines where it can,
// through rests where it can't, never through a fret number or a chord name.
// Wrapped rows start with the string names again.

const TAB_SCALES = [1, 0.95, 0.9, 0.86];
const WORDY = /\p{L}{3,}|\S:\s*$/u;
// What a staff row says after its last bar ("R1", "x2", "Repeat as needed").
const TRAIL_RX = /^(.*\|)( +)(\S.*?)\s*$/;
// The string names and opening bar ("e|", "D#|", "|"; "e" when there's no bar).
const HEAD_RX = /^(?:[A-Ga-g][#b]?\s?)?[|:]|^[A-Ga-g][#b]?(?=[-–—])/;

// Chord names over a staff, re-placed after transposing (names change length).
function chordRowText(line) {
  if (!line.chords.length) return null;
  const parts = [];
  let text = '';
  for (const c of line.chords) {
    const col = Math.max(c.col, text.length ? text.length + 1 : 0);
    text += ' '.repeat(col - text.length);
    parts.push({ col, name: c.name, orig: c.orig });
    text += c.name;
  }
  return { text, parts };
}

// A tab block's rows, in parts: [{ plain, rows }] for text, and for each staff
// { titles, rows, bare (its rows without the words after the bars), notes
// (those words), head (columns of string names, 0 when they differ), full and
// len (the longest row with and without those words) }.
export function tabSegments(lines) {
  const rows = lines.map(l => {
    const r = chordRowText(l);
    return r ? { text: r.text, parts: r.parts, staff: false } : { text: l.text, parts: [], staff: !!l.staff };
  });
  const groups = [];
  let cur = [];
  for (const r of rows) {
    if (!r.text.trim() && !r.parts.length) { if (cur.length) groups.push(cur); cur = []; } else cur.push(r);
  }
  if (cur.length) groups.push(cur);
  const out = [];
  for (const g of groups) for (const part of splitStaves(g)) out.push(staffSeg(part));
  return out;
}

// Staves stacked without a blank line between them are laid out one by one;
// the rows between two go with the one below (its chord names and heading).
function splitStaves(rows) {
  const runs = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].staff) continue;
    let j = i;
    while (j < rows.length && rows[j].staff) j++;
    runs.push([i, j]);
    i = j - 1;
  }
  const cuts = [];
  for (let k = 1; k < runs.length; k++) {
    const [a, b] = runs[k - 1], [c, d] = runs[k];
    if (b - a >= 3 && d - c >= 3) cuts.push(b);
  }
  if (!cuts.length) return [rows];
  const parts = [];
  let start = 0;
  for (const c of cuts) { parts.push(rows.slice(start, c)); start = c; }
  parts.push(rows.slice(start));
  return parts;
}

function staffSeg(rows) {
  if (!rows.some(r => r.staff)) return { plain: true, rows };
  const first = rows.findIndex(r => r.staff);
  let k = 0;
  const titles = [];
  while (k < first && !rows[k].parts.length && WORDY.test(rows[k].text)) titles.push(rows[k++].text.trim());
  const body = rows.slice(k);
  const notes = [];
  const bare = body.map(r => {
    const m = r.staff && TRAIL_RX.exec(r.text);
    if (!m || !/\p{L}/u.test(m[3]) || /[-–—]{2}/.test(m[3])) return r;
    if (!notes.includes(m[3])) notes.push(m[3]);
    return { ...r, text: m[1] };
  });
  const heads = bare.filter(r => r.staff).map(r => HEAD_RX.exec(r.text)?.[0] || '');
  const head = heads.every(h => h && h.length === heads[0].length) ? heads[0].length : 0;
  const longest = list => Math.max(...list.map(r => r.text.length));
  return { titles, rows: body, bare, notes, head, full: longest(body), len: longest(bare) };
}

// Columns to cut a staff's rows at, so that the first is at most `width`
// long and the others, with `head` columns of string names put in front, too.
export function cutPoints(rows, width, head = 0) {
  const texts = rows.map(r => r.text);
  const len = Math.max(...texts.map(t => t.length));
  if (len <= width) return [];
  if (width - head < 8) head = 0;
  const staves = texts.filter((t, i) => rows[i].staff);
  const at = (t, c) => t[c] ?? '';
  // never through a number or a name
  const ok = c => texts.every(t => !(/\d/.test(at(t, c - 1)) && /\d/.test(at(t, c))) && !(/[A-Za-z#]/.test(at(t, c - 1)) && /[A-Za-z0-9#/]/.test(at(t, c))));
  const bar = c => staves.every(t => '|:'.includes(at(t, c - 1)) || c > t.length) && ok(c);
  const rest = c => staves.every(t => /^[-–—|:]?$/.test(at(t, c - 1)) && /^[-–—|:]?$/.test(at(t, c))) && ok(c);
  const cuts = [];
  let start = 0;
  for (;;) {
    const room = start ? width - head : width;
    if (len - start <= room) break;
    const from = start || head;
    const per = width - head;
    const m = (len - from) / Math.ceil((len - from) / per);
    const target = Math.round(from + m);
    const lo = start + 2, hi = start + room;
    const win = Math.max(2, Math.round(m * 0.35));
    const near = (test, a, b) => {
      let best = -1;
      for (let c = Math.max(lo, a); c <= Math.min(hi, b); c++) if (test(c) && (best < 0 || Math.abs(c - target) < Math.abs(best - target))) best = c;
      return best;
    };
    let cut = near(bar, target - win, target + win);
    if (cut < 0) cut = near(rest, target - win, target + win);
    if (cut < 0) cut = near(ok, lo, hi);
    if (cut < 0) cut = hi;
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

// How a staff fits `cols` columns: its size, whether the words after the bars
// go above it, and where it's cut. The fewest rows, then the biggest size.
export function planStaff(seg, cols) {
  let best = null;
  for (const scale of TAB_SCALES) {
    const width = Math.floor(cols / scale);
    const p = seg.full <= width ? { scale, bare: false, cuts: [] }
      : { scale, bare: true, cuts: seg.len <= width ? [] : cutPoints(seg.bare, width, seg.head) };
    if (!best || p.cuts.length < best.cuts.length) best = p;
    if (!p.cuts.length) break;
  }
  return best;
}

function tabRowEl(r, a, z, prefix) {
  const row = el('div', r.staff ? 'tl st' : 'tl');
  if (prefix) row.append(prefix);
  const stop = Math.min(z, r.text.length);
  let pos = a;
  for (const p of r.parts) {
    if (p.col < a || p.col >= z) continue;
    if (p.col > pos) row.append(r.text.slice(pos, p.col));
    const c = el('b', 'cn tc', p.name);
    c.dataset.chord = p.name;
    if (p.orig !== p.name) c.dataset.orig = p.orig;
    row.append(c);
    pos = p.col + p.name.length;
  }
  if (pos < stop) row.append(r.text.slice(pos, stop));
  if (!row.childNodes.length) row.textContent = NBSP;
  return row;
}

function renderTab(t, cols) {
  t.replaceChildren();
  for (const seg of t._segs) {
    const box = el('div', seg.plain ? 'tseg plain' : 'tseg');
    t.append(box);
    if (seg.plain) {
      for (const r of seg.rows) box.append(tabRowEl(r, 0, Infinity, ''));
      continue;
    }
    const plan = Number.isFinite(cols) ? planStaff(seg, cols) : { scale: 1, bare: false, cuts: [] };
    if (plan.scale !== 1) box.style.fontSize = `${plan.scale}em`;
    for (const x of [...seg.titles, ...(plan.bare ? seg.notes : [])]) box.append(el('div', 'tt', x));
    const rows = plan.bare ? seg.bare : seg.rows;
    const bounds = [0, ...plan.cuts, Infinity];
    const head = seg.head && Math.floor(cols / plan.scale) - seg.head >= 8 ? seg.head : 0;
    box.dataset.head = String(plan.cuts.length ? head : 0);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const a = bounds[k], z = bounds[k + 1];
      const sys = el('div', 'sys');
      sys.dataset.a = String(a);
      for (const r of rows) {
        // a row with nothing on it in this part of the staff is left out (the staff's own rows never are)
        if (!r.staff && !r.text.slice(a, z).trim()) continue;
        sys.append(tabRowEl(r, a, z, k && head ? (r.staff ? r.text.slice(0, head) : ' '.repeat(head)) : ''));
      }
      box.append(sys);
    }
  }
}

// How long a tab block takes to play, in lyric lines: its staves by their
// length (a lyric line's worth is about 28 columns), and its text.
export function tabWeight(segs) {
  let w = 0;
  for (const seg of segs) w += seg.plain ? seg.rows.length * 0.5 : Math.max(0.8, (seg.len - seg.head) / 28) + seg.titles.length * 0.15;
  return Math.max(1, w);
}

// How long each kind of line takes to play, relative to a lyric line. The
// autoscroll paces itself by these instead of by pixels.
const WEIGHT = { pair: 1, lyric: 1, chords: 0.9, sec: 0.2, gap: 0.12 };

export function renderSheet(doc, { chordName, mono = false, hideChords = false } = {}) {
  const show = namer(chordName);
  const root = el('div', 'sheet' + (mono ? ' mono' : '') + (hideChords ? ' no-chords' : ''));
  // The author's notes before the music starts barely count for the autoscroll.
  const firstMusic = doc.blocks.findIndex(b => b.type !== 'lyric' && b.type !== 'blank');
  doc.blocks.forEach((b, i) => {
    let e;
    if (b.type === 'pair') e = pairLine(b, show);
    else if (b.type === 'chords') e = chordsLine(b, show);
    else if (b.type === 'section') e = sectionLine(b);
    else if (b.type === 'tab') e = tabBlock(b, show);
    else if (b.type === 'lyric') e = el('div', 'blk lyric', b.text);
    else e = el('div', 'blk gap');
    const kind = e.classList[1];
    let w = kind === 'tab' ? tabWeight(e._segs) : WEIGHT[kind] ?? 1;
    if (i < firstMusic) { w *= 0.15; e.classList.add('pre'); }
    e.dataset.w = String(w);
    root.append(e);
  });
  return root;
}

// After layout: where a hanging chord would touch the next chord on its line or
// stick out past the edge, give its unit a minimum width (in em, so it scales
// with the font until the next fit). Widening only makes lines longer, so this
// settles in a few rounds.
export function fitChords(root) {
  for (const u of root.querySelectorAll('.c.fit')) { u.style.minWidth = ''; u.classList.remove('fit'); }
  for (const x of root.querySelectorAll('.brk, .hy')) x.remove();
  for (const w of root.querySelectorAll('.w.split')) w.classList.remove('split');
  const lines = [...root.querySelectorAll('.pair')];
  if (!lines.length) return 0;
  const unitPx = parseFloat(getComputedStyle(lines[0]).fontSize) || 16;
  const gap = unitPx * 0.3;
  let total = 0;
  for (let round = 0; round < 6; round++) {
    const right = root.getBoundingClientRect().right;
    const fix = new Map();
    let split = 0;
    for (const line of lines) {
      const left = line.getBoundingClientRect().left;
      const units = line.querySelectorAll('.c');
      let prev = null;
      for (const unit of units) {
        const r = unit.firstChild.getBoundingClientRect();
        const ur = unit.getBoundingClientRect();
        if (r.right > right + 0.5) {
          // A chord partway into a word that's too long for the line even at its
          // start (big text on a small phone): the word breaks before it.
          const w = unit.parentNode;
          if (w.classList.contains('w') && !w.classList.contains('split') && unit.previousSibling &&
              left + (r.left - w.getBoundingClientRect().left) + r.width > right + 0.5) {
            const p = unit.previousSibling;
            const before = p.nodeType === 3 ? p.data : p.querySelector?.('.ct')?.textContent || '';
            if (/\p{L}$/u.test(before) && /^\p{L}/u.test(unit.lastChild.textContent)) unit.before(el('span', 'hy', '-'));
            unit.before(el('br', 'brk'));
            w.classList.add('split');
            split++;
          } else fix.set(unit, Math.max(fix.get(unit) || 0, r.width));
        }
        if (prev && Math.abs(prev.ur.top - ur.top) < 2 && r.left < prev.r.right + gap) {
          fix.set(prev.unit, Math.max(fix.get(prev.unit) || 0, prev.r.width + gap));
        }
        prev = { unit, r, ur };
      }
    }
    if (!fix.size && !split) break;
    for (const [u, w] of fix) {
      const em = Math.ceil((w / unitPx) * 1000) / 1000;
      const cur = parseFloat(u.style.minWidth) || 0;
      if (em > cur) {
        u.style.minWidth = em + 'em';
        u.classList.add('fit');
        total++;
      }
    }
  }
  return total;
}

// Width of one monospace character in the tab font.
function charWidth(t) {
  const probe = el('span', 'tl', '0'.repeat(50));
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  t.append(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  return w || 8;
}

// Lays tablature out again for the sheet's width.
export function layoutTabs(root) {
  for (const t of root.querySelectorAll('.blk.tab')) {
    const cs = getComputedStyle(t);
    const avail = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (avail <= 0) continue;
    const cols = Math.floor(avail / charWidth(t));
    if (t._cols === cols) continue;
    t._cols = cols;
    renderTab(t, cols);
  }
}

// Lays out the parts that depend on the width (tablature, hanging chords) now
// and again whenever the width or the font size changes. Returns a stop function.
export function watchSheet(root) {
  let raf = 0;
  let last = '';
  const run = () => {
    const key = `${root.clientWidth}|${getComputedStyle(root).fontSize}`;
    if (key === last) return;
    last = key;
    layoutTabs(root);
    fitChords(root);
  };
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(run);
  });
  ro.observe(root);
  // a font that finishes loading after the first layout changes every width
  let stopped = false;
  const refit = () => { if (!stopped) { last = ''; run(); } };
  document.fonts?.addEventListener?.('loadingdone', refit);
  document.fonts?.ready?.then(refit);
  // (WebKit doesn't always say when a font has loaded: the tab font's columns
  // are measured again once it's there)
  if (root.querySelector('.tab') || root.classList.contains('mono')) document.fonts?.load?.(`${getComputedStyle(root).fontSize} "JetBrains Mono"`).then(refit, () => {});
  run();
  return () => {
    stopped = true;
    ro.disconnect();
    cancelAnimationFrame(raf);
    document.fonts?.removeEventListener?.('loadingdone', refit);
  };
}
