// SVG chord diagrams: the vertical chord box from chord sheets, lowest string
// on the left. Built with createElementNS (never innerHTML), and every colour
// comes from a CSS custom property so the app can theme it:
//   --dg-line (strings, frets)   --dg-ink (nut, fret number)   --dg-dot (dots, barres)
//   --dg-dot-ink (finger numbers)   --dg-root (root-note dots)   --dg-mark (open and muted marks)

import { describe } from './voicings.js';

const NS = 'http://www.w3.org/2000/svg';
const STANDARD = [40, 45, 50, 55, 59, 64];
const GAP = 16; // between strings, in viewBox units
const ROW = 20; // one fret
const TOP = 20; // room above the grid for the open and muted marks
const FOOT = 5;
const EDGE = 10; // margin on the side without the fret number

// The mini look (a strip of ~56px diagrams) is drawn bolder so it stays crisp.
// `side` leaves room for the fret number beside the first row, clear of its dots.
const LOOK = {
  full: { side: 30, line: 1, nut: 4.5, dot: 6.3, mark: 4, markLine: 1.4, label: 9.5 },
  mini: { side: 30, line: 2.2, nut: 6, dot: 7, mark: 4.4, markLine: 2.6, label: 16 },
};

const COLOR = {
  line: 'var(--dg-line, currentColor)',
  ink: 'var(--dg-ink, currentColor)',
  dot: 'var(--dg-dot, currentColor)',
  dotInk: 'var(--dg-dot-ink, #fff)',
  root: 'var(--dg-root, var(--dg-dot, currentColor))',
  mark: 'var(--dg-mark, currentColor)',
};

const mod12 = n => ((n % 12) + 12) % 12;

// Numbers are rounded so the markup doesn't carry float noise like 4.3500000000000005.
function el(parent, tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) e.setAttribute(k, typeof v === 'number' ? String(Math.round(v * 100) / 100) : v);
  }
  parent.append(e);
  return e;
}

// Draws a voicing ({ frets, fingers, barres, baseFret }, as voicings() returns).
// `rootPc` (0-11) marks the root notes; `tuning` is only needed to find them
// when it isn't standard. `frets` is the number of fret rows (never fewer than
// the shape needs). The name goes in the <title>, not on the drawing.
export function renderDiagram(voicing, {
  name = '', size = 120, fingers = true, leftHanded = false, mini = false, frets: rows,
  rootPc = null, tuning = STANDARD,
} = {}) {
  const frets = Array.isArray(voicing?.frets) ? voicing.frets : [-1, -1, -1, -1, -1, -1];
  const n = frets.length;
  const look = mini ? LOOK.mini : LOOK.full;
  const pressed = frets.filter(f => f > 0);
  const lo = pressed.length ? Math.min(...pressed) : 1;
  const hi = pressed.length ? Math.max(...pressed) : 1;
  const base = Math.min(voicing?.baseFret >= 1 ? voicing.baseFret : hi <= 4 ? 1 : lo, lo);
  const count = Math.max(rows > 0 ? Math.floor(rows) : 4, hi - base + 1);
  const W = look.side + GAP * (n - 1) + EDGE;
  const H = TOP + ROW * count + FOOT;
  const x = s => (leftHanded ? W - look.side - s * GAP : look.side + s * GAP);
  const y = f => TOP + (f - base + 0.5) * ROW; // middle of fret f's row
  const left = Math.min(x(0), x(n - 1)), right = Math.max(x(0), x(n - 1));

  const svg = document.createElementNS(NS, 'svg');
  const label = [name, describe(frets)].filter(Boolean).join(': ');
  for (const [k, v] of Object.entries({
    class: `dg${mini ? ' dg-mini' : ''}${leftHanded ? ' dg-left' : ''}`, viewBox: `0 0 ${W} ${H}`,
    width: size, height: Math.round((size * H) / W * 10) / 10, role: 'img', 'aria-label': label,
  })) svg.setAttribute(k, String(v));
  el(svg, 'title', {}).textContent = label;

  // grid
  for (let r = base === 1 ? 1 : 0; r <= count; r++) {
    el(svg, 'line', { class: 'dg-fret', x1: left, x2: right, y1: TOP + r * ROW, y2: TOP + r * ROW, 'stroke-width': look.line, style: `stroke:${COLOR.line}` });
  }
  for (let s = 0; s < n; s++) {
    el(svg, 'line', { class: 'dg-string', x1: x(s), x2: x(s), y1: TOP, y2: TOP + count * ROW, 'stroke-width': look.line, style: `stroke:${COLOR.line}` });
  }
  if (base === 1) {
    el(svg, 'rect', { class: 'dg-nut', x: left - look.line / 2, y: TOP - look.nut, width: right - left + look.line, height: look.nut, style: `fill:${COLOR.ink}` });
  } else {
    const t = el(svg, 'text', {
      class: 'dg-fretnum', x: leftHanded ? right + look.dot + 2 : left - look.dot - 2, y: TOP + ROW / 2, dy: '.35em',
      'text-anchor': leftHanded ? 'start' : 'end', 'font-size': look.label, style: `fill:${COLOR.ink}`,
    });
    t.textContent = mini ? String(base) : `${base}fr`;
  }

  // open and muted marks
  const my = (TOP - look.nut) / 2;
  frets.forEach((f, s) => {
    if (f === 0) {
      el(svg, 'circle', { class: 'dg-mark dg-open', cx: x(s), cy: my, r: look.mark, fill: 'none', 'stroke-width': look.markLine, style: `stroke:${COLOR.mark}` });
    } else if (f < 0) {
      const m = look.mark * 0.85;
      el(svg, 'path', {
        class: 'dg-mark dg-mute', d: `M${x(s) - m} ${my - m}L${x(s) + m} ${my + m}M${x(s) + m} ${my - m}L${x(s) - m} ${my + m}`,
        'stroke-width': look.markLine, 'stroke-linecap': 'round', fill: 'none', style: `stroke:${COLOR.mark}`,
      });
    }
  });

  // barres, then dots; a barre stands in for the dots it covers, except root notes
  const isRoot = s => rootPc !== null && rootPc !== undefined && Number.isFinite(tuning[s]) && mod12(tuning[s] + frets[s]) === mod12(rootPc);
  const fingerOf = s => (fingers && !mini && Array.isArray(voicing?.fingers) ? voicing.fingers[s] : 0);
  const covered = new Set();
  const numbers = [];
  for (const b of Array.isArray(voicing?.barres) ? voicing.barres : []) {
    const from = Math.max(0, Math.min(b.from, b.to)), to = Math.min(n - 1, Math.max(b.from, b.to));
    if (!(b.fret >= base) || from === to) continue;
    const r = look.dot;
    const x1 = Math.min(x(from), x(to)), x2 = Math.max(x(from), x(to));
    el(svg, 'rect', { class: 'dg-barre', x: x1 - r, y: y(b.fret) - r, width: x2 - x1 + 2 * r, height: 2 * r, rx: r, style: `fill:${COLOR.dot}` });
    for (let s = from; s <= to; s++) if (frets[s] === b.fret) covered.add(s);
    if (fingers && !mini && b.finger > 0) numbers.push([from, b.fret, b.finger]);
  }
  frets.forEach((f, s) => {
    if (!(f > 0) || (covered.has(s) && !isRoot(s))) return;
    const root = isRoot(s);
    el(svg, 'circle', { class: root ? 'dg-dot dg-root' : 'dg-dot', cx: x(s), cy: y(f), r: look.dot, style: `fill:${root ? COLOR.root : COLOR.dot}` });
    if (!covered.has(s) && fingerOf(s) > 0) numbers.push([s, f, fingerOf(s)]);
  });
  for (const [s, f, finger] of numbers) {
    const t = el(svg, 'text', {
      class: 'dg-finger', x: x(s), y: y(f), dy: '.35em', 'text-anchor': 'middle',
      'font-size': look.dot * 1.35, 'font-weight': 600, style: `fill:${COLOR.dotInk}`,
    });
    t.textContent = String(finger);
  }
  return svg;
}
