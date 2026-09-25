// The track's bend inside the synths: one number while it is still, a block of values while
// something moves it, and the two must play the same pitch when the values do not move.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TRACK_BEND_PARAM, defaultValues } from './src/descriptor.mjs';
import { WAVETABLE, WavetableSynth } from './src/devices/wavetable.mjs';
import { FMSYNTH, FmSynth } from './src/devices/fmsynth.mjs';
import { bendOf, parameterDescriptorsFor } from './src/worklets/shared.mjs';

const SR = 48000;
const BLOCK = 128;

/** Renders a held note, handing the synth `bendFor(block)` before each block. */
function play(synth, bendFor, blocks = 40) {
  synth.queueNoteOn(57, 1, 0);
  const out = new Float32Array(blocks * BLOCK);
  const right = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    synth.setBend(bendFor(b));
    const left = out.subarray(b * BLOCK, (b + 1) * BLOCK);
    right.fill(0);
    synth.process(left, right, BLOCK);
  }
  return out;
}

const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

const SYNTHS = [
  ['Wavetable', () => { const s = new WavetableSynth(SR); s.setParams(defaultValues(WAVETABLE)); return s; }],
  ['FM', () => { const s = new FmSynth(SR); s.setParams(defaultValues(FMSYNTH)); return s; }],
];

test('bendOf hands a still block on as a number and a moving one as its values', () => {
  assert.equal(bendOf({}), 0);
  assert.equal(bendOf({ [TRACK_BEND_PARAM]: Float32Array.of(2) }), 2);
  assert.equal(bendOf({ [TRACK_BEND_PARAM]: new Float32Array(BLOCK).fill(-0.5) }), -0.5, 'a connected but flat block is still');
  const moving = new Float32Array(BLOCK).map((_, i) => i / BLOCK);
  assert.equal(bendOf({ [TRACK_BEND_PARAM]: moving }), moving);
});

test('only an instrument declares the bend input, and it is not a position', () => {
  const synth = parameterDescriptorsFor(WAVETABLE).find((p) => p.name === TRACK_BEND_PARAM);
  assert.equal(synth.automationRate, 'a-rate');
  assert.equal(synth.minValue, undefined, 'a bend in semitones has no 0..1 range');
});

for (const [name, make] of SYNTHS) {
  test(`${name}: a bend read per sample plays the pitch a still bend of the same value does`, () => {
    const still = play(make(), () => 7);
    const perSample = play(make(), () => new Float32Array(BLOCK).fill(7));
    const flat = play(make(), () => 0);
    assert.ok(maxDiff(still, flat) > 0.05, 'the bend moves the pitch at all');
    assert.ok(maxDiff(still, perSample) < 1e-3, `per sample matches the still bend (off by ${maxDiff(still, perSample)})`);
  });

  test(`${name}: a moving bend moves the note inside the block`, () => {
    // Half a block at the note and half a fifth up, against the bend arriving a block later. Read
    // at the block's first value only, the two would be the same all through block 20.
    const split = new Float32Array(BLOCK).fill(0);
    split.fill(7, BLOCK / 2);
    const moving = play(make(), (b) => (b === 20 ? split : b > 20 ? 7 : 0));
    const later = play(make(), (b) => (b > 20 ? 7 : 0));
    const start = 20 * BLOCK;
    const mid = start + BLOCK / 2;
    assert.equal(maxDiff(moving.subarray(0, start), later.subarray(0, start)), 0, 'identical until the block the bend moves in');
    const before = maxDiff(moving.subarray(start, mid), later.subarray(start, mid));
    const after = maxDiff(moving.subarray(mid, start + BLOCK), later.subarray(mid, start + BLOCK));
    assert.ok(after > 0.05 && after > 4 * before, `it moves mid-block (${before} before the midpoint, ${after} after)`);
  });
}
