'use strict';

// Sample-pack discovery and WAV analysis for the sampler (`s("bd")` patterns). A pack is a
// folder of audio files under the samples root; files are addressed by index (`.i(4)`) in
// filename-sorted order, strudel-style. A NAMED pack (`sp("kit")`, a `_pack()` definition) is a
// hand-picked list of files and folders instead - see expandPackEntries. scsynth does the actual playback (Buffer.read supports
// whatever libsndfile does - wav/aiff/flac); the JS-side analysis here only needs the raw
// samples for transient detection (`.slice()`), so that part is WAV-only: non-WAV files simply
// have no slices rather than failing the pack.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readWavRaw } = require('./wav');

const AUDIO_EXTS = new Set(['.wav', '.aif', '.aiff', '.flac']);

// Sample library location, in priority order:
//   1. POPTART_SAMPLES_DIR - environment override, always wins (useful for tests/CI).
//   2. a runtime value set via setSamplesRoot() - the UI's "settings" tab persists a chosen
//      folder here (see the web-app's settings handling).
//   3. the default library at ~/.poptart/samples.
// A pack is a subfolder of this root; drop or symlink your sample folders in and they appear.
let configuredRoot = null;

function setSamplesRoot(dir) {
  configuredRoot = dir ? String(dir) : null;
}

function samplesRoot() {
  if (process.env.POPTART_SAMPLES_DIR) return process.env.POPTART_SAMPLES_DIR;
  if (configuredRoot) return configuredRoot;
  return path.join(os.homedir(), '.poptart', 'samples');
}

/** Absolute paths of a pack's audio files in filename order, or null if the folder is missing. */
function listPackFiles(pack) {
  const dir = path.join(samplesRoot(), String(pack));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  return names
    .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Absolute path of ONE audio file addressed by its path relative to the samples root - what se()
 * plays, as opposed to s()'s pack-plus-index. Returns null if it isn't there or isn't audio.
 *
 * The resolved path is checked to still be inside the root afterwards, so a "../.." in a pattern
 * can't turn the sampler into a file browser for the rest of the disk.
 */
function resolveSampleFile(relPath) {
  const rel = String(relPath ?? '').trim();
  if (!rel || path.isAbsolute(rel)) return null;
  const root = path.resolve(samplesRoot());
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!AUDIO_EXTS.has(path.extname(abs).toLowerCase())) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * The files a named pack's entries stand for, in index order. An entry is a file, or a folder
 * standing for every audio file in it (filename order, one level); a relative path is under the
 * samples root, an absolute one is wherever it says - a pack is how a folder OUTSIDE the library
 * gets played, so there is no root check here. Anything missing or not audio is skipped rather
 * than failing the pack, so a drum rack with one moved file still plays its other seven.
 */
function expandPackEntries(entries) {
  const root = path.resolve(samplesRoot());
  const out = [];
  for (const raw of entries ?? []) {
    const rel = String(raw ?? '').trim();
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(abs);
      } catch {
        continue;
      }
      for (const f of names.filter((n) => AUDIO_EXTS.has(path.extname(n).toLowerCase())).sort()) out.push(path.join(abs, f));
    } else if (stat.isFile() && AUDIO_EXTS.has(path.extname(abs).toLowerCase())) {
      out.push(abs);
    }
  }
  return out;
}

/** True if `name` has an audio extension the sampler plays - what the pack panel lists as pickable. */
function isAudioName(name) {
  return AUDIO_EXTS.has(path.extname(String(name ?? '')).toLowerCase());
}

/**
 * One directory under the samples root, for the editor's se() autocomplete: its immediate
 * subfolders and its audio files, both in filename order. `rel` is root-relative ("" = the root).
 */
function browseSamples(rel = '') {
  const root = path.resolve(samplesRoot());
  const dir = path.resolve(root, String(rel ?? '').trim());
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const isDir = (e) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(dir, e.name)).isDirectory();
    } catch {
      return false;
    }
  };
  return {
    path: path.relative(root, dir),
    dirs: entries.filter(isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b)),
    files: entries
      .filter((e) => !isDir(e) && AUDIO_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Every audio file under `dir`, as paths relative to it, in "this folder first, then each
 * subfolder in name order" order - what the pack panel's search looks through and what adding a
 * folder recursively picks up. A folder's own files come before its subfolders' so that adding a
 * tree keeps the same indexes at the top as adding just the folder used to.
 *
 * Hidden entries are skipped (macOS `._x.wav` resource forks and `.git` are never what you meant),
 * symlinked folders are followed but only once each, and the walk stops at `limit` files or
 * `maxDepth` levels - `truncated` says which, so a caller can tell the user it saw only part.
 *
 * Async on purpose: this process is also the one sending OSC on time, and a sample library big
 * enough to be worth searching is big enough that walking it synchronously would be heard.
 */
async function walkAudioFiles(dir, { limit = 20000, maxDepth = 12 } = {}) {
  const files = [];
  let truncated = false; // saw only part of the tree, for whatever reason
  let full = false; // hit the file cap - the one reason to stop walking entirely
  const seen = new Set(); // realpaths of folders already walked, so a symlink loop can't spin
  const remember = async (abs) => {
    try {
      const real = await fs.promises.realpath(abs);
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    } catch {
      return false;
    }
  };
  const walk = async (abs, rel, depth) => {
    if (full) return;
    let entries;
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = [];
    const here = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = (await fs.promises.stat(path.join(abs, e.name))).isDirectory(); } catch { continue; }
      }
      if (isDir) subdirs.push(e.name);
      else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) here.push(e.name);
    }
    here.sort((a, b) => a.localeCompare(b));
    subdirs.sort((a, b) => a.localeCompare(b));
    for (const f of here) {
      if (files.length >= limit) { full = truncated = true; return; }
      files.push(rel ? `${rel}/${f}` : f);
    }
    if (depth >= maxDepth) {
      // Too deep to go on, but the folders beside this one are still worth having: only the file
      // cap stops the whole walk, a depth cut just marks the result partial.
      if (subdirs.length) truncated = true;
      return;
    }
    for (const d of subdirs) {
      if (!(await remember(path.join(abs, d)))) continue;
      await walk(path.join(abs, d), rel ? `${rel}/${d}` : d, depth + 1);
      if (full) return;
    }
  };
  await remember(dir);
  await walk(dir, '', 0);
  return { files, truncated };
}

/**
 * The subset of `files` (relative paths from walkAudioFiles) matching a search: every
 * whitespace-separated term must appear somewhere in the path, case-insensitively. Matching the
 * whole relative path rather than the filename is deliberate - "break" then also finds everything
 * inside a folder called Breaks, which is how sample libraries are usually organized.
 */
function matchAudioPaths(files, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return files;
  return files.filter((f) => {
    const hay = f.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// ---------------------------------------------------------------------------------------------
// Mono mixdown for the transient analysis below. The RIFF parsing itself lives in wav.js (the
// recorder's trim pass needs the channels kept); this only flattens what it returns.
// Returns { sampleRate, samples: Float32Array (mono mixdown) } or null for anything else.
// ---------------------------------------------------------------------------------------------

function readWav(filePath) {
  const raw = readWavRaw(filePath);
  if (!raw) return null;
  const { sampleRate, channels, frames, data } = raw;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) sum += data[i * channels + ch];
    samples[i] = sum / channels;
  }
  return { sampleRate, samples };
}

// ---------------------------------------------------------------------------------------------
// Transient detection - half-wave-rectified energy flux with an adaptive local threshold, the
// standard simple onset detector. Aimed at slicing drum loops, not polyphonic music.
// ---------------------------------------------------------------------------------------------

const HOP = 256; // ~5ms at 48k - the slice-position resolution
const MIN_GAP_SEC = 0.05; // two transients closer than this are one hit

function detectOnsets(samples, sampleRate) {
  const nHops = Math.floor(samples.length / HOP);
  if (nHops < 4) return [0];

  const rms = new Float32Array(nHops);
  for (let h = 0; h < nHops; h++) {
    let e = 0;
    for (let i = h * HOP; i < (h + 1) * HOP; i++) e += samples[i] * samples[i];
    rms[h] = Math.sqrt(e / HOP);
  }

  const flux = new Float32Array(nHops);
  for (let h = 1; h < nHops; h++) flux[h] = Math.max(0, rms[h] - rms[h - 1]);

  // Local mean over ~185ms on each side; an onset must clearly poke above its neighborhood.
  const radius = Math.max(2, Math.round((0.185 * sampleRate) / HOP));
  const minGapHops = Math.max(1, Math.round((MIN_GAP_SEC * sampleRate) / HOP));
  const peak = Math.max(...rms);
  const floor = peak * 0.02; // ignore "onsets" inside near-silence

  const onsets = [0];
  let lastOnset = -minGapHops;
  for (let h = 1; h < nHops; h++) {
    if (flux[h] <= 0 || rms[h] < floor) continue;
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, h - radius); k < Math.min(nHops, h + radius + 1); k++) {
      sum += flux[k];
      count++;
    }
    const isPeak = flux[h] >= flux[h - 1] && flux[h] >= (flux[h + 1] ?? 0);
    if (isPeak && flux[h] > (sum / count) * 2 + peak * 0.005 && h - lastOnset >= minGapHops) {
      // The flux peak lands on the first fully-loud window, ~one hop after the transient
      // actually starts - back off a hop so the slice keeps its attack.
      onsets.push(Math.max(0, h - 1) * HOP / samples.length);
      lastOnset = h;
    }
  }
  // Slice 0 is always the file start; drop a detected onset that's effectively at 0 anyway.
  if (onsets.length > 1 && onsets[1] < 0.002) onsets.splice(1, 1);
  return onsets;
}

/** Normalized (0..1) slice-start positions for a WAV file, or null if it can't be analyzed. */
function detectSlices(filePath) {
  const wav = readWav(filePath);
  if (!wav) return null;
  return detectOnsets(wav.samples, wav.sampleRate);
}

module.exports = {
  samplesRoot,
  setSamplesRoot,
  listPackFiles,
  resolveSampleFile,
  expandPackEntries,
  isAudioName,
  browseSamples,
  walkAudioFiles,
  matchAudioPaths,
  detectSlices,
  readWav,
};
