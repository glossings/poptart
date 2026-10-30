// The FreqShift effect. What earns the tests is the single sideband: a frequency shifter that
// leaks the other sideband is a ring modulator, so each direction is checked for landing where it
// says and for how little of the mirror image survives.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, denormalize, migrateState, normalize } from './src/descriptor.mjs';
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
    const { left } = run({ freq: BY * BIN }, bin);
    const wanted = magnitudeAt(left, bin + BY);
    const mirror = magnitudeAt(left, Math.abs(bin - BY));
    const original = magnitudeAt(left, bin);
    assert.ok(wanted > 0.2, `the shifted tone is there (${wanted})`);
    assert.ok(wanted / mirror > 100, `mirror rejection ${(20 * Math.log10(wanted / mirror)).toFixed(1)} dB`);
    assert.ok(wanted / original > 100, 'the original is gone at full mix');
  });
}

test('a negative frequency shifts down: it subtracts, and the upper sideband is gone', () => {
  const { left, right } = run({ freq: -BY * BIN }, IN);
  assert.ok(magnitudeAt(left, IN - BY) / magnitudeAt(left, IN + BY) > 100);
  assert.ok(magnitudeAt(right, IN - BY) / magnitudeAt(right, IN + BY) > 100, 'both channels, with wide off');
});

test('wide moves the right channel the other way from the left', () => {
  const up = run({ freq: BY * BIN, wide: 1 }, IN);
  assert.ok(magnitudeAt(up.left, IN + BY) / magnitudeAt(up.left, IN - BY) > 100);
  assert.ok(magnitudeAt(up.right, IN - BY) / magnitudeAt(up.right, IN + BY) > 100);
  const down = run({ freq: -BY * BIN, wide: 1 }, IN);
  assert.ok(magnitudeAt(down.left, IN - BY) / magnitudeAt(down.left, IN + BY) > 100);
  assert.ok(magnitudeAt(down.right, IN + BY) / magnitudeAt(down.right, IN - BY) > 100);
});

test('the one knob is signed and centered: zero in the middle, fine close to it, 5 kHz at the ends', () => {
  const freq = FREQSHIFT.params.find((p) => p.id === 'freq');
  assert.equal(freq.min, -5000);
  assert.equal(freq.max, 5000);
  assert.equal(denormalize(freq, 0.5), 0);
  assert.ok(Math.abs(denormalize(freq, 0.6) - 40) < 1e-9);
  assert.ok(Math.abs(denormalize(freq, 0.4) + 40) < 1e-9);
  assert.equal(denormalize(freq, 1), 5000);
  assert.equal(denormalize(freq, 0), -5000);
  assert.ok(!FREQSHIFT.params.some((p) => p.id === 'direction'), 'no direction menu');
  assert.equal(FREQSHIFT.params.find((p) => p.id === 'wide').ui, 'toggle');
});

test('a version 1 state - unsigned Freq and an up/down/split Direction - reads as this version', () => {
  const v1 = (freq, direction) => ({ device: 'FreqShift', version: 1, params: { freq, direction, feedback: 0.3, mix: 1 }, files: {} });
  assert.deepEqual(migrateState(FREQSHIFT, v1(269.838426, 0)).params, { freq: 269.838426, feedback: 0.3, mix: 1, wide: 0 });
  assert.deepEqual(migrateState(FREQSHIFT, v1(120, 1)).params, { freq: -120, feedback: 0.3, mix: 1, wide: 0 });
  assert.deepEqual(migrateState(FREQSHIFT, v1(5000, 2)).params, { freq: 5000, feedback: 0.3, mix: 1, wide: 1 });
  assert.equal(migrateState(FREQSHIFT, v1(5000, 2)).version, 2);
  // And the migrated map lands on the knobs: a split at 5 kHz is the top of the knob with wide on.
  const freq = FREQSHIFT.params.find((p) => p.id === 'freq');
  assert.equal(normalize(freq, migrateState(FREQSHIFT, v1(5000, 2)).params.freq), 1);
  assert.equal(normalize(freq, migrateState(FREQSHIFT, v1(5000, 1)).params.freq), 0);
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
