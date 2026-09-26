// The FreqShift effect. What earns the tests is the single sideband: a frequency shifter that
// leaks the other sideband is a ring modulator, so each direction is checked for landing where it
// says and for how little of the mirror image survives.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { FREQSHIFT, FreqShiftProcessor } from './src/devices/freqshift.mjs';

const SR = 48000;
const N = 8192;
const BIN = SR / N;

/** Magnitude of `signal` at bin `k` (a single DFT bin). */
function magnitudeAt(signal, k) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i++) {
    const w = (2 * Math.PI * k * i) / signal.length;
    re += signal[i] * Math.cos(w);
    im -= signal[i] * Math.sin(w);
  }
  return Math.hypot(re, im) / signal.length;
}

/** A bin-exact stereo sine through the effect; the last N samples, once the allpasses have settled. */
function run(params, inBin, block = 128) {
  const fx = new FreqShiftProcessor(SR, block);
  const full = { ...defaultValues(FREQSHIFT), ...params };
  const total = 2 * N;
  const input = new Float32Array(total);
  for (let i = 0; i < total; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * inBin * i) / N);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let at = 0; at < total; at += block) {
    const n = Math.min(block, total - at);
    const x = input.subarray(at, at + n);
    fx.process([x, x], [left.subarray(at, at + n), right.subarray(at, at + n)], n, full);
  }
  return { left: left.subarray(N), right: right.subarray(N) };
}

const IN = 100; // ~586 Hz
const BY = 20; // ~117 Hz

for (const [label, bin] of [['low', 8], ['mid', IN], ['high', 2000]]) {
  test(`shifting up moves a ${label} tone up by the frequency and leaves the mirror 40 dB down`, () => {
    const { left } = run({ freq: BY * BIN, direction: 0 }, bin);
    const wanted = magnitudeAt(left, bin + BY);
    const mirror = magnitudeAt(left, Math.abs(bin - BY));
    const original = magnitudeAt(left, bin);
    assert.ok(wanted > 0.2, `the shifted tone is there (${wanted})`);
    assert.ok(wanted / mirror > 100, `mirror rejection ${(20 * Math.log10(wanted / mirror)).toFixed(1)} dB`);
    assert.ok(wanted / original > 100, 'the original is gone at full mix');
  });
}

test('shifting down subtracts the frequency', () => {
  const { left } = run({ freq: BY * BIN, direction: 1 }, IN);
  assert.ok(magnitudeAt(left, IN - BY) / magnitudeAt(left, IN + BY) > 100);
});

test('split moves the left channel up and the right channel down', () => {
  const { left, right } = run({ freq: BY * BIN, direction: 2 }, IN);
  assert.ok(magnitudeAt(left, IN + BY) / magnitudeAt(left, IN - BY) > 100);
  assert.ok(magnitudeAt(right, IN - BY) / magnitudeAt(right, IN + BY) > 100);
});

test('a mix of zero is the dry signal, untouched', () => {
  const { left } = run({ freq: BY * BIN, mix: 0 }, IN);
  assert.ok(Math.abs(magnitudeAt(left, IN) - 0.25) < 1e-3);
  assert.ok(magnitudeAt(left, IN + BY) < 1e-6);
});

test('feedback shifts again on every pass, and stays bounded', () => {
  const { left } = run({ freq: BY * BIN, feedback: 0.9 }, IN);
  assert.ok(magnitudeAt(left, IN + 2 * BY) > 0.05, 'a second shift from the fed-back signal');
  assert.ok(left.every((v) => Number.isFinite(v) && Math.abs(v) < 4));
});
