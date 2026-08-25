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
const os = require('node:os');
const path = require('node:path');

const { parseMeta, displayLabel, patternNameProblem } = require('./public/pattern-meta.js');

const PATTERNS_DIR = process.env.POPTART_PATTERNS_DIR || path.join(os.homedir(), '.poptart', 'patterns');
const WIP_DIR = path.join(PATTERNS_DIR, 'wip');

// Don't slurp something enormous that wandered into the folder just to search it.
const MAX_INDEXED_BYTES = 512 * 1024;

// Names are used as filenames directly, so keep them to a single path segment. The rule itself
// lives in pattern-meta.js, which the editor also loads - so the naming dialog can refuse a name
// for the same reason, before it gets this far.
function patternFilePath(name) {
  if (patternNameProblem(name)) {
    throw new Error('pattern name must be a plain file name (no slashes, not starting with ".")');
  }
  return path.join(PATTERNS_DIR, `${String(name).trim()}.js`);
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
function nativeBpmOf(code) {
  let bpm = null;
  for (const m of String(code).matchAll(/(?<![\w$.])setbpm\s*\(\s*["']?(\d+(?:\.\d+)?)["']?\s*\)/g)) {
    bpm = Number(m[1]);
  }
  return bpm;
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

function listSavedPatterns() {
  let names = [];
  try {
    names = fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith('.js'));
  } catch {
    // directory doesn't exist yet - nothing saved
  }
  return names.map((f) => {
    const name = f.slice(0, -3);
    // A saved pattern is called what it was saved as, unless it gives itself an @title.
    return indexEntry({
      kind: 'saved',
      name,
      id: name,
      file: path.join(PATTERNS_DIR, f),
      displayName: name,
    });
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

// --- the library (playlists; the organize modal and deck B's song queue) ---
//
// One library.json alongside the pattern files, so a set travels with the songs it plays
// (fizzle's model). It holds only what the files can't say for themselves: the playlists and
// which one is the ACTIVE set (deck B's picker follows it). Tags stay in the files (@tags),
// tempo is read from the source (nativeBpmOf) - nothing here duplicates a file's own facts.
//
//   { version: 1, playlists: [{ id, name, items: [item, ...] }], active: id | null }
//
// An item is either a named save (a bare string) or a real audio file on disk (songs phase 2):
//
//   "saved-name"
//   { kind: 'file', path, title?, bpm?, key? }
//
// A file item carries what its file can't say to poptart yet - a display title, the native
// tempo /api/mix/tempo migrates toward, the musical key - entered by hand until tag parsing
// (phase 4) fills them in. Items of either kind may repeat (a set that comes back to a song is
// a real set). An item whose save was deleted - or whose file moved - stays in the list and
// renders as missing: the playlist is the user's document, not an index to be silently repaired.

const LIBRARY_FILE = path.join(PATTERNS_DIR, 'library.json');

const newLibraryId = () => Math.random().toString(36).slice(2, 10);

// One item coerced to the shapes above, or null for junk. Field rules match their consumers:
// bpm the /api/song/load sanity range, title/key non-empty trimmed strings or absent.
function normalizeLibraryItem(it) {
  if (typeof it === 'string') return it;
  if (!it || typeof it !== 'object' || it.kind !== 'file') return null;
  const p = typeof it.path === 'string' ? it.path.trim() : '';
  if (!p) return null;
  const item = { kind: 'file', path: p };
  if (typeof it.title === 'string' && it.title.trim()) item.title = it.title.trim();
  const bpm = Number(it.bpm);
  if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400) item.bpm = bpm;
  if (typeof it.key === 'string' && it.key.trim()) item.key = it.key.trim();
  return item;
}

// Whatever is on disk (or handed to writeLibrary) is coerced to the shape above - a hand-edited
// or truncated file degrades to an empty library rather than taking the UI down with it.
function normalizeLibrary(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const playlists = (Array.isArray(src.playlists) ? src.playlists : [])
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      id: String(p.id ?? newLibraryId()),
      name: p.name,
      items: Array.isArray(p.items) ? p.items.map(normalizeLibraryItem).filter((k) => k != null) : [],
    }));
  const active = playlists.some((p) => p.id === src.active) ? src.active : null;
  return { version: 1, playlists, active };
}

function readLibrary() {
  try {
    return normalizeLibrary(JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')));
  } catch {
    return normalizeLibrary(null); // no library yet (or unreadable) - start empty
  }
}

/** Normalizes, writes, and returns what was actually kept. */
function writeLibrary(doc) {
  const clean = normalizeLibrary(doc);
  fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
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
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipFallbackLabel,
  nativeBpmOf,
  readLibrary,
  writeLibrary,
};
