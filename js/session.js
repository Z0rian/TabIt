// What the app remembers while it's open, but doesn't save: the song being
// previewed from a search, the last search's results, scroll positions, the
// favorites in shuffled order. (The search itself is in the address: #/?q=…)

export const session = {
  preview: null, // a song from Ultimate Guitar that isn't in the library yet
  ug: null, // { q, groups, error }
  scroll: {}, // where the library was scrolled to, with and without each search
  list: null, // the setlist being played through: { id, index }
  shuffle: null, // song ids
};
