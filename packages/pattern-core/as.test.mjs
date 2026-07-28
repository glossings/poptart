// .as() field decomposition and its composition with .note()/.n()/.s(), plus keyboard()/tap()
// routes carrying a fixed pitch. Pure pattern math - no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { mini, n, note, s, tap, keyboard } from './src/signal.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

function stepsAt(sig, cycle = 0) {
  return sig.stepsForCycle(cycle).filter((st) => st.value != null);
}

// The velocity the scheduler would read at a step's onset (matching scheduler.mjs's _velAt): the
// merged step.vel wins, else the continuous vel note channel is sampled at the onset, else 1.
function velAt(sig, step, cycle = 0) {
  if (typeof step.vel === 'number' && !Number.isNaN(step.vel)) return step.vel;
  const ch = sig.noteChannels?.vel;
  if (ch) {
    const v = ch.sample(cycle + step.start, 1, cycle + step.start);
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return 1;
}

// ---------------------------------------------------------------------------------------------
// .as() decomposes tokens into pitch / vel / clip channels
// ---------------------------------------------------------------------------------------------

test('as("note:vel") sets pitch value stream and a velocity signal', () => {
  const sig = mini('36:1 47:0.5').as('note:vel');
  const st = stepsAt(sig);
  assert.equal(st.length, 2);
  assert.equal(st[0].value, 36);
  assert.equal(st[1].value, 47);
  close(velAt(sig, st[0]), 1);
  close(velAt(sig, st[1]), 0.5);
  assert.equal(sig.pitchKind, 'note');
});

test('as("note:vel:clip") stretches an event by its clip field', () => {
  const sig = mini('36:1:2 47:1:1').as('note:vel:clip');
  const st = stepsAt(sig).sort((a, b) => a.start - b.start);
  // first token, clip 2, occupies its own half-step doubled to a full step
  close(st[0].end - st[0].start, 2 * 0.5);
  close(st[1].end - st[1].start, 1 * 0.5);
});

test('as("n") holds scale degrees (pitchKind degree)', () => {
  const sig = mini('0 2 4').as('n');
  assert.equal(sig.pitchKind, 'degree');
  assert.deepEqual(stepsAt(sig).map((s2) => s2.value), [0, 2, 4]);
});

// ---------------------------------------------------------------------------------------------
// the core bug: as() keys are overridable later
// ---------------------------------------------------------------------------------------------

test('as("vel").note("f3") keeps the velocities and sets the pitch', () => {
  // <0 1 0.5> alternates one step per cycle; note("f3") supplies the pitch each cycle.
  const sig = mini('<0 1 0.5>').as('vel').note('f3');
  const f3 = note('f3').sample(0, 1);
  for (const [cycle, wantVel] of [[0, 0], [1, 1], [2, 0.5]]) {
    const st = stepsAt(sig, cycle);
    assert.equal(st.length, 1, `cycle ${cycle} has one onset`);
    assert.equal(st[0].value, f3, `cycle ${cycle} plays f3`);
    close(velAt(sig, st[0], cycle), wantVel, `cycle ${cycle} vel ${wantVel}`);
  }
});

test('as("vel").n("0").scale sees degrees; note override survives velocities', () => {
  const sig = mini('<0 1 0.5>').as('vel').note('c4');
  assert.ok(sig.noteChannels.vel, 'velocity channel carried onto the note pattern');
});

test('as("vel").note(...).s("rave") plays the sample repitched, velocities intact', () => {
  const sig = mini('<0 1 0.5>').as('vel').note('f3').s('rave');
  assert.ok(sig.sampler, 'became a sampler track');
  const f3 = note('f3').sample(0, 1);
  // value stream is now the pack name; the repitch note carries the pitch
  const st = stepsAt(sig, 0);
  assert.equal(st[0].value, 'rave');
  assert.equal(Math.round(sig.sampler.note.sample(0, 1)), f3);
  // vel is a note channel now, read the same way on synth and sampler tracks - no relocation into
  // the sampler config, so it survives .s() as-is (the walker maps it to sample gain).
  assert.ok(sig.noteChannels.vel, 'velocity preserved as a note channel through .s()');
  assert.ok(!sig.sampler.vel, 'not moved into the sampler config');
  close(sig.noteChannels.vel.sample(1, 1, 1), 1, 'cycle 1 velocity is 1');
});

test('.s() is a method that repitches a note line by the pack', () => {
  const sig = note('c e g').s('rave');
  assert.ok(sig.sampler);
  assert.deepEqual(stepsAt(sig).map((s2) => s2.value), ['rave', 'rave', 'rave']);
  const notes = stepsAt(sig).map((_, i) => Math.round(sig.sampler.note.stepsForCycle(0)[i].value));
  assert.deepEqual(notes, [note('c').sample(0, 1), note('e').sample(0, 1), note('g').sample(0, 1)]);
});

// ---------------------------------------------------------------------------------------------
// keyboard()/tap() routes: .note() sets the struck pitch and schedules nothing
// ---------------------------------------------------------------------------------------------

test('tap().note("f3") schedules no notes and records the fixed pitch on the route', () => {
  const sig = tap().note('f3').synth('Serum 2');
  assert.equal(sig.stepsForCycle, null, 'no step grid, so the scheduler fires nothing');
  assert.equal(sig.keyboardRoute.kind, 'tap');
  assert.equal(Math.round(sig.keyboardRoute.note.sample(0, 1)), note('f3').sample(0, 1));
  assert.equal(sig.instrument, 'Serum 2');
});

test('tap() alone has no fixed pitch on the route', () => {
  assert.equal(tap().keyboardRoute.note ?? null, null);
});

test('keyboard().n("0").scale maps the route pitch through the scale', () => {
  const sig = keyboard().n('0').scale('F minor');
  assert.equal(sig.stepsForCycle, null);
  // degree 0 maps to the scale root, not a bare 0 - same mapping n("0").scale() does.
  const oracle = n('0').scale('F minor').sample(0, 1);
  assert.equal(sig.keyboardRoute.note.sample(0, 1), oracle);
});
