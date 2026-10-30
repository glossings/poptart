// The Looper: a take on the grid, played back locked to the bar, overdubbed, cleared.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { LOOPER, LOOPER_CHUNK, LooperProcessor } from './src/devices/looper.mjs';
import { SYNC_OPTIONS } from './src/dsp/sync.mjs';

const SR = 8000;
const BLOCK = 128;
const BAR = 2 * SR;   // one bar at 120 bpm

/** A deterministic noise, so every sample of the input can be told from every other. */
function noise(length, seed = 22222) {
  let x = seed;
  return Float32Array.from({ length }, () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296 - 0.5;
  });
}

/**
 * Runs the looper over `input`. `record` and `clear` are functions of the sample index, handed
 * over per sample as a patched control would be; `timeAt` is where the transport is at a block's
 * first sample, in seconds.
 */
function run(input, { record = () => 0, clear = () => 0, timeAt = (at) => at / SR, bpm = 120, fx = null, ...params } = {}) {
  const looper = fx ?? new LooperProcessor(SR);
  looper.setTempo(bpm, 0);
  const full = { ...defaultValues(LOOPER), dry: 0, ...params };
  const out = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += BLOCK) {
    const n = Math.min(BLOCK, input.length - at);
    const l = input.subarray(at, at + n);
    full.record = Float32Array.from({ length: n }, (_, i) => record(at + i));
    full.clear = Float32Array.from({ length: n }, (_, i) => clear(at + i));
    looper.process([l, l], [out.subarray(at, at + n)], n, full, null, timeAt(at));
  }
  return { out, looper };
}

const between = (from, to) => (i) => (i >= from && i < to ? 1 : 0);

function assertNear(got, want, what, tol = 1e-6) {
  assert.ok(Math.abs(got - want) < tol, `${what}: ${got} is not ${want}`);
}

test('a take on the grid sets the loop length, and a late release is cut back to the line', () => {
  const input = noise(6 * BAR);
  // On at the first line, off 10 ms after the second bar's line: two bars, not two and a bit.
  const { out, looper } = run(input, { record: between(0, 2 * BAR + 0.01 * SR) });
  assert.equal(looper.length, 2 * BAR);
  assert.equal(looper.loopBeats, 8);
  // Played from the third bar on, the loop is the take, sample for sample away from the seam.
  for (let k = 0.01 * SR; k < 2 * BAR - 64; k++) assertNear(out[2 * BAR + k], input[k], `loop sample ${k}`);
  for (let k = 64; k < 2 * BAR - 64; k++) assertNear(out[4 * BAR + k], input[k], `second pass, sample ${k}`);
});

test('an edge within 30 ms after a line counts as on it; a later one waits for the next', () => {
  const input = noise(6 * BAR);
  // 20 ms late: the take is on line 0, and the 20 ms that went by are silence in the loop.
  const late = Math.round(0.02 * SR);
  const { out, looper } = run(input, { record: between(late, BAR) });
  assert.equal(looper.length, BAR);
  for (let k = 64; k < late; k++) assert.equal(out[2 * BAR + k], 0, `the skipped start, sample ${k}`);
  for (let k = late + 1; k < BAR - 64; k++) assertNear(out[2 * BAR + k], input[k], `loop sample ${k}`);

  // 50 ms late: the take waits for line 1, and a release 50 ms after line 2 waits for line 3.
  const slow = Math.round(0.05 * SR);
  const second = run(input, { record: between(slow, 2 * BAR + slow) });
  assert.equal(second.looper.length, 2 * BAR);
  assert.equal(second.looper.origin, 4);
  for (let k = 64; k < 2 * BAR - 64; k++) assertNear(second.out[3 * BAR + k], input[BAR + k], `loop sample ${k}`);
});

test('a locked loop stays on the bar when the transport jumps', () => {
  const input = noise(8 * BAR);
  // One bar recorded, then the transport relocated half a bar on, mid-play.
  const jump = 0.37 * 2;
  const { out } = run(input, {
    record: between(0, BAR),
    timeAt: (at) => (at >= 3 * BAR ? at / SR + jump : at / SR),
  });
  for (let i = 3 * BAR + BLOCK; i < 5 * BAR; i += 97) {
    const k = Math.floor(((i / SR + jump) * SR) % BAR);
    const frac = ((i / SR + jump) * SR) % BAR - k;
    if (k < 64 || k > BAR - 65) continue;
    const want = input[k] + (input[k + 1] - input[k]) * frac;
    assertNear(out[i], want, `sample ${i}`, 1e-5);
  }
});

test('an overdub layers at feedback 1 and replaces at feedback 0', () => {
  const a = noise(BAR, 1);
  const b = noise(BAR, 2);
  const input = new Float32Array(5 * BAR);
  input.set(a, 0);
  input.set(b, 2 * BAR);
  // Take one bar of a, play it one bar, overdub b over the whole of the next, then listen.
  const record = (i) => (i < BAR || (i >= 2 * BAR && i < 3 * BAR) ? 1 : 0);
  const layered = run(input, { record, feedback: 1 }).out;
  const replaced = run(input, { record, feedback: 0 }).out;
  for (let k = 128; k < BAR - 128; k++) {
    assertNear(layered[4 * BAR + k], a[k] + b[k], `layered, sample ${k}`, 1e-5);
    assertNear(replaced[4 * BAR + k], b[k], `replaced, sample ${k}`, 1e-5);
  }
});

test('clear empties the loop, and the next take is a new first take', () => {
  const input = noise(8 * BAR);
  const { out, looper } = run(input, {
    record: (i) => (i < BAR || (i >= 4 * BAR && i < 6 * BAR) ? 1 : 0),
    clear: between(3 * BAR, 3 * BAR + 10),
  });
  for (let i = 3 * BAR + 1; i < 4 * BAR; i++) assert.equal(out[i], 0, `cleared, sample ${i}`);
  // Re-recorded for two bars: a two-bar loop of what played then.
  assert.equal(looper.length, 2 * BAR);
  for (let k = 64; k < 2 * BAR - 64; k += 7) assertNear(out[6 * BAR + k], input[4 * BAR + k], `new loop, sample ${k}`);
});

test('a free take runs as long as Record is held, across several chunks', () => {
  const take = 3 * LOOPER_CHUNK + 12345;
  const input = noise(3 * take + 200);
  const { out, looper } = run(input, { record: between(100, 100 + take), quantize: SYNC_OPTIONS.indexOf('free') });
  assert.equal(looper.length, take);
  assert.equal(looper.locked, false);
  for (let k = 64; k < take - 64; k += 13) {
    assertNear(out[100 + take + k], input[100 + k], `first pass, sample ${k}`);
    assertNear(out[100 + 2 * take + k], input[100 + k], `second pass, sample ${k}`);
  }
});

test('speed and reverse move the playhead like tape, and never jump it', () => {
  const input = noise(6 * BAR);
  const free = SYNC_OPTIONS.indexOf('free');
  const fast = run(input, { record: between(0, BAR), quantize: free, speed: 2 }).out;
  for (let j = 64; j < BAR / 2 - 64; j++) assertNear(fast[BAR + j], input[2 * j], `double speed, sample ${j}`);
  const back = run(input, { record: between(0, BAR), quantize: free, reverse: 1 }).out;
  // Backwards from the start: the playhead wraps to the end and runs down.
  for (let j = 64; j < BAR - 128; j++) assertNear(back[BAR + j], input[BAR - j], `reversed, sample ${j}`);
  // A locked loop turned round mid-play carries on from where it was.
  const turn = 2 * BAR + 333;
  const fx = new LooperProcessor(SR);
  run(input.subarray(0, turn), { fx, record: between(0, BAR) });
  const params = { ...defaultValues(LOOPER), dry: 0, reverse: 1 };
  const two = new Float32Array(2);
  const live = input.subarray(turn, turn + 2);
  fx.process([live, live], [two], 2, params, null, turn / SR);
  // The first sample reversed is where the loop had got to; the next is one before it.
  assertNear(two[0], input[turn - 2 * BAR], 'where the loop had got to', 1e-6);
  assertNear(two[1], input[turn - 2 * BAR - 1], 'one sample back', 1e-6);
});

test('Record and Clear never reach a saved state', () => {
  const record = LOOPER.params.find((p) => p.id === 'record');
  const clear = LOOPER.params.find((p) => p.id === 'clear');
  assert.equal(record.saved, false);
  assert.equal(clear.saved, false);
  assert.ok(LOOPER.params.filter((p) => p.saved === false).length === 2);
});
