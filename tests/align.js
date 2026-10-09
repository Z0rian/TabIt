// Measures chord placement in a rendered sheet. Used by tests/sheet.html and the
// Playwright device matrix (tests/e2e_align.py).
//
// For every chord over lyrics it checks, in real pixels:
//  - the chord's left edge is at the left edge of the character it's anchored to
//  - the chord sits on the line directly above that character (no wrap between)
//  - it doesn't overlap the next chord on the same line
//  - it doesn't overlap any lyric text
// It also cross-checks against the source: in UG markup, the character under a
// chord's column is the one the chord must sit on (an independent re-reading of
// the columns, so a parser regression like the old two-columns-per-chord drift
// can't hide).

function firstCharRect(unit) {
  const tx = unit.querySelector('.tx');
  const node = tx && tx.firstChild;
  if (!node || node.nodeType !== 3 || !node.length) return null;
  const r = document.createRange();
  r.setStart(node, 0);
  r.setEnd(node, 1);
  const rects = r.getClientRects();
  return rects.length ? rects[0] : r.getBoundingClientRect();
}

function textRects(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  const r = document.createRange();
  while ((n = walker.nextNode())) {
    if (!n.data.trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest('.cn') || p.closest('.tab')) continue;
    r.selectNodeContents(n);
    for (const rect of r.getClientRects()) if (rect.width > 0.5) out.push(rect);
  }
  return out;
}

const overlaps = (a, b, pad = 0.5) => a.left < b.right - pad && b.left < a.right - pad && a.top < b.bottom - pad && b.top < a.bottom - pad;

export function checkSheet(sheet, { tolerance = 0.75 } = {}) {
  const problems = [];
  const chordRects = [];
  let units = 0;
  const box = sheet.getBoundingClientRect();
  for (const line of sheet.querySelectorAll('.pair')) {
    let prev = null;
    for (const u of line.querySelectorAll('.c')) {
      units++;
      const cn = u.querySelector('.cn');
      const cr = cn.getBoundingClientRect();
      const ch = firstCharRect(u);
      const name = cn.textContent;
      const text = u.querySelector('.tx')?.textContent || '';
      if (!ch) continue;
      const ann = cn.classList.contains('ann');
      if (!ann) {
        if (Math.abs(cr.left - ch.left) > tolerance) problems.push({ kind: 'x-offset', chord: name, text, dx: +(cr.left - ch.left).toFixed(2) });
        if (cr.bottom > ch.top + 2) problems.push({ kind: 'below-text', chord: name, text, dy: +(cr.bottom - ch.top).toFixed(2) });
        const lh = ch.height || 20;
        if (ch.top - cr.bottom > lh * 0.6) problems.push({ kind: 'not-adjacent', chord: name, text, gap: +(ch.top - cr.bottom).toFixed(2) });
        if (cr.right > box.right + 1) problems.push({ kind: 'off-edge', chord: name, text, dx: +(cr.right - box.right).toFixed(2) });
        chordRects.push({ rect: cr, name, text });
      }
      // neighbours on the same visual line (reading order) must not touch
      if (prev && Math.abs(prev.ch.top - ch.top) < (ch.height || 20) / 2 && cr.left < prev.cr.right - 0.5) {
        problems.push({ kind: 'chord-overlap', chord: `${prev.name}|${name}`, text: `${prev.text}|${text}`, dx: +(prev.cr.right - cr.left).toFixed(2) });
      }
      prev = { cr, ch, name, text };
    }
  }
  // chords never cover lyrics
  const texts = textRects(sheet);
  for (const c of chordRects) {
    for (const t of texts) {
      if (overlaps(c.rect, t, 1)) { problems.push({ kind: 'covers-text', chord: c.name, text: c.text }); break; }
    }
  }
  return { units, checked: chordRects.length, problems };
}

// Independent reading of UG markup: for each [tab] chord line followed by a
// lyric line, the lyric character under each chord's column (tags removed).
export function expectedAnchors(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\[\/?tab\]/g, ''));
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('[ch]')) continue;
    const plain = line.replace(/\[ch\]|\[\/ch\]/g, '');
    if (/[A-Za-z]{3,}/.test(plain.replace(/\b[A-G][#b]?(?:m|maj|min|dim|aug|sus|add|M)?\d*(?:sus\d|add\d+|b\d+|#\d+)*(?:\/[A-G][#b]?)?\b/g, ''))) continue;
    if (/\b[xX0-9]{6}\b|\d{3,}/.test(plain)) continue; // a chord legend ("D/F#  200232"), not a chord line
    const next = lines[i + 1];
    if (!next || !next.trim() || next.includes('[ch]') || /^\s*\[[^\]]+\]\s*$/.test(next) || /\|-|-\||-{4}/.test(next)) continue;
    const rx = /\[ch\]([^[]*?)\[\/ch\]/g;
    let m, removed = 0;
    while ((m = rx.exec(line))) {
      const col = m.index - removed;
      removed += 9; // "[ch]" + "[/ch]"
      if (col < next.replace(/\s+$/, '').length) out.push({ name: m[1], col, line: next, char: next[col] });
    }
    i++;
  }
  return out;
}
