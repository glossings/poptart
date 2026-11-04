// A DJ deck's song player: the reader that runs on the audio thread (devices/song-reader.mjs),
// played block by block here exactly as the worklet plays it - plain and keylocked - and the glue
// that puts it on a track (engine/song-player.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { SONG_FADE_SEC, SONG_HALT_SEC, SongReader } from './src/devices/song-reader.mjs';
import { KEYLOCK_CEILING, Keylock, KeylockPlayer } from './src/dsp/keylock.mjs';

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

/** A song of two tones, 16-bit: something a keylock has to hold the pitch of. */
function tones(frames) {
  const left = new Int16Array(frames);
  for (let i = 0; i < frames; i++) left[i] = Math.round(8000 * (Math.sin(2 * Math.PI * 220 * i / SR) + Math.sin(2 * Math.PI * 3300 * i / SR)));
  return left;
}

const rms = (x, from, to) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return Math.sqrt(e / (to - from));
};

test('keylocked, the reader plays the keylock at the playhead, no later than a plain read', () => {
  const song = tones(SR * 2);
  const plain = new SongReader(SR);
  const keyed = new SongReader(SR);
  for (const r of [plain, keyed]) r.receive({ kind: 'load', planes: [song], frames: song.length });
  plain.receive({ kind: 'start', pos: 0.25, rate: 1, time: 0 });
  keyed.receive({ kind: 'start', pos: 0.25, rate: 1, time: 0, keylock: true });
  const a = render(plain, 100);
  const b = render(keyed, 100);
  // At rate 1 the keylock reconstructs its read: the same samples, on the same frames.
  let err = 0;
  for (let i = 1000; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
  assert.ok(err < 2e-3, `the keylocked read is ${err} away from the plain one at rate 1`);
});

test('the keylocked read is the keylock\'s own, faded in as a start is', () => {
  const song = tones(SR * 2);
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [song], frames: song.length });
  reader.receive({ kind: 'start', pos: 0.25, rate: 0.94, time: 0, keylock: true });
  const out = render(reader, 200);
  const kl = new KeylockPlayer(SR, 2, Math.round(SONG_FADE_SEC * SR));
  kl.setSource([song, song], song.length, 1 / 32768, 1);
  kl.start(0.25 * SR);
  const want = new Float32Array(out.length);
  const o = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
  for (let b = 0; b < 200; b++) {
    kl.process(o, BLOCK, 0.94);
    for (let i = 0; i < BLOCK; i++) want[b * BLOCK + i] = o[0][i] * Math.min(1, (b * BLOCK + i) / Math.round(SONG_FADE_SEC * SR));
  }
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - want[i]) < 1e-6, `frame ${i}: ${out[i]} against ${want[i]}`);
});

test('a keylocked seek crossfades, its position is the new one, and a pause leaves no drone', () => {
  const said = [];
  const song = tones(SR * 3);
  const reader = new SongReader(SR, (m) => said.push(m));
  reader.receive({ kind: 'load', planes: [song], frames: song.length });
  reader.receive({ kind: 'start', pos: 0, rate: 0.94, time: 0, keylock: true });
  render(reader, 40);
  reader.receive({ kind: 'seek', pos: 2, time: 40 * BLOCK / SR });
  const out = render(reader, 40, 40 * BLOCK);
  // Level held through the crossfade: two copies of the same tones, so no dip to speak of.
  const level = rms(out, 1000, 4000);
  for (let at = 0; at < 1000; at += 100) assert.ok(rms(out, at, at + 100) > 0.3 * level, `a hole in the crossfade at ${at}`);
  reader.receive({ kind: 'query', id: 1 });
  assert.ok(Math.abs(said[0].pos - (2 + (40 * BLOCK * 0.94) / SR)) < 1e-6, `heard at ${said[0].pos}`);
  reader.receive({ kind: 'pause', time: 80 * BLOCK / SR });
  const paused = render(reader, 40, 80 * BLOCK);
  assert.ok(paused.slice(Math.ceil(SONG_HALT_SEC * SR) + 1).every((v) => v === 0), 'a paused keylock is silent');
});

/** Two tones at `amp` (a float song), louder from `loudFrom` to `loudTo` by `boost`. */
function hotTones(frames, amp, boost = 1, loudFrom = 0, loudTo = 0) {
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const g = i >= loudFrom && i < loudTo ? boost : 1;
    x[i] = amp * g * (Math.sin(2 * Math.PI * 220 * i / SR) + Math.sin(2 * Math.PI * 3300 * i / SR + 0.5 * Math.sin(2 * Math.PI * 3 * i / SR)));
  }
  return x;
}

/** A Keylock whose ceiling stage is a plain 63-sample delay: the stretcher's output, as heard. */
function unlimited(kl) {
  kl.limit = function (st, s) {
    const at = this.clock & 63;
    for (let c = 0; c < this.channels; c++) this.ahead[c][at] = st[c][s];
    this.clock++;
    return this.clock & 63;
  };
  return kl;
}

function playKeylock(kl, song, frames, rate, seeks = {}) {
  kl.setSource([song, song], song.length, 1, 1);
  kl.seek(0.1 * SR);
  const out = new Float64Array(frames);
  const o = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
  for (let b = 0; b * BLOCK < frames; b++) {
    if (seeks[b] != null) kl.seek(seeks[b]);
    kl.process(o, BLOCK, rate);
    out.set(o[0].subarray(0, Math.min(BLOCK, frames - b * BLOCK)), b * BLOCK);
  }
  return out;
}

test('a keylocked read peaks no higher than the ceiling, and on time', () => {
  // Peaks of 1.5, stretched at 0.94, with a seek: held at -0.1 dBFS throughout.
  const song = hotTones(SR * 3, 0.75);
  const seeks = { 200: 1.3 * SR };
  const out = playKeylock(new Keylock(SR, 2), song, SR * 2, 0.94, seeks);
  const raw = playKeylock(unlimited(new Keylock(SR, 2)), song, SR * 2, 0.94, seeks);
  let peak = 0;
  let rawPeak = 0;
  for (let i = 0; i < out.length; i++) {
    peak = Math.max(peak, Math.abs(out[i]));
    rawPeak = Math.max(rawPeak, Math.abs(raw[i]));
  }
  assert.ok(rawPeak > 1.3, `the stretcher peaked at only ${rawPeak}`);
  assert.ok(peak <= KEYLOCK_CEILING * (1 + 1e-12), `the keylock peaked at ${peak}`);
  assert.ok(peak > 0.98, `the keylock peaked at only ${peak}`);
  // Only a gain: every sample is the stretcher's own, on the same frame, scaled by at most 1.
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out[i]) <= Math.abs(raw[i]) + 1e-15, `frame ${i}: ${out[i]} against ${raw[i]}`);
    assert.ok(out[i] * raw[i] >= 0, `frame ${i} changed sign`);
  }
});

test('below the ceiling the keylock\'s audio passes bit for bit, and again once a loud passage has gone', () => {
  for (const rate of [0.94, 1, 1.06]) {
    const quiet = hotTones(SR * 2, 0.4);
    const a = playKeylock(new Keylock(SR, 2), quiet, SR, rate, { 100: 0.6 * SR });
    const b = playKeylock(unlimited(new Keylock(SR, 2)), quiet, SR, rate, { 100: 0.6 * SR });
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `rate ${rate}, frame ${i}`);
    // Half a second over the ceiling, then two seconds under it.
    const song = hotTones(SR * 4, 0.4, 2.5, 0.2 * SR, 0.7 * SR);
    const c = playKeylock(new Keylock(SR, 2), song, SR * 3, rate);
    const d = playKeylock(unlimited(new Keylock(SR, 2)), song, SR * 3, rate);
    let held = false;
    for (let i = 0; i < SR; i++) if (c[i] !== d[i]) held = true;
    assert.ok(held, `rate ${rate}: the loud passage was not held`);
    for (let i = 2 * SR; i < c.length; i++) assert.equal(c[i], d[i], `rate ${rate}, frame ${i}, after the loud passage`);
  }
});

test('switching keylock while playing crossfades between the two reads at the playhead', () => {
  const song = tones(SR * 2);
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [song], frames: song.length });
  reader.receive({ kind: 'start', pos: 0, rate: 1, time: 0 });
  render(reader, 20);
  reader.receive({ kind: 'keylock', on: true, time: 20 * BLOCK / SR });
  const on = render(reader, 20, 20 * BLOCK);
  assert.equal(reader.voices.length, 0, 'the plain read has faded out');
  // At rate 1 the two reads are the same song in the same place: the switch is inaudible.
  let worst = 0;
  for (let i = 0; i < on.length; i++) worst = Math.max(worst, Math.abs(on[i] - song[20 * BLOCK + i] / 32768));
  assert.ok(worst < 2e-3, `the switch moved the song by ${worst}`);
  reader.receive({ kind: 'keylock', on: false, time: 40 * BLOCK / SR });
  render(reader, 20, 40 * BLOCK);
  assert.equal(reader.voices.length, 1);
  assert.equal(reader.kv.gain, 0, 'the keylocked read has faded out');
});

test('a start that arrives late begins as far on as it is late, so it keeps time', () => {
  const reader = new SongReader(SR);
  reader.receive({ kind: 'load', planes: [ramp(SR)], frames: SR });
  render(reader, 4);
  reader.receive({ kind: 'start', pos: 1000 / SR, rate: 1, time: 100 / SR });
  const out = render(reader, 4, 4 * BLOCK);
  const settled = Math.ceil(SONG_FADE_SEC * SR) + 1;
  assert.equal(asFrame(out[settled]), 1000 + (4 * BLOCK - 100) + settled);
});

// --- on a track ---------------------------------------------------------------------------------

function makeEngine() {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  return { ctx, engine, warnings };
}

test('the player plays straight to the track, keylock on or off, told when each change is heard', () => {
  const { ctx, engine } = makeEngine();
  engine.songLoad('t', { planes: [new Int16Array(10)], frames: 10 });
  engine.songStart('t', 0, 1.06, 0.2, false);
  const player = engine.songs.get('t');
  assert.ok(player.node.reaches(engine.tracks.get('t').input), 'the player is the track\'s source');
  assert.equal(ctx.created.filter((n) => n.kind === 'delay').length, 0);
  assert.deepEqual(player.node.messages.find((m) => m.kind === 'start'), { kind: 'start', pos: 0, rate: 1.06, time: 0.2, keylock: false });
  engine.songKeylock('t', true, 0.5);
  assert.deepEqual(player.node.messages.at(-1), { kind: 'keylock', on: true, time: 0.5 });
  engine.songKeylock('t', true, 0.6);
  assert.equal(player.node.messages.filter((m) => m.kind === 'keylock').length, 1, 'no change, nothing sent');
  engine.songStart('t', 3, 0.94, 1, true);
  assert.equal(player.node.messages.at(-1).keylock, true);
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
