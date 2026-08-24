// "Every argument takes a pattern." The combinators used to coerce their numeric arguments with
// Number(), which silently collapsed to NaN (and then to a default) as soon as they were handed a
// signal - which is exactly what the editor hands them, since the location transpile rewrites every
// pattern-position "…" literal into mini("…", offset). These cover the signal forms of each.
// Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, s, mini, Signal, sine, saw, irand, env, midicc } from './src/signal.mjs';
import { stepLocs } from './src/mini.mjs';

const starts = (sig, cycle) => sig.stepsForCycle(cycle).map((x) => x.start);
const values = (sig, cycle) => sig.stepsForCycle(cycle).filter((x) => x.value != null).map((x) => x.value);

// ---------------------------------------------------------------------------------------------
// .ply()
// ---------------------------------------------------------------------------------------------

test('.ply() takes a signal count - what the editor actually passes for .ply("4")', () => {
  // mini("4", …) is literally what `.ply("4")` becomes after the location transpile.
  assert.equal(n('0').ply(mini('4', 0)).stepsForCycle(0).length, 4);
  assert.equal(n('0').ply('4').stepsForCycle(0).length, 4);
  assert.equal(n('0').ply(Signal(4)).stepsForCycle(0).length, 4);
  assert.equal(n('0').ply(4).stepsForCycle(0).length, 4, 'plain numbers unchanged');
});

test('.ply() reads its count per source event, so it can vary through the cycle', () => {
  // "2 4": the first event plies 2, the second plies 4.
  assert.deepEqual(starts(n('0 1').ply('2 4'), 0), [0, 0.25, 0.5, 0.625, 0.75, 0.875]);
  // "<2 4>": bar by bar.
  const alt = n('0').ply('<2 4>');
  assert.equal(alt.stepsForCycle(0).length, 2);
  assert.equal(alt.stepsForCycle(1).length, 4);
});

test('.ply() treats a rest or a nonsense count as "no subdivision"', () => {
  assert.deepEqual(starts(n('0 1').ply('2 ~'), 0), [0, 0.25, 0.5]);
  assert.deepEqual(starts(n('0 1').ply('2 x'), 0), [0, 0.25, 0.5]);
});

test('.ply() still runs its per-repetition transform, now built lazily', () => {
  assert.deepEqual(values(n('0 2').ply('3', (x, k) => x.add(k * 12)), 0), [0, 12, 24, 2, 14, 26]);
});

test('.ply() carries the count atom into the highlight spans', () => {
  const steps = mini('0').ply(mini('2', 10)).stepsForCycle(0);
  assert.deepEqual(steps.map((x) => x.locs), [[[0, 1], [10, 11]], [[0, 1], [10, 11]]]);
});

// ---------------------------------------------------------------------------------------------
// .seg() / .fast() / .slow()
// ---------------------------------------------------------------------------------------------

test('.seg() takes every signal form of its step count', () => {
  for (const arg of [8, '8', mini('8', 0), Signal(8)]) {
    assert.equal(n('0').seg(arg).stepsForCycle(0).length, 8, `seg(${JSON.stringify(arg)})`);
  }
});

test('.seg() takes a gridless signal, reading it once per cycle', () => {
  // saw(0.25) has no step grid at all - .seg() holds one rate per cycle off it. A quarter-Hz saw
  // over 0..4 reads 2, 3, 4, 5 at cycles 0..3, so the grid gets that many steps.
  const swept = n('0').seg(saw(0.25).range(2, 6));
  assert.deepEqual([0, 1, 2, 3].map((c) => swept.stepsForCycle(c).length), [2, 3, 4, 5]);
});

test('.fast()/.slow() take a constant-valued signal on the exact numeric path', () => {
  assert.deepEqual(starts(n('0 1').fast(Signal(2)), 0), starts(n('0 1').fast(2), 0));
  assert.deepEqual(starts(n('0 1').slow(Signal(2)), 0), starts(n('0 1').slow(2), 0));
  // An LFO's rate multiply is a constant-only fast path - a Signal(2) must reach it too.
  assert.equal(sine(1).fast(Signal(2)).lfoIR.rateCycles, 2);
});

test('.fast() takes a gridless signal, held once per cycle', () => {
  const swept = n('0').fast(saw(0.25).range(1, 5));
  assert.deepEqual([0, 1, 2, 3].map((c) => swept.stepsForCycle(c).length), [1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------------------------
// .degrade() / .echo() / .clamp()
// ---------------------------------------------------------------------------------------------

test('.degrade() takes a patterned probability', () => {
  // Never / always, so the assertion doesn't lean on a particular hash.
  assert.equal(values(n('0 1 2 3').degrade('0'), 0).length, 4);
  assert.equal(values(n('0 1 2 3').degrade('1'), 0).length, 0);
  // Alternating bar by bar: bar 0 keeps everything, bar 1 drops everything.
  const alt = n('0 1 2 3').degrade('<0 1>');
  assert.equal(values(alt, 0).length, 4);
  assert.equal(values(alt, 1).length, 0);
});

test('.echo() takes patterned reps and time', () => {
  // A signal argument must lay the copies out exactly as the equivalent number does.
  assert.deepEqual(starts(n('0').echo('2', 0.25), 0), starts(n('0').echo(2, 0.25), 0));
  assert.deepEqual(starts(n('0').echo(2, '0.5'), 0), starts(n('0').echo(2, 0.5), 0));
  // Both are read once per output cycle, so an alternation changes the echo bar by bar.
  const alt = n('0').echo('<1 3>', 0.25);
  assert.deepEqual(starts(alt, 0), starts(n('0').echo(1, 0.25), 0));
  assert.deepEqual(starts(alt, 1), starts(n('0').echo(3, 0.25), 1));
});

test('.clamp() takes patterned bounds', () => {
  assert.deepEqual(values(n('0 5 10').clamp(2, 8), 0), [2, 5, 8], 'numbers unchanged');
  assert.deepEqual(values(n('10 10').clamp(0, '2 8'), 0), [2, 8]);
});

// ---------------------------------------------------------------------------------------------
// The idiom that started this: a sampler chopped by a segmented random
// ---------------------------------------------------------------------------------------------

test('irand("8").seg(8) still drives eight fresh sampler starts a bar', () => {
  const track = s('breaks:19').fit().begin(irand('8').seg(8).div(8));
  assert.deepEqual(starts(track, 0), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  const drawn = starts(track, 0).map((p) => track.sampler.begin.sample(p, 1, p));
  for (const v of drawn) assert.ok(v >= 0 && v < 1, `${v} is a real 0..1 position`);
  assert.ok(new Set(drawn).size > 1, 'the eight draws are not one frozen value');
});

// ---------------------------------------------------------------------------------------------
// Triggers mix
// ---------------------------------------------------------------------------------------------
// An operator's pattern argument keeps its own timeline and mixes its own onsets into the events it
// lands on. It is never squeezed into them (mini's euclid used to do that), and never collapsed to
// one value per event either. An argument with no grid of its own - a number, an LFO, a within-cycle
// signal like irand() - has no triggers to contribute, so those events are untouched.

const closeAll = (got, want, msg = 'starts') => {
  assert.equal(got.length, want.length, `${msg}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 1e-9, `${msg}[${i}]: ${g} !~ ${want[i]}`));
};

test('arithmetic mixes its right operand\'s triggers in', () => {
  const sig = n('0').add('1 2');
  assert.deepEqual(values(sig, 0), [1, 2], 'two events, one per half of "1 2"');
  closeAll(starts(sig, 0), [0, 0.5]);
  assert.ok(sig.stepsForCycle(0).every((st) => !st.cont), 'each is an attack, not a tie');
  // Aligned grids are unchanged, and an operand with no triggers of its own adds none.
  assert.deepEqual(values(n('0 1').add('7 0'), 0), [7, 1]);
  assert.deepEqual(values(n('0 1 2 3').add(12), 0), [12, 13, 14, 15]);
  assert.equal(n('0').add(sine(1).range(0, 12)).stepsForCycle(0).length, 1, 'an LFO has no triggers to mix');
  assert.equal(n('0').add(irand(12)).stepsForCycle(0).length, 1, 'nor does a within-cycle random');
});

test('a `,`-stacked operand fans the event out instead of cutting it', () => {
  const sig = n('0').add('0,7');
  assert.deepEqual(values(sig, 0), [0, 7]);
  assert.deepEqual(sig.stepsForCycle(0).map((st) => [st.start, st.end]), [[0, 1], [0, 1]]);
});

test('each mixed event lights both operands - its own half of the argument', () => {
  const sig = n(mini('0', 100)).add(mini('1 2', 0));
  assert.deepEqual(sig.stepsForCycle(0).map((st) => st.locs), [
    [[100, 101], [0, 1]],
    [[100, 101], [2, 3]],
  ]);
});

test('.ply() switches count at the mixed triggers - n("0").ply("4 3")', () => {
  // ply(4) is quarter notes, ply(3) triplets. Two quarters, then the triplet grid takes over
  // halfway through the bar and its last note (2/3) is the one that lands there.
  closeAll(starts(n('0').ply('4 3'), 0), [0, 0.25, 2 / 3]);
  closeAll(starts(n('0').ply('3 4'), 0), [0, 1 / 3, 0.5, 0.75]);
  // A count that doesn't change mid-event is unaffected.
  closeAll(starts(n('0').ply('4'), 0), [0, 0.25, 0.5, 0.75]);
});

test('arithmetic reads a note name as its MIDI number', () => {
  // `note("C2".add("0 12"))`: after the string shim the add happens before note() ever sees the
  // value, so the operator has to know that "C2" is 48 - otherwise the note came out NaN.
  assert.deepEqual(values(note(mini('C2').add('0 12')), 0), [48, 60]);
  assert.deepEqual(values(mini('c2 e2').add(12), 0), [60, 64]);
  // Converting first, the long way round, gives the same thing.
  assert.deepEqual(values(note('C2').add('0 12'), 0), [48, 60]);
});

// ---------------------------------------------------------------------------------------------
// .range()
// ---------------------------------------------------------------------------------------------

test('.range() takes pattern bounds on a native modulator and keeps their spans for the highlighter', () => {
  // sine(1).range("200 300", 4000) as the editor hands it over: the string is already a mini Sig
  // carrying its document offset. The bound rides in the IR as itself (the scheduler polls it to
  // move the running LFO's floor), and its steps keep the atom spans the highlighter lights.
  const lo = mini('200 300', 10);
  const lfo = sine(1).range(lo, mini('4000', 22));
  assert.equal(lfo.lfoIR.min, lo, 'a pattern bound rides along in the IR as itself');
  assert.deepEqual(lfo.lfoIR.min.stepsForCycle(0).map((x) => [x.value, x.loc]), [[200, [10, 13]], [300, [14, 17]]]);
  assert.deepEqual(lfo.lfoIR.max.stepsForCycle(0).map((x) => [x.value, x.loc]), [[4000, [22, 26]]]);
  // env() and midicc() carry theirs the same way; a plain number stays a number.
  const e = env().range(mini('0.2 0.5', 3), 1);
  assert.deepEqual(e.envIR.min.stepsForCycle(0).map((x) => x.value), [0.2, 0.5]);
  assert.equal(e.envIR.max, 1);
  const c = midicc('Twister')(12).range(mini('80 100', 0), 2000);
  assert.deepEqual(c.ccIR.min.stepsForCycle(0).map((x) => x.value), [80, 100]);
  assert.equal(c.ccIR.max, 2000);
});

test('.range() with pattern bounds on a step pattern is plain arithmetic, and both sides keep their spans', () => {
  const p = n('0 1').range(mini('10 20', 5), 100);
  assert.deepEqual(values(p, 0), [10, 100]);
  const spans = p.stepsForCycle(0).map((x) => stepLocs(x));
  assert.ok(spans[0].some(([a, b]) => a === 5 && b === 7), 'the first event lights the "10" it read');
  assert.ok(spans[1].some(([a, b]) => a === 8 && b === 10), 'the second lights the "20"');
});
