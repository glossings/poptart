// .seg(n) - sample-and-hold on an even n-per-cycle grid (Strudel's segment/seg), plus the
// patterned-bound form of irand() that says the same thing from the other end (irand("8!8")).
// Pure pattern math - no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, s, mini, sine, irand, rand } from './src/signal.mjs';

const valuesAt = (sig, cycle) => sig.stepsForCycle(cycle).filter((x) => x.value != null).map((x) => x.value);
const startsAt = (sig, cycle) => sig.stepsForCycle(cycle).map((x) => x.start);

// ---------------------------------------------------------------------------------------------
// .seg() structure
// ---------------------------------------------------------------------------------------------

test('.seg(n) lays an even n-step grid over a structureless signal', () => {
  const sig = sine(1).seg(8);
  const steps = sig.stepsForCycle(3);
  assert.equal(steps.length, 8);
  steps.forEach((step, i) => {
    assert.ok(Math.abs(step.start - i / 8) < 1e-9, `step ${i} starts at ${i}/8`);
    assert.ok(Math.abs(step.end - (i + 1) / 8) < 1e-9, `step ${i} ends at ${i + 1}/8`);
    assert.equal(typeof step.value, 'number');
  });
});

test('.seg() holds each value across its step - sample() agrees with the grid', () => {
  const sig = rand().seg(4);
  const steps = sig.stepsForCycle(0);
  for (const step of steps) {
    const mid = (step.start + step.end) / 2;
    assert.equal(sig.sample(mid, 1, mid), step.value, `held across [${step.start}, ${step.end})`);
  }
});

test('.seg() re-quantizes an existing pattern onto the grid', () => {
  // Coarser than the source: each grid point takes the value sounding there, the rest are skipped.
  assert.deepEqual(valuesAt(n('0 1 2 3').seg(2), 0), [0, 2]);
  // Finer: values repeat, but as separate events (four onsets, not two ties).
  assert.deepEqual(valuesAt(n('0 1').seg(4), 0), [0, 0, 1, 1]);
  assert.deepEqual(startsAt(n('0 1').seg(4), 0), [0, 0.25, 0.5, 0.75]);
});

test('.seg() keeps the source atom lit - highlight spans survive the re-quantize', () => {
  const steps = mini('0 1').seg(4).stepsForCycle(0);
  // Every step points back at the atom whose value it froze; the synthesized trigger contributes
  // no spans of its own (it would otherwise light the head of the document).
  assert.deepEqual(steps.map((x) => x.locs), [[[0, 1]], [[0, 1]], [[2, 3]], [[2, 3]]]);
});

test('.seg() carries track metadata, so a sampler pattern stays a sampler pattern', () => {
  const sig = s('breaks:19').fit().seg(8);
  assert.ok(sig.sampler, 'sampler config survives');
  assert.equal(sig.sampler.fit, 'auto');
  assert.deepEqual(valuesAt(sig, 0), Array(8).fill('breaks:19'));
});

test('.seg() takes a patterned n', () => {
  const sig = n('0 1 2 3').seg('<2 4>');
  assert.equal(sig.stepsForCycle(0).length, 2);
  assert.equal(sig.stepsForCycle(1).length, 4);
  assert.equal(sig.stepsForCycle(2).length, 2);
  // A rate that varies WITHIN the cycle reads as "1*[4 8]" does - 4-per-cycle across the first
  // half, 8-per-cycle across the second.
  assert.deepEqual(startsAt(n('0').seg('4 8'), 0), [0, 0.25, 0.5, 0.625, 0.75, 0.875]);
});

test('.seg() rejects a non-positive step count', () => {
  assert.throws(() => n('0 1').seg(0), /positive number of steps/);
  assert.throws(() => n('0 1').seg(-4), /positive number of steps/);
});

test('.segment() is the same operator under Strudel\'s longer name', () => {
  assert.deepEqual(valuesAt(n('0 1 2 3').segment(2), 0), valuesAt(n('0 1 2 3').seg(2), 0));
});

// ---------------------------------------------------------------------------------------------
// .seg() + irand: the "N triggers per bar of random sampler starts" idiom, both orders
// ---------------------------------------------------------------------------------------------

test('irand().seg(n) draws afresh at every step, in either order with the arithmetic', () => {
  for (const sig of [irand(8).seg(8).div(8), irand(8).div(8).seg(8)]) {
    const vals = valuesAt(sig, 0);
    assert.equal(vals.length, 8);
    for (const v of vals) assert.ok(v >= 0 && v < 1, `${v} in 0..1`);
    assert.ok(new Set(vals).size > 1, 'the eight draws are not one frozen value');
  }
});

test('a segmented control gives the sampler pattern its structure - eight triggers a bar', () => {
  const track = s('breaks:19').fit().begin(irand(8).seg(8).div(8));
  const steps = track.stepsForCycle(0);
  assert.equal(steps.length, 8, 'eight events');
  assert.deepEqual(steps.map((x) => x.start), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  assert.ok(steps.every((x) => !x.cont), 'each is a fresh onset, not a tie');
  // What the scheduler reads at each onset (the begin Sig, sampled there) matches the grid.
  const begin = track.sampler.begin;
  for (const step of steps) {
    const v = begin.sample(step.start, 1, step.start);
    assert.ok(v >= 0 && v < 1, `begin ${v} at ${step.start} is a real 0..1 position`);
  }
});

// ---------------------------------------------------------------------------------------------
// irand with a patterned bound
// ---------------------------------------------------------------------------------------------

test('irand("8!8") is eight draws per cycle, each its own event', () => {
  const sig = irand('8!8');
  const steps = sig.stepsForCycle(0);
  assert.equal(steps.length, 8);
  for (const step of steps) {
    assert.ok(Number.isInteger(step.value) && step.value >= 0 && step.value < 8, `${step.value} in 0..7`);
  }
  assert.ok(new Set(steps.map((x) => x.value)).size > 1, 'the draws differ from each other');
  // Deterministic in time, like every other random here, and sample() reads the same draws.
  assert.deepEqual(valuesAt(sig, 5), valuesAt(sig, 5));
  for (const step of sig.stepsForCycle(5)) {
    assert.equal(sig.sample(5 + step.start, 1, 5 + step.start), step.value);
  }
});

test('a subdividing bound may vary per step, and rests stay rests', () => {
  const sig = irand('8 2');
  const [a, b] = sig.stepsForCycle(0);
  assert.ok(a.value >= 0 && a.value < 8);
  assert.ok(b.value >= 0 && b.value < 2);
  // A rest in the bound leaves a gap in the result (mini drops rest steps rather than emitting
  // them), so the middle third is silent instead of drawing from a NaN bound.
  const gapped = irand('8 ~ 8').stepsForCycle(0);
  assert.equal(gapped.length, 2);
  assert.ok(Math.abs(gapped[1].start - 2 / 3) < 1e-9, 'second draw starts after the gap');
  for (const step of gapped) assert.ok(Number.isInteger(step.value) && step.value >= 0 && step.value < 8);
});

test('a patterned begin built from irand("8!8") drives eight triggers, as .seg(8) does', () => {
  const track = s('breaks:19').fit().begin(irand('8!8').div(8));
  const steps = track.stepsForCycle(0);
  assert.equal(steps.length, 8);
  assert.deepEqual(steps.map((x) => x.start), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  for (const step of steps) {
    const v = track.sampler.begin.sample(step.start, 1, step.start);
    assert.ok(v >= 0 && v < 1, `begin ${v} at ${step.start}`);
  }
});

test('a WHOLE-CYCLE bound imposes no grid - it keeps drawing per onset', () => {
  // "<8 16>" moves the bound bar by bar but has no structure within a bar, so as a control it must
  // behave exactly as irand(8) does: a fresh draw at every note, not the bar's first draw frozen.
  const sig = irand('<8 16>');
  assert.equal(sig.stepsForCycle(0).length, 1, 'one value per cycle as a pattern');
  assert.equal(typeof sig.eventAt, 'function', 'keeps the per-onset reader');
  const drawn = [0, 0.25, 0.5, 0.75].map((p) => sig.eventAt(p).value);
  assert.ok(new Set(drawn).size > 1, 'four onsets in a bar draw independently');
  for (const v of drawn) assert.ok(v >= 0 && v < 8, `cycle 0 bound is 8, got ${v}`);
  for (const v of [0, 0.5].map((p) => sig.eventAt(1 + p).value)) assert.ok(v >= 0 && v < 16);
});

test('irand rejects a bound it cannot draw from, rather than drawing NaN', () => {
  assert.throws(() => irand(), /takes a positive integer/);
  assert.throws(() => irand({}), /takes a positive integer/);
  // A non-numeric mini bound is a rest (mini's own convention for "nothing here"), not a NaN.
  assert.equal(irand('x').stepsForCycle(0)[0].value, null);
});

// ---------------------------------------------------------------------------------------------
// The per-onset reader surviving arithmetic (what makes .div(8) safe on a random)
// ---------------------------------------------------------------------------------------------

test('arithmetic on a gridless random keeps its per-onset reader', () => {
  const sig = irand(16).div(16);
  assert.equal(typeof sig.eventAt, 'function');
  const drawn = [0, 0.25, 0.5, 0.75].map((p) => sig.eventAt(p).value);
  assert.ok(new Set(drawn).size > 1, 'four onsets draw independently');
  for (const v of drawn) assert.ok(v >= 0 && v < 1);
});

test('arithmetic does NOT invent a reader where the left side has honest structure', () => {
  // n("0 1").add(irand(12)) has two real steps; a reader here would let crossMerge discard them.
  const sig = n('0 1').add(irand(12));
  assert.equal(sig.eventAt, null);
  assert.equal(sig.stepsForCycle(0).length, 2);
});
