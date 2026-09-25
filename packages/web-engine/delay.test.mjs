// The Delay effect's feedback clip.
//
// What is fed back goes through a soft clip so a feedback near one saturates rather than running
// away. The clip has to be a clip: continuous, never turning back down as the level rises, and
// out of the way at ordinary levels. One that peaked above its own ceiling and then dropped to it
// put a step in the tail every time a repeat crossed the knee.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clipTail } from './src/devices/delay.mjs';

test('the feedback clip rises without a step and never turns back down', () => {
  let last = clipTail(-4);
  for (let x = -4; x <= 4; x += 0.001) {
    const y = clipTail(x);
    assert.ok(y >= last - 1e-12, `the clip falls at ${x.toFixed(3)}: ${last} then ${y}`);
    assert.ok(y - last < 0.0011, `the clip jumps at ${x.toFixed(3)}: ${last} then ${y}`);
    assert.ok(Math.abs(y) <= 1, `the clip reaches ${y} at ${x.toFixed(3)}`);
    last = y;
  }
});

test('the feedback clip leaves ordinary levels alone', () => {
  // Unity slope at zero: a quiet repeat is fed back at the level it was.
  for (const x of [0.001, 0.01, -0.01, 0.1]) {
    assert.ok(Math.abs(clipTail(x) - x) / Math.abs(x) < 0.002, `${x} came back as ${clipTail(x)}`);
  }
  assert.equal(clipTail(0), 0);
  assert.equal(clipTail(10), 1);
  assert.equal(clipTail(-10), -1);
});
