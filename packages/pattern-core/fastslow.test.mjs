// Playback-rate control: the Sig-level .fast()/.slow() combinators (including negative factors =
// reverse playback) and the mini-notation pattern-valued rates ("a*[1 2]" - the rate changing
// WITHIN a cycle, each rate step a window of the sped/slowed pattern). Pure pattern math, no
// scheduler/engine boot (see the package's testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMini, getStepsForCycle, warpSteps } from './src/mini.mjs';
import { n, note, s, sine, env, soundingEnd } from './src/signal.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

function miniOnsets(str, cycle = 0) {
  return getStepsForCycle(parseMini(str), cycle)
    .filter((st) => st.value != null && !st.cont)
    .sort((a, b) => a.start - b.start);
}

function onsets(sig, cycle = 0) {
  return sig
    .stepsForCycle(cycle)
    .filter((st) => st.value != null && !st.cont)
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// mini-notation: pattern-valued rates
// ---------------------------------------------------------------------------------------------

test('mini: "[0 1 2]*[1 2]" - rate changes within the cycle, each window shows its slice', () => {
  const steps = miniOnsets('[0 1 2]*[1 2]');
  // First half at 1x: onsets 0 and 1/3 land inside [0, 0.5) (the "2" at 2/3 does not).
  // Second half at 2x: the doubled pattern's onsets 1/2, 2/3, 5/6 all land inside [0.5, 1).
  assert.deepEqual(steps.map((st) => st.value), ['0', '1', '0', '1', '2']);
  const starts = steps.map((st) => st.start);
  [0, 1 / 3, 1 / 2, 2 / 3, 5 / 6].forEach((want, i) => close(starts[i], want));
});

test('mini: "a*<2 3>" per-cycle alternation is unchanged', () => {
  assert.equal(miniOnsets('a*<2 3>', 0).length, 2);
  assert.equal(miniOnsets('a*<2 3>', 1).length, 3);
  assert.equal(miniOnsets('a*<2 3>', 2).length, 2);
});

test('mini: a rest in the rate pattern silences its window', () => {
  const steps = miniOnsets('1*[2 ~]');
  // 2x over the whole cycle puts onsets at 0 and 0.5; only 0 is inside the first window,
  // and the second window plays nothing.
  assert.equal(steps.length, 1);
  close(steps[0].start, 0);
});

test('mini: "/" takes windowed rates too', () => {
  // Window [0, 0.5) at /2: the stretched pattern's "0" (onset 0, two cycles long) plays.
  // Window [0.5, 1) at /1: plain "1" at 0.5.
  const c0 = miniOnsets('[0 1]/[2 1]');
  assert.deepEqual(c0.map((st) => st.value), ['0', '1']);
  close(c0[1].start, 0.5);
  // Cycle 1: the /2 window now shows the stretched pattern's second half ("1"'s onset, rescaled
  // to 0), and the /1 window plays its "1" again.
  const c1 = miniOnsets('[0 1]/[2 1]', 1);
  assert.deepEqual(c1.map((st) => st.value), ['1', '1']);
});

test('mini: a non-numeric pattern rate is a clear error', () => {
  assert.throws(() => miniOnsets('1*[b]'), /must be numeric/);
});

test('mini: "*" still rejects junk after it at parse time', () => {
  assert.throws(() => parseMini('a*b'), /followed by a number or a pattern/);
});

// ---------------------------------------------------------------------------------------------
// Sig .fast() / .slow()
// ---------------------------------------------------------------------------------------------

test('.fast(2) fits two cycles of the pattern into one', () => {
  const steps = onsets(n('0 1 2 3').fast(2));
  assert.deepEqual(steps.map((st) => st.value), [0, 1, 2, 3, 0, 1, 2, 3]);
  steps.forEach((st, i) => close(st.start, i / 8));
});

test('.slow(2) spreads the pattern over two cycles', () => {
  const sig = n('0 1 2 3').slow(2);
  assert.deepEqual(onsets(sig, 0).map((st) => st.value), [0, 1]);
  assert.deepEqual(onsets(sig, 1).map((st) => st.value), [2, 3]);
  close(onsets(sig, 1)[0].start, 0);
});

test('.fast(4).slow(4) round-trips to the original grid', () => {
  const steps = onsets(n('0 1 2 3').fast(4).slow(4));
  assert.deepEqual(steps.map((st) => st.value), [0, 1, 2, 3]);
  steps.forEach((st, i) => close(st.start, i / 4));
});

test('.fast(-1) plays the pattern in reverse', () => {
  const steps = onsets(n('0 1 2 3').fast(-1));
  assert.deepEqual(steps.map((st) => st.value), [3, 2, 1, 0]);
  steps.forEach((st, i) => close(st.start, i / 4));
});

test('.slow(-2) reverses at half speed', () => {
  const sig = n('0 1 2 3').slow(-2);
  assert.deepEqual(onsets(sig, 0).map((st) => st.value), [3, 2]);
  assert.deepEqual(onsets(sig, 1).map((st) => st.value), [1, 0]);
});

test('.fast() continuous sample() agrees with the warped step grid', () => {
  const sig = n('0 1 2 3').fast(2);
  // Result position 0.6 reads source position 1.2 - cycle 1's first quarter, value 0.
  assert.equal(sig.sample(0.6, 1), 0);
  assert.equal(sig.sample(0.6 / 2, 2), 0); // same position via t*cps
  assert.equal(sig.sample(0.9, 1), 3); // source 1.8 - cycle 1's last quarter
});

test('a ringing tail crossing a cycle under .slow() becomes a cont step', () => {
  // A tie is real structure - the step itself is long - so slowing it across the cycle line leaves a
  // cont tail in the next cycle. (A .clip() does NOT: it's a key the emitter reads, so the note
  // rings past the line without any step being there - see the next test.)
  const sig = n('0 _ _ 1').slow(2);
  const c1 = sig.stepsForCycle(1).sort((a, b) => a.start - b.start);
  const tail = c1.find((st) => st.cont);
  assert.ok(tail, 'expected the held "0" to report a cont tail in cycle 1');
  assert.equal(tail.value, 0);
  assert.deepEqual(onsets(sig, 1).map((st) => st.value), [1]);
});

test('.clip() rings past the cycle without inventing a step there', () => {
  const sig = n('0 1').clip(2).slow(2);
  // Each note's own step is a whole cycle after .slow(2); clip 2 makes it SOUND for two.
  const c0 = onsets(sig, 0);
  assert.deepEqual(c0.map((st) => [st.start, st.end]), [[0, 1]]);
  close(soundingEnd(c0[0], sig.noteChannels, 0, 1, 0), 2);
  // Cycle 1 holds the next note's own onset - no phantom tail, and nothing dropped.
  assert.deepEqual(onsets(sig, 1).map((st) => st.value), [1]);
  assert.equal(sig.stepsForCycle(1).some((st) => st.cont), false);
});

test('.vel() attached before .fast() warps with its events', () => {
  const sig = note('60').vel('1 0.5').fast(2);
  assert.equal(onsets(sig).length, 4); // the patterned vel's grid, doubled
  // Onset at result 0.25 reads the source vel at 0.5 - the "0.5" step.
  assert.equal(sig.noteChannels.vel.sample(0.25, 1), 0.5);
  assert.equal(sig.noteChannels.vel.sample(0, 1), 1);
});

test('sampler configs attached before .fast() warp with their events', () => {
  const sig = s('bd').i('0 1').fast(2);
  assert.equal(onsets(sig).length, 4);
  assert.equal(sig.sampler.index.sample(0.25, 1), 1); // source position 0.5 -> index 1
  assert.equal(sig.sampler.index.sample(0.5, 1), 0); // source position 1.0 -> cycle 1's "0"
});

test('.fast() on an LFO multiplies the rate; .rate() sets it absolutely', () => {
  assert.equal(sine(2).fast(2).lfoIR.rateHz, 4);
  assert.equal(sine(2).slow(4).lfoIR.rateHz, 0.5);
  assert.equal(sine(2).rate(3).lfoIR.rateHz, 3);
});

test('.fast()/.slow() reject zero and non-numbers, and .fast() rejects env()', () => {
  assert.throws(() => n('0').fast(0), /nonzero factor/);
  assert.throws(() => n('0').slow('x'), /nonzero factor/);
  assert.throws(() => env().fast(2), /env/);
});

// ---------------------------------------------------------------------------------------------
// Sig .fast() / .slow() with a PATTERNED factor (the rate itself varies across the cycle)
// ---------------------------------------------------------------------------------------------

test('.fast("<2 3>") alternates the whole-cycle rate per cycle', () => {
  const sig = n('0 1 2 3').fast('<2 3>');
  assert.deepEqual(onsets(sig, 0).map((s) => s.value), [0, 1, 2, 3, 0, 1, 2, 3]); // 2x
  assert.equal(onsets(sig, 1).length, 12); // 3x -> three copies
});

test('.fast("2 4") changes the rate WITHIN the cycle, each half its own window', () => {
  const sig = n('0 1 2 3').fast('2 4');
  const steps = onsets(sig);
  // First half [0,0.5) at 2x: one pass of 0 1 2 3. Second half [0.5,1) at 4x: two passes.
  assert.equal(steps.length, 12);
  const firstHalf = steps.filter((s) => s.start < 0.5 - 1e-9);
  const secondHalf = steps.filter((s) => s.start >= 0.5 - 1e-9);
  assert.deepEqual(firstHalf.map((s) => s.value), [0, 1, 2, 3]);
  close(firstHalf[0].start, 0);
  close(firstHalf[1].start, 1 / 8);
  assert.deepEqual(secondHalf.map((s) => s.value), [0, 1, 2, 3, 0, 1, 2, 3]);
  close(secondHalf[0].start, 0.5);
});

test('.slow("2") matches the numeric .slow(2) grid', () => {
  const pat = n('0 1 2 3').slow('2');
  const num = n('0 1 2 3').slow(2);
  for (const c of [0, 1]) {
    assert.deepEqual(onsets(pat, c).map((s) => s.value), onsets(num, c).map((s) => s.value));
  }
});

test('a non-numeric or all-zero rate pattern is a clear error at eval time', () => {
  assert.throws(() => n('0').fast('x'), /nonzero factor|numeric rate/);
  assert.throws(() => n('0').slow('x'), /nonzero factor|numeric rate/);
});

// ---------------------------------------------------------------------------------------------
// warpSteps: the shared helper the client highlighter uses so its timing matches the scheduler
// (the Sig warps through this same function). These lock the client-facing contract.
// ---------------------------------------------------------------------------------------------

test('warpSteps mirrors the Sig grid the highlighter has to reproduce', () => {
  const base = (cyc) => getStepsForCycle(parseMini('0 1 2 3'), cyc);
  // .fast(2): two source cycles fold into result cycle 0, onsets every 1/8.
  const fast = warpSteps(base, 2);
  const f0 = fast(0).filter((s) => s.value != null && !s.cont).sort((a, b) => a.start - b.start);
  assert.deepEqual(f0.map((s) => s.value), ['0', '1', '2', '3', '0', '1', '2', '3']);
  f0.forEach((s, i) => close(s.start, i / 8));
  // .slow(2): source spread over two result cycles, "2"/"3" land in cycle 1 (onset at 0).
  const slow = warpSteps(base, 0.5);
  const s1 = slow(1).filter((s) => s.value != null && !s.cont).sort((a, b) => a.start - b.start);
  assert.deepEqual(s1.map((s) => s.value), ['2', '3']);
  close(s1[0].start, 0);
  // .fast(-1): reversed onsets, same grid the scheduler plays.
  const rev = warpSteps(base, -1);
  const r0 = rev(0).filter((s) => s.value != null && !s.cont).sort((a, b) => a.start - b.start);
  assert.deepEqual(r0.map((s) => s.value), ['3', '2', '1', '0']);
});
