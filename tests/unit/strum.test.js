import { test, eq, ok, deepEq } from '../harness.js';
import { readStrumming, strokeOf, bars, slotsPerBeat } from '../../js/strum.js';

test('strumming: reads Ultimate Guitar\'s own form and the worker\'s', () => {
  const ug = [{ part: 'Chorus ', denuminator: 8, bpm: 79, is_triplet: 0, measures: [{ measure: 3 }, { measure: 202 }, { measure: 1 }, { measure: 101 }] }];
  const worker = [{ part: 'Chorus', denominator: 8, bpm: 79, triplet: false, measures: [3, 202, 1, 101] }];
  const a = readStrumming(ug);
  deepEq(a, [{ part: 'Chorus', bpm: 79, den: 8, trip: undefined, m: [3, 202, 1, 101] }]);
  deepEq(readStrumming(worker), a, 'both give the same pattern');
  eq(readStrumming([{ denominator: 16, bpm: 0, measures: [1, 101], triplet: true }])[0].bpm, undefined, 'no tempo rather than 0');
  eq(readStrumming([{ measures: [202, 202] }]), undefined, 'a pattern with no strokes is dropped');
  eq(readStrumming(null), undefined);
});

test('strumming: stroke codes', () => {
  deepEq(strokeOf(1), { dir: 'down', mark: '' });
  deepEq(strokeOf(101), { dir: 'up', mark: '' });
  deepEq(strokeOf(2), { dir: 'down', mark: 'mute' });
  deepEq(strokeOf(103), { dir: 'up', mark: 'accent' });
  deepEq(strokeOf(201), { dir: 'hit', mark: '' });
  deepEq(strokeOf(202), { dir: 'rest', mark: '' });
  deepEq(strokeOf(203), { dir: 'rest', mark: '' });
});

test('strumming: beats, bars and what to count', () => {
  const eighths = { den: 8, m: [1, 202, 1, 101, 202, 101, 1, 101] };
  eq(slotsPerBeat(eighths), 2);
  const b = bars(eighths);
  eq(b.length, 1, 'one bar of four beats');
  deepEq(b[0].flat().map(s => s.count), ['1', '&', '2', '&', '3', '&', '4', '&']);
  const waltz = bars({ den: 8, m: [3, 202, 202, 101, 1, 101] });
  deepEq(waltz[0].flat().map(s => s.count), ['1', '&', '2', '&', '3', '&'], 'three beats: a bar of three');
  const trip = bars({ den: 8, trip: true, m: [3, 1, 1, 3, 1, 1] });
  deepEq(trip[0].flat().map(s => s.count), ['1', '&', 'a', '2', '&', 'a']);
  const sixteenths = bars({ den: 16, m: Array(32).fill(1) });
  eq(sixteenths.length, 2, 'two bars of sixteenths');
  deepEq(sixteenths[1][0].map(s => s.count), ['1', 'e', '&', 'a']);
  eq(sixteenths[1][0][0].i, 16, 'slots keep their place in the pattern');
});
