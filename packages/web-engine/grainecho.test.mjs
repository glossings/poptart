// The Grain Echo effect: a delay whose repeats are grains.
//
// A grain pitched up reads the buffer faster than it is being written, so it gains on the write
// head for its whole life. If it started too close, it would pass the head and go on reading
// what was written a whole buffer ago - four seconds of the past, heard as a ghost of something
// long gone. And nothing that cannot be played may stay in the buffer to come round again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { GRAINECHO, GrainEchoProcessor } from './src/devices/grainecho.mjs';

const SR = 48000;
const BLOCK = 128;

function run(input, params) {
  const fx = new GrainEchoProcessor(SR);
  const full = { ...defaultValues(GRAINECHO), ...params };
  const outL = new Float32Array(input.length);
  const outR = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += BLOCK) {
    const n = Math.min(BLOCK, input.length - at);
    const x = input.subarray(at, at + n);
    fx.process([x, x], [outL.subarray(at, at + n), outR.subarray(at, at + n)], n, full);
  }
  return outL;
}

const peakIn = (x, from, to) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};

test('a grain pitched up never reads past the write head into audio seconds old', () => {
  // Half a second of sound, then silence. Two octaves up with half-second grains, each one
  // covers two seconds of buffer in half a second of time; it has to start far enough back to
  // finish behind the head. Once the sound is further back than any grain reaches, the echo is
  // silent - it must not come back from the far end of the buffer.
  const input = new Float32Array(7 * SR);
  for (let i = 0; i < SR / 2; i++) input[i] = Math.sin((2 * Math.PI * 330 * i) / SR) * 0.8;
  const out = run(input, { pitch: 24, random: 0, size: 500, time: 0.01, spray: 0, feedback: 0, mix: 1 });
  assert.ok(peakIn(out, 0, 2 * SR) > 0.01, 'the sound should have been echoed at all');
  const ghost = peakIn(out, Math.round(2.6 * SR), 7 * SR);
  assert.ok(ghost < 1e-6, `after the sound has gone, the echo still reads ${ghost.toFixed(4)} from the far end of the buffer`);
});

test('a number nobody can play does not stay in the feedback', () => {
  const input = new Float32Array(3 * SR);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
  input[1000] = NaN;
  const out = run(input, { feedback: 0.9, mix: 0.5 });
  for (let i = SR; i < input.length; i++) assert.ok(Number.isFinite(out[i]), `sample ${i} was ${out[i]}`);
});
