'use strict';

// Packs the host keeps as a list of files where they live, rather than as a folder under the
// samples root: the desktop's `files` pack is the audio dropped on the code, each one played from
// the place it was dropped from - nothing is copied into the library to make it a pack.
//
// The host registers a name with a function that answers the pack's entries (absolute paths, in
// index order). Read per lookup, so a file added a moment ago is in the next load. An entry that
// is missing or not audio is skipped, the way a named pack skips one (see expandPackEntries).
//
// A folder of the same name in the sample library comes first (listPackFiles asks the library
// before this), the same rule the built-in packs follow.

const lists = new Map(); // name -> () => entries

/** Registers (or, with no function, removes) a pack that is a list of files. */
function setListedPack(name, entries) {
  const key = String(name);
  if (typeof entries === 'function') lists.set(key, entries);
  else lists.delete(key);
}

/** The names of the packs registered as lists. */
function listedPackNames() {
  return [...lists.keys()];
}

/** A listed pack's raw entries, or null when no pack of that name is a list. */
function listedPackEntries(name) {
  const read = lists.get(String(name));
  if (!read) return null;
  try {
    const entries = read();
    return Array.isArray(entries) ? entries.map(String) : [];
  } catch {
    return [];
  }
}

module.exports = { setListedPack, listedPackNames, listedPackEntries };
