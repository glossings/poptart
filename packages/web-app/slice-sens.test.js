'use strict';

// The sensitivity slider's scale (public/client.js sliceSensOf).
//
// The slider's travel is a POSITION and the sensitivity is geometric, because sensitivity is a
// ratio: halving it doubles what a peak has to clear. A linear 0.25..4 put 1 - the value a sample
// with no set of its own chops on - a fifth of the way along, with the whole quiet end of the range
// crammed to its left (reported 2026-09-04). Centered and geometric, each sixth of the travel is
// one halving in either direction.
//
// The ends have to be the detector's own clamp: a slider that ran past it would have a dead zone,
// and one that stopped short would put reachable settings out of reach. They live in different
// packages, so this is what says they still agree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { detectOnsets, clampSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX } = require('./../osc-engine/samples.js');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

/** `const name = ...;` lifted out of client.js - these are arrow constants, not functions. */
function grabConst(name) {
  const m = new RegExp(`^const ${name} = .*?;$`, 'ms').exec(SRC);
  assert.ok(m, `${name} not found in client.js - this test needs updating`);
  return m[0];
}

// eslint-disable-next-line no-new-func
const sliceSensOf = new Function(
  `${grabConst('SLICE_SENS_OCTAVES')}\n${grabConst('sliceSensOf')}\nreturn sliceSensOf;`,
)();

test('the middle of the travel is 1 - what a sample chops on with no set of its own', () => {
  assert.equal(sliceSensOf(0.5), 1);
});

test('the ends of the travel are exactly the detector\'s own limits', () => {
  assert.equal(sliceSensOf(0), SENSITIVITY_MIN);
  assert.equal(sliceSensOf(1), SENSITIVITY_MAX);
  // ...so nothing the slider can ask for is clamped away, which is what a dead zone would be.
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const sens = sliceSensOf(t);
    assert.ok(Math.abs(clampSensitivity(sens) - sens) < 1e-9, `t=${t.toFixed(2)} asks for ${sens}, clamped to ${clampSensitivity(sens)}`);
  }
});

test('every sixth of the travel is one halving, in both directions', () => {
  for (let t = 0; t < 0.9999; t += 1 / 6) {
    const ratio = sliceSensOf(t + 1 / 6) / sliceSensOf(t);
    assert.ok(Math.abs(ratio - 2) < 0.02, `${t.toFixed(3)} -> ${(t + 1 / 6).toFixed(3)} is x${ratio}`);
  }
});

test('the quiet half of the range is half the slider, not a fifth of it', () => {
  // The complaint that started this: below-1 settings are the ones you reach for on a busy break.
  const below = [0.1, 0.2, 0.3, 0.4].filter((t) => sliceSensOf(t) < 1).length;
  assert.equal(below, 4);
  assert.ok(sliceSensOf(0.25) < 0.4, 'a quarter of the way along is already well under 1');
});

test('the detector really does get quieter than the old floor of 0.25', () => {
  // Not just a wider number: fewer markers actually come back. A synthesized ladder of decaying
  // clicks over a noise bed, the same fixture detect-onsets.test.js uses.
  const RATE = 48000;
  const rnd = (i) => {
    const n = Math.sin(i * 12.9898) * 43758.5453;
    return n - Math.floor(n) - 0.5;
  };
  const samples = new Float32Array(RATE * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.02 * rnd(i * 7 + 1);
  let amp = 1;
  for (let k = 0; k < 16; k++) {
    const start = Math.round(k * 0.18 * RATE);
    for (let i = 0; i < RATE * 0.03 && start + i < samples.length; i++) {
      samples[start + i] += amp * rnd(i + k * 99) * Math.exp(-i / (RATE * 0.006));
    }
    amp *= 0.7;
  }
  const at = (sens) => detectOnsets(samples, RATE, { sensitivity: sens }).length;
  assert.ok(at(SENSITIVITY_MIN) < at(0.25), `the new floor is stricter than the old one: ${at(SENSITIVITY_MIN)} vs ${at(0.25)}`);
});
