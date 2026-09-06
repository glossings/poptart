// Two things that came in together, both about where a value LIVES rather than what it is:
//
//   - a note-channel operand (`.mul(vel(0.5))`) composing with per-EVENT values, not just with the
//     channel. A pianoroll's drawn velocities and a chord token's `57:0.8` can only ride on the
//     event (two events at one onset can't share a channel), so an operand that looked only at
//     noteChannels composed against the resting default and then had the setter clear the drawn
//     values off - playing a whole roll at the operand's own value.
//   - .mask() and .struct(), the two boolean combinators: one gates a pattern without touching its
//     rhythm, the other replaces the rhythm and keeps the values.
//
// Pure pattern math, no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, mini, s, pianoroll, vel, clip, sine, rand } from './src/signal.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

/** Sounding steps for a cycle, start-sorted. */
function grid(sig, cycle = 0) {
  return sig.stepsForCycle(cycle).filter((st) => st.value != null).sort((a, b) => a.start - b.start);
}

/** A four-cell roll whose notes carry four different drawn velocities. */
const drawnRoll = () => pianoroll('60,0,1,0.2 62,1,1,0.4 64,2,1,0.6 65,3,1,0.8', { grid: 4 });

// ---------------------------------------------------------------------------------------------
// a control operand composes with per-event values (the pianoroll case)
// ---------------------------------------------------------------------------------------------

test('a roll carries its drawn velocities on the events, not as a channel', () => {
  const roll = drawnRoll();
  assert.deepEqual(grid(roll).map((st) => st.vel), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(Object.keys(roll.noteChannels), [], 'a channel could not hold a chord\'s two velocities');
});

test('.mul(vel(x)) scales a roll\'s drawn velocities instead of replacing them', () => {
  assert.deepEqual(grid(drawnRoll().mul(vel(0.5))).map((st) => st.vel), [0.1, 0.2, 0.3, 0.4]);
});

test('.mul(vel(pattern)) composes per event, gating where the operand rests', () => {
  // The reported case: a whole-cycle `1` for seven bars, then a rest. The velocities must survive
  // the seven, and the eighth must go silent.
  const gated = drawnRoll().mul(vel('<1@7 ~>'));
  assert.deepEqual(grid(gated, 0).map((st) => st.vel), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(grid(gated, 6).map((st) => st.vel), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(grid(gated, 7), [], 'a rest in the operand drops the events it covers');
});

test('a patterned operand still subdivides, composing with each event\'s own value', () => {
  // Two operand steps across four notes: notes 0-1 halve, notes 2-3 double.
  const out = grid(drawnRoll().mul(vel('0.5 2')));
  assert.deepEqual(out.map((st) => st.vel), [0.1, 0.2, 1.2, 1.6]);
});

test('the resting default is the left side where nothing carries a velocity', () => {
  // n("0 2") has no vel anywhere - channel or event - so the composition is against the resting 1,
  // and with no grid on the operand it stays a channel the scheduler samples per onset.
  const sig = n('0 2').add(vel(0.5));
  assert.deepEqual(grid(sig).map((st) => st.vel), [undefined, undefined]);
  assert.equal(sig.noteChannels.vel.sample(0, 1), 1.5);
});

test('a patterned operand over value-less events still composes with the resting default', () => {
  // The operand has a grid, so it subdivides and stamps - against 1, since nothing else is in force.
  assert.deepEqual(grid(n('0 2').mul(vel('1 0.5'))).map((st) => st.vel), [1, 0.5]);
});

test('a channel-set velocity still composes on the channel', () => {
  // The path that already worked, kept working: .vel() sets a channel, and the operand composes
  // there rather than per event.
  const sig = n('0 2 4').vel('1 0.5 0.25').mul(vel(0.5));
  assert.deepEqual(grid(sig).map((st) => st.vel), [0.5, 0.25, 0.125]);
});

test('an .as() spec\'s per-token velocities compose too', () => {
  const sig = mini('60:0.2 62:0.4 64:0.6 65:0.8').as('note:vel').mul(vel(0.5));
  assert.deepEqual(grid(sig).map((st) => st.vel), [0.1, 0.2, 0.3, 0.4]);
});

test('a chord\'s two velocities at one onset each keep their own', () => {
  // The reason this can't be a channel: one onset, two events, two different velocities.
  const sig = mini('[60:0.2,67:0.9]').as('note:vel').mul(vel(0.5));
  assert.deepEqual(grid(sig).map((st) => st.vel).sort(), [0.1, 0.45]);
});

test('clip composes with a per-event clip and never changes a step\'s width', () => {
  const sig = mini('0:2 1:1').as('n:clip').mul(clip(2));
  assert.deepEqual(grid(sig).map((st) => st.clip), [4, 2]);
  // clip never changes the step's own width - only how long it rings (see soundingEnd).
  assert.deepEqual(grid(sig).map((st) => st.end - st.start), [0.5, 0.5]);
});

test('a continuous operand behind a continuous channel stays a real-time read', () => {
  // Nothing on the events and an LFO on the channel: there is nothing to stamp at build time, so
  // the composed channel is what the scheduler reads - which keeps the LFO in real seconds instead
  // of freezing it at each onset's cycle position.
  const sig = n('0 2').vel(sine()).mul(vel(0.5));
  assert.deepEqual(grid(sig).map((st) => st.vel), [undefined, undefined]);
  assert.ok(sig.noteChannels.vel, 'the composed channel is still set');
});

// ---------------------------------------------------------------------------------------------
// .mask() - gate, don't restructure
// ---------------------------------------------------------------------------------------------

test('.mask() silences the events whose onset the mask is off for', () => {
  const g = grid(s('hh*4').mask('1 0 1 1'));
  assert.deepEqual(g.map((st) => st.start), [0, 0.5, 0.75]);
});

test('.mask() keeps the masked-out event in the grid as a rest', () => {
  // The grid keeps its shape (the highlighter has nothing to light, rather than nothing to find) -
  // the same rule .degrade() and the arrangement painter follow.
  const all = s('hh*4').mask('1 0 1 1').stepsForCycle(0);
  assert.equal(all.length, 4);
  assert.equal(all.filter((st) => st.value == null).length, 1);
});

test('.mask() leaves a roll\'s velocities completely alone', () => {
  // The whole point next to .vel("1 ~ 1 1"), which would clear and restamp them.
  const g = grid(drawnRoll().mask('1 0 1 1'));
  assert.deepEqual(g.map((st) => st.vel), [0.2, 0.6, 0.8]);
});

test('.mask() gates whole bars with an alternation', () => {
  const gated = drawnRoll().mask('<1@7 0>');
  assert.equal(grid(gated, 0).length, 4);
  assert.equal(grid(gated, 6).length, 4);
  assert.equal(grid(gated, 7).length, 0);
});

test('.mask() adds no triggers - a long note is cut short, never re-struck', () => {
  // One whole-cycle note under a mask that is on for the first quarter and the third: the note
  // starts (the mask was on at its onset) and stops where the mask closes. It does NOT pick up
  // again at 0.5 - that would be a trigger the mask invented.
  const g = grid(note('c3').mask('1 0 1 0'));
  assert.equal(g.length, 1);
  close(g[0].start, 0);
  close(g[0].end, 0.25);
});

test('a mask with no grid of its own is read at each onset', () => {
  // rand() varies within the cycle, so it has no honest grid; each event asks it at its own onset.
  const g = grid(s('hh*8').mask(rand().gte(0.5)));
  assert.ok(g.length > 0 && g.length < 8, `expected some hats through, got ${g.length}`);
});

test('.mask(0) silences everything and .mask(1) changes nothing', () => {
  assert.equal(grid(s('hh*4').mask(0)).length, 0);
  assert.deepEqual(grid(s('hh*4').mask(1)).map((st) => st.start), [0, 0.25, 0.5, 0.75]);
});

test('.mask() reads f/false as off, and any other sounding value as on', () => {
  assert.deepEqual(grid(s('hh*4').mask('t f t t')).map((st) => st.start), [0, 0.5, 0.75]);
  // A rhythm used directly as a mask: the pack names are values that sound, so they are "on".
  assert.deepEqual(grid(s('hh*4').mask(s('bd ~ ~ bd'))).map((st) => st.start), [0, 0.75]);
});

test('.mask() needs a step pattern', () => {
  assert.throws(() => sine().mask('1 0'), /needs a step pattern/);
});

// ---------------------------------------------------------------------------------------------
// .struct() - rhythm from the boolean, values from here
// ---------------------------------------------------------------------------------------------

test('.struct() plays this pattern\'s values on the boolean\'s rhythm', () => {
  const g = grid(note('c3').struct('1 ~ 1 1'));
  assert.deepEqual(g.map((st) => st.start), [0, 0.5, 0.75]);
  assert.deepEqual(g.map((st) => st.value), [60, 60, 60]);
});

test('.struct() reads the value sounding at each trigger', () => {
  // Two half-cycle notes, four triggers: the first two take the first note, the last two the second.
  const g = grid(n('0 7').struct('1 1 1 1'));
  assert.deepEqual(g.map((st) => st.value), [0, 0, 7, 7]);
});

test('.struct() drops a trigger that lands over a rest', () => {
  const g = grid(n('0 ~ 4 ~').struct('1 1 1 1'));
  assert.deepEqual(g.map((st) => st.start), [0, 0.5]);
  assert.deepEqual(g.map((st) => st.value), [0, 4]);
});

test('each struct\'d event is its own attack, lasting its own trigger\'s width', () => {
  const g = grid(note('c3').struct('1@3 1'));
  assert.equal(g.length, 2);
  close(g[0].start, 0);
  close(g[0].end, 0.75);
  close(g[1].start, 0.75);
  close(g[1].end, 1);
  assert.deepEqual(g.map((st) => st.cont), [undefined, undefined], 'a trigger is a strike, never a tie');
});

test('.struct() carries the whole bundle - a roll\'s velocities travel to the new rhythm', () => {
  // Triggers on cells 0 and 2 of the roll: they take those notes' drawn velocities with them.
  const g = grid(drawnRoll().struct('1 ~ 1 ~'));
  assert.deepEqual(g.map((st) => st.value), [60, 64]);
  assert.deepEqual(g.map((st) => st.vel), [0.2, 0.6]);
});

test('.struct() carries a sampler\'s per-event config', () => {
  // A roll that picks sample indices: the index rides on step.cfg and must survive the restructure.
  const g = grid(pianoroll('60:2,0,1 62:5,2,1', { grid: 4 }).s('breaks').struct('1 ~ 1 ~'));
  assert.deepEqual(g.map((st) => st.cfg?.index), [2, 5]);
});

test('.struct() gives a structureless signal structure', () => {
  // No steps to take from, so each trigger reads the signal as one event at its onset - the same
  // thing .seg() does on an even grid.
  const g = grid(rand().struct('1 1 1 1'));
  assert.equal(g.length, 4);
  assert.ok(g.every((st) => typeof st.value === 'number'));
});

test('.struct() reads f/false as off', () => {
  assert.deepEqual(grid(note('c3').struct('t f t t')).map((st) => st.start), [0, 0.5, 0.75]);
});

test('.struct() needs a step pattern of triggers', () => {
  assert.throws(() => note('c3').struct(1), /needs a step pattern/);
});

test('.struct() and .hold() use the same triggers different ways', () => {
  // struct: each trigger is one event of its own width, with gaps where the boolean is off.
  // hold: each trigger's value is stretched to the NEXT trigger, so there are no gaps.
  const structed = grid(n('0 7').struct('1 ~ 1 ~'));
  const held = grid(n('0 7').hold('1 ~ 1 ~'));
  assert.deepEqual(structed.map((st) => st.end), [0.25, 0.75]);
  assert.deepEqual(held.map((st) => st.end), [0.5, 1]);
});
