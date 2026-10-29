// The ducker's clock trigger: a beat that ADVANCES dips; a clock corrected a little backward is
// not a new beat, and a relocate is taken without a dip. The desktop's transport is told its
// position every few seconds and lands a little behind the audio clock, and the ducker re-dipped
// on every such step back across a beat line (seen live, 2026-10-28). The same rule is in
// osc-engine's own/ducker.cc, which the parity test holds to this one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DUCKER, DuckerProcessor } from './src/devices/ducker.mjs';
import { defaultValues } from './src/descriptor.mjs';
import { SYNC_OPTIONS } from './src/dsp/sync.mjs';

const RATE = 48000;
const BLOCK = 128;

/** A ducker on quarter notes at 120, driven block by block; returns the gain at each block's end. */
function run(steps) {
  const fx = new DuckerProcessor(RATE);
  fx.setTempo(120, 0);
  const params = { ...defaultValues(DUCKER), sync: SYNC_OPTIONS.indexOf('1/4'), amount: 0.8, length: 0.5, attack: 1 };
  const inputs = [new Float32Array(BLOCK).fill(0.5), new Float32Array(BLOCK).fill(0.5)];
  const outputs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const gains = [];
  for (const timeSec of steps) {
    fx.process(inputs, outputs, BLOCK, params, null, timeSec);
    gains.push(fx.gain);
  }
  return { gains, fx };
}

const blocksOver = (from, seconds) => Array.from({ length: Math.round((seconds * RATE) / BLOCK) }, (_, i) => from + (i * BLOCK) / RATE);

test('the first beat seen is not a trigger; the next one is', () => {
  const { gains } = run(blocksOver(0, 0.6));
  const firstBeat = Math.round((0.5 * RATE) / BLOCK);
  assert.ok(gains.slice(0, firstBeat - 1).every((g) => g > 0.99), 'nothing dips before the beat line at 0.5 s');
  assert.ok(Math.min(...gains.slice(firstBeat, firstBeat + 10)) < 0.3, 'the beat at 0.5 s dips');
});

test('a clock corrected a little backward across a beat line does not dip again', () => {
  // Through the beat at 0.5 s and fully recovered, then one block told it is 0.499 s - just
  // before the line it already crossed - then on from where it was.
  const steady = blocksOver(0, 0.9);
  const { gains } = run([...steady, 0.499, ...blocksOver(0.9, 0.1)]);
  const after = gains.slice(steady.length);
  assert.ok(after.every((g) => g > 0.99), `the step back re-dipped: ${after.map((g) => g.toFixed(2)).join(' ')}`);
});

test('a relocate of more than a beat is taken without a dip, and the next beat line dips', () => {
  const steady = blocksOver(0, 0.9);
  const back = blocksOver(-0.6, 0.7); // relocated to -0.6 s, crossing the line at -0.5 s on the way
  const { gains } = run([...steady, ...back]);
  const after = gains.slice(steady.length);
  const line = Math.round((0.1 * RATE) / BLOCK); // -0.5 s is 0.1 s into the relocated run
  assert.ok(after.slice(0, line - 1).every((g) => g > 0.99), 'the relocate itself does not dip');
  assert.ok(Math.min(...after.slice(line, line + 10)) < 0.3, 'the beat line after it does');
});

test('the report says where on the clock the newest entry is', () => {
  const steps = blocksOver(0, 0.3);
  const { fx } = run(steps);
  const at = fx.report().history.at;
  const expected = steps[steps.length - 1] + BLOCK / RATE;
  assert.ok(Math.abs(at - expected) < 1e-9, `${at} against ${expected}`);
});
