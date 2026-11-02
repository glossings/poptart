'use strict';

// What a device window draws a loaded file as, on the desktop.
//
// The browser's engine keeps the outline of every file it loads onto a device control as audio
// (its `waves`) and the frames of every file it loads as a table (its `tables`), taken as the
// file is decoded, and the window's pictures read them. On the desktop the file goes straight from
// disk into a server buffer and nothing in Node ever holds the samples, so both are read here
// instead - from the file the engine says is in each option slot (osc-engine's deviceSlot
// `sources`), with the browser's own decoder, outline and table code, so both builds draw the
// same picture of the same file.

const fsp = require('node:fs/promises');
const { resolveSongFile } = require('@poptart/osc-engine/songs');

// "path|table" -> { tag, picture: Promise<...| null> }. A file is read once for as long as it is
// the same file (its mtime and size); a failed read is kept too, so a window polling its picture
// does not read it again on every frame.
const filePictures = new Map();

// space name -> { seconds, outline }: the last synthesized impulse drawn of each space.
const spaceOutlines = new Map();

/**
 * One file as the browser's engine keeps it for a picture: as audio, the outline of its first
 * channel at its own rate; as a table, its frames (`{ frameCount, mips, names }`, each frame the
 * first level of its pyramid, as the engine files it). Non-WAV files take the same decode the song
 * decks use (songs.js), since only a WAV is read in Node. Null when the file cannot be read.
 */
async function filePicture(kit, filePath, { table = false, resolve = resolveSongFile } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return null;
  }
  const key = `${filePath}|${table}`;
  const tag = `${stat.mtimeMs}|${stat.size}`;
  const had = filePictures.get(key);
  if (had?.tag === tag) return had.picture;
  const picture = (async () => {
    const wavPath = (await resolve(filePath, { wav: true })).path;
    const wav = kit.wavfile.decodeWav(await fsp.readFile(wavPath));
    if (!table) return kit.outline.outlineOf(wav.channels[0], wav.sampleRate);
    const frames = kit.wavfile.tableFramesOf(wav);
    return { frameCount: frames.length, mips: frames.map((frame) => [frame]), names: null };
  })().catch((err) => {
    console.warn(`[poptart] ${filePath} could not be read for its picture - ${err?.message ?? err}`);
    return null;
  });
  filePictures.set(key, { tag, picture });
  return picture;
}

/** A stand-in for the one AudioContext call synthesizeImpulse makes. */
function bufferMaker(sampleRate) {
  return {
    sampleRate,
    createBuffer(count, length, rate) {
      const channels = Array.from({ length: count }, () => new Float32Array(length));
      return { sampleRate: rate, numberOfChannels: count, length, getChannelData: (c) => channels[c] };
    },
  };
}

/**
 * The outline of a synthesized space - the browser's convolver takes it as it builds the space
 * (builtins.mjs), and here it is built by the same function at the engine's rate.
 */
function spaceOutline(kit, name, seconds, sampleRate) {
  const had = spaceOutlines.get(name);
  if (had?.seconds === seconds && had.sampleRate === sampleRate) return had.outline;
  const buffer = kit.builtins.synthesizeImpulse(bufferMaker(sampleRate), name, seconds);
  const outline = kit.outline.outlineOf(buffer.getChannelData(0), buffer.sampleRate);
  spaceOutlines.set(name, { seconds, sampleRate, outline });
  return outline;
}

/**
 * What a slot's device has loaded, as the browser's engine keeps it for its pictures, by option
 * slot: `waves` ({ name, peaks, seconds }) for what it plays as audio - and for a space the
 * convolver synthesizes - and `tables` ({ name, frameCount, mips, names }) for what it plays as a
 * wavetable. Each is null when there is none.
 *
 * `at` is osc-engine's deviceSlot answer; `values` the controls in real units.
 */
async function deviceSources(kit, descriptor, values, at, { sampleRate = 48000, resolve } = {}) {
  let waves = null;
  let tables = null;
  for (const [index, { name, path, table }] of Object.entries(at?.sources ?? {})) {
    const picture = await filePicture(kit, path, { table, resolve });
    if (!picture) continue;
    if (table) (tables ??= {})[index] = { name, ...picture };
    else (waves ??= {})[index] = { name, ...picture };
  }
  // The convolver's own spaces exist nowhere but in the device: drawn from the same synthesis.
  if (descriptor.id === kit.builtins.CONVOLVER.id) {
    const ir = descriptor.params.find((p) => p.id === 'ir');
    const index = Math.round(values.ir ?? ir.default);
    const name = kit.builtins.IR_NAMES[index];
    if (name && !waves?.[index]) {
      const size = values.size ?? descriptor.params.find((p) => p.id === 'size').default;
      (waves ??= {})[index] = { name, ...spaceOutline(kit, name, size, sampleRate) };
    }
  }
  return { waves, tables };
}

/** The shipped tables, then whatever a slot loaded into the spare slots (the browser host's rule). */
function withLoadedTables(shipped, loaded) {
  if (!loaded) return shipped;
  const out = [...shipped];
  for (const [index, table] of Object.entries(loaded)) out[Number(index)] = table;
  return out;
}

module.exports = { deviceSources, filePicture, withLoadedTables };
