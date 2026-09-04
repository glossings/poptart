'use strict';

// Transient detection's sensitivity control - the slice editor's auto-slice slider (see
// samples.js's detectOnsets, and /api/sampleSlices). Runs on a synthesized signal rather than a
// fixture so the loud hits and the quiet ones are known by construction, which is the whole
// question the slider answers: how quiet does a hit get before the detector stops calling it one.

const { test } = require('node:test');
const assert = require('node:assert');

const { detectOnsets } = require('./samples');

const RATE = 48000;
const SECONDS = 3;
const GAP = 0.18; // seconds between hits
const HITS = 16;

// Deterministic pseudo-noise: the detector reads energy, and a repeatable test needs a repeatable
// signal (Math.random would make the counts below a lottery).
const rnd = (i) => {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  return n - Math.floor(n) - 0.5;
};

/**
 * A ladder: sixteen decaying clicks, each 0.7x the one before, over a quiet noise bed. The bed is
 * what makes the ladder a real test - with digital silence between them even the faintest click is
 * an enormous jump, and every sensitivity finds everything.
 */
function ladder() {
  const samples = new Float32Array(RATE * SECONDS);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.02 * rnd(i * 7 + 1);
  let amp = 1;
  for (let k = 0; k < HITS; k++) {
    const start = Math.round(k * GAP * RATE);
    for (let i = 0; i < RATE * 0.03 && start + i < samples.length; i++) {
      samples[start + i] += amp * rnd(i + k * 99) * Math.exp(-i / (RATE * 0.006));
    }
    amp *= 0.7;
  }
  return samples;
}

/** Did the detector put a marker on hit `k`? Positions come back as fractions of the file. */
const foundHit = (positions, k) => positions.some((p) => Math.abs(p * SECONDS - k * GAP) < 0.02);

test('sensitivity trades missed hits against false ones, monotonically', () => {
  const samples = ladder();
  const counts = [0.25, 0.5, 1, 2, 4].map((sensitivity) => detectOnsets(samples, RATE, { sensitivity }).length);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] >= counts[i - 1], `sensitivity only ever finds more: ${counts.join(' -> ')}`);
  }
  assert.ok(counts[counts.length - 1] > counts[0], `the slider has to actually move something: ${counts.join(' -> ')}`);
});

test('the loudest hits survive the strictest setting; the quiet ones need the loosest', () => {
  const samples = ladder();
  const low = detectOnsets(samples, RATE, { sensitivity: 0.25 });
  const high = detectOnsets(samples, RATE, { sensitivity: 4 });
  for (const k of [1, 2, 3]) assert.ok(foundHit(low, k), `hit ${k} is loud enough for any setting`);
  // ...and somewhere down the ladder is a hit only the loose setting calls a hit at all.
  const quiet = [10, 11, 12].filter((k) => foundHit(high, k) && !foundHit(low, k));
  assert.ok(quiet.length, 'raising the sensitivity has to reach hits the strict setting misses');
});

test('the default is unchanged - omitting sensitivity is sensitivity 1', () => {
  const samples = ladder();
  assert.deepStrictEqual(detectOnsets(samples, RATE), detectOnsets(samples, RATE, { sensitivity: 1 }));
});

test('positions come back ascending, inside the file, and always with a start', () => {
  const found = detectOnsets(ladder(), RATE, { sensitivity: 2 });
  assert.strictEqual(found[0], 0);
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i] > found[i - 1], 'ascending');
    assert.ok(found[i] < 1, 'inside the file');
  }
});

test('a sensitivity out of range is clamped rather than turning the detector off', () => {
  const samples = ladder();
  assert.deepStrictEqual(detectOnsets(samples, RATE, { sensitivity: 999 }), detectOnsets(samples, RATE, { sensitivity: 4 }));
  assert.deepStrictEqual(detectOnsets(samples, RATE, { sensitivity: 0 }), detectOnsets(samples, RATE, { sensitivity: 1 }));
});
