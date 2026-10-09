// What the app remembers while it's open, but doesn't save: the song being
// previewed from a search, the last search, scroll positions.

export const session = {
  preview: null, // a song from Ultimate Guitar that isn't in the library yet
  query: '',
  ug: null, // { q, groups, error }
  libraryScroll: 0,
  list: null, // the setlist being played through: { id, index }
};
