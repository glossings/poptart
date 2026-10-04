'use strict';

// Transient detection's sensitivity control - the slice editor's auto-slice slider (see
// samples.js's detectOnsets, and /api/sampleSlices). Runs on a synthesized signal rather than a
// fixture so the loud hits and the quiet ones are known by construction, which is the whole
// question the slider answers: how quiet does a hit get before the detector stops calling it one.

const { test } = require('node:test');
const assert = require('node:assert');

const { detectOnsets, detectOnsetHits } = require('./samples');

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
  const counts = [0.125, 0.25, 0.5, 1, 2, 4, 8].map((sensitivity) => detectOnsets(samples, RATE, { sensitivity }).length);
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
  const { SENSITIVITY_MIN, SENSITIVITY_MAX } = require('./samples');
  assert.deepStrictEqual(detectOnsets(samples, RATE, { sensitivity: 999 }), detectOnsets(samples, RATE, { sensitivity: SENSITIVITY_MAX }));
  assert.deepStrictEqual(detectOnsets(samples, RATE, { sensitivity: -3 }), detectOnsets(samples, RATE, { sensitivity: SENSITIVITY_MIN }));
  // 0 is not "as strict as possible" - it's no answer at all, and the default is what it means.
  assert.deepStrictEqual(detectOnsets(samples, RATE, { sensitivity: 0 }), detectOnsets(samples, RATE, { sensitivity: 1 }));
});

// ---------------------------------------------------------------------------------------------
// The strength of each hit - what a groove's accents are measured from (see groove-extract.mjs)
// ---------------------------------------------------------------------------------------------

test('the hits come back with a strength, the loudest being 1', () => {
  const found = detectOnsetHits(ladder(), RATE, { sensitivity: 2 });
  assert.ok(found.length > 4, 'something to compare');
  assert.strictEqual(found[0].at, 0, 'the file start is still the first of them');
  for (const h of found) {
    assert.ok(h.strength >= 0 && h.strength <= 1, `strength in range (${h.strength})`);
  }
  assert.strictEqual(Math.max(...found.map((h) => h.strength)), 1, 'the loudest hit is the reference');
  // The ladder decays by 0.7 per hit, so the strengths have to fall with it - that is the whole
  // claim: this measures how hard a hit was, not merely that there was one. It holds while the
  // hits are above the noise bed; below that the reading levels off at the bed, because a hit
  // quieter than the noise it sits in cannot be measured and should not be invented.
  const ABOVE_BED = 8;
  for (let i = 1; i < ABOVE_BED; i++) {
    assert.ok(found[i].strength < found[i - 1].strength, `hit ${i} is quieter than the one before`);
    const ideal = Math.pow(0.7, i);
    assert.ok(Math.abs(found[i].strength - ideal) < 0.2, `hit ${i} is read near its real level (${found[i].strength} vs ${ideal})`);
  }
});

test('asking for strengths finds the same hits, timed more precisely', () => {
  // The same detection either way - the strengths path only times what it found differently. For
  // slicing, a position is backed off a hop so the slice keeps its attack; for measuring a feel
  // that back-off would read as every hit being played a few milliseconds early, so the hits path
  // refines to the sample instead (see refineOnset). Within one hop of each other, never before.
  const samples = ladder();
  const HOP_SEC = 256 / RATE;
  for (const sensitivity of [0.5, 1, 4]) {
    const plain = detectOnsets(samples, RATE, { sensitivity });
    const withStrength = detectOnsetHits(samples, RATE, { sensitivity });
    assert.strictEqual(withStrength.length, plain.length, `same count at sensitivity ${sensitivity}`);
    for (let i = 0; i < plain.length; i++) {
      const diff = (withStrength[i].at - plain[i]) * SECONDS;
      assert.ok(diff >= -1e-9, `hit ${i} is not timed earlier than the slice position (${diff})`);
      // The refinement searches the hop before the flux peak and the two after it, so the answer
      // sits inside that window - never earlier than the slice position, never 3 hops past it.
      assert.ok(diff <= HOP_SEC * 3, `hit ${i} is inside the refinement window (${diff})`);
    }
  }
});

test('a loop that begins with a rest is not credited with a hit at zero', () => {
  // Slice 0 is the file start by convention, which is right for chopping and wrong for measuring.
  const samples = ladder();
  const quietStart = new Float32Array(samples.length);
  quietStart.set(samples.subarray(0, samples.length - RATE / 2), RATE / 2); // half a second of bed first
  for (let i = 0; i < RATE / 2; i++) quietStart[i] = 0.0001 * rnd(i);
  const hits = detectOnsetHits(quietStart, RATE, { sensitivity: 2 });
  assert.ok(hits.length, 'the hits after the rest are still found');
  assert.ok(hits[0].at * SECONDS > 0.4, `the first hit is where the sound is, not at 0 (${hits[0].at * SECONDS})`);
  // ...while the slicer still answers with its start, because a chop needs one.
  assert.strictEqual(detectOnsets(quietStart, RATE, { sensitivity: 2 })[0], 0);
});

test('a file too short to analyze still answers with its one hit', () => {
  const tiny = new Float32Array(100);
  assert.deepStrictEqual(detectOnsetHits(tiny, RATE), [{ at: 0, strength: 1 }]);
});
