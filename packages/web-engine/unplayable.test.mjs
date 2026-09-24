// A number nobody can play, once, does not silence a device for good.
//
// A NaN compared against anything is false and added to anything is NaN, so a detector or a
// smoothed gain that is fed one keeps it for ever: every sample after is NaN, or a dynamics
// device quietly stops reacting. One bad sample from upstream - a plugin's first block, a
// division by zero in a pattern - must cost that sample and the few after it, not the track.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { COMPRESSOR, CompressorProcessor } from './src/devices/compressor.mjs';
import { MULTIBAND, MultibandProcessor } from './src/devices/multiband.mjs';
import { OVERDRIVE, OverdriveProcessor } from './src/devices/overdrive.mjs';
import { LIMITER, LimiterProcessor } from './src/devices/limiter.mjs';
import { DUCKER, DuckerProcessor } from './src/devices/ducker.mjs';

const SR = 48000;
const BLOCK = 128;
const BLOCKS = 40;

/** A sine with one NaN in its second block; answers with the output from the tenth block on. */
function renderAfterNaN(Processor, descriptor, overrides = {}, sidechainOf = null) {
  const fx = new Processor(SR, BLOCK);
  const params = { ...defaultValues(descriptor), ...overrides };
  const outL = new Float32Array(BLOCK * BLOCKS);
  const outR = new Float32Array(BLOCK * BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    const x = Float32Array.from({ length: BLOCK }, (_, i) => Math.sin((2 * Math.PI * 220 * (b * BLOCK + i)) / SR) * 0.5);
    if (b === 1) x[40] = NaN;
    const side = sidechainOf ? sidechainOf(b, x) : undefined;
    fx.process([x, x], [outL.subarray(b * BLOCK, (b + 1) * BLOCK), outR.subarray(b * BLOCK, (b + 1) * BLOCK)], BLOCK, params, side);
  }
  return { fx, out: outL.subarray(BLOCK * 10) };
}

function assertRecovers(name, out) {
  const bad = out.findIndex((v) => !Number.isFinite(v));
  assert.equal(bad, -1, `${name} was still putting out ${out[bad]} long after the one NaN`);
}

test('the compressor\'s detector starts again after a NaN', () => {
  const { fx, out } = renderAfterNaN(CompressorProcessor, COMPRESSOR);
  assertRecovers('the compressor', out);
  assert.ok(Number.isFinite(fx.detector.env));
});

test('the multiband compressor\'s detectors start again after a NaN', () => {
  const { fx, out } = renderAfterNaN(MultibandProcessor, MULTIBAND);
  assertRecovers('the multiband', out);
  for (const d of fx.detectors) assert.ok(Number.isFinite(d.env));
});

test('the overdrive\'s dynamics detector starts again after a NaN', () => {
  const { fx, out } = renderAfterNaN(OverdriveProcessor, OVERDRIVE, { dynamics: 0.8 });
  assertRecovers('the overdrive', out);
  for (const c of fx.channels) assert.ok(Number.isFinite(c.detector.env));
});

test('the limiter\'s gain and lookahead start again after a NaN', () => {
  const { fx, out } = renderAfterNaN(LimiterProcessor, LIMITER, { gain: 12 });
  assertRecovers('the limiter', out);
  assert.ok(Number.isFinite(fx.gain));
});

test('the ducker still triggers on its sidechain after a NaN in it', () => {
  // The key's envelope is compared against the threshold, and a NaN envelope is never above it:
  // the dip would simply stop happening, with no NaN anywhere in the output to say why.
  const { fx } = renderAfterNaN(DuckerProcessor, DUCKER, { amount: 1, threshold: -24 }, (b) => {
    const key = new Float32Array(BLOCK);
    if (b === 1) key[10] = NaN;
    if (b === 30) key.fill(0.9);
    return [key, key];
  });
  assert.ok(Number.isFinite(fx.env), `the key envelope was left at ${fx.env}`);
  assert.ok(fx.gain < 0.9, `a loud hit on the sidechain should have dipped the level, gain is ${fx.gain}`);
});
