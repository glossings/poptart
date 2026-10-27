'use strict';

// The music library's collection and sets, as data: the track records, the playlists that
// play them, and every change the browser makes to either - shared by both builds. The desktop
// (pattern-files.js) keeps the document in ~/.poptart/patterns/library.json and the browser build
// (public/web/storage.mjs) under the same name in its store; this file is everything about it that
// is not where it lives, so an edit, an import or a measurement means the same thing in both.
//
// Loaded in the browser as a module of its own (never as a plain script: its names would join the
// editor's) and require()d by the desktop and the tests. Pure: nothing here reads a disk.
//
// The document: { version: 2, tracks, playlists: [{ id, name, folder?, items }], active, saves }.
// A track record is one file - { id, path, title, artist?, album?, bpm?, key?, rating?,
// anchorSec?, byHand?, detected?, analyzed?, added } - and a playlist item is a saved pattern's
// name or { kind: 'track', id } on disk, HYDRATED for the editor into the { kind: 'file', path,
// title, bpm?, key?, trackId } shape the decks and pickers speak (see hydrateLibrary).

const newLibraryId = () => Math.random().toString(36).slice(2, 10);

// Field rules match their consumers: bpm the /api/song/load sanity range, text non-empty and
// bounded so a corrupt tag can't put something enormous in a list row.
const MAX_TRACK_TEXT = 300;

// The fields a file's own tags can speak for, and so the only ones a rescan may rewrite or a
// hand edit may claim. `rating` is deliberately not among them.
const TRACK_TAG_FIELDS = ['title', 'artist', 'album', 'bpm', 'key'];

function cleanTrackText(s) {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/\0/g, '').trim();
  return clean ? clean.slice(0, MAX_TRACK_TEXT) : null;
}

function cleanTrackBpm(n) {
  const bpm = Number(n);
  return Number.isFinite(bpm) && bpm >= 20 && bpm <= 400 ? bpm : null;
}

/** The title a track falls back to when neither its tags nor the user gave it one. */
function titleFromPath(p) {
  return String(p).split(/[/\\]/).pop().replace(/\.[^.]+$/, '') || String(p);
}

// One track record coerced to the shape above, or null for junk. `added` keeps whatever it had
// (the collection's "date added" column is only useful if it survives a rewrite).
function normalizeTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const p = typeof t.path === 'string' ? t.path.trim() : '';
  if (!p) return null;
  const track = {
    id: String(t.id ?? newLibraryId()),
    path: p,
    title: cleanTrackText(t.title) ?? titleFromPath(p),
  };
  for (const field of ['artist', 'album', 'key']) {
    const value = cleanTrackText(t[field]);
    if (value) track[field] = value;
  }
  const bpm = cleanTrackBpm(t.bpm);
  if (bpm != null) track.bpm = bpm;
  // Stars, 1 to 5. No tag is read into this and no rescan touches it - a rating is the one fact
  // here that is nobody's but the listener's, so absent means unrated rather than zero.
  const rating = Math.round(Number(t.rating));
  if (Number.isFinite(rating) && rating >= 1 && rating <= 5) track.rating = rating;
  // Where the beatgrid's downbeat sits, in seconds. Only the deck's anchor button ever writes
  // this (see setTrackAnchor), so its presence MEANS "placed by hand" - the analyzer's own
  // guess is cheap to recompute and is never stored. No tag holds it and no rescan touches it.
  const anchorSec = Number(t.anchorSec);
  if (Number.isFinite(anchorSec) && anchorSec >= 0) track.anchorSec = anchorSec;
  // Which fields were typed by hand, and so outlive a rescan that would otherwise take the
  // file's word for them (the same rule the song decks' bpmByHand/anchorByHand follow).
  const byHand = (Array.isArray(t.byHand) ? t.byHand : []).filter((f) => TRACK_TAG_FIELDS.includes(f));
  if (byHand.length) track.byHand = [...new Set(byHand)].sort();
  // Which fields the AUDIO was measured for rather than tagged with, so a row can mark them as
  // estimates; and when it was measured, so a pass over the collection can skip what it has done.
  const detected = (Array.isArray(t.detected) ? t.detected : []).filter((f) => TRACK_TAG_FIELDS.includes(f));
  if (detected.length) track.detected = [...new Set(detected)].sort();
  const analyzed = Number(t.analyzed);
  if (Number.isFinite(analyzed) && analyzed > 0) track.analyzed = analyzed;
  const added = Number(t.added);
  track.added = Number.isFinite(added) && added > 0 ? added : Date.now();
  return track;
}

/**
 * The collection, deduplicated by path: one record per file, the first mention winning so an
 * older hand-corrected record is never replaced by a later bare one. Returns { tracks, byPath,
 * byId } - the two indexes the item collapse below needs anyway.
 */
function indexTracks(list) {
  const tracks = [];
  const byPath = new Map();
  const byId = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const track = normalizeTrack(raw);
    if (!track) continue;
    const seen = byPath.get(track.path);
    if (seen) {
      // A duplicate path is two records for one file (a hand-edited library, or an import that
      // raced a write). Keep the first and let the second's id resolve to it, so any playlist
      // item still pointing at the loser keeps working.
      byId.set(track.id, seen);
      continue;
    }
    if (byId.has(track.id)) track.id = newLibraryId(); // a repeated id would alias two files
    tracks.push(track);
    byPath.set(track.path, track);
    byId.set(track.id, track);
  }
  return { tracks, byPath, byId };
}

/**
 * An item coerced to its stored shape, importing a file that has no track yet. Returns null for
 * junk, so a damaged entry drops out of its playlist instead of taking the library down.
 *
 * The hydrated shape the UI posts back ({ kind: 'file', path, ... }) collapses to a reference:
 * whatever title or tempo rode along with the item is the TRACK's to hold, and the record
 * already has it. The one exception is a path with no record at all - a file being used for the
 * first time - which is imported here, from what the item says plus the file name.
 */
function collapseLibraryItem(it, index) {
  // A named save is kept exactly as written, even if no such file exists (or could): the row is
  // the user's note that this set plays that song, and a save can come back.
  if (typeof it === 'string') return it.trim() ? it : null;
  if (!it || typeof it !== 'object') return null;
  if (it.kind === 'track') {
    const track = index.byId.get(String(it.id));
    return track ? { kind: 'track', id: track.id } : null;
  }
  if (it.kind !== 'file') return null;
  const p = typeof it.path === 'string' ? it.path.trim() : '';
  if (!p) return null;
  const known = index.byPath.get(p) ?? (it.trackId ? index.byId.get(String(it.trackId)) : null);
  if (known) return { kind: 'track', id: known.id };
  const track = normalizeTrack({ ...it, id: newLibraryId(), path: p });
  index.tracks.push(track);
  index.byPath.set(track.path, track);
  index.byId.set(track.id, track);
  return { kind: 'track', id: track.id };
}

// A playlist's folder, for the browser's sidebar tree: "club/2026" or absent for a top-level set.
// Stored as a path string rather than as nesting, so the document stays flat and an old library
// (or a hand-edited one) normalizes without a structural migration.
function cleanPlaylistFolder(s) {
  const clean = cleanTrackText(s);
  if (!clean) return null;
  const parts = clean.split('/').map((x) => x.trim()).filter(Boolean).slice(0, 8);
  return parts.length ? parts.join('/') : null;
}

// Whatever is on disk (or handed to writeLibrary) is coerced to the shape above - a hand-edited
// or truncated file degrades to an empty library rather than taking the UI down with it.
function normalizeLibrary(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const index = indexTracks(src.tracks);
  const playlists = (Array.isArray(src.playlists) ? src.playlists : [])
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => {
      const list = {
        id: String(p.id ?? newLibraryId()),
        name: p.name,
        items: Array.isArray(p.items)
          ? p.items.map((it) => collapseLibraryItem(it, index)).filter((k) => k != null)
          : [],
      };
      const folder = cleanPlaylistFolder(p.folder);
      if (folder) list.folder = folder;
      return list;
    });
  const active = playlists.some((p) => p.id === src.active) ? src.active : null;
  // Per-SAVE facts, keyed by the save's own name ("techno/stomper"). A livecode save says almost
  // everything about itself in its own source - @title, @tags, its setbpm - and that is the rule
  // this is the one exception to: a rating is not something to write into somebody's code, and a
  // star you cannot put on a save is a star missing from half the browser. Only ratings live here
  // today; anything a FILE can say for itself still belongs in the file.
  const saves = {};
  const rawSaves = src.saves && typeof src.saves === 'object' ? src.saves : {};
  for (const [name, held] of Object.entries(rawSaves)) {
    const rating = Math.round(Number(held?.rating));
    // An entry that says nothing is not kept, so clearing a rating empties the map rather than
    // leaving a litter of {} behind.
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) saves[String(name)] = { rating };
  }
  // A collection nobody references is still the collection: imported tracks are kept whether or
  // not a set happens to name them, which is the whole point of importing rather than queueing.
  return { version: 2, tracks: index.tracks, playlists, active, saves };
}

/**
 * The document as everything downstream wants to read it: each track reference replaced by the
 * track's own facts, in the { kind: 'file', path, title, bpm?, key?, ... } shape the decks and
 * the pickers already speak, with `trackId` kept so an edit can find the record again.
 *
 * Every caller normalizes first, which has already dropped any reference whose record is gone
 * (there is nothing left to say about one - see the tests); the stand-in row below is this
 * function keeping its own promise to return one item per item, whatever it is handed.
 */
function hydrateLibrary(doc) {
  const byId = new Map(doc.tracks.map((t) => [t.id, t]));
  return {
    ...doc,
    playlists: doc.playlists.map((p) => ({
      ...p,
      items: p.items.map((it) => {
        if (typeof it === 'string') return it;
        const track = byId.get(it.id);
        if (!track) return { kind: 'file', path: '', title: 'missing track', trackId: it.id };
        const { id, ...facts } = track; // the record's id rides as trackId, not as the item's own
        return { ...facts, kind: 'file', trackId: id };
      }),
    })),
  };
}


function editOneTrack(track, fields) {
  const byHand = new Set(track.byHand ?? []);
  for (const [field, value] of Object.entries(fields)) {
    if (field === 'rating') {
      const rating = Math.round(Number(value));
      if (Number.isFinite(rating) && rating >= 1 && rating <= 5) track.rating = rating;
      else delete track.rating; // 0, blank or junk is unrated
      continue;
    }
    if (!TRACK_TAG_FIELDS.includes(field)) continue;
    byHand.add(field); // typed by hand, whatever it was set to
    if (field === 'bpm') {
      const bpm = cleanTrackBpm(value);
      if (bpm != null) track.bpm = bpm;
      else if (value === null || value === '') delete track.bpm;
      else byHand.delete('bpm'); // refused, so nothing was typed after all
      continue;
    }
    const text = cleanTrackText(value);
    if (text) track[field] = text;
    else if (field === 'title') track.title = titleFromPath(track.path);
    else delete track[field];
  }
  track.byHand = [...byHand].sort();
  if (!track.byHand.length) delete track.byHand;
  // Whatever was typed is no longer an estimate; the fields nobody touched keep their marks.
  if (track.detected) {
    const left = track.detected.filter((f) => !byHand.has(f));
    if (left.length) track.detected = left;
    else delete track.detected;
  }
}


/** Nothing left for a fill-only re-import to take from the tags, so they need not be read. */
function trackHasNoGaps(t) {
  return ['title', 'artist', 'album', 'bpm', 'key'].every((f) => t[f] != null && t[f] !== '');
}


// Tags fill only what the record is missing - see importTracks on why hand-entered facts win.
function fillTrackGaps(track, tags) {
  for (const field of ['artist', 'album', 'key']) {
    if (track[field] == null) {
      const value = cleanTrackText(tags[field]);
      if (value) track[field] = value;
    }
  }
  if (track.bpm == null) {
    const bpm = cleanTrackBpm(tags.bpm);
    if (bpm != null) track.bpm = bpm;
  }
  // A title standing in for an untagged file (its own file name) gives way to a real one.
  const title = cleanTrackText(tags.title);
  if (title && track.title === titleFromPath(track.path)) track.title = title;
}

/**
 * A rescan: the file's tags are taken as the better word for everything EXCEPT what was typed by
 * hand (`byHand`) and the rating, which no tag speaks for. This is what picks up a file that has
 * been retagged since it was imported - gap-filling cannot, because the field it would correct
 * already holds the old value.
 *
 * It never EMPTIES a field. A tag that is absent reads the same as a tag that was deleted (both
 * arrive null), so clearing on absence would quietly throw away good metadata every time a file
 * happened to be tagged more thinly than the record. A rescan adds and corrects; it does not
 * prune, and an edit by hand is how a field goes away.
 */
function rescanTrack(track, tags) {
  const held = new Set(track.byHand ?? []);
  for (const field of ['artist', 'album', 'key']) {
    if (held.has(field)) continue;
    const value = cleanTrackText(tags[field]);
    if (value) track[field] = value;
  }
  if (!held.has('bpm')) {
    const bpm = cleanTrackBpm(tags.bpm);
    if (bpm != null) track.bpm = bpm;
  }
  if (!held.has('title')) {
    const title = cleanTrackText(tags.title);
    if (title) track.title = title;
  }
}


/**
 * Track records changed in place, by id: a tag field given here is marked `byHand`, which is what
 * makes it outlive a later rescan or analysis. Returns the records that were hit.
 */
function editTracks(doc, ids, fields = {}) {
  const want = (Array.isArray(ids) ? ids : [ids]).map(String);
  const hit = doc.tracks.filter((t) => want.includes(t.id));
  for (const track of hit) editOneTrack(track, fields);
  return hit;
}

/**
 * What analysis measured, written onto the record for a path. A tempo or key the FILE already
 * stated is trusted over anything measured, so this only fills what is missing - and never
 * touches a field typed by hand. `detected` lists the fields that came from the audio rather than
 * from a tag, so a row can show them as estimates. Null when no record has that path.
 */
function applyTrackFacts(doc, trackPath, facts = {}, now = Date.now) {
  const track = doc.tracks.find((t) => t.path === trackPath);
  if (!track) return null;
  const held = new Set(track.byHand ?? []);
  const detected = new Set(track.detected ?? []);
  let changed = false;
  const bpm = cleanTrackBpm(facts.bpm);
  if (bpm != null && track.bpm == null && !held.has('bpm')) {
    track.bpm = bpm;
    detected.add('bpm');
    changed = true;
  }
  const key = cleanTrackText(facts.key);
  if (key && track.key == null && !held.has('key')) {
    track.key = key;
    detected.add('key');
    changed = true;
  }
  // Analyzed either way, so an analysis that found nothing is not retried forever.
  track.analyzed = Number(facts.at) > 0 ? Number(facts.at) : now();
  if (detected.size) track.detected = [...detected].sort();
  return { changed };
}

/**
 * The beatgrid anchor the hand placed on a deck, kept on the track's record so the next load
 * stands on the same grid; null clears it. Like a rating, nobody's fact but the listener's.
 * Returns whether the record changed (null for no record).
 */
function applyTrackAnchor(doc, trackPath, sec) {
  const track = doc.tracks.find((t) => t.path === trackPath);
  if (!track) return null;
  if (sec == null) {
    if (!('anchorSec' in track)) return false;
    delete track.anchorSec;
    return true;
  }
  const a = Number(sec);
  if (!Number.isFinite(a) || a < 0) return null;
  track.anchorSec = a;
  return true;
}

/**
 * A tempo cleared on a deck: the record has none, and none typed by hand - so the measuring is
 * welcome to fill it in again, as the deck's own detection is. Null for no record.
 */
function clearTrackTempo(doc, trackPath) {
  const track = doc.tracks.find((t) => t.path === trackPath);
  if (!track) return null;
  delete track.bpm;
  track.byHand = (track.byHand ?? []).filter((f) => f !== 'bpm');
  if (!track.byHand.length) delete track.byHand;
  track.detected = (track.detected ?? []).filter((f) => f !== 'bpm');
  if (!track.detected.length) delete track.detected;
  delete track.analyzed;
  return true;
}

/** Records out of the collection, and out of every set that referenced them. Returns how many. */
function forgetFrom(doc, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const gone = doc.tracks.filter((t) => want.has(t.id));
  doc.tracks = doc.tracks.filter((t) => !want.has(t.id));
  for (const p of doc.playlists) {
    p.items = p.items.filter((it) => typeof it === 'string' || !want.has(String(it.id)));
  }
  return gone.length;
}

/**
 * Import: paths into the collection, each with what its tags say. Returns { added, already }.
 *
 * Importing the same file twice is a no-op on purpose - every gesture that uses a track also
 * imports it, so this runs far more often than it does anything. A path already in the collection
 * only has its GAPS filled from the tags: a tempo or title corrected by hand is the better fact,
 * and re-importing must never undo it. `mode: 'rescan'` is the deliberate exception, asked for by
 * hand: the file's tags become the better word for everything the user did not type (see
 * rescanTrack).
 *
 * `tagsOf(path, seen)` answers a path's tags, or {} - `seen` is its record when it has one, so a
 * caller can skip reading a file whose record has nothing left to fill (see trackHasNoGaps).
 * `canon(path)` is the spelling two paths are compared by (the desktop resolves symlinks and
 * composes accents); `now()` stamps the records added.
 */
function importInto(doc, paths, { tagsOf = () => ({}), canon = (p) => p, now = Date.now, mode = 'fill' } = {}) {
  const index = indexTracks(doc.tracks);
  const added = [];
  const already = [];
  const byCanon = new Map(index.tracks.map((t) => [canon(t.path), t]));
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) continue;
    const c = canon(p);
    const seen = index.byPath.get(p) ?? byCanon.get(c);
    const tags = (seen && mode !== 'rescan' && trackHasNoGaps(seen) ? {} : tagsOf(p, seen)) ?? {};
    if (seen) {
      already.push(seen);
      if (mode === 'rescan') rescanTrack(seen, tags);
      else fillTrackGaps(seen, tags);
      continue;
    }
    const track = normalizeTrack({
      id: newLibraryId(),
      path: p,
      title: cleanTrackText(tags.title) ?? titleFromPath(p),
      artist: tags.artist,
      album: tags.album,
      bpm: tags.bpm,
      key: tags.key,
      added: now(),
    });
    index.tracks.push(track);
    index.byPath.set(track.path, track);
    index.byId.set(track.id, track);
    byCanon.set(c, track);
    added.push(track);
  }
  doc.tracks = index.tracks;
  return { added, already };
}

/** The paths in a collection still worth measuring: no tempo or no key, and not already tried. */
function tracksToMeasure(tracks, { force = false } = {}) {
  return tracks.filter((t) => (force ? true : (t.bpm == null || t.key == null) && !t.analyzed));
}

const poptartLibraryTracks = {
  TRACK_TAG_FIELDS, cleanTrackText, cleanTrackBpm, titleFromPath, normalizeTrack, indexTracks,
  normalizeLibrary, hydrateLibrary, editTracks, applyTrackFacts, applyTrackAnchor, clearTrackTempo, forgetFrom,
  importInto, tracksToMeasure, fillTrackGaps, rescanTrack, trackHasNoGaps,
};

if (typeof module !== 'undefined' && module.exports) module.exports = poptartLibraryTracks;
else globalThis.poptartLibraryTracks = poptartLibraryTracks;
