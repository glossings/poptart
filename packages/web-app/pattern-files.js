'use strict';

// Pattern files - where the editor's "files" tab keeps whole editor buffers, as plain .js files
// under ~/.poptart/patterns (overridable via POPTART_PATTERNS_DIR), so they're ordinary files
// the user can also back up / edit / version outside poptart.
//
// Two kinds live there:
//
//   patterns/<name>.js                 named saves - what the user deliberately kept
//   patterns/wip/2026-08/<id>.js       work in progress - one file per editing session,
//                                      rewritten as the user types
//
// The WIP half means nothing is ever only-in-the-browser: close the tab mid-jam, or lose the
// buffer to a crash, and the session is still on disk, filed under the month it was played in.
// Both kinds carry `@title`/`@by`/`@tags` metadata in their own comments (see pattern-meta.js),
// which is what the files tab lists and searches on.
//
// Path building lives here and nowhere else - a request names a pattern or a session, never a
// path - and it's all plain filesystem work, so pattern-files.test.js drives it against a temp
// directory without a server.

const fs = require('node:fs');
const path = require('node:path');
const { poptartHome } = require('@poptart/osc-engine/home');

const { parseMeta, displayLabel, patternPathProblem } = require('./public/pattern-meta.js');

const PATTERNS_DIR = process.env.POPTART_PATTERNS_DIR || path.join(poptartHome(), 'patterns');
const WIP_DIR = path.join(PATTERNS_DIR, 'wip');

// How much of a file the index reads. Everything it wants - the @ header, the setbpm, a label to
// borrow - sits near the top, and a save with its plugin state inline is routinely megabytes, so
// the HEAD is read rather than the file skipped: skipped, every such song listed as a bare file
// name with no title or tempo, and the browser's tempo filter could not see it.
const MAX_INDEXED_BYTES = 512 * 1024;

// A name is used as its path under patterns/ directly, so it may name folders ("techno/stomper")
// but every segment has to be an ordinary file name. The rule itself lives in pattern-meta.js,
// which the editor also loads - so the naming dialog can refuse a name for the same reason,
// before it gets this far - and it is what keeps ".." and dotfiles from climbing out of the
// patterns directory.
function patternFilePath(name) {
  const problem = patternPathProblem(name);
  if (problem) throw new Error(`pattern name: ${problem}`);
  const rel = patternRelName(name);
  const file = path.join(PATTERNS_DIR, `${rel}.js`);
  // Belt to the rule's braces: whatever the segments were, the result has to land inside the
  // patterns directory. A path that escapes is a bug in the rule, not something to write to.
  const root = path.resolve(PATTERNS_DIR);
  if (path.resolve(file) !== path.join(root, `${rel}.js`)) throw new Error('pattern name: bad path');
  return file;
}

/** A name as it is stored and listed: trimmed segments joined by "/", the one spelling. */
function patternRelName(name) {
  return String(name ?? '').trim().split('/').map((p) => p.trim()).join('/');
}

/** The folders a saved pattern's name implies, created so a nested save can be written. */
function ensurePatternDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// A WIP id is "<month>/<session>" - "2026-08/2026-08-02-143205" - which is also its path under
// patterns/wip. The editor mints one per editing session, from local time. Validated strictly,
// and cross-checked so the month folder is the one the date actually belongs to: this is the
// only place a request gets to name a subdirectory.
const WIP_ID_RE = /^(\d{4}-\d{2})\/(\d{4}-\d{2})-\d{2}-\d{6}$/;

function wipFilePath(id) {
  const m = WIP_ID_RE.exec(String(id ?? '').trim());
  if (!m || m[1] !== m[2]) throw new Error('bad work-in-progress id (expected "YYYY-MM/YYYY-MM-DD-HHMMSS")');
  return path.join(WIP_DIR, `${m[0]}.js`);
}

// A song's native tempo, read straight from its source: the LAST plain-number setbpm() in the
// buffer is the one an eval leaves in force. Quoted numbers count (setbpm("140") is the same
// call); a signal tempo ("<120 140>", an lfo) has no single native bpm and reads as null.
// Derived at list time rather than stored anywhere, so it can never go stale against the file.
//
// A buffer that never calls setbpm at all is a different case from one that calls it with a
// signal, and the two read differently: saying nothing is saying 120, because that is the tempo
// the transport opens at and what the save would actually play at. The desk has always read it
// that way (server.js, deckNativeBpm) - so the listing says 120 too rather than leaving the
// explorer's tempo column blank for most of a livecode folder.
const DEFAULT_BPM = 120; // the transport's own opening tempo (server.js, DEFAULT_CPS)
const SETBPM_CALL_RE = /(?<![\w$.])setbpm\s*\(/;
const SETBPM_NUMBER_RE = /(?<![\w$.])setbpm\s*\(\s*["']?(\d+(?:\.\d+)?)["']?\s*\)/g;

function nativeBpmOf(code) {
  const src = String(code);
  let bpm = null;
  for (const m of src.matchAll(SETBPM_NUMBER_RE)) bpm = Number(m[1]);
  if (bpm != null) return bpm;
  // No plain number anywhere: either the buffer declares no tempo (120) or every declaration it
  // makes is a signal, which has no single number to report.
  return SETBPM_CALL_RE.test(src) ? null : DEFAULT_BPM;
}

function readHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(MAX_INDEXED_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_INDEXED_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// One files-tab row: the file's own metadata plus how it should read in the list. `code` rides
// along so the caller can search file *contents*; the route drops it before responding.
// `label` is what the row says: see displayLabel for the order it's worked out in - a saved
// pattern is called what the user named it, a nameless session borrows a label from its code.
function indexEntry({ kind, name, id, file, displayName, fallbackLabel, borrowBlockLabel }) {
  const code = readHead(file);
  const meta = parseMeta(code);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // raced with a delete - it just sorts last
  }
  return {
    kind,
    name,
    id,
    mtime,
    title: meta.title,
    by: meta.by,
    tags: meta.tags,
    bpm: nativeBpmOf(code),
    label: displayLabel({ title: meta.title, name: displayName, code, fallback: fallbackLabel, borrowBlockLabel }),
    code,
  };
}

// How deep a nested save is looked for. Matches the segment cap in patternPathProblem - a tree
// deeper than that was not made by saving a pattern, and walking it is someone else's problem.
const SAVED_MAX_DEPTH = 16;

/**
 * Every saved pattern's name, relative to PATTERNS_DIR with "/" separators, so a nested save is
 * called "techno/stomper" - the same string its playlists store and its routes name. The `wip`
 * subtree is skipped: sessions live inside the patterns folder but are their own kind, listed by
 * listWipPatterns. Dot-folders are skipped too, which keeps a .git or a sync tool's scratch
 * directory out of the library.
 */
function savedPatternNames(dir = PATTERNS_DIR, prefix = '', depth = 0) {
  if (depth > SAVED_MAX_DEPTH) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist yet - nothing saved
  }
  const out = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (!prefix && ent.name === 'wip') continue;
      out.push(...savedPatternNames(path.join(dir, ent.name), rel, depth + 1));
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push(rel.slice(0, -3));
    }
  }
  return out;
}

function listSavedPatterns() {
  return savedPatternNames().map((name) => {
    // A saved pattern is called what it was saved as, unless it gives itself an @title. The
    // folders are part of the name, so a row can say where it is filed and the list can be
    // grouped by it without a second source of truth.
    const entry = indexEntry({
      kind: 'saved',
      name,
      id: name,
      file: path.join(PATTERNS_DIR, `${name}.js`),
      displayName: name,
    });
    const cut = name.lastIndexOf('/');
    if (cut > 0) entry.folder = name.slice(0, cut);
    return entry;
  });
}

// "2026-08-02-143205" -> "Aug 2, 14:32" - what a session row reads as when it has neither an
// @title nor a labeled block to borrow a name from.
function wipFallbackLabel(session) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(session);
  if (!m) return session;
  const [, y, mo, d, hh, mm] = m;
  const when = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hh}:${mm}`;
}

function listWipPatterns() {
  let months = [];
  try {
    months = fs.readdirSync(WIP_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    // nothing worked on yet
  }
  const out = [];
  for (const month of months) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(WIP_DIR, month)).filter((f) => f.endsWith('.js'));
    } catch {
      continue;
    }
    for (const f of files) {
      const session = f.slice(0, -3);
      // A session has no name of its own, so it borrows one from its first block, and reads as
      // when it was played if there isn't one.
      const entry = indexEntry({
        kind: 'wip',
        name: session,
        id: `${month}/${session}`,
        file: path.join(WIP_DIR, month, f),
        borrowBlockLabel: true,
        fallbackLabel: wipFallbackLabel(session),
      });
      entry.month = month;
      out.push(entry);
    }
  }
  return out;
}

// --- the library (the track collection, the playlists, and deck B's song queue) ---
//
// One library.json alongside the pattern files, so a collection and the sets built from it travel
// with the songs they play. It holds only what the files can't say for themselves. Livecode saves
// say everything about themselves already (@title/@tags in the source, tempo read by nativeBpmOf),
// so the library never names one except to put it in a set; a disk track can't talk to poptart at
// all, so the library is where what we know about it lives.
//
//   { version: 2,
//     tracks: [{ id, path, title, artist?, album?, bpm?, key?, added }],
//     playlists: [{ id, name, folder?, items: [item, ...] }],
//     active: id | null }
//
// TRACKS are the imported collection: one record per audio file on disk, deduplicated by path,
// holding the metadata read from the file's own tags at import (see importTracks) and whatever
// was then corrected by hand. It is the collection the browser sorts and searches, and the one
// place a track's title/bpm/key is edited - two playlists holding the same file hold the same
// record, not two copies of a typo.
//
// A track is never a copy of the audio: `path` points at the file where it lives, and a file that
// moves or is deleted renders as missing rather than being silently repaired or dropped.
//
// PLAYLIST ITEMS are either a named livecode save (a bare string, which is also its path under
// patterns/ - "techno/stomper") or a reference to a track:
//
//   "saved-name"
//   { kind: 'track', id }
//
// Items of either kind may repeat - a set that comes back to a song is a real set - and an item
// whose save was deleted keeps its slot: a playlist is the user's document, not an index.
//
// The shape ABOVE is what is on disk. What readLibrary returns, and what the UI posts back, has
// each track reference hydrated into the track's own facts (see hydrateLibrary) so that walking a
// set needs no second lookup. writeLibrary collapses them again - and any hydrated item naming a
// path that has no track yet is imported on the spot, which is what makes every gesture that
// USES a file (loading it onto a deck, dropping it into a set) also file it in the collection.

const LIBRARY_FILE = path.join(PATTERNS_DIR, 'library.json');

// The records and the document's rules are library-tracks.js, which the browser build shares;
// what is here is where the document lives.
const {
  normalizeLibrary, hydrateLibrary, titleFromPath, editTracks, applyTrackFacts, applyTrackAnchor,
  clearTrackTempo, forgetFrom, importInto,
} = require('./public/library-tracks.js');

function readLibrary() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch {
    // no library yet (or unreadable) - start empty
  }
  return hydrateLibrary(normalizeLibrary(raw));
}

/**
 * Normalizes, writes, and returns what was actually kept, hydrated as readLibrary returns it.
 *
 * A document with NO `tracks` key keeps the collection that is already on disk. That is how the
 * editor posts a playlist edit: background analysis writes tempos and keys into records while the
 * window is open, so a UI that sent back the whole collection it read a minute ago would undo
 * them. The collection is changed through the track calls below, never by posting the document.
 */
function writeLibrary(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const held = src.tracks === undefined ? (readLibraryRaw()?.tracks ?? []) : src.tracks;
  const clean = normalizeLibrary({ ...src, tracks: held });
  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return hydrateLibrary(clean);
}

/**
 * Track records changed in place, by id, and the document written. `fields` may carry any of the
 * tag fields plus `rating`; a tag field given here is marked `byHand`, which is what makes it
 * outlive a later rescan or analysis. A field set to null or '' is cleared (the one way a field
 * goes away - see library-tracks.js's rescanTrack on why a rescan never empties one).
 *
 * Takes one id or several, so rating a selection is one call rather than one per row. Returns
 * the hydrated library, or null when none of the ids names a track.
 */
function editTrack(ids, fields = {}) {
  const doc = normalizeLibrary(readLibraryRaw());
  if (!editTracks(doc, ids, fields).length) return null;
  return writeLibrary(doc);
}

/**
 * What analysis measured, written onto the record for a path. Her rule, and the right one: a
 * tempo or key the FILE already stated is trusted over anything we measure, so this only fills
 * what is missing - and never touches a field typed by hand. `detected` lists the fields that
 * came from the audio rather than from a tag, so a row can show them as estimates.
 */
function setTrackFacts(trackPath, facts = {}) {
  const doc = normalizeLibrary(readLibraryRaw());
  const done = applyTrackFacts(doc, trackPath, facts);
  if (!done) return null;
  return { library: writeLibrary(doc), changed: done.changed };
}

/**
 * The beatgrid anchor the hand placed on a deck, kept on the track's record so the next load
 * stands on the same grid (song/meta writes it; the pane's re-analyze clears it with null).
 * Like a rating, this is nobody's fact but the listener's.
 */
function setTrackAnchor(trackPath, sec) {
  const doc = normalizeLibrary(readLibraryRaw());
  if (!applyTrackAnchor(doc, trackPath, sec)) return null; // no record, or nothing to change
  return { library: writeLibrary(doc) };
}

/** A tempo cleared on a deck, off the track's record (see library-tracks.js's clearTrackTempo). */
function forgetTrackTempo(trackPath) {
  const doc = normalizeLibrary(readLibraryRaw());
  if (!clearTrackTempo(doc, trackPath)) return null;
  return { library: writeLibrary(doc) };
}

/** Records out of the collection, and out of every set that referenced them. */
function forgetTracks(ids) {
  const doc = normalizeLibrary(readLibraryRaw());
  const forgot = forgetFrom(doc, ids);
  return { library: writeLibrary(doc), forgot };
}

/** A track path as the file system means it: symlinks resolved, accents composed (NFC). */
function canonicalTrackPath(p) {
  let real = p;
  try { real = fs.realpathSync(p); } catch { /* not on disk (or not yet) - the spelling given */ }
  return real.normalize('NFC');
}

/**
 * Import: file paths into the collection, reading each file's own tags for what it can say about
 * itself. Returns { library (hydrated), added, already } so the caller can report what happened
 * rather than guessing.
 *
 * Importing the same file twice is a no-op on purpose - every gesture that uses a track also
 * imports it, so this runs far more often than it does anything. A path already in the collection
 * only has its GAPS filled from the tags: a tempo or title corrected by hand is the better fact,
 * and re-importing must never undo it.
 *
 * `mode: 'rescan'` is the deliberate exception, asked for by hand: the file's tags become the
 * better word for everything the user did not type themselves (see library-tracks.js's rescanTrack). That is the only
 * way a file retagged AFTER it was imported gets its new metadata in, since the field that would
 * be corrected is no longer a gap.
 *
 * `readTags` is injected so this stays plain filesystem work the tests can drive without an
 * audio file (and so a caller can skip tag reading on a hot path).
 */
function importTracks(paths, { readTags = null, now = Date.now, mode = 'fill' } = {}) {
  const doc = normalizeLibrary(readLibraryRaw());
  // The same file can arrive spelled another way: macOS hands out names with accents decomposed
  // or composed depending on where they came from (63 of one 922-track collection were stored
  // decomposed), and a folder can be reached through a symlink. Matched on the resolved,
  // composed spelling too, so a re-import is still a re-import - and not a second record for
  // the library pass to measure all over again. The stored path stays as it was first given.
  const { added, already } = importInto(doc, paths, {
    tagsOf: (p) => (readTags ? safeTags(readTags, p) : {}),
    canon: canonicalTrackPath,
    now,
    mode,
  });
  return { library: writeLibrary(doc), added, already };
}

// A tag read is advisory: a file that can't be read is a track with no tags, never a failed import.
function safeTags(readTags, p) {
  try {
    return readTags(p) ?? {};
  } catch {
    return {};
  }
}

function readLibraryRaw() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// --- session retention (off unless the settings tab turns it on) ---
//
// A session file is never removed on its own: it is the recovery net for work that was never
// given a name, and the app has no business deciding how long that is worth keeping. It does
// cost something, though - each one pins the captured plugin states it mentions, so the state
// store can only let go of what no session still names (see blobs.js) - so it can be bounded,
// deliberately, by the person whose work it is.

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Session files last touched more than `months` ago, as { ids, bytes }. 0 (or anything that isn't
 * a positive number) means the policy is off and nothing is old.
 *
 * Stats only - listWipPatterns reads every file to work out what its row should say, which is a
 * lot of IO to answer a question about dates.
 */
function wipOlderThan(months) {
  if (!(Number(months) > 0)) return { ids: [], bytes: 0 };
  const cutoff = Date.now() - Number(months) * MONTH_MS;
  const ids = [];
  let bytes = 0;
  let monthDirs = [];
  try {
    monthDirs = fs.readdirSync(WIP_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return { ids, bytes }; // nothing worked on yet
  }
  for (const month of monthDirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(WIP_DIR, month)).filter((f) => f.endsWith('.js'));
    } catch {
      continue;
    }
    for (const f of files) {
      let stat;
      try {
        stat = fs.statSync(path.join(WIP_DIR, month, f));
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) continue;
      ids.push(`${month}/${f.slice(0, -3)}`);
      bytes += stat.size;
    }
  }
  return { ids, bytes };
}

/** Deletes them. Returns what went, so the caller can say so rather than doing it silently. */
function pruneWipSessions(months) {
  const { ids, bytes } = wipOlderThan(months);
  let deleted = 0;
  for (const id of ids) {
    try {
      fs.unlinkSync(wipFilePath(id));
      deleted += 1;
    } catch {
      // already gone, or not ours to delete - either way it isn't holding anything up
    }
  }
  return { deleted, freed: bytes };
}

module.exports = {
  PATTERNS_DIR,
  wipOlderThan,
  pruneWipSessions,
  WIP_DIR,
  patternFilePath,
  patternRelName,
  ensurePatternDir,
  savedPatternNames,
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipFallbackLabel,
  nativeBpmOf,
  readLibrary,
  writeLibrary,
  importTracks,
  editTrack,
  setTrackFacts,
  setTrackAnchor,
  forgetTrackTempo,
  forgetTracks,
  titleFromPath,
};
