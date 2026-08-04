'use strict';

// Sample-pack discovery and WAV analysis for the sampler (`s("bd")` patterns). A pack is a
// folder of audio files under the samples root; files are addressed by index (`.i(4)`) in
// filename-sorted order, strudel-style. scsynth does the actual playback (Buffer.read supports
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
  browseSamples,
  detectSlices,
  readWav,
};
