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

const AUDIO_EXTS = new Set(['.wav', '.aif', '.aiff', '.flac']);

// Sample library location. POPTART_SAMPLES_DIR always wins; otherwise the default library is
// ~/Downloads/gsamps_for_poptart, falling back to the legacy ~/.poptart/samples location if
// the default folder doesn't exist on this machine.
function samplesRoot() {
  if (process.env.POPTART_SAMPLES_DIR) return process.env.POPTART_SAMPLES_DIR;
  const defaultDir = path.join(os.homedir(), 'Downloads', 'gsamps_for_poptart');
  if (fs.existsSync(defaultDir)) return defaultDir;
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

// ---------------------------------------------------------------------------------------------
// Minimal WAV reader - enough of RIFF to get mono float samples out of the PCM/float encodings
// sample packs actually use (16/24/32-bit int, 32/64-bit float, plain or EXTENSIBLE header).
// Returns { sampleRate, samples: Float32Array (mono mixdown) } or null for anything else.
// ---------------------------------------------------------------------------------------------

function readWav(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { off: body, size };
    if (id === 'data') data = { off: body, size: Math.min(size, buf.length - body) };
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data || fmt.size < 16) return null;

  let format = buf.readUInt16LE(fmt.off);
  const channels = buf.readUInt16LE(fmt.off + 2);
  const sampleRate = buf.readUInt32LE(fmt.off + 4);
  const bits = buf.readUInt16LE(fmt.off + 14);
  if (format === 0xfffe && fmt.size >= 40) format = buf.readUInt16LE(fmt.off + 24); // EXTENSIBLE: real format is in the GUID
  if (!channels || !sampleRate) return null;

  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * channels));
  if (!frames) return null;

  const readSample = (() => {
    if (format === 1 && bits === 16) return (o) => buf.readInt16LE(o) / 0x8000;
    if (format === 1 && bits === 24) return (o) => ((buf.readIntLE(o, 3) << 8) >> 8) / 0x800000;
    if (format === 1 && bits === 32) return (o) => buf.readInt32LE(o) / 0x80000000;
    if (format === 1 && bits === 8) return (o) => (buf.readUInt8(o) - 128) / 128;
    if (format === 3 && bits === 32) return (o) => buf.readFloatLE(o);
    if (format === 3 && bits === 64) return (o) => buf.readDoubleLE(o);
    return null;
  })();
  if (!readSample) return null;

  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      sum += readSample(data.off + (i * channels + ch) * bytesPer);
    }
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

module.exports = { samplesRoot, listPackFiles, detectSlices, readWav };
