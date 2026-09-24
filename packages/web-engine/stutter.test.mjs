// The Stutter effect: a caught slice, repeated on the grid.
//
// The buffer the slice is caught from is four seconds long, and a grid division times the number
// of repeats can easily run past that. What has to hold is that every repeat is the slice that
// was caught - the recording must never write over it while it plays - and that once the repeat
// is over, the next catch is of what has been playing since, not of anything older.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { STUTTER, StutterProcessor } from './src/devices/stutter.mjs';
import { SYNC_OPTIONS } from './src/dsp/sync.mjs';

const SR = 8000;
const BLOCK = 128;

/** A deterministic noise, so every sample of the input can be told from every other. */
function noise(length) {
  let x = 22222;
  return Float32Array.from({ length }, () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296 - 0.5;
  });
}

function run(input, params) {
  const fx = new StutterProcessor(SR);
  fx.setTempo(120, 0);
  const full = { ...defaultValues(STUTTER), ...params };
  const out = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += BLOCK) {
    const n = Math.min(BLOCK, input.length - at);
    const l = input.subarray(at, at + n);
    fx.process([l, l], [out.subarray(at, at + n)], n, full);
  }
  return out;
}

test('every repeat is the slice that was caught, however long the repeats run', () => {
  // Every eight seconds, a two-second slice four times over: eight seconds of repeats out of a
  // four-second buffer. Written over, the later repeats would be the live input.
  const interval = SYNC_OPTIONS.indexOf('4 bars');      // 8 s at 120
  const grid = SYNC_OPTIONS.indexOf('1 bar');           // 2 s
  const L = 2 * SR;
  const catchAt = 8 * SR;
  const input = noise(26 * SR);
  const out = run(input, { interval, grid, repeats: 4, chance: 1, dry: 0, wet: 1, decay: 0, pitch: 0 });
  for (let k = 0; k < 4; k++) {
    for (let p = 64; p < L - 64; p++) {
      const got = out[catchAt + k * L + p];
      const want = input[catchAt - L + p];
      assert.ok(Math.abs(got - want) < 1e-6, `repeat ${k + 1}, sample ${p}: ${got} is not the caught slice's ${want}`);
    }
  }

  // At sixteen seconds the repeats have only just finished and the buffer holds nothing recent:
  // that catch is let go, and the track plays as it is.
  for (let i = 16 * SR; i < 16.5 * SR; i++) assert.equal(out[i], input[i], `sample ${i} should be the live input`);

  // At twenty-four the buffer has been recording again for eight seconds, and the catch is of
  // the two just gone.
  const next = 24 * SR;
  for (let p = 64; p < L - 64; p++) {
    assert.ok(Math.abs(out[next + p] - input[next - L + p]) < 1e-6, `the next catch, sample ${p}, is not fresh audio`);
  }
});

test('the dry path is untouched between repeats', () => {
  const input = noise(4 * SR);
  const out = run(input, { interval: SYNC_OPTIONS.indexOf('1 bar'), grid: SYNC_OPTIONS.indexOf('1/4'), repeats: 2, dry: 0 });
  // The first catch is at two seconds; before it everything is the input as it came.
  for (let i = 0; i < 2 * SR; i++) assert.equal(out[i], input[i]);
});

test('a number nobody can play is not caught and repeated', () => {
  const input = noise(8 * SR);
  input[1.9 * SR] = NaN;
  const out = run(input, { interval: SYNC_OPTIONS.indexOf('1 bar'), grid: SYNC_OPTIONS.indexOf('1/2'), repeats: 4, dry: 0 });
  // The slice caught at two seconds covers the NaN; it is repeated as silence, not as NaN.
  for (let i = 2 * SR; i < 4 * SR; i++) assert.ok(Number.isFinite(out[i]), `sample ${i} was ${out[i]}`);
});
