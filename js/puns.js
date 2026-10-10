// What the loading screen says while TabIt starts: a different one each time.

export const PUNS = [
  'Tuning up…',
  'Finding the right chord…',
  'Warming up the fretboard…',
  'Changing strings. Don’t fret.',
  'Putting on the capo…',
  'Getting in the right key…',
  'Strumming up your songs…',
  'Counting it in: one, two, three, four…',
  'Sliding into the verse…',
  'Polishing the frets…',
  'Hammering on, pulling off…',
  'Tightening the tuning pegs…',
  'Still practicing that F barre chord…',
  'Turning it up to eleven…',
  'Fishing a pick out of the soundhole…',
  'Waiting for the drummer…',
  'Asking the bassist where the song went…',
  'Treble-shooting…',
  'Barring no expense…',
  'Minor setback, major comeback…',
  'Picking up where you left off…',
  'Re-tuning after one song, as usual…',
  'No strings attached. Well, six.',
  'Untangling the guitar cable…',
  'Doing a quick sound check…',
  'Taking it from the top…',
  'Fret not, almost there…',
  'Getting the strum of it…',
  'Finding the groove…',
  'Bridging to the chorus…',
  'Picking the perfect pick…',
  'Politely declining another Wonderwall…',
  'Chord-inating your library…',
  'Bending a few notes…',
  'Tuning by ear. Your ear, hopefully.',
  'In the key of C you in a sec…',
  'Lowering the action…',
  'Hold on, a string just snapped…',
];

const LAST = 'tabit.lastPun';

// A pun, never the same as the last one shown.
export function pun() {
  let last = -1;
  try { last = +(localStorage.getItem(LAST) ?? -1); } catch { /* no storage */ }
  let i = Math.floor(Math.random() * PUNS.length);
  if (i === last) i = (i + 1) % PUNS.length;
  try { localStorage.setItem(LAST, String(i)); } catch { /* no storage */ }
  return PUNS[i];
}
