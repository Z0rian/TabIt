// Chord voicings: the playable ways to finger any chord the parser accepts,
// best (most common, easiest) first, so the UI can swipe through them.
// Pure functions, no DOM. Strings run low to high (index 0 is the low E in
// standard tuning) and a fret of -1 means the string is muted.

import { parseChord } from './theory.js';

// MIDI note of each open string, low string first. Frozen: they're shared defaults.
export const TUNINGS = freeze({
  standard: { name: 'Standard', midi: [40, 45, 50, 55, 59, 64] }, // E2 A2 D3 G3 B3 E4
  dropD: { name: 'Drop D', midi: [38, 45, 50, 55, 59, 64] },
  halfDown: { name: 'Half step down', midi: [39, 44, 49, 54, 58, 63] },
  fullDown: { name: 'Full step down', midi: [38, 43, 48, 53, 57, 62] },
  openG: { name: 'Open G', midi: [38, 43, 50, 55, 59, 62] },
  openD: { name: 'Open D', midi: [38, 45, 50, 54, 57, 62] },
  dadgad: { name: 'DADGAD', midi: [38, 45, 50, 55, 57, 62] },
});

function freeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
}

// The shapes everyone learns first. They go to the front of the list in
// standard tuning (and in tunings with the same intervals, shifted), but they
// still have to pass the generator's rules, so a typo can't show a wrong chord.
export const CANONICAL = {
  C: 'x32010', C7: 'x32310', Cmaj7: 'x32000', Cadd9: 'x32033', Csus4: 'x33011', 'C/G': '332010', 'C/E': '032010', Cm: 'x35543',
  D: 'xx0232', Dm: 'xx0231', D7: 'xx0212', Dmaj7: 'xx0222', Dm7: 'xx0211', Dsus2: 'xx0230', Dsus4: 'xx0233', 'D/F#': '200232', D6: 'xx0202',
  E: '022100', Em: '022000', E7: '020100', Em7: ['022030', '020000'], Emaj7: '021100', Esus4: '022200', E5: '022xxx', 'E7#9': 'x7678x',
  F: '133211', Fm: '133111', F7: '131211', Fmaj7: 'xx3210', 'F/C': 'x33211', Fsus2: 'xx3013',
  G: '320003', G7: '320001', Gmaj7: '320002', G6: '320000', Gsus4: '330013', 'G/B': 'x20003', Gm: '355333', G5: '355xxx',
  A: 'x02220', Am: 'x02210', A7: 'x02020', Am7: 'x02010', Amaj7: 'x02120', Asus2: 'x02200', Asus4: 'x02230', A7sus4: 'x02030',
  A6: 'x02222', A5: 'x022xx', 'A/C#': 'x42220', 'Am/G': '302210', 'Am/C': 'x32210',
  B: 'x24442', Bm: 'x24432', B7: 'x21202', Bm7: 'x20202', Bsus4: 'x24452', Bm7b5: 'x2323x',
  Bb: 'x13331', Bbm: 'x13321', Bb7: 'x13131', Bbmaj7: 'x13231',
  'F#': '244322', 'F#m': '244222', 'F#7': '242322', 'F#m7': '242222',
  'C#m': 'x46654', 'C#m7': 'x46454', 'G#m': '466444', Ab: '466544', Db: 'x46664', Eb: 'x68886',
  'C#7': 'x46464', Bmaj7: 'x24342', 'F#maj7': 'xx4321', Abmaj7: 'xx6543',
};

const STANDARD = TUNINGS.standard.midi;
const HAND = 4; // fretting fingers
const KEEP = 32; // voicings ranked per chord; the UI shows about 16
const STRICT = { span: 3, inner: 1 }; // fret span of the fretted notes, muted strings inside the shape
const LOOSE = { span: 4, inner: 2 };

const mod12 = n => ((n % 12) + 12) % 12;
const BITS = new Uint8Array(4096); // popcount of a pitch-class mask
for (let i = 1; i < 4096; i++) BITS[i] = BITS[i >> 1] + (i & 1);

const cache = new Map();

// The voicings of a chord symbol, best first: [] only when it isn't a chord.
// `tuning` is MIDI notes low string first (a TUNINGS entry works too);
// `curated: false` skips the CANONICAL table and shows the generator's own order.
export function voicings(symbol, { tuning = STANDARD, limit = 16, maxFret = 15, curated = true } = {}) {
  const chord = parseChord(symbol);
  if (!chord) return [];
  const midi = Array.isArray(tuning) ? tuning : tuning && Array.isArray(tuning.midi) ? tuning.midi : STANDARD;
  const top = Number.isFinite(maxFret) ? Math.max(0, Math.min(24, Math.floor(maxFret))) : 15;
  const key = `${symbol}|${midi.join(',')}|${top}|${curated ? 1 : 0}`;
  let list = cache.get(key);
  if (!list) {
    list = build(chord, midi, top, curated);
    if (cache.size > 2000) cache.clear();
    cache.set(key, list);
  }
  return list.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : 16).map(copy);
}

// A stable id: "x32010", or dash-separated once a fret has two digits ("x-10-12-12-12-10").
export function voicingKey(v) {
  const frets = Array.isArray(v) ? v : v.frets;
  const parts = frets.map(f => (f < 0 ? 'x' : String(f)));
  return parts.join(frets.some(f => f > 9) ? '-' : '');
}

// "x 3 2 0 1 0", for titles and screen readers.
export function describe(v) {
  const frets = Array.isArray(v) ? v : v.frets;
  return frets.map(f => (f < 0 ? 'x' : String(f))).join(' ');
}

const copy = v => ({
  frets: [...v.frets], fingers: [...v.fingers], barres: v.barres.map(b => ({ ...b })),
  baseFret: v.baseFret, score: v.score, notes: [...v.notes], relaxed: v.relaxed,
});

function build(chord, tuning, maxFret, curated) {
  const t = tonesFor(chord, tuning, maxFret);
  return rank(gather(t), curated ? curatedFor(t) : []);
}

// Chord tones as 12-bit pitch-class masks, plus what the search needs to know.
function tonesFor(chord, tuning, maxFret) {
  const root = chord.rootPc;
  const mask = ivs => ivs.reduce((m, iv) => m | (1 << mod12(root + iv)), 0);
  const req = mask(chord.required);
  const opt = mask(chord.optional);
  return {
    chord, tuning, maxFret, root, req, opt,
    bass: chord.bassPc,
    allowed: req | opt | (1 << chord.bassPc),
    fifth: chord.optional.includes(7) ? mod12(root + 7) : -1,
    power: !!chord.quality.power,
  };
}

// Strict rules first; looser shapes only when that finds almost nothing; and
// only when nothing fits at all does a required tone get left out.
function gather(t) {
  const min = t.power ? 2 : 3;
  let found = search(t, t.req, STRICT, min);
  if (found.length < 3) found = union(found, search(t, t.req, LOOSE, min));
  if (found.length) return found;
  for (const drops of dropOrder(t)) {
    let some = [];
    for (const p of drops) {
      const req = t.req & ~(1 << p);
      some = union(some, search(t, req, STRICT, min));
      if (some.length < 3) some = union(some, search(t, req, LOOSE, min));
    }
    if (some.length) return some.map(relax);
  }
  return fallback(t);
}

const relax = v => ({ ...v, relaxed: true });

function union(a, b) {
  if (!a.length) return b;
  const seen = new Set(a.map(voicingKey));
  return a.concat(b.filter(v => !seen.has(voicingKey(v))));
}

// The tones a guitarist leaves out when a chord won't fit under four fingers,
// as groups tried in order: extensions and altered fifths, then the seventh
// (or sixth), then the third. Never the root.
function dropOrder(t) {
  const { quality: q, required } = t.chord;
  const third = q.sus === 'sus2' ? [2] : q.sus === 'sus4' ? [5] : q.sus === 'sus24' ? [2, 5]
    : required.includes(3) && q.third === 'minor' ? [3] : required.includes(4) ? [4] : [5];
  const seventh = q.seventh === 'major' ? [11] : q.seventh === 'minor' ? [10] : q.seventh === 'dim' || q.sixth ? [9] : [];
  const rest = required.filter(iv => iv && !third.includes(iv) && !seventh.includes(iv));
  return [rest, seventh, third]
    .map(g => g.filter(iv => required.includes(iv)).map(iv => mod12(t.root + iv)))
    .filter(g => g.length);
}

// Last resorts so every chord gets a diagram: a power chord, then any chord
// tones over the bass (searching the whole octave so something always fits).
function fallback(t) {
  const wide = { ...t, maxFret: Math.max(t.maxFret, 12) };
  const base = (1 << t.root) | (1 << t.bass);
  const five = 1 << mod12(t.root + 7);
  if (t.allowed & five) {
    const found = search({ ...wide, allowed: base | five }, base | five, STRICT, 2);
    if (found.length) return found.map(relax);
  }
  return search(wide, base, LOOSE, 1).map(relax);
}

// Every voicing whose lowest fretted note is at fret p, for each p (p = 0 is
// open strings only), so each shape is found exactly once. Per string the
// choices are: muted, open, or a chord tone within the span above p.
function search(t, req, rule, minStrings) {
  const { tuning, maxFret, allowed, bass } = t;
  const n = tuning.length;
  const out = [];
  const frets = new Array(n).fill(-1);
  const reach = new Array(n + 1).fill(0); // pitch classes the strings from s up can still add
  const canP = new Array(n + 1).fill(false); // whether a string from s up can still take fret p
  let cands, p;

  const walk = (s, mask, sounding, pending, inner, hasP, upper) => {
    if (s === n) {
      if (hasP && (mask & req) === req && sounding >= minStrings) {
        const v = voicing(frets, t);
        if (v) out.push(v);
      }
      return;
    }
    const missing = req & ~mask;
    if ((missing & ~reach[s]) || BITS[missing] > n - s || (!hasP && !canP[s])) return;
    for (const f of cands[s]) {
      frets[s] = f;
      if (f < 0) {
        // mutes below the bass are free; above it they count once a note follows
        walk(s + 1, mask, sounding, sounding ? pending + 1 : 0, inner, hasP, upper);
        continue;
      }
      const pc = (tuning[s] + f) % 12;
      if (!sounding && pc !== bass) continue;
      if (inner + pending > rule.inner) continue;
      // notes above fret p each need their own finger, plus one (or a barre) for fret p
      const up = upper + (f > p ? 1 : 0);
      if (p && up >= HAND) continue;
      walk(s + 1, mask | (1 << pc), sounding + 1, 0, inner + pending, hasP || f === p, up);
    }
    frets[s] = -1;
  };

  for (p = 0; p <= maxFret; p++) {
    const top = p ? Math.min(maxFret, p + rule.span) : 0;
    cands = tuning.map(open => {
      const list = [-1];
      if ((allowed >> (open % 12)) & 1) list.push(0);
      for (let f = p; p && f <= top; f++) if ((allowed >> ((open + f) % 12)) & 1) list.push(f);
      return list;
    });
    for (let s = n - 1; s >= 0; s--) {
      let m = 0;
      for (const f of cands[s]) if (f >= 0) m |= 1 << ((tuning[s] + f) % 12);
      reach[s] = reach[s + 1] | m;
      canP[s] = canP[s + 1] || (p > 0 && cands[s].includes(p));
    }
    if ((req & ~reach[0]) || (p && !canP[0])) continue;
    walk(0, 0, 0, 0, 0, p === 0, 0);
  }
  return out;
}

// The voicing for a set of frets the search found, or null when no hand can play it.
function voicing(frets, t) {
  const notes = [];
  for (let s = 0; s < frets.length; s++) {
    if (frets[s] < 0) continue;
    const m = t.tuning[s] + frets[s];
    // an open string ringing below the lowest string's note would change the bass
    if (notes.length && m < notes[0]) return null;
    notes.push(m);
  }
  const hand = fingering(frets);
  if (!hand) return null;
  const v = {
    frets: frets.slice(), fingers: hand.fingers, barres: hand.barres, baseFret: baseFret(frets),
    score: 0, notes: notes.sort((a, b) => a - b), relaxed: false,
  };
  v.score = Math.round(rate(v, hand, t) * 100) / 100;
  return v;
}

// The nut is shown when the whole shape fits in the first four frets.
function baseFret(frets) {
  let lo = 0, hi = 0;
  for (const f of frets) if (f > 0) { if (!lo || f < lo) lo = f; if (f > hi) hi = f; }
  return hi <= 4 ? 1 : lo;
}

// Which finger presses what. The index finger barres the lowest fret when
// there are more notes than fingers (F 133211), or when that fret runs across
// the top strings (Dm7 xx0211). Everything else gets fingers 1-4 by fret, then
// string, skipping a finger over an empty fret when one is spare (Fm 1 3 4 1 1 1).
function fingering(frets) {
  const n = frets.length;
  const fingers = new Array(n).fill(0);
  const pressed = [];
  let low = 0;
  for (let s = 0; s < n; s++) if (frets[s] > 0) { pressed.push(s); if (!low || frets[s] < low) low = frets[s]; }
  if (!pressed.length) return { fingers, barres: [], count: 0, forced: false };
  const forced = pressed.length > HAND;
  let bar = null;
  if (forced) {
    bar = widestBarre(frets, low);
    if (!bar) return null;
  } else {
    let s = n - 1;
    while (s >= 0 && frets[s] === low) s--;
    if (n - 1 - s >= 2) bar = { from: s + 1, to: n - 1 };
  }
  // The barring finger fills its fret, so no other finger fits on that fret
  // (F7 101211 would need the thumb). Optional barres just aren't used then.
  const under = s => bar && s >= bar.from && s <= bar.to && frets[s] === low;
  if (bar && pressed.some(s => frets[s] === low && !under(s))) {
    if (forced) return null;
    bar = null;
  }
  const rest = pressed.filter(s => !under(s)).sort((a, b) => frets[a] - frets[b] || a - b);
  const count = rest.length + (bar ? 1 : 0);
  if (count > HAND) return null;
  let next = 1, prev = 0;
  if (bar) {
    for (let s = bar.from; s <= bar.to; s++) if (under(s)) fingers[s] = 1;
    next = 2;
    prev = low;
  }
  rest.forEach((s, k) => {
    const spare = HAND - next + 1 - (rest.length - k);
    if (prev && frets[s] > prev + 1 && spare > 0) next += Math.min(spare, frets[s] - prev - 1);
    fingers[s] = next++;
    prev = frets[s];
  });
  const barres = bar ? [{ fret: low, from: bar.from, to: bar.to, finger: 1 }] : [];
  return { fingers, barres, count, forced };
}

// The biggest run of strings at the lowest fret one finger can lie across:
// every string under it must be fretted (an open or muted one would sound wrong).
function widestBarre(frets, low) {
  let best = null, from = -1, to = -1, count = 0;
  for (let s = 0; s <= frets.length; s++) {
    const f = s < frets.length ? frets[s] : -1;
    if (f <= 0) {
      if (count >= 2 && (!best || count > best.count)) best = { from, to, count };
      from = -1;
      count = 0;
    } else if (f === low) {
      if (from < 0) from = s;
      to = s;
      count++;
    }
  }
  return best;
}

const FULLNESS = [0, -30, -20, -8, 3, 9, 12]; // by sounding strings: thin voicings lose
const POWER_FULLNESS = [0, -30, 2, 8, 4, 2, 0]; // power chords sound best on two or three strings
const SPAN = [0, 0, 1.5, 7, 11]; // stretch, by frets between the lowest and highest fretted note
// Close intervals sound muddy low down: a second or third right above a root
// bass below these notes (indexed by the interval in semitones) is penalized.
const MUD_BELOW = [0, 52, 51, 50, 48, 45];
const MUD = [0, 8, 8, 8, 4, 2];

// Higher is better. Tuned so the classic shapes mostly win on their own;
// CANONICAL settles the close calls.
function rate(v, hand, t) {
  const { frets, notes } = v;
  const n = frets.length;
  let opens = 0, lo = 0, hi = 0, first = -1, last = -1;
  for (let s = 0; s < n; s++) {
    const f = frets[s];
    if (f < 0) continue;
    if (first < 0) first = s;
    last = s;
    if (!f) opens++;
    else { if (!lo || f < lo) lo = f; if (f > hi) hi = f; }
  }
  const sounding = notes.length;
  let score = (t.power ? POWER_FULLNESS : FULLNESS)[Math.min(sounding, 6)];
  // Low on the neck is easiest; past the 9th fret is hard to reach and thin.
  if (lo) score -= 2 * (lo - 1) + 3 * Math.max(0, hi - 9);
  // Open strings are free near the nut and awkward with the hand far from it.
  score += lo <= 3 ? 3 * opens : lo > 5 ? -3 * opens : 0;
  score -= 3.5 * hand.count;
  const span = lo ? hi - lo : 0;
  score -= SPAN[Math.min(span, 4)];
  // A barre is work; one lying across the top strings (E, A shapes, F/C) is the usual kind.
  if (hand.forced) score -= hand.barres[0].to === n - 1 ? 3 : 8;
  for (let s = first + 1; s < last; s++) {
    if (frets[s] < 0) score -= frets[s - 1] > 0 && frets[s + 1] > 0 ? 18 : 15;
  }
  if (frets[n - 1] < 0 && !t.power) score -= 2;
  const have = notes.reduce((m, x) => m | (1 << (x % 12)), 0);
  // A triad sounds hollow without its fifth (a sus chord turns into an inversion
  // of something else); sevenths and up often drop it.
  if (t.fifth >= 0 && !((have >> t.fifth) & 1)) score -= t.chord.quality.sus ? 10 : t.chord.required.length > 2 ? 2 : 5;
  score -= 2 * BITS[t.opt & ~have & ~(t.fifth >= 0 ? 1 << t.fifth : 0)];
  // (a slash bass is a bass line note, so its spacing is left alone)
  const gap = notes[1] - notes[0];
  if (t.bass === t.root && gap > 0 && gap < MUD.length && notes[0] < MUD_BELOW[gap]) score -= MUD[gap];
  // The same note twice (a fretted note and an open string) marks an odd shape.
  for (let i = 1; i < sounding; i++) if (notes[i] === notes[i - 1]) score -= 12;
  if (t.power) score += powerShape(notes, first, last);
  return score;
}

// Root, fifth and octave on neighbouring bass strings is the power chord everyone plays.
function powerShape(notes, first, last) {
  let bonus = -8 * Math.max(0, first - 1);
  const [r, f, o] = notes;
  if (notes.length === 3 && last - first === 2 && f - r === 7 && o - r === 12) bonus += 10;
  else if (notes.length === 2 && last - first === 1 && f - r === 7) bonus += 4;
  return bonus;
}

// ---------- ranking ----------

const VARIANT = 30; // a shape that only adds or drops a muted string from a better one
const POOL = 120; // candidates considered for the list, best first

// Best first, but spread along the neck so the list doesn't fill up with six
// versions of the open G: variants of a better shape drop well down, a shape
// one fret away from one already listed drops a little, and each spot of the
// neck gets more crowded the more shapes it already has. Scores are rewritten
// to these adjusted values, so the order and the scores agree.
function rank(found, firsts) {
  const byKey = new Map(found.map(v => [voicingKey(v), v]));
  const head = [];
  for (const v of firsts) {
    const k = voicingKey(v);
    if (head.some(h => voicingKey(h) === k)) continue;
    head.push(byKey.get(k) || v);
    byKey.delete(k);
  }
  const byScore = (a, b) => b.score - a.score || (voicingKey(a) < voicingKey(b) ? -1 : 1);
  const pool = [...byKey.values()].sort(byScore).slice(0, POOL);
  const kept = [...head];
  for (const v of pool) {
    if (kept.some(k => variant(v, k))) v.score -= VARIANT;
    else kept.push(v);
  }
  pool.sort(byScore);
  const near = new Float64Array(pool.length); // worst similarity to a listed shape
  const crowd = new Uint8Array(pool.length); // listed shapes in the same spot
  const taken = new Uint8Array(pool.length);
  const list = v => {
    for (let i = 0; i < pool.length; i++) {
      if (taken[i]) continue;
      near[i] = Math.max(near[i], likeness(pool[i], v));
      if (Math.abs(spot(pool[i]) - spot(v)) <= 1) crowd[i]++;
    }
  };
  const adjusted = i => pool[i].score - near[i] - 2 * Math.min(crowd[i], 4);
  head.forEach(list);
  const tail = [];
  while (head.length + tail.length < KEEP && tail.length < pool.length) {
    let best = -1;
    for (let i = 0; i < pool.length; i++) if (!taken[i] && (best < 0 || adjusted(i) > adjusted(best))) best = i;
    taken[best] = 1;
    pool[best].score = Math.round(adjusted(best) * 100) / 100;
    tail.push(pool[best]);
    list(pool[best]);
  }
  let floor = tail.length ? tail[0].score : -Infinity;
  for (let i = head.length - 1; i >= 0; i--) {
    head[i].score = Math.max(head[i].score, floor + 1);
    floor = head[i].score;
  }
  return head.concat(tail);
}

// Where the hand is: the lowest fretted fret (open-string-only shapes count as 1).
function spot(v) {
  let m = 0;
  for (const f of v.frets) if (f > 0 && (!m || f < m)) m = f;
  return m || 1;
}

// Same notes give or take one muted string, or two off the top. (Two more
// bass strings change how the chord sounds, so xx3210 isn't a copy of 103210.)
function variant(a, b) {
  let shared = 0, odd = 0, top = -1, low = 99;
  for (let s = 0; s < a.frets.length; s++) {
    const x = a.frets[s], y = b.frets[s];
    if (x >= 0 && y >= 0) {
      if (x !== y) return false;
      shared++;
      top = s;
    } else if (x !== y) {
      odd++;
      low = Math.min(low, s);
    }
  }
  return shared >= 2 && (odd <= 1 || (odd === 2 && low > top));
}

// How much voicing a repeats b, beyond being a variant (rank() handles those):
// the same shape with one string moved, in the same spot.
function likeness(a, b) {
  if (Math.abs(spot(a) - spot(b)) > 1) return 0;
  let clash = 0;
  for (let s = 0; s < a.frets.length; s++) if (a.frets[s] !== b.frets[s]) clash++;
  return clash === 1 ? 8 : 0;
}

// ---------- the canonical table ----------

let canonIndex = null;

const signature = (root, req, opt, bass) => `${mod12(root)}|${req}|${opt}|${mod12(bass)}`;
const parseShape = s => (s.includes('-') ? s.split('-') : [...s]).map(c => (c === 'x' || c === 'X' ? -1 : +c));

function canonical() {
  if (canonIndex) return canonIndex;
  canonIndex = new Map();
  for (const [sym, shapes] of Object.entries(CANONICAL)) {
    const c = parseChord(sym);
    if (!c) continue;
    const key = signature(c.rootPc, c.required, c.optional, c.bassPc);
    canonIndex.set(key, (canonIndex.get(key) || []).concat([].concat(shapes).map(parseShape)));
  }
  return canonIndex;
}

// Tunings with standard's intervals (half or full step down) reuse the standard
// shapes, shifted: in Eb tuning the E shape sounds an Eb chord.
function shiftFromStandard(tuning) {
  if (tuning.length !== STANDARD.length) return null;
  const d = STANDARD[0] - tuning[0];
  return tuning.every((m, i) => STANDARD[i] - m === d) ? d : null;
}

function curatedFor(t) {
  const d = shiftFromStandard(t.tuning);
  if (d === null) return [];
  const c = t.chord;
  const shapes = canonical().get(signature(c.rootPc + d, c.required, c.optional, c.bassPc + d)) || [];
  return shapes.map(frets => strict(frets, t)).filter(Boolean);
}

// The voicing for a fixed shape if it passes the strict rules, else null.
function strict(frets, t) {
  const { tuning } = t;
  if (frets.length !== tuning.length || frets.some(f => f > t.maxFret)) return null;
  let mask = 0, sounding = 0, pending = 0, inner = 0, lo = 0, hi = 0;
  for (let s = 0; s < frets.length; s++) {
    const f = frets[s];
    if (f < 0) { if (sounding) pending++; continue; }
    const pc = (tuning[s] + f) % 12;
    if (!((t.allowed >> pc) & 1) || (!sounding && pc !== t.bass)) return null;
    inner += pending;
    pending = 0;
    sounding++;
    mask |= 1 << pc;
    if (f > 0) { if (!lo || f < lo) lo = f; if (f > hi) hi = f; }
  }
  if ((mask & t.req) !== t.req || inner > STRICT.inner || hi - lo > STRICT.span) return null;
  if (sounding < (t.power ? 2 : 3)) return null;
  return voicing(frets, t);
}

// A shape someone wrote down (the tab author's, or one saved by the user) as a
// voicing for the diagrams: fingering worked out the same way, no rules checked.
export function fromFrets(frets, tuning = STANDARD) {
  const f = Array.from({ length: 6 }, (_, i) => (Number.isFinite(+frets[i]) ? Math.max(-1, Math.min(24, Math.round(+frets[i]))) : -1));
  const midi = Array.isArray(tuning) ? tuning : tuning && Array.isArray(tuning.midi) ? tuning.midi : STANDARD;
  const hand = fingering(f) || { fingers: new Array(6).fill(0), barres: [] };
  const notes = f.map((x, s) => (x < 0 ? null : midi[s] + x)).filter(x => x !== null).sort((a, b) => a - b);
  return { frets: f, fingers: hand.fingers, barres: hand.barres, baseFret: baseFret(f), score: 0, notes, relaxed: false, author: true };
}
