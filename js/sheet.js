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
// Tablature is monospace and wraps all lines of a staff at the same column.

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
  t._lines = b.lines.map(l => ({ text: l.text, chords: l.chords.map(c => ({ col: c.col, name: show(c.name), orig: c.name })) }));
  renderTab(t, Infinity);
  return t;
}

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

// Columns where every line of the staff can be cut: after a bar line if
// possible, never through a fret number or a chord name.
function cutPoints(texts, width) {
  const len = Math.max(...texts.map(t => t.length));
  const ok = col => texts.every(t => {
    const a = t[col - 1], b = t[col];
    return a === undefined || b === undefined || !(/[0-9]/.test(a) && /[0-9]/.test(b)) && !(/[A-Za-z#]/.test(a) && /[A-Za-z0-9#/]/.test(b));
  });
  const staves = texts.filter(t => /[|]/.test(t) && /-{2}/.test(t));
  const bar = col => staves.length > 0 && staves.every(t => t[col - 1] === '|' || t[col - 1] === undefined) && ok(col);
  const cuts = [];
  let start = 0;
  while (len - start > width) {
    let cut = -1;
    for (let c = start + width; c > start + width * 0.5; c--) if (bar(c)) { cut = c; break; }
    if (cut < 0) for (let c = start + width; c > start + 1; c--) if (ok(c)) { cut = c; break; }
    if (cut < 0) cut = start + width;
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

function renderTab(t, width) {
  const lines = t._lines.map(l => {
    const row = chordRowText(l);
    return row ? { text: row.text, parts: row.parts } : { text: l.text, parts: [] };
  });
  const texts = lines.map(l => l.text);
  const cuts = Number.isFinite(width) ? cutPoints(texts, Math.max(8, width)) : [];
  const bounds = [0, ...cuts, Infinity];
  t.replaceChildren();
  for (let s = 0; s + 1 < bounds.length; s++) {
    const a = bounds[s], z = bounds[s + 1];
    const sys = el('div', 'sys');
    for (const l of lines) {
      const row = el('div', 'tl');
      const stop = z === Infinity ? l.text.length : Math.min(z, l.text.length);
      if (!l.parts.length) { row.textContent = l.text.slice(a, stop) || NBSP; sys.append(row); continue; }
      let pos = a;
      for (const p of l.parts) {
        if (p.col < a || p.col >= z) continue;
        if (p.col > pos) row.append(l.text.slice(pos, p.col));
        const c = el('b', 'cn tc', p.name);
        c.dataset.chord = p.name;
        if (p.orig !== p.name) c.dataset.orig = p.orig;
        row.append(c);
        pos = p.col + p.name.length;
      }
      if (pos < stop) row.append(l.text.slice(pos, stop));
      if (!row.childNodes.length) row.textContent = NBSP;
      sys.append(row);
    }
    t.append(sys);
  }
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
    let w = kind === 'tab' ? Math.max(1, b.lines.filter(l => l.text.trim()).length / 3) : WEIGHT[kind] ?? 1;
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

// Re-wraps tablature to the sheet's width.
export function layoutTabs(root) {
  for (const t of root.querySelectorAll('.blk.tab')) {
    const cs = getComputedStyle(t);
    const avail = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (avail <= 0) continue;
    const cols = Math.floor(avail / charWidth(t));
    if (t._cols === cols) continue;
    t._cols = cols;
    const longest = Math.max(...t._lines.map(l => (chordRowText(l)?.text || l.text).length));
    renderTab(t, longest > cols ? cols : Infinity);
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
  run();
  return () => {
    stopped = true;
    ro.disconnect();
    cancelAnimationFrame(raf);
    document.fonts?.removeEventListener?.('loadingdone', refit);
  };
}
