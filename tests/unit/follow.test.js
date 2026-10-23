// Following a YouTube video: where the moment the video is at is on the page.
// A tall tab gets its share of the time by its length, not its height; a
// sync point (this second of the video is this line) bends the way through it.
import { test, eq, ok, near, deepEq } from '../harness.js';
import { weigh, yOfS, sOfY, placeAt, followCurve, sAtTime } from '../../js/autoscroll.js';

// a song on a phone: a riff in tab at the top, wrapped into 300 px (one line
// of music's worth, weight 2), then ten lines of words, 50 px each
const PARTS = [
  { i: 1, top: 100, h: 300, w: 2, tab: true },
  ...Array.from({ length: 10 }, (_, k) => ({ i: 2 + k, top: 400 + k * 50, h: 50, w: 1, tab: false })),
];
const map = weigh(PARTS);
const at = (t, d = 120, points = []) => yOfS(map, sAtTime(followCurve(map, d, points), t));

test('a tab gets its time by its length, the lines of words by their height', () => {
  eq(map.parts[0].e, 100, 'the riff: two lines’ worth (50 px a line), not its 300 px');
  eq(map.E, 600);
  eq(map.parts[1].s, 100, 'the words start after it');
  near(yOfS(map, 50), 250, 0.01, 'halfway through the riff’s time is halfway down it');
  eq(yOfS(map, 100), 400);
  eq(yOfS(map, 600), 900, 'the end of the last line');
  near(sOfY(map, 250), 50, 0.01, 'and back');
  eq(sOfY(map, 50), 0, 'above the song: its start');
  // one-sixth of the way into the video: past the riff, at the first line of words
  near(at(20), 400, 0.5, 'a sixth of the video in: the first line, not still in the tab (where it’d be by height alone)');
});

test('a sync point: the video goes through it, in a straight line from one to the next', () => {
  // the band plays a 30-second intro before the first line of words
  const pts = [{ t: 30, b: 2, f: 0 }];
  near(at(30, 120, pts), 400, 0.5, 'at 30 s: the first line of words');
  near(at(15, 120, pts), 250, 0.5, 'halfway through the intro: halfway down the riff');
  near(at(75, 120, pts), 650, 0.5, 'from there on, steadily to the end');
  near(at(120, 120, pts), 900, 0.5);
  // a second one later on
  const two = [...pts, { t: 90, b: 11, f: 0 }];
  near(at(90, 120, two), 850, 0.5, 'the last line at 90 s');
  near(at(60, 120, two), 625, 0.5, 'and between them, steady');
});

test('sync points out of order, or outside the video, are left out', () => {
  const c = followCurve(map, 120, [{ t: 60, b: 8, f: 0 }, { t: 70, b: 3, f: 0 }, { t: -5, b: 4, f: 0 }, { t: 500, b: 5, f: 0 }]);
  deepEq(c.map(p => p.t), [0, 60, 120], 'only the one that’s further on in both');
  ok(c.every((p, k) => !k || (p.t > c[k - 1].t && p.s >= c[k - 1].s)));
});

test('a place in the song doesn’t depend on the screen: a block and how far into it', () => {
  deepEq(placeAt(map, 425), { b: 2, f: 0.5 });
  deepEq(placeAt(map, 250), { b: 1, f: 0.5 }, 'halfway down the riff');
  // the same place on a wider screen, where the riff takes 120 px
  const wide = weigh([{ i: 1, top: 80, h: 120, w: 2, tab: true }, ...Array.from({ length: 10 }, (_, k) => ({ i: 2 + k, top: 200 + k * 40, h: 40, w: 1, tab: false }))]);
  near(yOfS(wide, sAtTime(followCurve(wide, 120, [{ t: 30, b: 2, f: 0 }]), 30)), 200, 0.5, 'lined up on the phone, right on the laptop too');
});

test('a song that’s all tab: each staff by its length', () => {
  const tabs = weigh([{ i: 0, top: 0, h: 200, w: 4, tab: true }, { i: 1, top: 200, h: 200, w: 1, tab: true }]);
  near(tabs.parts[0].e / tabs.parts[1].e, 4, 0.001, 'four times as long, four times the time');
});
