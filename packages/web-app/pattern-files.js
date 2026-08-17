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

module.exports = {
  PATTERNS_DIR,
  WIP_DIR,
  patternFilePath,
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipFallbackLabel,
};
