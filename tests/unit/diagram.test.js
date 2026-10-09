import { test, eq, ok, deepEq, near } from '../harness.js';
import { renderDiagram } from '../../js/diagram.js';
import { voicings, voicingKey, TUNINGS } from '../../js/voicings.js';

const find = (sym, key, opts) => {
  const v = voicings(sym, { limit: 32, ...opts }).find(x => voicingKey(x) === key);
  ok(v, `${sym} ${key} exists`);
  return v;
};
const all = (svg, sel) => [...svg.querySelectorAll(sel)];
const num = (e, a) => parseFloat(e.getAttribute(a));
const texts = (svg, sel) => all(svg, sel).map(t => t.textContent);

// Attached to the page, so computed styles and layout are real.
function mounted(svg, style = '') {
  const host = document.createElement('div');
  host.style.cssText = style;
  host.append(svg);
  (document.getElementById('sandbox') || document.body).append(host);
  return host;
}

test('an accessible, scalable svg', () => {
  const svg = renderDiagram(find('C', 'x32010'), { name: 'C', size: 150 });
  ok(svg instanceof SVGSVGElement, 'svg element');
  eq(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  ok(svg.classList.contains('dg'));
  eq(svg.getAttribute('role'), 'img');
  eq(svg.getAttribute('aria-label'), 'C: x 3 2 0 1 0');
  eq(svg.querySelector('title').textContent, 'C: x 3 2 0 1 0');
  eq(svg.getAttribute('width'), '150');
  const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  near(num(svg, 'height'), (150 * h) / w, 0.1, 'height keeps the aspect ratio');
  eq(renderDiagram(find('C', 'x32010')).getAttribute('width'), '120', 'default size');
  eq(renderDiagram(find('C', 'x32010')).querySelector('title').textContent, 'x 3 2 0 1 0', 'no name');
});

test('an open chord: dots, finger numbers, marks and the nut', () => {
  const svg = renderDiagram(find('C', 'x32010'), { rootPc: 0 });
  eq(all(svg, '.dg-dot').length, 3, 'dots');
  eq(all(svg, '.dg-root').length, 2, 'the two Cs are roots');
  eq(all(svg, '.dg-open').length, 2, 'open marks');
  eq(all(svg, '.dg-mute').length, 1, 'muted marks');
  eq(all(svg, '.dg-mark').length, 3);
  eq(all(svg, '.dg-nut').length, 1, 'nut');
  eq(all(svg, '.dg-fretnum').length, 0);
  eq(all(svg, '.dg-barre').length, 0);
  deepEq(texts(svg, '.dg-finger').sort(), ['1', '2', '3']);
  eq(all(svg, '.dg-string').length, 6);
  eq(all(svg, '.dg-fret').length, 4, 'four fret rows under the nut');
  // each finger number sits in its dot
  for (const t of all(svg, '.dg-finger')) {
    ok(all(svg, '.dg-dot').some(d => num(d, 'cx') === num(t, 'x') && num(d, 'cy') === num(t, 'y')), 'number inside a dot');
  }
});

test('barre chords draw a bar, with the root notes on it marked', () => {
  const svg = renderDiagram(find('F', '133211'), { rootPc: 5 });
  const bars = all(svg, '.dg-barre');
  eq(bars.length, 1, 'one barre');
  const xs = all(svg, '.dg-string').map(l => num(l, 'x1'));
  const bar = bars[0];
  ok(num(bar, 'x') < xs[0] && num(bar, 'x') + num(bar, 'width') > xs[5], 'spans all six strings');
  // C, F and A above the barre, plus the low and high F under it
  eq(all(svg, '.dg-dot').length, 5, 'dots');
  eq(all(svg, '.dg-root').length, 3, 'roots');
  deepEq(texts(svg, '.dg-finger').sort(), ['1', '2', '3', '4'], 'the barre is numbered once');
  const partial = renderDiagram(find('Dm7', 'xx0211'), { rootPc: 2 });
  eq(all(partial, '.dg-barre').length, 1, 'small barre');
  eq(all(partial, '.dg-dot').length, 1, 'just the G-string dot (the barre notes are not roots)');
});

test('up the neck: a fret number instead of the nut', () => {
  const v = find('A', '577655');
  const svg = renderDiagram(v, { rootPc: 9 });
  eq(all(svg, '.dg-nut').length, 0);
  deepEq(texts(svg, '.dg-fretnum'), ['5fr']);
  eq(all(svg, '.dg-fret').length, 5, 'top line plus four rows');
  deepEq(texts(renderDiagram(v, { mini: true }), '.dg-fretnum'), ['5'], 'mini shows just the number');
  // the label is clear of the dots on the first row
  const host = mounted(svg);
  const label = svg.querySelector('.dg-fretnum').getBBox();
  for (const d of all(svg, '.dg-dot, .dg-barre')) ok(d.getBBox().x >= label.x + label.width, 'label left of the shape');
  host.remove();
});

test('rows: at least four, more when asked or when the shape needs them', () => {
  const c = find('C', 'x32010');
  eq(all(renderDiagram(c, { frets: 6 }), '.dg-fret').length, 6, 'frets option');
  eq(all(renderDiagram(c, { frets: 3 }), '.dg-fret').length, 3, 'the frets option replaces the default of four');
  eq(all(renderDiagram(c, { frets: 2 }), '.dg-fret').length, 3, 'but never cuts the shape off');
  const wide = { frets: [-1, 5, 4, 2, 6, -1], fingers: [0, 3, 2, 1, 4, 0], barres: [], baseFret: 2 };
  eq(all(renderDiagram(wide), '.dg-fret').length, 6, 'a five-fret shape gets five rows');
});

test('left-handed mirrors the strings', () => {
  const c = find('C', 'x32010');
  const right = renderDiagram(c);
  const left = renderDiagram(c, { leftHanded: true });
  ok(left.classList.contains('dg-left'));
  const rx = all(right, '.dg-string').map(l => num(l, 'x1'));
  const lx = all(left, '.dg-string').map(l => num(l, 'x1'));
  ok(rx.every((x, i) => !i || x > rx[i - 1]), 'low string on the left');
  ok(lx.every((x, i) => !i || x < lx[i - 1]), 'low string on the right');
  const [, , w] = left.getAttribute('viewBox').split(' ').map(Number);
  // the same picture flipped: string s lands where string 5 - s was, measured from the other edge
  rx.forEach((x, s) => near(w - lx[s], x, 1e-9, `string ${s} mirrored`));
  // the dot on the A string (3rd fret) follows its string
  const dotAt = (svg, x) => all(svg, '.dg-dot').some(d => num(d, 'cx') === x);
  ok(dotAt(right, rx[1]) && dotAt(left, lx[1]), 'dots follow their strings');
  const muteX = svg => all(svg, '.dg-mute')[0].getAttribute('d').match(/^M([\d.]+)/)[1] * 1;
  ok(muteX(right) < rx[1] && muteX(left) > lx[1], 'the muted low string mark moves too');
  const f = renderDiagram(find('A', '577655'), { leftHanded: true });
  const host = mounted(f);
  const label = f.querySelector('.dg-fretnum').getBBox();
  for (const d of all(f, '.dg-dot, .dg-barre')) ok(d.getBBox().x + d.getBBox().width <= label.x, 'label on the right');
  host.remove();
});

test('mini mode: no finger numbers, bolder lines', () => {
  const v = find('F', '133211');
  const full = renderDiagram(v);
  const mini = renderDiagram(v, { mini: true, size: 56 });
  ok(mini.classList.contains('dg-mini'));
  eq(all(mini, '.dg-finger').length, 0, 'no numbers');
  eq(all(mini, '.dg-barre').length, 1);
  eq(mini.getAttribute('width'), '56');
  const stroke = svg => num(svg.querySelector('.dg-string'), 'stroke-width') / Number(svg.getAttribute('viewBox').split(' ')[2]);
  ok(stroke(mini) > 1.8 * stroke(full), 'lines are thicker relative to the size');
  eq(all(renderDiagram(v, { fingers: false }), '.dg-finger').length, 0, 'fingers: false');
});

test('colours come from CSS custom properties', () => {
  const svg = renderDiagram(find('C', 'x32010'), { rootPc: 0 });
  const uses = (sel, prop) => all(svg, sel).every(e => (e.getAttribute('style') || '').includes(prop));
  ok(uses('.dg-string, .dg-fret', '--dg-line'), 'lines');
  ok(uses('.dg-nut', '--dg-ink'), 'nut');
  ok(uses('.dg-dot:not(.dg-root)', '--dg-dot'), 'dots');
  ok(uses('.dg-root', '--dg-root'), 'roots');
  ok(uses('.dg-finger', '--dg-dot-ink'), 'finger numbers');
  ok(uses('.dg-mark', '--dg-mark'), 'marks');
  ok(uses('.dg-fretnum', '--dg-ink') || !all(svg, '.dg-fretnum').length, 'fret number');
  const host = mounted(svg, 'color: rgb(10, 20, 30); --dg-dot: rgb(200, 0, 0); --dg-root: rgb(0, 0, 200)');
  eq(getComputedStyle(svg.querySelector('.dg-dot:not(.dg-root)')).fill, 'rgb(200, 0, 0)', 'themed dot');
  eq(getComputedStyle(svg.querySelector('.dg-root')).fill, 'rgb(0, 0, 200)', 'themed root');
  eq(getComputedStyle(svg.querySelector('.dg-string')).stroke, 'rgb(10, 20, 30)', 'falls back to currentColor');
  eq(getComputedStyle(svg.querySelector('.dg-finger')).fill, 'rgb(255, 255, 255)', 'finger numbers default to white');
  host.remove();
});

test('names are text, never markup', () => {
  const svg = renderDiagram(find('C', 'x32010'), { name: '<b onclick="x()">C</b>' });
  eq(svg.querySelector('title').textContent, '<b onclick="x()">C</b>: x 3 2 0 1 0');
  eq(svg.querySelector('b'), null);
  eq(svg.querySelectorAll('*').length, svg.getElementsByTagNameNS('http://www.w3.org/2000/svg', '*').length, 'only svg elements');
});

test('copes with partial or missing data', () => {
  const bare = renderDiagram({ frets: [0, 2, 2, 1, 0, 0] });
  eq(all(bare, '.dg-dot').length, 3);
  eq(all(bare, '.dg-finger').length, 0, 'no fingers known');
  eq(all(bare, '.dg-nut').length, 1, 'base fret worked out');
  const high = renderDiagram({ frets: [-1, 7, 9, 9, 9, 7] });
  deepEq(texts(high, '.dg-fretnum'), ['7fr']);
  const none = renderDiagram(null);
  eq(all(none, '.dg-string').length, 6);
  eq(all(none, '.dg-dot').length, 0);
});

test('roots in other tunings', () => {
  const v = find('D', '000232', { tuning: TUNINGS.dropD.midi });
  const svg = renderDiagram(v, { rootPc: 2, tuning: TUNINGS.dropD.midi });
  eq(all(svg, '.dg-root').length, 1, 'the D on the B string');
  eq(all(svg, '.dg-open').length, 3);
});

test('every voicing of some chords draws each fretted note once', () => {
  for (const sym of ['G', 'Bb', 'F#m7', 'Cadd9', 'Ebmaj7', 'C13b9']) {
    for (const v of voicings(sym)) {
      const svg = renderDiagram(v, { rootPc: 0, fingers: true });
      const covered = new Set();
      for (const b of v.barres) for (let s = b.from; s <= b.to; s++) if (v.frets[s] === b.fret) covered.add(s);
      const dots = all(svg, '.dg-dot').length;
      const fretted = v.frets.filter(f => f > 0).length;
      ok(dots >= fretted - covered.size && dots <= fretted, `${sym} ${voicingKey(v)} dots`);
      eq(all(svg, '.dg-barre').length, v.barres.length, `${sym} ${voicingKey(v)} barres`);
      eq(all(svg, '.dg-mark').length, v.frets.filter(f => f <= 0).length, `${sym} ${voicingKey(v)} marks`);
      eq(all(svg, '.dg-finger').length, fretted - covered.size + v.barres.length, `${sym} ${voicingKey(v)} numbers`);
    }
  }
});
