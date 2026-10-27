// A DJ deck's song player: the reader that runs on the audio thread (devices/song-reader.mjs),
// played block by block here exactly as the worklet plays it, and the glue that puts it on a
// track with its keylock (engine/song-player.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { SONG_FADE_SEC, SONG_HALT_SEC, SongReader } from './src/devices/song-reader.mjs';
import { SONG_LATENCY_SEC, keylockSemitones } from './src/engine/song-player.mjs';
import { STRETCH_DEVICES } from './src/devices/stretch.mjs';

const SR = 48000;
const BLOCK = 128;

/** A song whose sample at frame f is f (scaled into 16 bits), so a read says where it read. */
function ramp(frames) {
  const left = new Int16Array(frames);
  for (let i = 0; i < frames; i++) left[i] = i % 32768;
  return left;
}

/** Plays `blocks` blocks from `fromFrame`, returning the left channel. */
function render(reader, blocks, fromFrame = 0) {
  const out = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    reader.process(l, r, BLOCK, fromFrame + b * BLOCK);
    out.set(l, b * BLOCK);
  }
  return out;
}

const asFrame = (v) => Math.round(v * 32768);

test('a start lands on the sample its time names, from the position it names', () => {
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [ramp(SR)], frames: SR });
  // Starting 100 frames into the second block, at position frame 1000.
  reader.receive({ kind: 'start', pos: 1000 / SR, rate: 1, time: (BLOCK + 100) / SR });
  const out = render(reader, 4);
  for (let i = 0; i < BLOCK + 100; i++) assert.equal(out[i], 0, `silent before the start (frame ${i})`);
  // The fade in is a few milliseconds; past it, the read is the file, frame for frame.
  const settled = BLOCK + 100 + Math.ceil(SONG_FADE_SEC * SR) + 1;
  for (let i = settled; i < settled + 20; i++) assert.equal(asFrame(out[i]), 1000 + (i - BLOCK - 100));
});

test('a rate reads through the file that much faster, interpolated between samples', () => {
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [ramp(SR)], frames: SR });
  reader.receive({ kind: 'start', pos: 0, rate: 1.5, time: 0 });
  const out = render(reader, 8);
  const at = 600;
  // A ramp interpolates exactly: frame i reads position 1.5 * i.
  assert.ok(Math.abs(asFrame(out[at]) - 1.5 * at) < 0.01);
  reader.receive({ kind: 'rate', rate: 0.5, time: 8 * BLOCK / SR });
  const later = render(reader, 1, 8 * BLOCK);
  const step = (later[10] - later[9]) * 32768;
  assert.ok(Math.abs(step - 0.5) < 0.01, 'the new rate from the moment it was timed for');
});

test('a seek crossfades the old read out under the new one, and then plays only the new', () => {
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [ramp(SR)], frames: SR });
  reader.receive({ kind: 'start', pos: 0, rate: 1, time: 0 });
  render(reader, 10);
  reader.receive({ kind: 'seek', pos: 20000 / SR, time: 10 * BLOCK / SR });
  const out = render(reader, 10, 10 * BLOCK);
  assert.equal(reader.voices.length, 1, 'the old read is gone once it has faded');
  const settled = Math.ceil(SONG_FADE_SEC * SR) + 2;
  assert.equal(asFrame(out[settled]), 20000 + settled);
});

test('a pause slews to a halt and goes quiet; a stop releases; the end of the file is silence', () => {
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [new Int16Array(SR).fill(16384)], frames: SR });
  reader.receive({ kind: 'start', pos: 0, rate: 1, time: 0 });
  render(reader, 4);
  reader.receive({ kind: 'pause', time: 4 * BLOCK / SR });
  const after = render(reader, 20, 4 * BLOCK);
  const haltFrames = Math.ceil(SONG_HALT_SEC * SR);
  assert.ok(after.slice(haltFrames + 1).every((v) => v === 0), 'nothing left holding a sample after the halt');
  assert.equal(reader.voices.length, 0);

  reader.receive({ kind: 'start', pos: (SR - 300) / SR, rate: 1, time: 24 * BLOCK / SR });
  const end = render(reader, 8, 24 * BLOCK);
  assert.ok(end.slice(400).every((v) => v === 0), 'past the last sample there is nothing to read');
  assert.equal(reader.voices.length, 0);
});

test('a song that never loaded, or was freed, is silence rather than an error', () => {
  const reader = new SongReader(SR);
  reader.receive({ kind: 'start', pos: 0, rate: 1, time: 0 });
  assert.ok(render(reader, 2).every((v) => v === 0));
  reader.receive({ kind: 'load', planes: [ramp(SR)], frames: SR });
  reader.receive({ kind: 'free' });
  assert.ok(render(reader, 2).every((v) => v === 0));
});

test('a query answers where the read is, for checking the model against', () => {
  const said = [];
  const reader = new SongReader(SR, (m) => said.push(m));
  reader.receive({ kind: 'load', planes: [ramp(SR)], frames: SR });
  reader.receive({ kind: 'start', pos: 0, rate: 1, time: 0 });
  render(reader, 4);
  reader.receive({ kind: 'query', id: 7 });
  assert.equal(said[0].id, 7);
  assert.ok(Math.abs(said[0].pos - (4 * BLOCK) / SR) < 1e-9);
});

// --- on a track ---------------------------------------------------------------------------------

function makeEngine({ shift = true } = {}) {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
    deviceModules: shift ? new Map([['Shift', {}]]) : new Map(),
  });
  return { ctx, engine, warnings };
}

test('the keylock is the Shift device, late by exactly the latency the plain path is delayed by', () => {
  const shiftLatency = STRETCH_DEVICES.find((d) => d.id === 'Shift').latencySec;
  assert.equal(SONG_LATENCY_SEC, shiftLatency, 'one number, or toggling keylock would jump the song');
  const { engine } = makeEngine();
  engine.songLoad('t', { planes: [new Int16Array(10)], frames: 10 });
  const player = engine.songs.get('t');
  assert.equal(player.delay.delayTime.value, SONG_LATENCY_SEC);
  assert.ok(player.node.reaches(engine.tracks.get('t').input), 'the player is the track\'s source');
});

test('keylock crossfades onto the shifter, transposed against the rate, everything transposed', () => {
  const { engine } = makeEngine();
  engine.songLoad('t', { planes: [new Int16Array(10)], frames: 10 });
  engine.songStart('t', 0, 1.06, 0, true);
  const player = engine.songs.get('t');
  assert.ok(player.shift, 'the shifter is built the first time keylock is wanted');
  assert.ok(player.keyed.gain.rampedTo(1) && player.plain.gain.rampedTo(0));
  const pitch = player.shift.pitch;
  const spec = player.shift.spec;
  const semis = spec.min + (spec.max - spec.min) * pitch.value;
  assert.ok(Math.abs(semis - keylockSemitones(1.06)) < 1e-9);
  assert.ok(Math.abs(keylockSemitones(1.06) - -1.00876) < 1e-4);
  assert.equal(player.shift.built.node.parameters.get('tonality').value, 0, 'partials above a limit would stay repitched');
  engine.songRate('t', 0.94, 0);
  assert.ok(Math.abs(spec.min + (spec.max - spec.min) * pitch.value - keylockSemitones(0.94)) < 1e-9);
  engine.songKeylock('t', false, 0);
  assert.ok(player.plain.gain.rampedTo(1));
});

test('without the Shift binary the deck plays repitched and says why, once', () => {
  const { engine, warnings } = makeEngine({ shift: false });
  engine.songLoad('t', { planes: [new Int16Array(10)], frames: 10 });
  engine.songStart('t', 0, 1, 0, true);
  engine.songKeylock('t', true, 0);
  assert.equal(warnings.filter((w) => /keylock/.test(w)).length, 1);
  assert.equal(engine.songs.get('t').keylock, false);
});

test('the song is handed to the audio thread, not copied, and let go with the track', () => {
  const { engine } = makeEngine();
  const planes = [new Int16Array(10), new Int16Array(10)];
  engine.songLoad('t', { planes, frames: 10 });
  const player = engine.songs.get('t');
  const load = player.node.messages.find((m) => m.kind === 'load');
  assert.equal(load.planes, planes);
  engine.destroyTrack('t');
  assert.ok(player.node.messages.some((m) => m.kind === 'free'));
  assert.equal(engine.songs.has('t'), false);
});
