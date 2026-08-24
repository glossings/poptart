// A `,`-stack as the RIGHT operand of an operator: several values sounding at once, so the event
// fans out into one per layer instead of collapsing to whichever layer a sample() happens to pick.
// `myPat.add(note("0,7"))` keeps every note and sounds its fifth alongside; the same holds for the
// sampler controls (`.mul(speed("1.1,0.9"))` is two hits, detuned apart) and for mini's own "+".
// Pure pattern math plus one mocked engine - no server, no audio.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, n, s, mini, speed, begin, i } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

const values = (sig, cycle = 0) => sig.stepsForCycle(cycle).map((x) => x.value);
const spans = (sig, cycle = 0) => sig.stepsForCycle(cycle).map((x) => [x.start, x.end]);
const cfgs = (sig, cycle = 0) => sig.stepsForCycle(cycle).map((x) => x.cfg);

// ---------------------------------------------------------------------------------------------
// Value arithmetic (synth patterns)
// ---------------------------------------------------------------------------------------------

test('a stacked operand fans each event out, one per layer', () => {
  const track = note('0 1').add(note('0,7'));
  assert.deepEqual(values(track), [0, 7, 1, 8]);
  // Both layers of a step sound TOGETHER - same span, twice.
  assert.deepEqual(spans(track), [[0, 0.5], [0, 0.5], [0.5, 1], [0.5, 1]]);
});

test('the stack may be a bare mini string, and may have more than two layers', () => {
  assert.deepEqual(values(note('0 1').add('0,7')), [0, 7, 1, 8]);
  assert.deepEqual(values(note('0').add(note('0,7,12'))), [0, 7, 12]);
});

test('it works for every operator, not just add', () => {
  assert.deepEqual(values(n('2 4').mul('1,0.5')), [2, 1, 4, 2]);
  assert.deepEqual(values(n('10').sub('0,3')), [10, 7]);
  assert.deepEqual(values(n('12').div('1,2')), [12, 6]);
});

test('a stack on both sides gives every combination', () => {
  // Two notes, each offset two ways: a four-note voicing.
  assert.deepEqual(values(note('0,4').add(note('0,7'))), [0, 7, 4, 11]);
});

test('a non-stacked operand still reads as exactly one value', () => {
  assert.deepEqual(values(note('0 1').add(note('<0 7>'))), [0, 1]);
  assert.deepEqual(values(note('0 1').add(note('<0 7>')), 1), [7, 8]);
  assert.deepEqual(values(note('0 1').add(12)), [12, 13]);
  assert.deepEqual(values(n('0 1 2 3').add('10 20')), [10, 11, 22, 23]);
});

test('rests and structure survive the fan-out', () => {
  const rest = note('0 ~ 1').add(note('0,7'));
  assert.deepEqual(values(rest), [0, 7, 1, 8], 'the rest stays silent, the sounding thirds fan out');
  assert.deepEqual(spans(rest), [[0, 1 / 3], [0, 1 / 3], [2 / 3, 1], [2 / 3, 1]]);
  const fast = note('0 1').add(note('0,7')).fast(2);
  assert.deepEqual(values(fast), [0, 7, 1, 8, 0, 7, 1, 8]);
  assert.deepEqual(spans(fast)[0], [0, 0.25]);
});

test('both operands light up, so playback highlighting follows either atom', () => {
  const steps = note('0 1').add(note('0,7')).stepsForCycle(0);
  // Each fanned event carries its own layer's span alongside the left atom's - four distinct
  // pairs, not the same layer repeated.
  const locSets = steps.map((s) => JSON.stringify(s.locs));
  assert.equal(new Set(locSets).size, 4);
  for (const s of steps) assert.equal(s.locs.length, 2);
});

// ---------------------------------------------------------------------------------------------
// mini's own arithmetic
// ---------------------------------------------------------------------------------------------

test('mini "+" fans a stacked operand out the same way', () => {
  assert.deepEqual(values(mini('([0 1] + [0,7])')), [0, 7, 1, 8]);
  assert.deepEqual(values(mini('(3 + [0,7])')), [3, 10]);
  assert.deepEqual(values(mini('([0 1] + 7)')), [7, 8], 'a plain operand is untouched');
});

// ---------------------------------------------------------------------------------------------
// Sampler controls - each fanned event carries its own layer's value
// ---------------------------------------------------------------------------------------------

test('a stacked sampler control plays one event per layer, each with its own value', () => {
  assert.deepEqual(cfgs(s('bd').speed('1.1,0.9')), [{ speed: 1.1 }, { speed: 0.9 }]);
  assert.deepEqual(cfgs(s('bd').mul(speed('1.1,0.9'))), [{ speed: 1.1 }, { speed: 0.9 }]);
  // The unset default is the left operand, as it is for a non-stacked control: begin 0, index 0.
  assert.deepEqual(cfgs(s('bd').add(begin('0,0.5'))), [{ begin: 0 }, { begin: 0.5 }]);
  assert.deepEqual(cfgs(s('bd').add(i('0,3'))), [{ index: 0 }, { index: 3 }]);
});

test('a stacked repitch turns a sample into a chord', () => {
  assert.deepEqual(cfgs(s('pluck').n('0,7')), [{ note: 0 }, { note: 7 }]);
  // Bare arithmetic on a sampler aims at the repitch note, whose unset default is 60 (c3).
  assert.deepEqual(cfgs(s('pluck').add(note('0,7'))), [{ note: 60 }, { note: 67 }]);
});

test('different stacked controls cross-product; the same one re-applied does not', () => {
  assert.deepEqual(cfgs(s('bd').n('0,7').speed('1,2')), [
    { note: 0, speed: 1 }, { note: 0, speed: 2 }, { note: 7, speed: 1 }, { note: 7, speed: 2 },
  ]);
  // .add() rebuilds the whole note channel and re-merges it, so without the collapse in crossMerge
  // this would come back as four events - two pairs playing the same note.
  assert.deepEqual(cfgs(s('bd').n('0,7').add(12)), [{ note: 12 }, { note: 19 }]);
  assert.deepEqual(cfgs(s('bd').speed('1,0.5').mul(speed(2))), [{ speed: 2 }, { speed: 1 }]);
});

test('genuinely duplicated events are left alone - the collapse only removes re-stamped copies', () => {
  // s("bd,bd") is two hits by construction; merging a control on top must not thin it to one.
  assert.equal(s('bd,bd').speed('1 2').stepsForCycle(0).length, 4);
});

test('.scale() maps the repitch that rides on each event, not just the channel', () => {
  assert.deepEqual(cfgs(s('pluck').n('0,7').scale('F minor')), [{ note: 65 }, { note: 77 }]);
});

test('a control with no grid of its own imposes no fan-out', () => {
  assert.deepEqual(spans(s('bd').speed(2)), [[0, 1]]);
  assert.equal(s('bd').speed(2).stepsForCycle(0)[0].cfg, undefined, 'nothing to stamp');
});

// ---------------------------------------------------------------------------------------------
// What the scheduler actually plays
// ---------------------------------------------------------------------------------------------

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, callsTo: (method) => calls.filter((c) => c.method === method) };
}

// Runs one tick's worth of the lookahead walk over cycle 0.
function play(sig) {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1);
  return callsTo;
}

test('the scheduler fires each layer with its own sampler config', () => {
  const played = play(s('bd').speed('1.1,0.9'))('playSample');
  assert.equal(played.length, 2, 'two hits');
  assert.deepEqual(played.map((c) => c.args[2].speed), [1.1, 0.9]);
});

test('the scheduler fires each layer of a stacked repitch', () => {
  const played = play(s('pluck').n('0,7'))('playSample');
  assert.deepEqual(played.map((c) => c.args[2].note), [0, 7]);
});

test('a channel with no step grid is still sampled per onset, as before', () => {
  const played = play(s('bd*2').speed(2))('playSample');
  assert.deepEqual(played.map((c) => c.args[2].speed), [2, 2]);
});

test('a stacked note pattern fires every layer as its own note', () => {
  const ons = play(note('0 1').add(note('0,7')))('noteOn');
  assert.deepEqual(ons.map((c) => c.args[1]), [0, 7, 1, 8]);
});
