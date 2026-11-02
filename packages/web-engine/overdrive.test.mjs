// The Overdrive effect.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { OVERDRIVE, OverdriveProcessor } from './src/devices/overdrive.mjs';

const SR = 48000;
const BLOCK = 128;

/** A second of a sine in the driven region, and how far from it the second half comes out, in dB. */
function levelDb(params, amplitude, hz = 1000) {
  const n = SR;
  const input = Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / SR));
  const fx = new OverdriveProcessor(SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const full = { ...defaultValues(OVERDRIVE), ...params };
  for (let at = 0; at < n; at += BLOCK) {
    const x = input.subarray(at, at + BLOCK);
    fx.process([x, x], [left.subarray(at, at + BLOCK), right.subarray(at, at + BLOCK)], BLOCK, full);
  }
  const rms = (x) => Math.sqrt(x.subarray(n / 2).reduce((a, v) => a + v * v, 0) / (n / 2));
  return 20 * Math.log10(rms(left) / rms(input));
}

test('the drive changes the grit and not the level, at a track\'s level', () => {
  for (const params of [{}, { drive: 0 }, { drive: 30 }, { drive: 48, dynamics: 1 }, { dynamics: 0 }]) {
    const db = levelDb(params, 0.17825);
    assert.ok(Math.abs(db) < 1.5, `${JSON.stringify(params)} came out ${db.toFixed(1)} dB from the input`);
  }
});

test('the makeup does not depend on the signal: a hit after silence comes through whole', () => {
  const n = Math.round(1.5 * SR / BLOCK) * BLOCK;
  const input = Float32Array.from({ length: n }, (_, i) => (i < SR ? 0 : 0.4 * Math.sin((2 * Math.PI * 1000 * (i - SR)) / SR)));
  const fx = new OverdriveProcessor(SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const params = { ...defaultValues(OVERDRIVE), drive: 30, dynamics: 0 };
  for (let at = 0; at < n; at += BLOCK) {
    const x = input.subarray(at, at + BLOCK);
    fx.process([x, x], [left.subarray(at, at + BLOCK), right.subarray(at, at + BLOCK)], BLOCK, params);
  }
  const rms = (from) => Math.sqrt(left.subarray(from, from + SR / 100).reduce((a, v) => a + v * v, 0) / (SR / 100));
  const db = 20 * Math.log10(rms(SR) / rms(SR + SR / 4));
  assert.ok(Math.abs(db) < 0.5, `the first 10 ms came out ${db.toFixed(2)} dB from the settled hit`);
});

test('what lies outside the region passes at its own level', () => {
  const db = levelDb({ low: 2000, high: 8000, drive: 36 }, 0.4, 100);
  assert.ok(Math.abs(db) < 1, `a 100 Hz sine under the region came out ${db.toFixed(1)} dB`);
});
