'use strict';

// Where on the disk a file dropped into the pack panel lives.
//
// A drop from the desktop (Finder, a sample service's app, a download) reaches the page as a
// name, a size and the bytes - never a path: a web page is not told where a file came from. A
// pack entry IS a path, and nothing is copied or moved to make one, so the file has to be found
// again on the disk: every file with that exact name is a candidate, and the one with the same
// size and the same bytes (a hash the page computed) is the file that was dropped. Spotlight
// answers the name question for the whole machine at once; where it can't (not macOS, indexing
// off, a folder it skips), the usual places a sample lands are walked instead.
//
// Pure file work with the finders injected, no server state - see sample-locate.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/** Folders under the home directory a dropped sample is likely to have come from, in order. */
const HOME_SEARCH_FOLDERS = ['Splice', 'Downloads', 'Music', 'Desktop', 'Documents'];

/** How far the fallback walk goes before giving up on a folder - a sample library, not a disk. */
const WALK_LIMIT = 20000;
const WALK_DEPTH = 8;

/** Spotlight's files of exactly this name; [] where there is no Spotlight or it fails. */
function spotlightByName(name) {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('mdfind', ['-name', name], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      // -name matches the name as a substring (kick.wav also finds bigkick.wav), so keep the exact ones.
      resolve(String(stdout).split('\n').filter((p) => p && path.basename(p) === name));
    });
  });
}

/** The sha256 of a file's bytes, hex - streamed, since a stem can run to hundreds of MB. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Whether `file` is the dropped file: a regular file of the same size, then the same bytes. */
async function isTheFile(file, { size, sha256 }) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== size) return false;
  try {
    return (await hashFile(file)) === sha256;
  } catch {
    return false;
  }
}

/**
 * The best of several copies of the same file: one inside the sample library first (its entry is
 * then written relative to the root and travels with the library), then the shortest path - the
 * original over a copy buried in an app's cache - then alphabetical, so the answer is stable.
 */
function rankPaths(paths, samplesRoot) {
  const root = samplesRoot ? path.resolve(samplesRoot) : null;
  const inLib = (p) => !!root && (p === root || p.startsWith(root + path.sep));
  return [...new Set(paths.map((p) => path.resolve(p)))].sort((a, b) =>
    Number(inLib(b)) - Number(inLib(a)) || a.length - b.length || a.localeCompare(b));
}

/** The folders the fallback walk covers: the library, the panel's hints, the usual home folders. */
function searchRoots({ samplesRoot, hints = [], home = os.homedir() }) {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p));
    if (out.includes(abs)) return;
    try {
      if (fs.statSync(abs).isDirectory()) out.push(abs);
    } catch { /* not there - nothing to walk */ }
  };
  add(samplesRoot);
  for (const h of hints) add(h);
  for (const f of HOME_SEARCH_FOLDERS) add(path.join(home, f));
  return out;
}

/**
 * Finds the dropped file: `name` and `size` as the browser reported them, `sha256` of its bytes
 * (hex). Spotlight first; then the search roots walked one at a time until one holds it. Returns
 * the absolute path, or null when nothing on the disk is that file - the caller says so rather
 * than adding a guess. `isAudioName` is the library's rule for what a sample is; anything else
 * is refused before the disk is asked.
 */
async function locateDroppedFile({
  name, size, sha256, samplesRoot, hints, home, isAudioName,
  findByName = spotlightByName, walk = null,
}) {
  const base = path.basename(String(name ?? '').trim());
  if (!base || base === '.' || base === '..') throw new Error('that file has no usable name');
  if (isAudioName && !isAudioName(base)) throw new Error(`${base} is not a sample the sampler plays (wav, aif, aiff, flac, mp3)`);
  const want = { size: Number(size), sha256: String(sha256 ?? '').toLowerCase() };
  if (!Number.isInteger(want.size) || want.size <= 0) throw new Error('locateSample needs the file size');
  if (!/^[0-9a-f]{64}$/.test(want.sha256)) throw new Error('locateSample needs the file hash');
  const verify = async (paths) => {
    for (const p of rankPaths(paths, samplesRoot)) if (await isTheFile(p, want)) return p;
    return null;
  };
  // Spotlight: the whole disk in one question. Only exact names, verified by bytes.
  const spotted = await verify(await findByName(base));
  if (spotted) return spotted;
  if (!walk) return null;
  for (const root of searchRoots({ samplesRoot, hints, home })) {
    let listing;
    try {
      listing = await walk(root, { limit: WALK_LIMIT, maxDepth: WALK_DEPTH });
    } catch {
      continue;
    }
    const here = (listing?.files ?? []).filter((f) => path.basename(f) === base).map((f) => path.join(root, f));
    const found = await verify(here);
    if (found) return found;
  }
  return null;
}

/**
 * A dropped path (a file:// URL the drag carried, already a location): the absolute path of the
 * audio file it names, or null when there is no such file. Nothing is searched for - a path is
 * either the file or it isn't. Refuses anything that is not a sample, as the locate does.
 */
async function verifyDroppedPath(dropped, { isAudioName } = {}) {
  const raw = String(dropped ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('a dropped path has to be absolute');
  if (isAudioName && !isAudioName(raw)) throw new Error(`${path.basename(raw)} is not a sample the sampler plays (wav, aif, aiff, flac, mp3)`);
  const abs = path.resolve(raw);
  try {
    return (await fs.promises.stat(abs)).isFile() ? abs : null;
  } catch {
    return null;
  }
}

module.exports = { locateDroppedFile, verifyDroppedPath, rankPaths, searchRoots, hashFile, spotlightByName, HOME_SEARCH_FOLDERS };
