'use strict';

// What the file picker reads on the desktop: a pack's files, one file drawn as the wavetable it
// would become, one file drawn as its waveform. The browser build answers the same three routes
// out of its own store (public/web/host.mjs); these are their desktop halves, over the sample
// library on disk, and they answer in the same shapes so the picker is one piece of code.
//
// Pure, with what they read handed in (the pack lister, the decoders, the device's own tables),
// so they are tested without a library or an engine.

const fs = require('node:fs');
const path = require('node:path');

/** "pack:name" split in two, or null where the string is not a file reference. */
function splitRef(ref) {
  const s = String(ref ?? '');
  const at = s.indexOf(':');
  if (at <= 0) return null;
  const pack = s.slice(0, at).trim();
  const name = s.slice(at + 1).trim();
  return pack && name ? { pack, name } : null;
}

/**
 * A pack's files by name, and what they weigh - the settings row says so. Names rather than
 * paths: a pack folder is flat here, and the name is what a `.param()` writes after the colon.
 */
function packFiles(pack, { listPackFiles }) {
  const paths = listPackFiles(pack) ?? [];
  let bytes = 0;
  for (const p of paths) {
    try { bytes += fs.statSync(p).size; } catch { /* a file that went away weighs nothing */ }
  }
  return { pack, files: paths.map((p) => path.basename(p)), count: paths.length, bytes };
}

/**
 * The file a reference names, as the engine resolves one (osc-engine's _fileInPack): by index,
 * or by its name with or without the extension, case-insensitively. Null where there is none.
 */
function fileInPack(pack, want, { listPackFiles }) {
  const paths = listPackFiles(pack);
  if (!paths || !paths.length) return null;
  const n = Number(want);
  if (Number.isInteger(n) && n >= 0) return paths[n % paths.length];
  const lower = String(want).toLowerCase();
  return paths.find((p) => {
    const base = path.basename(p).toLowerCase();
    return base === lower || base.replace(/\.[^.]+$/, '') === lower;
  }) ?? null;
}

/**
 * A table's frames small enough to draw and to send: a stack of a few dozen outlines, not a
 * megabyte of samples. Frames past the first few dozen are skipped evenly rather than truncated,
 * so the shape of the WHOLE table is what shows. The same picture host.mjs draws.
 */
function drawableStack(frames) {
  const MAX_DRAWN = 48;
  const POINTS = 96;
  const step = Math.max(1, Math.ceil(frames.length / MAX_DRAWN));
  const stack = [];
  for (let f = 0; f < frames.length; f += step) {
    const frame = frames[f];
    const out = new Array(POINTS);
    for (let i = 0; i < POINTS; i++) out[i] = frame[Math.floor((i / POINTS) * frame.length)];
    stack.push(out);
  }
  return stack;
}

/**
 * One file drawn as the wavetable it would become. A name with no pack in front of it is one of
 * the device's own tables, drawn from the frames the synth itself reads.
 */
function wavetablePreview(ref, { listPackFiles, decodeWav, framesOf, tables }) {
  const s = String(ref ?? '');
  if (!s.includes(':')) {
    const table = (tables ?? []).find((t) => t?.name === s);
    if (!table) throw new Error(`there is no table called ${JSON.stringify(s)}`);
    const frames = table.mips.map((m) => m[0]);
    return { ref: s, name: s, frameCount: table.frameCount, frameLength: frames[0].length, stack: drawableStack(frames) };
  }
  const at = splitRef(s);
  if (!at) throw new Error(`${JSON.stringify(s)} is not a file - write "pack:name"`);
  const file = fileInPack(at.pack, at.name, { listPackFiles });
  if (!file) throw new Error(`there is no file called ${JSON.stringify(s)} here`);
  const wav = decodeWav(fs.readFileSync(file));
  let mono = wav.channels[0];
  if (wav.channels.length > 1) {
    mono = new Float32Array(wav.channels[0].length);
    for (const c of wav.channels) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / wav.channels.length;
  }
  const frames = framesOf(mono, wav.frameLength ?? 2048);
  return { ref: s, name: at.name, frameCount: frames.length, frameLength: frames[0].length, sampleRate: wav.sampleRate, stack: drawableStack(frames) };
}

/**
 * One file drawn as its waveform: the lowest and highest sample per column, a couple of hundred
 * columns wide - which is what a waveform IS at that width, however long the file.
 */
function samplePreview(ref, { listPackFiles, readWavRaw }) {
  const s = String(ref ?? '');
  const at = splitRef(s);
  if (!at) throw new Error(`${JSON.stringify(s)} is not a file - write "pack:name"`);
  const file = fileInPack(at.pack, at.name, { listPackFiles });
  if (!file) throw new Error(`there is no file called ${JSON.stringify(s)} here`);
  const wav = readWavRaw(file);
  if (!wav) throw new Error(`${JSON.stringify(s)} could not be read`);
  const COLUMNS = 220;
  const channels = Math.max(1, wav.channels | 0);
  const frames = Math.floor(wav.data.length / channels);
  const per = Math.max(1, Math.floor(frames / COLUMNS));
  const peaks = [];
  for (let i = 0; i + 1 < frames; i += per) {
    let lo = 0;
    let hi = 0;
    for (let j = i; j < i + per && j < frames; j++) {
      const v = wav.data[j * channels];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    peaks.push([lo, hi]);
  }
  return { ref: s, name: at.name, channels, seconds: frames / (wav.sampleRate || 48000), peaks };
}

module.exports = { splitRef, packFiles, fileInPack, drawableStack, wavetablePreview, samplePreview };
