// Userland access to a pattern's events: .fmap() on values, .events() on whole events (time,
// channels, sampler controls), and the binop modifiers .in/.out/.squeeze/.mix that say whose
// events an operation plays on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, n, s, vel, speed } from './src/index.mjs';

// [start, end, value] per sounding step of `cycle`, rounded so float noise doesn't fail a test.
const grid = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle).filter((x) => x.value != null).map((x) => [round(x.start), round(x.end), x.value]);
const round = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// fmap
// ---------------------------------------------------------------------------------------------

test('fmap maps the values and leaves the timing alone', () => {
  assert.deepEqual(grid(n('0 2 ~ 4').fmap((v) => v * 2)), [[0, 0.25, 0], [0.25, 0.5, 4], [0.75, 1, 8]]);
  assert.throws(() => n('0').fmap(2), /takes a function/);
});

// ---------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------

test('events shows one cycle at a time, in cycles from the top of the song, with what is in force', () => {
  const seen = [];
  note('c3 e3').vel('1 0.5').events((es, cycle) => { if (cycle === 2) seen.push(...es); }).stepsForCycle(2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].start, 2);
  assert.equal(seen[1].end, 3);
  assert.deepEqual([seen[0].value, seen[0].vel, seen[1].vel, seen[0].clip, seen[0].nudge], [60, 1, 0.5, 1, 0]);
});

test('events can change values and channels, in place or by returning new ones', () => {
  const half = note('c3 e3').vel('1 0.5').events((es) => es.map((e) => ({ ...e, vel: e.vel / 2 })));
  assert.deepEqual(half.stepsForCycle(0).map((x) => x.vel), [0.5, 0.25]);
  const inPlace = note('c3 e3').events((es) => { es[0].value = 72; });
  assert.deepEqual(grid(inPlace), [[0, 0.5, 72], [0.5, 1, 64]]);
});

test('a channel shown but left alone is not frozen onto the event', () => {
  const steps = note('c3 e3').vel(0.7).events((es) => es).stepsForCycle(0);
  assert.equal(steps[0].vel, undefined, 'the constant channel keeps playing from the channel');
});

test('an event moved past the cycle line plays in the next cycle', () => {
  const late = note('c3 e3 g3 b3').events((es) => es.map((e) => ({ ...e, start: e.start + 0.1, end: e.end + 0.1 })));
  assert.deepEqual(grid(late, 0).map((x) => x[0]), [0.1, 0.35, 0.6, 0.85]);
  // cycle 0's last note sounds from 0.85 to 1.1; nothing from cycle -1 lands before 0.1 in cycle 0
  const early = note('c3 e3').events((es) => es.map((e) => ({ ...e, start: e.start - 0.1, end: e.end - 0.1 })));
  assert.deepEqual(grid(early, 0), [[0.4, 0.9, 64], [0.9, 1.4, 60]], "cycle 1's first note arrives at the end of cycle 0");
});

test('events can be added from scratch and dropped', () => {
  const more = note('c3').events((es) => [...es, { start: es[0].start + 0.5, end: es[0].start + 0.75, value: 67 }]);
  assert.deepEqual(grid(more), [[0, 1, 60], [0.5, 0.75, 67]]);
  const fewer = note('c3 e3 g3').events((es) => es.filter((e) => e.value !== 64));
  assert.deepEqual(grid(fewer).map((x) => x[2]), [60, 67]);
});

test('a copy of an event keeps its highlight; a made-up one has none', () => {
  const steps = note('c3').events((es) => [...es, { ...es[0], start: es[0].start + 0.5 }, { start: 0.25, end: 0.5, value: 1 }]).stepsForCycle(0);
  const copy = steps.find((x) => x.start === 0.5);
  const made = steps.find((x) => x.start === 0.25);
  assert.deepEqual(copy.loc ?? copy.locs, steps[0].loc ?? steps[0].locs);
  assert.equal(made.loc ?? made.locs, undefined);
});

test('sampler controls are shown by name and written back by name', () => {
  const flipped = s('bd*2').speed(2).begin('0 0.5').events((es) => es.map((e) => ({ ...e, controls: { ...e.controls, speed: -e.controls.speed } })));
  const cfg = flipped.stepsForCycle(0).map((x) => x.cfg);
  assert.deepEqual(cfg, [{ begin: 0, speed: -2 }, { begin: 0.5, speed: -2 }]);
});

test('the function runs once per cycle, so randomness is one answer per cycle', () => {
  let calls = 0;
  const sig = note('c3').events((es) => { calls++; return es.map((e) => ({ ...e, value: e.value + Math.floor(Math.random() * 12) })); });
  const first = grid(sig, 5);
  assert.deepEqual(grid(sig, 5), first);
  assert.equal(calls, 3, 'cycles 4, 5 and 6 - once each');
});

test('events that cannot play are warned about and left out; a pattern with no events is left alone', () => {
  const sig = note('c3').events(() => [{ start: 1, end: 0.5, value: 60 }, 'nope']);
  assert.deepEqual(grid(sig), []);
  assert.throws(() => note('c3').events(() => 5).stepsForCycle(0), /return a list of events/);
});

// ---------------------------------------------------------------------------------------------
// Binop modifiers
// ---------------------------------------------------------------------------------------------

test('.add mixes; .add.in keeps the events; .add.out takes the operand\'s; .add.squeeze fits a cycle in', () => {
  const c = () => note('c3 e3');
  assert.deepEqual(grid(c().add('0 7 12 3')), [[0, 0.25, 60], [0.25, 0.5, 67], [0.5, 0.75, 76], [0.75, 1, 67]]);
  assert.deepEqual(grid(c().add.mix('0 7 12 3')), grid(c().add('0 7 12 3')));
  assert.deepEqual(grid(c().add.in('0 7 12 3')), [[0, 0.5, 60], [0.5, 1, 76]]);
  assert.deepEqual(grid(c().add.out('0 7 12 3')), [[0, 0.25, 60], [0.25, 0.5, 67], [0.5, 0.75, 76], [0.75, 1, 67]]);
  assert.deepEqual(grid(note('c3 e3').add.out('0 ~ 12')), [[0, 0.333, 60], [0.667, 1, 76]]);
  assert.deepEqual(grid(c().add.squeeze('0 7')), [[0, 0.25, 60], [0.25, 0.5, 67], [0.5, 0.75, 64], [0.75, 1, 71]]);
});

test('.in reads the operand at each onset: a rest there silences the event, a stack fans it out', () => {
  assert.deepEqual(grid(note('c3 e3').add.in('~ 7')), [[0.5, 1, 71]]);
  assert.deepEqual(grid(note('c3').add.in('0,12')).map((x) => x[2]).sort(), [60, 72]);
  assert.deepEqual(grid(note('c3*2').add.in('<0 7 12>'), 1).map((x) => x[2]), [67, 67]);
  assert.deepEqual(grid(note('c3 e3').add.in(12)), [[0, 0.5, 72], [0.5, 1, 76]], 'a number is the same every way');
});

test('.out keeps every layer of a chord', () => {
  assert.deepEqual(grid(note('c3,e3').add.out('0 12')), [[0, 0.5, 60], [0, 0.5, 64], [0.5, 1, 72], [0.5, 1, 76]]);
});

test('the modifiers reach the sampler, the note channels and the layers alike', () => {
  const cfg = (sig) => sig.stepsForCycle(0).filter((x) => x.value != null).map((x) => x.cfg);
  assert.deepEqual(cfg(s('bd*2').add.in('0 7 12 3')), [{ note: 60 }, { note: 72 }]);
  assert.deepEqual(cfg(s('bd*2').add.out('0 7 12 3')).length, 4);
  assert.deepEqual(cfg(s('bd*2').mul.in(speed('1 -1 2 -2'))), [{ speed: 1 }, { speed: 2 }]);
  assert.deepEqual(note('c3 e3').mul.in(vel('1 0.5 0.5 1')).stepsForCycle(0).map((x) => x.vel), [1, 0.5]);
  assert.deepEqual(grid(note('c3 e3').add.in(note('0 12'), note('7 19'))).map((x) => x[2]), [60, 67, 76, 83]);
});

test('comparisons take the modifiers too', () => {
  assert.deepEqual(grid(n('0 1 2 3').gte.in('2 0')).map((x) => x[2]), [0, 0, 1, 1]);
});
