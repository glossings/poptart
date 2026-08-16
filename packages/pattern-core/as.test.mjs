// .as() field decomposition and its composition with .note()/.n()/.s(), plus keyboard()/tap()
// routes carrying a fixed pitch. Pure pattern math - no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { mini, n, note, s, tap, keyboard, clip, channelAt, soundingEnd } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

function stepsAt(sig, cycle = 0) {
  return sig.stepsForCycle(cycle).filter((st) => st.value != null);
}

// The velocity the scheduler reads at a step's onset - the shared channel reader, unset = 1.
function velAt(sig, step, cycle = 0) {
  return channelAt('vel', step, sig.noteChannels, cycle + step.start, 1, cycle + step.start) ?? 1;
}

// How long the event actually rings: its step width times its clip, applied at emit time exactly as
// the scheduler applies it when placing the noteOff.
function rings(sig, step, cycle = 0) {
  return soundingEnd(step, sig.noteChannels, cycle + step.start, 1, cycle + step.start) - step.start;
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

test('as("note:vel:clip") rings an event for its clip field', () => {
  const sig = mini('36:1:2 47:1:1').as('note:vel:clip');
  const st = stepsAt(sig).sort((a, b) => a.start - b.start);
  // The clip is a key on the event, not a change to the grid: both steps keep their own half-cycle
  // width, and the first one SOUNDS for twice that.
  assert.deepEqual(st.map((x) => [x.start, x.end]), [[0, 0.5], [0.5, 1]]);
  close(rings(sig, st[0]), 2 * 0.5);
  close(rings(sig, st[1]), 1 * 0.5);
});

// A token may simply not carry every field the spec names - recordingToMini (and the midi file
// import through it) writes a bare `36` whenever vel and clip are both the default. The missing
// field has to read as UNSET so the caller's default stands: coerced instead, `Number(null)` made
// it a velocity of 0 and every full-velocity note came out silent.
test('as("note:vel:clip") leaves a field the token omitted unset, not zero', () => {
  const sig = mini('36 47:0.5:3').as('note:vel:clip');
  const st = stepsAt(sig).sort((a, b) => a.start - b.start);
  close(velAt(sig, st[0]), 1); // no vel field -> the default, full velocity
  close(rings(sig, st[0]), 0.5); // no clip field -> rings for exactly its step
  close(velAt(sig, st[1]), 0.5);
  close(rings(sig, st[1]), 3 * 0.5);
});

// A chord cell stacks several tokens on ONE onset - the form the piano roll writes for a chord
// whose notes differ in length or velocity. Each note has to keep its OWN clip/vel; reading the
// fields as a signal sampled at the onset gave every layer the first one's values.
test('as("note:clip") gives each note of a chord cell its own duration', () => {
  const sig = mini('[57:0.8,59:10] ~ ~ ~').as('note:clip');
  const st = stepsAt(sig);
  assert.deepEqual(st.map((s2) => s2.value), [57, 59]);
  const step = 0.25; // four cells in the cycle
  st.forEach((s2) => close(s2.start, 0));
  close(rings(sig, st[0]), 0.8 * step);
  close(rings(sig, st[1]), 10 * step); // rings well past the cycle, like a mini-notation tie
});

test('as("note:vel:clip") gives each note of a chord cell its own velocity', () => {
  const sig = mini('[57:0.8:1,59:0.2:4] ~').as('note:vel:clip');
  const st = stepsAt(sig);
  close(velAt(sig, st[0]), 0.8);
  close(velAt(sig, st[1]), 0.2);
  close(rings(sig, st[0]), 0.5);
  close(rings(sig, st[1]), 4 * 0.5);
});

test('clip composes with arithmetic, like any other control', () => {
  // The example from the design: the token carries clip 2, .mul(clip(2)) makes it 4.
  const sig = mini('0:2').as('n:clip').mul(clip(2));
  const st = stepsAt(sig);
  close(rings(sig, st[0]), 4);
  assert.equal(st[0].value, 0, 'the arithmetic aimed at the clip channel, not at the degrees');
  // And on a pattern with no clip of its own the resting default (1) is the left operand.
  const plain = n('0 1').mul(clip(3));
  close(rings(plain, stepsAt(plain)[0]), 3 * 0.5);
});

test('a later continuous .vel() replaces the token velocities', () => {
  const sig = mini('[57:0.2,59:0.9] ~').as('note:vel').vel(0.6);
  for (const st of stepsAt(sig)) close(velAt(sig, st), 0.6);
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

// ---------------------------------------------------------------------------------------------
// end to end: what the engine is actually told
// ---------------------------------------------------------------------------------------------
// clip is applied where the event is emitted, so the proof is in the noteOff times the scheduler
// sends - not in the pattern's structure, which clip no longer touches.

test('the scheduler holds each note of a chord for its own clip', () => {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const sch = new Scheduler(engine, { trackId: 'chord' });
  sch.transport.cps = 1; // one cycle per second, so cycle positions read straight as seconds
  sch.setPattern(mini('[57:0.8,59:10] ~ ~ ~').as('note:clip').synth('Serum 2'));
  sch._scheduleNoteEdges(0, 1);

  // noteOn(track, midi, vel, timeSec); noteOff(track, midi, timeSec)
  const at = (method, midi) => {
    const call = calls.find((c) => c.method === method && c.args[1] === midi);
    return call.args[method === 'noteOn' ? 3 : 2];
  };
  assert.deepEqual(calls.filter((c) => c.method === 'noteOn').map((c) => c.args[1]), [57, 59]);
  // cps 1, so a cycle is a second and the step is 0.25s. Both strike at 0; 57 runs 0.8 of its step
  // and 59 ten times it - the note-offs are pulled a few ms early (NOTE_OFF_EARLY_SEC).
  close(at('noteOn', 57), 0);
  close(at('noteOn', 59), 0);
  close(at('noteOff', 57), 0.25 * 0.8 - 0.005);
  close(at('noteOff', 59), 0.25 * 10 - 0.005, 'the long note rings on for cycles, one scheduled off');
});
