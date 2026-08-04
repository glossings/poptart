'use strict';

// Where bounced tracks live: ~/.poptart/recordings/<YYYY-MM>/<name>.wav (overridable via
// POPTART_RECORDINGS_DIR), filed by month exactly like the editor's work-in-progress patterns.
//
// The month folder is FILING, never ADDRESSING. `sr("bass")` names a recording, not a path, and
// the name is minted globally unique across every month at the moment of recording - so a name
// resolves to the same file forever, and a second bounce of the same label becomes "bass-2"
// rather than quietly changing what existing code plays. That is also what keeps the reference
// spellable in mini-notation without quoting: "/" is the slow operator, so a month-qualified
// "2026-08/bass" could not be written as a bare atom (see mini.mjs's quoted atoms, which se()
// needs for real sample paths - sr() deliberately doesn't).
//
// Plain filesystem work, no server and no engine, so recordings.test.js drives it against a
// temp directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let configuredRoot = null;

function setRecordingsRoot(dir) {
  configuredRoot = dir ? String(dir) : null;
}

function recordingsRoot() {
  if (process.env.POPTART_RECORDINGS_DIR) return process.env.POPTART_RECORDINGS_DIR;
  if (configuredRoot) return configuredRoot;
  return path.join(os.homedir(), '.poptart', 'recordings');
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/** "2026-08" for a given date - the folder a recording made now is filed under. */
function monthFolder(when = new Date()) {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
}

// A recording name has to survive being written as a bare mini-notation atom, so it is held to
// letters, digits, "_" and "-" - no dots (a ".wav" would read as a value method), no ":" (the
// field suffix), no "/" (slow), no spaces (the sequence separator). A leading "-" would lex as a
// negative number, and the mini function names are reserved words there, so both get a prefix.
const RESERVED = new Set(['r', 'i', 'p', 'round', 'floor', 'ceil']);

function sanitizeName(raw) {
  let name = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) name = 'take';
  if (RESERVED.has(name)) name = `${name}-take`;
  if (/^\d/.test(name)) name = `t${name}`; // a bare number is a value, not a name
  return name.slice(0, 64);
}

function listMonths() {
  try {
    return fs
      .readdirSync(recordingsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && MONTH_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // newest first - the order a lookup and the browser both want
  } catch {
    return []; // nothing recorded yet
  }
}

/** Every recording on disk, newest month first: { name, month, file, mtime }. */
function listRecordings() {
  const out = [];
  for (const month of listMonths()) {
    const dir = path.join(recordingsRoot(), month);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        // raced with a delete - it just sorts last
      }
      out.push({ name: f.slice(0, -4), month, file, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Absolute path of the recording called `name`, or null. Names are unique, so month order only
 *  matters for a folder someone rearranged by hand - newest wins there. */
function resolveRecording(name) {
  const clean = String(name ?? '').trim();
  // A name is one path segment by construction; refuse anything else rather than let a pattern
  // reach outside the recordings folder.
  if (!clean || clean.startsWith('.') || /[/\\]/.test(clean)) return null;
  for (const month of listMonths()) {
    const file = path.join(recordingsRoot(), month, `${clean}.wav`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * A free recording name based on `base` (normally the block's label), unique across every month:
 * "bass", then "bass-2", "bass-3", … Checked against the whole store, not just this month, so a
 * name never changes meaning.
 */
function mintName(base) {
  const clean = sanitizeName(base);
  const taken = new Set(listRecordings().map((r) => r.name));
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Path a new recording called `name` should be written to, with its month folder created. */
function newRecordingFile(name, when = new Date()) {
  const dir = path.join(recordingsRoot(), monthFolder(when));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sanitizeName(name)}.wav`);
}

/** Scratch path for the raw [pre-roll][window][post-roll] capture, before the trim pass. Kept out
 *  of the recordings folder so a crashed bounce can't leave an untrimmed file looking like a take. */
function captureFile(label) {
  return path.join(os.tmpdir(), `poptart-capture-${sanitizeName(label)}-${Date.now()}.wav`);
}

module.exports = {
  recordingsRoot,
  setRecordingsRoot,
  monthFolder,
  sanitizeName,
  listRecordings,
  resolveRecording,
  mintName,
  newRecordingFile,
  captureFile,
};
