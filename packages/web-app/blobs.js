'use strict';

// Captured plugin state, kept out of the buffer.
//
// A Serum program is a couple of megabytes of gzipped base64, and it used to live in the editor
// buffer as a string literal - `synth("Serum 2", { state: "H4sI…" })`. The buffer is the source of
// truth for everything, so every copy of it carried those megabytes: the autosave that fires a
// second after you stop typing, the history checkpoint on every Cmd+Enter, the eval request
// itself, the sessionStorage copy that survives a reload, and CodeMirror's own view of a
// 2.7-million-character line. One real patch measured 8.3MB across 50 lines, 99.8% of it in three
// literals - and a month of playing left 519MB of autosaves and 448MB of snapshots on disk.
//
// So the bytes live here instead, one file per distinct state, and the buffer holds a short handle
// in their place:
//
//     synth("Serum 2", { state: "@2f9a1c3d5e7b" })
//
// Ids are content-addressed, so the same program captured twice is stored once, and a handle is
// stable across sessions and machines-with-the-same-store. Nothing in the editor ever holds the
// bytes again: a capture stores them here and hands the editor the handle (see captureDirtyPlugins),
// and a state on its way to a plugin is resolved back at the one point that turns a state into
// bytes (OscEngine#_inflateState, via the resolver server.js installs).
//
// Files that leave this machine are the exception, and are HYDRATED on the way out - an exported
// or saved .js carries its states in full, so it is still the whole patch and still opens on a
// machine that has never seen this store. Everything machine-local (the live buffer, wip
// autosaves, history snapshots) keeps handles.
//
// Swept, not pruned. Content addressing keeps repeats out, but a knob you turn for a minute is a
// hundred DIFFERENT programs, each stored the moment it is captured - so the folder has to be able
// to give ground, and an LRU cap would do it by throwing away whichever states happened to be
// oldest, which is to say the sound of the oldest work still on disk. Instead the store is
// collected: a blob nothing can still ask for goes, and everything else stays however old it gets
// (see sweepBlobs). Saved patterns and exports carry their states in full, so the only things that
// hold a blob alive are the machine-local copies - wip sessions and history snapshots - and
// whatever the editor has open right now, which the age floor covers.

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BLOB_DIR = process.env.POPTART_BLOB_DIR || path.join(os.homedir(), '.poptart', 'blobs');

const ID_RE = /^[0-9a-f]{12}$/;

// What a captured state looks like in the buffer: a string literal of base64, which every state
// is - and base64 of a gzip header always begins "H4sI", so this can't collide with the other long
// strings a patch holds (note grids and shape data both carry commas and spaces). Commented-out
// states count too: they cost the same to carry around, and they have to keep working when the
// comment comes off.
//
// Found by scanning rather than with one regex. `/"(H4sI[A-Za-z0-9+/=]{64,})"/` reads better and
// works fine up to a couple of megabytes, then overflows V8's regex stack - which a real 17.9MB
// patch here does. A quantifier is only as safe as the longest thing it will ever match, and a
// captured state has no upper bound at all.
const BLOB_START = /"H4sI/g;
const MIN_BLOB = 68; // shorter than any real program, and past it "H4sI…" can't be a coincidence

const isB64 = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

/** Every captured state written out in full in `text`, as { start, end, state } over its body. */
function* findBlobs(text) {
  BLOB_START.lastIndex = 0;
  let m;
  while ((m = BLOB_START.exec(text)) !== null) {
    const start = m.index + 1; // past the opening quote
    let end = start + 4; // past "H4sI"
    while (end < text.length && isB64(text.charCodeAt(end))) end += 1;
    // Only a literal that ENDS here is one: base64 runs to its closing quote, and anything else
    // ("H4sI" opening a word in a comment, a truncated paste) is left where it stands.
    if (text[end] !== '"' || end - start < MIN_BLOB) {
      BLOB_START.lastIndex = m.index + 1;
      continue;
    }
    yield { start, end, state: text.slice(start, end) };
    BLOB_START.lastIndex = end + 1;
  }
}

// What replaces one, and the only regex left here - a handle is twelve characters, so nothing can
// run away with it. `@` can't start a base64 string, so hydrate and dehydrate can never mistake
// one for the other, whatever order they run in.
const HANDLE_RE = /"@([0-9a-f]{12})"/g;

const blobId = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 12);

// Ids come out of buffers the user can edit, so anything that isn't the exact shape blobId
// produces must not become a path.
function blobPath(id) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('not a blob id');
  return path.join(BLOB_DIR, `${id}.b64`);
}

/**
 * Files the store holds, for the diagnostics that report what it costs.
 */
function blobStats() {
  let files = 0;
  let bytes = 0;
  for (const name of fs.existsSync(BLOB_DIR) ? fs.readdirSync(BLOB_DIR) : []) {
    if (!name.endsWith('.b64')) continue;
    files += 1;
    bytes += fs.statSync(path.join(BLOB_DIR, name)).size;
  }
  return { files, bytes, dir: BLOB_DIR };
}

/**
 * Stores one captured state and returns its handle (`@<id>`, ready to write into code).
 * Storing the same state twice is one write and the same handle.
 */
async function putBlob(text) {
  const id = blobId(text);
  const file = blobPath(id);
  // Content-addressed, so a file that's already there already holds exactly this state - there is
  // nothing to overwrite, and re-writing megabytes is time the scheduler would spend not sending
  // notes. Writes go to a temp name first: a reader that catches a half-written state would inflate
  // to garbage and push it into a plugin.
  if (fs.existsSync(file)) {
    // Touched instead: capturing a program the store already has says this state is in use now,
    // which is what keeps the sweep's age floor meaningful for a patch you keep coming back to.
    const now = new Date();
    await fsp.utimes(file, now, now).catch(() => {});
  } else {
    await fsp.mkdir(BLOB_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, String(text), 'utf8');
    await fsp.rename(tmp, file);
  }
  return `@${id}`;
}

/** The state behind a handle - `@<id>` or a bare id - or null if the store doesn't have it. */
async function getBlob(handle) {
  const id = String(handle ?? '').replace(/^@/, '');
  if (!ID_RE.test(id)) return null;
  try {
    return await fsp.readFile(blobPath(id), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Code on its way INTO the editor: every captured state stored here and replaced by its handle.
 * Applied wherever code arrives from somewhere that may hold states in full - a saved pattern, a
 * wip session, an imported file - so the buffer never holds the bytes even once.
 *
 * Returns { code, stored } - `stored` being how many literals were replaced, which is 0 for the
 * overwhelmingly common case of code that is already handles.
 */
async function dehydrate(code) {
  const text = String(code ?? '');
  const found = [...findBlobs(text)];
  if (!found.length) return { code: text, stored: 0 };
  // Distinct states only: a patch that plays one program in three places stores it once.
  const handles = new Map();
  for (const { state } of found) {
    if (!handles.has(state)) handles.set(state, await putBlob(state));
  }
  // Assembled from the gaps between the states rather than by replacing across the whole text: the
  // pieces being joined are kilobytes even when what came in was megabytes. The quotes are outside
  // each span, so a handle drops straight into the literal that held the program.
  const parts = [];
  let at = 0;
  for (const { start, end, state } of found) {
    parts.push(text.slice(at, start), handles.get(state));
    at = end;
  }
  parts.push(text.slice(at));
  return { code: parts.join(''), stored: handles.size };
}

/**
 * Code on its way OUT to a file someone might open anywhere: handles replaced by the states
 * themselves, so what is written is the whole patch.
 *
 * Returns { code, missing } - `missing` being the handles this store could not resolve. They are
 * left as they stand rather than silently dropped: a `"@…"` in a file is a state that can be found
 * again if its store turns up, where an empty string is a sound that is simply gone. Callers report
 * it; nothing here decides that a save should fail.
 */
async function hydrate(code) {
  const text = String(code ?? '');
  const found = [...text.matchAll(HANDLE_RE)];
  if (!found.length) return { code: text, missing: [] };
  const states = new Map();
  const missing = [];
  for (const [, id] of found) {
    if (states.has(id)) continue;
    const state = await getBlob(id);
    if (state == null) missing.push(id);
    else states.set(id, state);
  }
  return {
    code: text.replace(HANDLE_RE, (whole, id) => (states.has(id) ? `"${states.get(id)}"` : whole)),
    missing,
  };
}

/** Every handle `text` mentions. */
function referencedIds(text) {
  const out = new Set();
  HANDLE_RE.lastIndex = 0;
  let m;
  while ((m = HANDLE_RE.exec(String(text ?? ''))) !== null) out.add(m[1]);
  return out;
}

// A file bigger than this can't be a buffer that mentions handles - it is one written before the
// store existed, carrying its states in full - so the sweep doesn't read it. Without this, one
// collection would read every 8MB autosave a month of playing left behind.
const SCAN_MAX_BYTES = 2 * 1024 * 1024;

// How long a blob is safe whatever nothing says about it. The window it covers is small and known:
// a state is captured, the editor writes it into the buffer on its next poll, and the autosave
// records it a second later - the server sees that autosave and holds those handles by name from
// then on. Half an hour is that window many times over, and it bounds what a knob held for a
// minute can leave behind to the last half hour of it.
const SWEEP_KEEP_MS = 30 * 60 * 1000;

/**
 * Mark and sweep: reads every file in `scanDirs` small enough to be a buffer, and deletes the
 * stored states that none of them - nor `alsoKeep` - mentions. Blobs younger than `keepMs` are
 * kept regardless, because the newest capture is the one nothing has written down yet.
 *
 * Returns { deleted, freed, kept }.
 */
async function sweepBlobs({ scanDirs = [], alsoKeep = [], keepMs = SWEEP_KEEP_MS } = {}) {
  const keep = new Set(alsoKeep);
  for (const dir of scanDirs) {
    for (const file of await walkFiles(dir)) {
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue; // pruned out from under us - it holds nothing alive either way
      }
      if (!stat.isFile() || stat.size > SCAN_MAX_BYTES) continue;
      const text = await fsp.readFile(file, 'utf8').catch(() => '');
      for (const id of referencedIds(text)) keep.add(id);
    }
  }
  let names;
  try {
    names = (await fsp.readdir(BLOB_DIR)).filter((f) => f.endsWith('.b64') && ID_RE.test(path.basename(f, '.b64')));
  } catch {
    return { deleted: 0, freed: 0, kept: 0 }; // no store yet
  }
  const cutoff = Date.now() - keepMs;
  let deleted = 0;
  let freed = 0;
  for (const name of names) {
    const id = path.basename(name, '.b64');
    if (keep.has(id)) continue;
    const file = path.join(BLOB_DIR, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs >= cutoff) continue;
    if (await fsp.unlink(file).then(() => true, () => false)) {
      deleted += 1;
      freed += stat.size;
    }
  }
  return { deleted, freed, kept: names.length - deleted };
}

/** Every file under `dir`, one level of subdirectories included (wip files sit in month folders). */
async function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Does this code hold captured states in full? (What decides whether a load has work to do.) */
const hasBlobs = (code) => !findBlobs(String(code ?? '')).next().done;

module.exports = { BLOB_DIR, SWEEP_KEEP_MS, blobId, blobStats, putBlob, getBlob, dehydrate, hydrate, hasBlobs, referencedIds, sweepBlobs };
