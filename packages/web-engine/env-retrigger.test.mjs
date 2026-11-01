// env() with retrigger: every note starts the attack from the floor, so a long attack under
// back-to-back notes stays low instead of climbing a little further on each note.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvConnection } from './src/engine/modulators.mjs';

const param = () => ({
  value: 0,
  cancelScheduledValues() {},
  cancelAndHoldAtTime() {},
  setValueAtTime() {},
  linearRampToValueAtTime() {},
});

// Her riff: a 0.76 s attack, a note every 0.21 s.
const ir = { attack: 0.7628, decay: 0.7, sustain: 0, release: 0.2, curve: 1.2, min: 0, max: 1 };
const play = (retrigger) => {
  const env = new EnvConnection({ currentTime: 0 }, param(), { ...ir, retrigger });
  const peaks = [];
  for (let k = 0; k < 8; k++) {
    env.gateOn(k * 0.21);
    peaks.push(env.valueAt(k * 0.21 + 0.209));
  }
  return { env, peaks };
};

test('a retriggered env starts every note from the floor', () => {
  const { env, peaks } = play(true);
  for (const p of peaks) assert.ok(Math.abs(p - peaks[0]) < 1e-9, `each note reaches the same level: ${peaks}`);
  assert.ok(peaks[0] < 0.3, `a long attack stays low over a short note: ${peaks[0]}`);
  assert.ok(env.valueAt(7 * 0.21 + 1e-4) < 0.01, 'and drops to the floor as the note starts');
});

test('without retrigger the gate opens once and the attack carries on', () => {
  const { peaks } = play(false);
  assert.ok(peaks[3] > peaks[0] + 0.2, `it climbs across the notes: ${peaks}`);
});
