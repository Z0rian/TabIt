// Music theory: note names, chord symbols, transposing, keys.
// Pure functions, no DOM, so the unit tests can cover all of it.

export const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const BASE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const mod12 = n => ((n % 12) + 12) % 12;

// Pitch class (0-11) of a note name such as "C", "F#", "Bb", "E♭", "B#"; -1 if not a note.
export function pc(name) {
  const m = /^([A-G])([#♯b♭]*)$/.exec(name || '');
  if (!m) return -1;
  let v = BASE_PC[m[1]];
  for (const ch of m[2]) v += ch === '#' || ch === '♯' ? 1 : -1;
  return mod12(v);
}

export function noteName(pitchClass, flats = false) {
  return (flats ? FLATS : SHARPS)[mod12(pitchClass)];
}

// ---------- chord symbols ----------

// The suffix grammar. Each entry turns part of the suffix into chord tones
// (semitones above the root). Parsing is greedy left to right, so longer
// spellings come first.
const TRIADS = [
  // [regex, triad, label]
  [/^(?:mmaj|mMaj|mM|minmaj|minMaj|-maj|-M|-Δ|m\(maj|m\/maj)(?=7|9|11|13|\)|$)/, 'minor-major'],
  [/^(?:min|mi|m|-)(?!aj)/, 'minor'],
  [/^(?:dim|°|o(?=7))(?![a-z])/, 'dim'], // "Co7", but a bare "Do" is more likely a word
  [/^ø/, 'half-dim'],
  [/^(?:aug|\+)/, 'aug'],
];

function emptyChord() {
  return { third: 'major', fifth: 'perfect', seventh: null, sixth: false, ext: 0, adds: new Set(), alts: new Set(), sus: null, power: false, no3: false, no5: false };
}

// Parses a chord suffix ("m7b5", "maj7(#11)", "sus4", "") into a description,
// or returns null when it isn't a chord suffix we understand.
export function parseSuffix(suffix) {
  const c = emptyChord();
  let s = suffix.replace(/\s+/g, '');
  if (s === '') return c;
  // Parentheses only group alterations: "7(b9)" == "7b9", "m(add9)" == "madd9".
  if (/[()]/.test(s)) {
    if (!/^[^()]*(\([^()]*\))*[^()]*$/.test(s)) return null;
    s = s.replace(/\(/g, '').replace(/\)/g, '');
  }
  s = s.replace(/,/g, '');

  // triad family
  let explicitMaj = false;
  for (const [rx, kind] of TRIADS) {
    const m = rx.exec(s);
    if (!m) continue;
    s = s.slice(m[0].length);
    if (kind === 'minor') c.third = 'minor';
    else if (kind === 'minor-major') { c.third = 'minor'; c.seventh = 'major'; explicitMaj = true; if (/^7/.test(s)) s = s.slice(1); }
    else if (kind === 'dim') { c.third = 'minor'; c.fifth = 'flat'; c.dim = true; }
    else if (kind === 'half-dim') { c.third = 'minor'; c.fifth = 'flat'; c.seventh = 'minor'; if (/^7/.test(s)) s = s.slice(1); }
    else if (kind === 'aug') c.fifth = 'sharp';
    break;
  }

  // major seventh family: maj, Maj, ma, M, Δ, ^, j
  const mj = /^(?:maj|Maj|MAJ|ma|M|Δ|\^|j)(?=\d|$|add|sus|b|#|♭|♯)/.exec(s);
  if (mj && c.seventh !== 'major') {
    s = s.slice(mj[0].length);
    const n = /^(7|9|11|13)/.exec(s);
    // "Cmaj7" is a major seventh; a bare "Cmaj" or "CM" is just C major.
    if (n) { s = s.slice(n[0].length); setExt(c, +n[1], 'major'); explicitMaj = true; }
  }

  // the main number
  if (!explicitMaj || c.seventh === 'major') {
    let n = /^(13|11|9|7|69|6\/9|6|5|4|2)/.exec(s);
    if (n && !(c.seventh === 'major' && explicitMaj && c.ext)) {
      s = s.slice(n[0].length);
      const v = n[1];
      if (v === '5') { if (c.third === 'major' && c.fifth === 'perfect' && !c.dim) c.power = true; else return null; }
      else if (v === '6') c.sixth = true;
      else if (v === '69' || v === '6/9') { c.sixth = true; c.adds.add(2); }
      else if (v === '2') c.sus = 'sus2'; // "D2" is played as Dsus2
      else if (v === '4') c.sus = 'sus4';
      else setExt(c, +v, c.seventh === 'major' ? 'major' : (c.dim && v === '7' ? 'dim' : 'minor'));
    }
  }

  // modifiers, in any order
  while (s.length) {
    let m;
    if ((m = /^sus(2|4|24|42)?/.exec(s))) {
      s = s.slice(m[0].length);
      c.sus = m[1] === '2' ? 'sus2' : m[1] === '24' || m[1] === '42' ? 'sus24' : 'sus4';
      continue;
    }
    if ((m = /^(?:add|ad|\+)(2|4|6|9|11|13)/.exec(s))) {
      s = s.slice(m[0].length);
      c.adds.add({ 2: 2, 9: 2, 4: 5, 11: 5, 6: 9, 13: 9 }[m[1]]);
      continue;
    }
    if ((m = /^(?:no|omit)(3|5)/.exec(s))) {
      s = s.slice(m[0].length);
      if (m[1] === '3') c.no3 = true; else c.no5 = true;
      continue;
    }
    if ((m = /^([b♭#♯+-])(5|9|11|13)/.exec(s))) {
      s = s.slice(m[0].length);
      const sharp = m[1] === '#' || m[1] === '♯' || m[1] === '+';
      const deg = +m[2];
      if (deg === 5) c.fifth = sharp ? 'sharp' : 'flat';
      else {
        c.alts.add({ 9: sharp ? 3 : 1, 11: sharp ? 6 : 4, 13: sharp ? 10 : 8 }[deg]);
        if (!c.seventh && !c.sixth) c.seventh = 'minor'; // "C7b9" style without the 7 ("Cb9") is rare; treat as dominant
      }
      continue;
    }
    if ((m = /^alt/.exec(s))) { s = s.slice(3); c.alts.add(3); c.alts.add(1); if (!c.seventh) c.seventh = 'minor'; continue; }
    if ((m = /^(9|11|13)/.exec(s)) && (c.seventh || c.sixth)) { s = s.slice(m[0].length); c.adds.add({ 9: 2, 11: 5, 13: 9 }[m[1]]); continue; }
    if ((m = /^maj7/.exec(s)) && !c.seventh) { s = s.slice(4); c.seventh = 'major'; continue; }
    if ((m = /^7/.exec(s)) && !c.seventh) { s = s.slice(1); c.seventh = c.dim ? 'dim' : 'minor'; continue; }
    if (/^[*'"]+$/.test(s)) break; // "C*" or "G'" annotations some tabs use
    return null;
  }
  return c;
}

function setExt(c, n, kind) {
  if (n === 7) { c.seventh = kind; return; }
  c.seventh = kind === 'dim' ? 'dim' : kind;
  c.ext = n;
}

// Chord tones in semitones above the root, split into the ones a voicing must
// have and the ones it may leave out.
function tonesOf(c) {
  const third = c.sus === 'sus2' ? 2 : c.sus === 'sus4' ? 5 : c.third === 'minor' ? 3 : 4;
  const fifth = c.fifth === 'flat' ? 6 : c.fifth === 'sharp' ? 8 : 7;
  const req = new Set([0]);
  const opt = new Set();
  if (c.power) { req.add(7); return { req, opt }; }
  if (c.sus === 'sus24') { req.add(2); req.add(5); } else if (!c.no3) req.add(third);
  // The perfect fifth is optional (and often dropped); an altered one isn't.
  if (!c.no5) (c.fifth === 'perfect' ? opt : req).add(fifth);
  if (c.sixth) req.add(9);
  if (c.seventh) req.add(c.seventh === 'major' ? 11 : c.seventh === 'dim' ? 9 : 10);
  if (c.ext >= 9) req.add(2);
  if (c.ext >= 11) {
    if (c.third === 'minor' || c.sus) req.add(5);
    else if (c.ext === 11) { req.delete(4); req.add(5); } // a major 11 clashes with the 3rd, so it's played without it
  }
  if (c.ext === 13) {
    req.add(9);
    // 9 and 11 are usually left out of a 13th on guitar
    if (req.has(2)) { req.delete(2); opt.add(2); }
    if (req.has(5)) { req.delete(5); if (c.third === 'minor' || c.sus) opt.add(5); }
  }
  if (c.ext === 11 && req.has(2)) { req.delete(2); opt.add(2); }
  for (const a of c.adds) req.add(a);
  for (const a of c.alts) req.add(a);
  // b5/#11 and #5/b13 are the same pitch: don't also ask for the plain fifth
  if (req.has(6) || req.has(8)) opt.delete(7);
  for (const r of req) opt.delete(r);
  return { req, opt };
}

// A flat right after the letter is part of the root: "Bb5" is a B-flat power chord,
// "Eb9" an E-flat ninth (alterations come after a number: "E7b9").
const ROOT_RX = /^([A-G](?:#|♯|b|♭)?)(.*)$/;

// Parses a chord symbol: "F#m7b5", "Bbmaj7/D", "Cadd9", "D/F#".
// Returns null for things that aren't chords ("N.C.", "x2", "Verse").
export function parseChord(sym) {
  if (!sym) return null;
  let s = String(sym).trim();
  if (!s || s.length > 16) return null;
  let bass = null;
  // A slash bass at the end: "G/B", "C/G", "Am7/G". ("6/9" has no letter, so it stays.)
  const sl = /^(.+?)\/([A-G](?:#|♯|b|♭)?)$/.exec(s);
  if (sl) { s = sl[1]; bass = sl[2]; }
  const m = ROOT_RX.exec(s);
  if (!m) return null;
  const root = m[1].replace('♯', '#').replace('♭', 'b');
  const suffix = m[2];
  const q = parseSuffix(suffix);
  if (!q) return null;
  const rootPc = pc(root);
  const bassName = bass ? bass.replace('♯', '#').replace('♭', 'b') : null;
  const { req, opt } = tonesOf(q);
  return {
    root, rootPc, suffix, bass: bassName, bassPc: bassName ? pc(bassName) : rootPc,
    quality: q,
    required: [...req].sort((a, b) => a - b),
    optional: [...opt].sort((a, b) => a - b),
  };
}

export const isChord = sym => parseChord(sym) !== null;

// ---------- transposing ----------

// Keys written with flats; every other key gets sharps (F# rather than Gb).
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]); // F Bb Eb Ab Db
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

export function parseKey(key) {
  const m = /^([A-G](?:#|b|♯|♭)?)\s*(m|min|minor|-)?$/.exec(String(key || '').trim().replace(/\s*maj(?:or)?$/i, ''));
  if (!m) return null;
  const p = pc(m[1].replace('♯', '#').replace('♭', 'b'));
  return p < 0 ? null : { pc: p, minor: !!m[2] };
}

const flatsFor = k => !!k && (k.minor ? FLAT_MINOR : FLAT_MAJOR).has(k.pc);

export function keyPrefersFlats(key) {
  return flatsFor(typeof key === 'string' ? parseKey(key) : key);
}

export function keyName(k) {
  if (!k) return '';
  return noteName(k.pc, flatsFor(k)) + (k.minor ? 'm' : '');
}

export function transposeKey(key, semis) {
  const k = parseKey(key);
  if (!k) return key;
  const t = { pc: mod12(k.pc + semis), minor: k.minor };
  return keyName(t);
}

export function transposeNote(name, semis, flats) {
  const p = pc(name);
  if (p < 0) return name;
  return noteName(p + semis, flats);
}

// Transposes the root and bass of a chord symbol and keeps the rest as written.
export function transposeChord(sym, semis, flats = false) {
  if (!semis) return sym;
  const p = parseChord(sym);
  if (!p) return sym;
  return transposeNote(p.root, semis, flats) + p.suffix + (p.bass ? '/' + transposeNote(p.bass, semis, flats) : '');
}

// Respells a chord for a key (Bb instead of A# in F) without moving it.
export function respell(sym, flats) {
  const p = parseChord(sym);
  if (!p) return sym;
  return noteName(p.rootPc, flats) + p.suffix + (p.bass ? '/' + noteName(p.bassPc, flats) : '');
}

// "Simplify chords": reduce to the basic triad a beginner would play.
export function simplifyChord(sym) {
  const p = parseChord(sym);
  if (!p) return sym;
  const q = p.quality;
  let suffix = '';
  if (q.power) suffix = '';
  else if (q.dim || (q.third === 'minor' && q.fifth === 'flat')) suffix = 'dim';
  else if (q.fifth === 'sharp' && q.third === 'major' && !q.seventh) suffix = 'aug';
  else if (q.third === 'minor' && !q.sus) suffix = 'm';
  return p.root + suffix;
}

// ---------- keys ----------

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
// Diatonic triad quality on each degree of a major key.
const DEGREE_MINOR = [false, true, true, false, false, true, true];

// Guesses the key from the chords of a song. Returns a name like "G" or "Em".
export function detectKey(chords) {
  const parsed = chords.map(parseChord).filter(Boolean);
  if (!parsed.length) return null;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    let score = 0;
    parsed.forEach((c, i) => {
      const deg = MAJOR_SCALE.indexOf(mod12(c.rootPc - tonic));
      const minorish = c.quality.third === 'minor' && !c.quality.sus;
      let s = 0;
      if (deg >= 0) s = DEGREE_MINOR[deg] === minorish ? 2 : 0.6;
      else if (mod12(c.rootPc - tonic) === 10 && !minorish) s = 0.8; // bVII, common in rock and folk
      else s = -1;
      if (deg === 0 || deg === 4 || deg === 3) s *= 1.15;
      if (i === 0 || i === parsed.length - 1) s *= 1.5;
      score += s;
    });
    // first/last chord on the tonic is a strong hint
    const first = parsed[0], last = parsed[parsed.length - 1];
    if (first.rootPc === tonic && first.quality.third !== 'minor') score += 3;
    if (last.rootPc === tonic && last.quality.third !== 'minor') score += 3;
    if (!best || score > best.score) best = { tonic, score };
  }
  // relative minor if the song starts and ends on the vi chord
  const rel = mod12(best.tonic + 9);
  const first = parsed[0], last = parsed[parsed.length - 1];
  const minorTonic = c => c.rootPc === rel && c.quality.third === 'minor';
  const k = { pc: best.tonic, minor: false };
  if (minorTonic(first) && (minorTonic(last) || parsed.filter(minorTonic).length >= parsed.length / 4)) {
    k.pc = rel;
    k.minor = true;
  }
  return keyName(k);
}
