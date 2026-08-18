// cat()/seq(): the pattern-of-patterns join. Both are one mechanism (selectorJoin) under a
// different division of the cycle, so the slot-edge rules are tested through seq(), which is the
// form that actually has edges inside a cycle. Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cat, seq, mini, n, note, setPatternWarn } from './src/signal.mjs';

const spans = (sig, cycle) => sig.stepsForCycle(cycle).map((s) => [s.start, s.end, s.value]);
const values = (sig, cycle) => sig.stepsForCycle(cycle).map((s) => s.value);

test('cat() gives each option a whole cycle in turn, wrapping', () => {
  const c = cat(mini('10'), mini('20'), mini('30'));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((cyc) => values(c, cyc)), [[10], [20], [30], [10], [20], [30]]);
});

test('cat() options keep running on the transport rather than resuming where they left off', () => {
  // A three-cycle option taking every OTHER turn: if it advanced per turn it would read
  // 10, 20, 30 on its turns. It reads its own absolute cycle instead.
  const c = cat(mini('<10 20 30>'), mini('99'));
  assert.deepEqual([0, 2, 4].map((cyc) => values(c, cyc)), [[10], [30], [20]]);
  assert.deepEqual([1, 3, 5].map((cyc) => values(c, cyc)), [[99], [99], [99]]);
});

test('cat() sample() agrees with the step grid', () => {
  const c = cat(mini('10 11'), mini('20 21'));
  for (const [cyc, phase, want] of [[0, 0.25, 10], [0, 0.75, 11], [1, 0.25, 20], [1, 0.75, 21]]) {
    assert.equal(c.sample(cyc + phase, 1, cyc + phase), want, `cycle ${cyc} phase ${phase}`);
  }
});

test('cat() of a value with no grid holds it across the cycle', () => {
  const c = cat(mini('1 2'), 7);
  assert.deepEqual(spans(c, 0), [[0, 0.5, 1], [0.5, 1, 2]]);
  assert.deepEqual(spans(c, 1), [[0, 1, 7]]);
});

test('seq() splits the cycle, and each option is heard where it already was', () => {
  // Not squeezed to fit: the first option contributes the onsets that fall in its own first half,
  // the second the onsets that fall in its own second half - so 0 1 6 7, not 0 1 4 5.
  const q = seq(mini('0 1 2 3'), mini('4 5 6 7'));
  assert.deepEqual(spans(q, 0), [[0, 0.25, 0], [0.25, 0.5, 1], [0.5, 0.75, 6], [0.75, 1, 7]]);
});

test('seq() clips a note that runs past its slot', () => {
  // The whole-cycle "0" is cut at the switch; "4" never sounds - its onset is in the slot the
  // other option holds, and a note already ringing is not adopted when the slot opens.
  assert.deepEqual(spans(seq(mini('0'), mini('4 5')), 0), [[0, 0.5, 0], [0.5, 1, 5]]);
});

test('seq() plays silence for a rest in the option holding the slot', () => {
  const q = seq(mini('~ 0'), mini('4 5'));
  assert.deepEqual(spans(q, 0), [[0.5, 1, 5]]);
  assert.equal(q.sample(0.2, 1, 0.2), null, 'the first half is silent, not the other option');
});

test('seq() slots are filled only by onsets that fall inside them', () => {
  // The sharp edge of the onsets-only rule: each option here is ONE whole-cycle note, and a note
  // sounds only where it starts. Option 1 owns phase 0, so it is the only one heard - the others
  // were already ringing when their slots opened, and a switch does not restart them.
  assert.deepEqual(spans(seq(mini('1'), mini('2'), mini('3')), 0), [[0, 1 / 3, 1]]);
  // Options with onsets of their own inside their slot - a drawn roll, "hh*8" - fill them.
  const dense = seq(mini('1*3'), mini('2*3'), mini('3*3'));
  assert.deepEqual(spans(dense, 0), [[0, 1 / 3, 1], [1 / 3, 2 / 3, 2], [2 / 3, 1, 3]]);
});

test('a join carries a unanimous pitch kind, and drops a mixed one', () => {
  assert.equal(cat(note('c4'), note('e4')).pitchKind, 'note');
  assert.equal(seq(n('0'), n('2')).pitchKind, 'degree');
  assert.equal(cat(note('c4'), n('0')).pitchKind, null, 'no one answer - .scale() must not guess');
});

test('a join keeps the source spans of the option that sounded', () => {
  // Highlighting follows the atom that actually played, with no per-builder wiring.
  const step = cat(mini('10'), mini('99')).stepsForCycle(1)[0];
  assert.ok(step.loc || (step.locs && step.locs.length), 'the step carries its atom span');
});

test('an option carrying its own synth() warns and still sounds', () => {
  const warnings = [];
  setPatternWarn((m) => warnings.push(m));
  try {
    const c = cat(note('c4').synth('Serum 2'), note('e4'));
    assert.equal(c.instrument, 'Serum 2', 'the chain is kept so the track is not silent');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /aren't patterned yet/);
  } finally {
    setPatternWarn(null);
  }
});

test('cat()/seq() need at least one option', () => {
  assert.throws(() => cat(), /needs at least one pattern/);
  assert.throws(() => seq(), /needs at least one pattern/);
});
