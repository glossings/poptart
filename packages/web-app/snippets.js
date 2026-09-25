'use strict';

// Snippets - a reusable PHRASE, and everything it needs to play.
//
// The ★ library (pinned-defs.js) already generalises four things across projects: a roll, a shape,
// a preset, a pack. What it can't hold is the code between them - the four-line acid bass, the
// sidechain-pump .fx() chain, the dub-delay send. Reusing one of those used to mean loading the old
// patch, copying the lines, loading yours back, and discovering the paste was broken: the lines
// said `pianoroll("bass")` and the notes stayed behind in the other file.
//
// A snippet is those lines PLUS the definitions they name, carried together:
//
//   ~/.poptart/snippets/acid bass.js
//
//     // @title acid bass
//     // @tags 303 bass acid
//
//     bass: pianoroll("bass").synth("Serum 2", { state: "@2f9a1c3d5e7b" }).preset("growl")
//
//     _roll("bass", "36,0,4 47,9,3", { grid: 16, len: 16 })
//     _preset("growl", "Serum 2", "@8c1d2e3f4a5b")
//
// which is a VALID POPTART BUFFER, on purpose. It opens, it plays, it hand-edits, and every pass
// that already reads a buffer reads it: the body/definitions split is the one defsEdit writes and
// refoldAll folds, and the `@title`/`@tags` are pattern-meta.js's, which is where the browser's
// search comes from. Nothing here is a format of its own.
//
// Path building lives here and nowhere else - a request names a snippet, never a path - and it's
// all plain filesystem work, so snippets.test.js drives it against a temp directory with no server.
//
// One thing outside this file is load-bearing: a captured plugin program is stored DEHYDRATED (a
// "@handle" into blobs.js), so SNIPPETS_DIR has to be one of the directories the blob sweep scans.
// Without that the sweep collects a snippet's program as unreachable and the snippet quietly loses
// its sound - the same reason the sweep already scans the prebake folder for the ★ library.

const fs = require('node:fs');
const path = require('node:path');
const { poptartHome } = require('@poptart/osc-engine/home');

const { parseMeta, displayLabel, matchesQuery, patternNameProblem } = require('./public/pattern-meta.js');
// The snippet FILE format (body + trailing definitions) is pinned-defs.js's, shared with the browser build.
const { splitSnippet, composeSnippet } = require('./pinned-defs.js');

const SNIPPETS_DIR = process.env.POPTART_SNIPPETS_DIR || path.join(poptartHome(), 'snippets');

// A snippet is code someone selected, not a whole patch - but a selection can be a whole track with
// a captured program on it, so the ceiling is the same as a pattern's rather than something tight.
const MAX_INDEXED_BYTES = 512 * 1024;

// Names are used as filenames directly, so keep them to a single path segment. The rule itself
// lives in pattern-meta.js, which the editor also loads - so the save dialog can refuse a name for
// the same reason, before it gets this far.
function snippetFilePath(name) {
  if (patternNameProblem(name)) {
    throw new Error('snippet name must be a plain file name (no slashes, not starting with ".")');
  }
  return path.join(SNIPPETS_DIR, `${String(name).trim()}.js`);
}

function readIfSmall(file) {
  try {
    if (fs.statSync(file).size > MAX_INDEXED_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// One row of the browser: what the snippet calls itself, the code the preview shows, and what rides
// along with it. `code` is the whole file, kept for searching; the route drops it before responding
// - a snippet carrying a captured program is megabytes hydrated and pointless to ship to a list.
function snippetEntry(name) {
  const file = path.join(SNIPPETS_DIR, `${name}.js`);
  const code = readIfSmall(file);
  const meta = parseMeta(code);
  const { body, carries } = splitSnippet(code);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // raced with a delete - it just sorts last
  }
  return {
    name,
    mtime,
    title: meta.title,
    by: meta.by,
    tags: meta.tags,
    label: displayLabel({ title: meta.title, name, fallback: name }),
    body,
    carries,
    code,
  };
}

function listSnippets(query = '') {
  let names = [];
  try {
    names = fs.readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith('.js'));
  } catch {
    // directory doesn't exist yet - nothing saved
  }
  return names
    .map((f) => snippetEntry(f.slice(0, -3)))
    .filter((e) => matchesQuery(e, query))
    .sort((a, b) => b.mtime - a.mtime);
}

function readSnippet(name) {
  const file = snippetFilePath(name);
  if (!fs.existsSync(file)) throw new Error(`no snippet named "${name}"`);
  return fs.readFileSync(file, 'utf8');
}

/** Overwrites silently - "save" in a livecoding tool means "keep this". Returns the file's text. */
function writeSnippet(name, code) {
  const file = snippetFilePath(name);
  fs.mkdirSync(SNIPPETS_DIR, { recursive: true });
  fs.writeFileSync(file, code, 'utf8');
  return code;
}

function deleteSnippet(name) {
  const file = snippetFilePath(name);
  if (!fs.existsSync(file)) throw new Error(`no snippet named "${name}"`);
  fs.unlinkSync(file);
}

function renameSnippet(from, to) {
  const a = snippetFilePath(from);
  const b = snippetFilePath(to);
  if (!fs.existsSync(a)) throw new Error(`no snippet named "${from}"`);
  if (a !== b && fs.existsSync(b)) throw new Error(`a snippet named "${to}" already exists`);
  fs.renameSync(a, b);
}

module.exports = {
  SNIPPETS_DIR,
  snippetFilePath,
  splitSnippet,
  composeSnippet,
  snippetEntry,
  listSnippets,
  readSnippet,
  writeSnippet,
  deleteSnippet,
  renameSnippet,
};
