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

// Don't slurp something enormous that wandered into the folder just to search it.
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

function readIfSmall(file) {
  try {
    if (fs.statSync(file).size > MAX_INDEXED_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// One files-tab row: the file's own metadata plus how it should read in the list. `code` rides
// along so the caller can search file *contents*; the route drops it before responding.
// `label` is what the row says: see displayLabel for the order it's worked out in - a saved
// pattern is called what the user named it, a nameless session borrows a label from its code.
function indexEntry({ kind, name, id, file, displayName, fallbackLabel, borrowBlockLabel }) {
  const code = readIfSmall(file);
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
 * goes away - see rescanTrack on why a rescan never empties one).
 *
 * Takes one id or several, so rating a selection is one call rather than one per row. Returns
 * the hydrated library, or null when none of the ids names a track.
 */
function editTrack(ids, fields = {}) {
  const want = (Array.isArray(ids) ? ids : [ids]).map(String);
  const doc = normalizeLibrary(readLibraryRaw());
  const hit = doc.tracks.filter((t) => want.includes(t.id));
  if (!hit.length) return null;
  for (const track of hit) editOneTrack(track, fields);
  return writeLibrary(doc);
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

/**
 * What analysis measured, written onto the record for a path. Her rule, and the right one: a
 * tempo or key the FILE already stated is trusted over anything we measure, so this only fills
 * what is missing - and never touches a field typed by hand. `detected` lists the fields that
 * came from the audio rather than from a tag, so a row can show them as estimates.
 */
function setTrackFacts(trackPath, facts = {}) {
  const doc = normalizeLibrary(readLibraryRaw());
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
  track.analyzed = Number(facts.at) > 0 ? Number(facts.at) : Date.now();
  if (detected.size) track.detected = [...detected].sort();
  return { library: writeLibrary(doc), changed };
}

/**
 * The beatgrid anchor the hand placed on a deck, kept on the track's record so the next load
 * stands on the same grid (song/meta writes it; the pane's re-analyze clears it with null).
 * Like a rating, this is nobody's fact but the listener's.
 */
function setTrackAnchor(trackPath, sec) {
  const doc = normalizeLibrary(readLibraryRaw());
  const track = doc.tracks.find((t) => t.path === trackPath);
  if (!track) return null;
  if (sec == null) {
    if (!('anchorSec' in track)) return null; // nothing stored - don't rewrite the file for a no-op
    delete track.anchorSec;
  } else {
    const a = Number(sec);
    if (!Number.isFinite(a) || a < 0) return null;
    track.anchorSec = a;
  }
  return { library: writeLibrary(doc) };
}

/** Records out of the collection, and out of every set that referenced them. */
function forgetTracks(ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const doc = normalizeLibrary(readLibraryRaw());
  const gone = doc.tracks.filter((t) => want.has(t.id));
  doc.tracks = doc.tracks.filter((t) => !want.has(t.id));
  for (const p of doc.playlists) {
    p.items = p.items.filter((it) => typeof it === 'string' || !want.has(String(it.id)));
  }
  return { library: writeLibrary(doc), forgot: gone.length };
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
 * better word for everything the user did not type themselves (see rescanTrack). That is the only
 * way a file retagged AFTER it was imported gets its new metadata in, since the field that would
 * be corrected is no longer a gap.
 *
 * `readTags` is injected so this stays plain filesystem work the tests can drive without an
 * audio file (and so a caller can skip tag reading on a hot path).
 */
function importTracks(paths, { readTags = null, now = Date.now, mode = 'fill' } = {}) {
  const doc = normalizeLibrary(readLibraryRaw());
  const index = indexTracks(doc.tracks);
  const added = [];
  const already = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) continue;
    const tags = readTags ? safeTags(readTags, p) : {};
    const seen = index.byPath.get(p);
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
    added.push(track);
  }
  const next = { ...doc, tracks: index.tracks };
  return { library: writeLibrary(next), added, already };
}

// A tag read is advisory: a file that can't be read is a track with no tags, never a failed import.
function safeTags(readTags, p) {
  try {
    return readTags(p) ?? {};
  } catch {
    return {};
  }
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
  forgetTracks,
  titleFromPath,
};
