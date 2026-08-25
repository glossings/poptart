'use strict';

// The song-file browser (songs phase 2). The client can't produce disk paths, so putting a real
// audio file into a playlist goes through the server: one directory listed at a time (its
// subdirectories plus the audio files poptart can play - see osc-engine/songs.js for what that
// means), and an existence check for the file items a library already holds, so a moved or
// deleted file renders as missing - the same contract as a deleted save.
//
// Plain filesystem work, unit-tested against temp directories (song-files.test.js) - no server.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifySongFile, NATIVE_EXTS, DECODE_EXTS } = require('@poptart/osc-engine/songs');
const { walkAudioFiles } = require('@poptart/osc-engine/samples');

// Every extension a song deck can play - what the recursive walk below collects.
const SONG_EXTS = new Set([...NATIVE_EXTS, ...DECODE_EXTS]);

/** Where browsing starts with no history: ~/Music when it exists, else home. */
function defaultSongDir() {
  const music = path.join(os.homedir(), 'Music');
  try {
    if (fs.statSync(music).isDirectory()) return music;
  } catch { /* no ~/Music on this machine */ }
  return os.homedir();
}

// A dirent resolved through symlinks (a Music folder full of aliases is normal); anything that
// can't be statted (dangling link, permissions) reports as neither file nor directory.
function kindOf(dir, ent) {
  if (!ent.isSymbolicLink()) return ent;
  try {
    return fs.statSync(path.join(dir, ent.name));
  } catch {
    return { isDirectory: () => false, isFile: () => false };
  }
}

/**
 * One directory's listing: { dir, parent, entries } with entries [{ name, path, dir: bool }] -
 * subdirectories first, then playable audio files, each side alphabetical (case-insensitive).
 * Dotfiles are skipped; `parent` is null at the filesystem root. Throws a clear error for a
 * path that isn't a readable directory.
 */
function browseSongDir(dirPath) {
  const dir = path.resolve(String(dirPath ?? '').trim() || defaultSongDir());
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`can't read directory: ${dir}`);
  }
  const dirs = [];
  const files = [];
  for (const ent of dirents) {
    if (ent.name.startsWith('.')) continue;
    const kind = kindOf(dir, ent);
    if (kind.isDirectory()) dirs.push(ent.name);
    else if (kind.isFile() && classifySongFile(ent.name)) files.push(ent.name);
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const entry = (name, isDir) => ({ name, path: path.join(dir, name), dir: isDir });
  const parent = path.dirname(dir);
  return {
    dir,
    parent: parent === dir ? null : parent,
    entries: [
      ...dirs.sort(byName).map((n) => entry(n, true)),
      ...files.sort(byName).map((n) => entry(n, false)),
    ],
  };
}

/**
 * Which of these paths are files that still exist, as { [path]: bool }. Non-strings are
 * skipped; the list is bounded (it comes from one library's file items).
 */
function statSongPaths(paths) {
  const out = {};
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 2000)) {
    if (typeof p !== 'string') continue;
    try {
      out[p] = fs.statSync(p).isFile();
    } catch {
      out[p] = false;
    }
  }
  return out;
}

/**
 * Every playable audio file anywhere under a folder, as paths relative to it - the organize
 * modal's folder adds and its tree search (mirroring the pack browser's /api/findSamples).
 * Same walker as the sample library's, pointed at the song formats (mp3/m4a and friends
 * included). Resolves { files, truncated }.
 */
function walkSongFiles(dir, opts = {}) {
  return walkAudioFiles(dir, { ...opts, exts: SONG_EXTS });
}

module.exports = { defaultSongDir, browseSongDir, statSongPaths, walkSongFiles };
