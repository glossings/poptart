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

/** Two seconds of a pulsed tone, then four of silence. */
function pulses() {
  const input = new Float32Array(6 * SR);
  for (let i = 0; i < 2 * SR; i++) {
    const t = i / SR;
    input[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) * (Math.sin(2 * Math.PI * 2 * t) > 0 ? 1 : 0);
  }
  return input;
}

const stats = (x, from, to) => {
  let sum = 0;
  let energy = 0;
  for (let i = from; i < to; i++) { sum += x[i]; energy += x[i] * x[i]; }
  return { dc: sum / (to - from), rms: Math.sqrt(energy / (to - from)) };
};

test('a dense cloud fed back hard stays bounded, carries no offset and dies away', () => {
  const input = pulses();
  for (const params of [
    { size: 500, density: 200, feedback: 0.95 },
    { size: 300, density: 100, feedback: 0.8, mix: 1 },
    { size: 200, density: 50, feedback: 0.95, pitch: -12 },
  ]) {
    const out = run(input, params);
    const what = JSON.stringify(params);
    assert.ok(peakIn(out, 0, out.length) < 0.98, `${what} peaked at ${peakIn(out, 0, out.length)}`);
    assert.ok(Math.abs(stats(out, 0, out.length).dc) < 0.005, `${what} left an offset`);
    assert.ok(peakIn(out, 5 * SR, 6 * SR) < 1e-3, `${what} is still sounding seconds after its input stopped`);
  }
});

test('more grains overlapping is not a louder echo', () => {
  const input = pulses();
  const wet = (density) => stats(run(input, { size: 200, density, spray: 0, feedback: 0, mix: 1 }), 0, 2 * SR).rms;
  const sparse = wet(10);
  for (const density of [40, 100, 200]) assert.ok(wet(density) <= sparse * 1.1, `at ${density} Hz the wet is ${wet(density)} against ${sparse}`);
});
