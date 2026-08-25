'use strict';

// Song files for the DJ decks: resolving a user's audio file into something scsynth's
// Buffer.read can load. wav/aiff/flac go straight through (libsndfile decodes those
// everywhere); compressed formats CoreAudio knows (mp3, m4a/aac, caf) are converted ONCE with
// macOS's stock afconvert - no new dependency - into a cache under ~/.poptart/cache/songs,
// keyed by the source's (path, mtime, size) so an edited or replaced file re-decodes and an
// untouched one never does. Decodes land under a temp name and rename into place, so a crash
// mid-convert can't leave a half-written file that later reads as a cache hit.
//
// Cache eviction is a known gap (see TODO.md's song oddments) - entries currently accumulate.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// What scsynth reads natively vs what needs an afconvert pass first. Anything else is a clear
// error - better than handing scsynth a file it will fail on with a cryptic read error.
const NATIVE_EXTS = new Set(['.wav', '.aif', '.aiff', '.flac']);
const DECODE_EXTS = new Set(['.mp3', '.m4a', '.aac', '.caf']);

function songCacheDir() {
  return path.join(os.homedir(), '.poptart', 'cache', 'songs');
}

/** 'native' (Buffer.read handles it), 'decode' (afconvert first), or null (unsupported). */
function classifySongFile(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (NATIVE_EXTS.has(ext)) return 'native';
  if (DECODE_EXTS.has(ext)) return 'decode';
  return null;
}

/** Where a decode of this exact file (identified by path + mtime + size) lands in the cache. */
function songCachePath(filePath, stat, dir = songCacheDir()) {
  const tag = crypto.createHash('sha1')
    .update(`${path.resolve(filePath)}|${Math.round(stat.mtimeMs)}|${stat.size}`)
    .digest('hex');
  return path.join(dir, `${tag}.wav`);
}

/**
 * Resolve a song file to a path scsynth can Buffer.read, decoding through the cache when
 * needed. Returns { path, decoded, cached }. Throws with a user-facing message for a missing
 * file, an unsupported format, or a failed decode.
 *
 * `opts.exec` (execFile-shaped) and `opts.cacheDir` are injectable for tests.
 */
async function resolveSongFile(filePath, { exec = execFile, cacheDir } = {}) {
  const src = String(filePath ?? '').trim();
  let stat;
  try {
    stat = fs.statSync(src);
  } catch {
    throw new Error(`no such file: ${src}`);
  }
  if (!stat.isFile()) throw new Error(`not a file: ${src}`);
  const kind = classifySongFile(src);
  if (!kind) {
    throw new Error(
      `unsupported audio format "${path.extname(src) || '(none)'}" - `
      + `wav/aiff/flac play directly, mp3/m4a/aac/caf are converted via afconvert`,
    );
  }
  if (kind === 'native') return { path: src, decoded: false, cached: false };

  const dir = cacheDir ?? songCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = songCachePath(src, stat, dir);
  if (fs.existsSync(out)) return { path: out, decoded: true, cached: true };

  // Float WAV keeps whatever headroom the source had; afconvert preserves sample rate and
  // channel count unless told otherwise, which is exactly what a deck wants.
  const part = `${out}.part.wav`;
  await new Promise((resolve, reject) => {
    exec('afconvert', ['-f', 'WAVE', '-d', 'LEF32', src, part], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`decoding ${path.basename(src)} failed: ${String(stderr || err.message).trim()}`));
      } else resolve();
    });
  });
  fs.renameSync(part, out);
  return { path: out, decoded: true, cached: false };
}

module.exports = { classifySongFile, songCachePath, songCacheDir, resolveSongFile, NATIVE_EXTS, DECODE_EXTS };
