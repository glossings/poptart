// The Limiter.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { LIMITER, LimiterProcessor } from './src/devices/limiter.mjs';

const SR = 48000;
const BLOCK = 128;

test('a new limiter passes a signal under its ceiling at full level from the first sample', () => {
  const fx = new LimiterProcessor(SR);
  const params = defaultValues(LIMITER);
  const count = BLOCK * 8;
  const input = Float32Array.from({ length: count }, (_, i) => Math.fround(0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)));
  const out = new Float32Array(count);
  const reductions = [];
  for (let at = 0; at < count; at += BLOCK) {
    fx.process([input.subarray(at, at + BLOCK)], [out.subarray(at, at + BLOCK)], BLOCK, params);
    reductions.push(fx.report().meters.curve.grDb);
  }
  // Late by the lookahead and otherwise untouched: nothing was over, so nothing is taken off.
  const late = fx.look;
  for (let i = late; i < count; i++) assert.ok(Math.abs(out[i] - input[i - late]) < 1e-6, `sample ${i} is ${out[i]}, not ${input[i - late]}`);
  assert.deepEqual(reductions, reductions.map(() => 0));
});

test('a peak over the ceiling is brought down to it', () => {
  const fx = new LimiterProcessor(SR);
  const params = { ...defaultValues(LIMITER), gain: 12 };
  const count = BLOCK * 32;
  const input = Float32Array.from({ length: count }, (_, i) => Math.fround(0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)));
  const out = new Float32Array(count);
  for (let at = 0; at < count; at += BLOCK) fx.process([input.subarray(at, at + BLOCK)], [out.subarray(at, at + BLOCK)], BLOCK, params);
  const ceiling = 10 ** (params.ceiling / 20);
  assert.ok(out.every((v) => Math.abs(v) <= ceiling + 1e-6));
  assert.ok(fx.report().meters.curve.grDb < -5);
});
