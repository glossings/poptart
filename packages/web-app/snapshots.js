'use strict';

// Code snapshots - the store the editor's URL points at.
//
// The buffer used to live in the URL itself, base64'd into location.hash. That made every
// checkpoint a megabyte-long URL once a patch carried captured plugin state, which cost real
// time in pushState (Chrome canonicalizes the URL, repaints the omnibox and writes the session
// history entry to disk on the main thread) and, worse, put that cost in front of the eval
// request. It also silently defeated the point: Chrome's history database drops URLs past a
// couple of kilobytes, so the states were never findable in chrome://history anyway.
//
// So the URL now carries a short id and the code lives here, one file per state, under
// ~/.poptart/snapshots. Ids are content-addressed, which means re-evaluating an unchanged buffer
// reuses its snapshot instead of piling up copies of the same text.
//
// This is a recovery net, not an archive - it's pruned to the most recent MAX_SNAPSHOTS, so a
// history entry old enough to have fallen out restores nothing (the editor says so). Anything
// worth keeping is a named pattern file or a wip session; both outlive this.
//
// Sharing is deliberately NOT this: a snapshot id means nothing on someone else's machine, so
// the editor's share action still builds a self-contained base64 URL, on demand.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SNAPSHOT_DIR = process.env.POPTART_SNAPSHOT_DIR || path.join(os.homedir(), '.poptart', 'snapshots');

// Roughly a long session's worth of evals. Each file is one buffer, so the folder's size is
// bounded by this times the biggest patch you play - a few hundred MB in the worst case of
// megabyte state blobs, and far less in practice because unchanged buffers dedupe to one file.
const MAX_SNAPSHOTS = 500;

const ID_RE = /^[0-9a-f]{12}$/;

// Content-addressed: the same buffer always gets the same id, so a re-eval that changed nothing
// re-points at the file that's already there.
function snapshotId(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex').slice(0, 12);
}

// Ids come off a URL hash, so they're untrusted input - anything that isn't the exact shape
// snapshotId produces can't become a path.
function snapshotPath(id) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('not a snapshot id');
  return path.join(SNAPSHOT_DIR, `${id}.js`);
}

// Writes are async on purpose: this runs in the same process (and event loop) as the pattern
// scheduler, whose lookahead is 150ms - a synchronous write of a megabyte buffer is time the
// scheduler isn't sending notes.
async function putSnapshot(code) {
  const id = snapshotId(code);
  const file = path.join(SNAPSHOT_DIR, `${id}.js`);
  // Touch first: an unchanged buffer is the common case (re-evaluating what you just played), and
  // this both detects it in one syscall and tells pruning the state is one you're still using,
  // rather than as old as the first time you played it.
  const now = new Date();
  try {
    await fsp.utimes(file, now, now);
    return id;
  } catch {
    // not stored yet
  }
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fsp.writeFile(file, String(code), 'utf8');
  return id;
}

// null when the id is unknown - a state pruned away, or a hash from another machine.
async function getSnapshot(id) {
  try {
    return await fsp.readFile(snapshotPath(id), 'utf8');
  } catch {
    return null;
  }
}

// Drop all but the `keep` most recently used snapshots. Returns how many were removed.
async function pruneSnapshots(keep = MAX_SNAPSHOTS) {
  let names;
  try {
    names = (await fsp.readdir(SNAPSHOT_DIR)).filter((f) => ID_RE.test(path.basename(f, '.js')) && f.endsWith('.js'));
  } catch {
    return 0; // no store yet
  }
  if (names.length <= keep) return 0;
  const stamped = await Promise.all(
    names.map(async (name) => {
      const mtime = await fsp.stat(path.join(SNAPSHOT_DIR, name)).then((s) => s.mtimeMs, () => 0);
      return { name, mtime };
    }),
  );
  stamped.sort((a, b) => b.mtime - a.mtime); // newest first
  const doomed = stamped.slice(keep);
  await Promise.all(doomed.map((s) => fsp.unlink(path.join(SNAPSHOT_DIR, s.name)).catch(() => {})));
  return doomed.length;
}

module.exports = { SNAPSHOT_DIR, MAX_SNAPSHOTS, snapshotId, snapshotPath, putSnapshot, getSnapshot, pruneSnapshots };
