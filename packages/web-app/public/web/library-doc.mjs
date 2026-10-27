// The library document in the browser build: the desktop's own rules for it (library-tracks.js -
// the collection's records, the sets, an import, an edit, a measurement), loaded as they are, so
// a document carried between the two builds reads the same in both.
//
// library-tracks.js is the desktop's file: require()d there, and a module of its own here, where
// it leaves its functions on globalThis (a CommonJS default when a test imports it).

const loaded = await import('../library-tracks.js');

/** The shared library rules (see library-tracks.js). */
export const libraryTracks = loaded.default ?? globalThis.poptartLibraryTracks;

export const { normalizeLibrary, hydrateLibrary } = libraryTracks;
