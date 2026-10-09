import { test, eq } from '../harness.js';
import { pickUG, pickItunes, coverOf, NO_COVER } from '../../js/covers.js';

test('covers: Ultimate Guitar’s, for this very tab or the same song', () => {
  const song = { title: 'Wagon Wheel', artist: 'Darius Rucker', src: { site: 'ug', url: 'u2' } };
  const r = (url, artist, cover) => ({ url, title: 'Wagon Wheel', artist, cover });
  eq(pickUG(song, [r('u1', 'Darius Rucker', 'c1'), r('u2', 'Darius Rucker', 'c2')]), 'c2', 'this tab first');
  eq(pickUG(song, [r('u9', 'Old Crow Medicine Show', 'x'), r('u1', 'Darius Rucker', 'c1')]), 'c1', 'else the same song by the same artist');
  eq(pickUG(song, [r('u9', 'Old Crow Medicine Show', 'x')]), '', 'never another artist’s');
  eq(pickUG(song, [r('u2', 'Darius Rucker', '')]), '', 'nothing when there is none');
});

test('covers: iTunes, by the same artist and title, never a karaoke album', () => {
  const song = { title: 'Something In The Orange', artist: 'Zach Bryan' };
  const art = n => `https://is1-ssl.mzstatic.com/image/thumb/x/${n}/100x100bb.jpg`;
  const big = n => art(n).replace('100x100bb', '300x300bb');
  const results = [
    { trackName: 'Something in the Orange', artistName: 'Karaoke Kings', collectionName: 'Karaoke Hits', artworkUrl100: art('k') },
    { trackName: 'Something in the Orange (Z&E’s Version)', artistName: 'Zach Bryan', collectionName: 'Something in the Orange', artworkUrl100: art('ze') },
    { trackName: 'Something in the Orange', artistName: 'Zach Bryan', collectionName: 'American Heartbreak', artworkUrl100: art('ah') },
  ];
  eq(pickItunes(song, results), big('ah'), 'the exact title, at 300 px');
  eq(pickItunes(song, results.slice(0, 2)), big('ze'), 'or the title with something added');
  eq(pickItunes({ title: 'Fast Car', artist: 'Tracy Chapman' }, [{ trackName: 'Fast Car', artistName: 'Luke Combs', artworkUrl100: art('lc') }]), '', 'never another artist’s');
  eq(pickItunes(song, [{ trackName: 'Something in the Orange', artistName: 'Zach Bryan', collectionName: 'Something in the Orange (Karaoke Version)', artworkUrl100: art('kv') }]), '', 'not a karaoke version');
  eq(coverOf({ cover: NO_COVER }), '', 'a cover removed by hand shows as none');
  eq(coverOf({ cover: 'x' }), 'x');
});
