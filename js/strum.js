// Strumming patterns, as Ultimate Guitar stores them: a list of slots, each a
// stroke code, with a note value ("denominator": 8 = eighth notes), a triplet
// flag and a tempo. The codes, as UG's own pattern display draws them:
//
//    1 ↓   101 ↑            plain stroke
//    2 ↓×  102 ↑×           muted stroke (little × over the arrow)
//    3 ↓>  103 ↑>           accent
//    201 ×                  palm-muted hit, no direction (big ×)
//    202, 203               nothing played (the hand keeps moving)

// { part, bpm, den, trip, m: [codes] } from the worker's tidy form
// ({ denominator, triplet, measures: [1, 101…] }) or UG's own
// ({ denuminator, is_triplet, measures: [{ measure: 1 }…] }).
export function readStrumming(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const s of list) {
    if (!s || !Array.isArray(s.measures)) continue;
    const m = s.measures.map(x => +(typeof x === 'object' ? x?.measure : x)).filter(Number.isFinite);
    if (!m.length || !m.some(c => c === 1 || c === 2 || c === 3 || (c > 100 && c < 104))) continue;
    const den = +(s.denominator ?? s.denuminator) || 8;
    const bpm = +s.bpm;
    out.push({
      part: String(s.part || '').trim(),
      bpm: bpm >= 30 && bpm <= 320 ? Math.round(bpm) : undefined,
      den: [4, 8, 16, 32].includes(den) ? den : 8,
      trip: !!(s.triplet ?? s.is_triplet) || undefined,
      m,
    });
  }
  return out.length ? out : undefined;
}

// { dir: 'down' | 'up' | 'hit' | 'rest', mark: '' | 'mute' | 'accent' }
export function strokeOf(code) {
  const kind = Math.floor(code / 100);
  const mod = code % 100;
  if (kind === 2) return { dir: code === 201 ? 'hit' : 'rest', mark: '' };
  return { dir: kind === 1 ? 'up' : 'down', mark: mod === 2 ? 'mute' : mod === 3 ? 'accent' : '' };
}

export const slotsPerBeat = p => Math.max(1, Math.round((p.den / 4) * (p.trip ? 1.5 : 1)));

// The pattern cut into bars of beats of slots, each slot with what to count
// out loud under it ("1 & 2 &", "1 e & a", triplets "1 & a").
export function bars(p) {
  const per = slotsPerBeat(p);
  const beats = Math.ceil(p.m.length / per);
  const perBar = beats % 4 === 0 ? 4 : beats % 3 === 0 ? 3 : beats;
  const sub = per === 2 ? ['&'] : per === 3 ? ['&', 'a'] : per === 4 ? ['e', '&', 'a'] : per === 6 ? ['', '&', '', 'a', ''] : [];
  const out = [];
  for (let b = 0; b < beats; b++) {
    if (b % perBar === 0) out.push([]);
    const slots = [];
    for (let k = 0; k < per; k++) {
      const i = b * per + k;
      if (i >= p.m.length) break;
      slots.push({ i, code: p.m[i], ...strokeOf(p.m[i]), count: k === 0 ? String((b % perBar) + 1) : sub[k - 1] || '' });
    }
    out.at(-1).push(slots);
  }
  return out;
}
