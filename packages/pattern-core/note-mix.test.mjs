// .note() / .n() on a synth track MERGE onto the events already there, the way every other control
// does (crossMerge), instead of replacing the grid with the note pattern's own:
//
//   - a patterned note mixes: it cuts the events it falls across, like any patterned control.
//   - a note that only holds across the cycle ("F0", 60, "<c3 e3>") neither cuts nor adds
//     triggers, so struct(...).note("F0") plays F0 on each hit (the reported bug: one F0 a cycle).
//   - grid-changing ops written before .note() keep their rhythm.
//   - a control that changes at the cycle line still cuts a held note (the seamed-steps rule).
//   - copy(), pcopy(), .pianoroll() from a control head, and live sources still SWAP the notes in.
//
// Pure pattern math, no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from './src/index.mjs';

const {
  note, n, struct, synth, s, vel, steps, pianoroll, midikeys, setCopyResolver,
  injectLocations, beginWidgets, takeWidgets,
} = core;

/** Sounding steps for a cycle, start-sorted. Starts are cycle-relative. */
function grid(sig, cycle = 0) {
  return sig.stepsForCycle(cycle).filter((st) => st.value != null).sort((a, b) => a.start - b.start);
}

/** [start, value] per sounding step. */
const hits = (sig, cycle = 0) => grid(sig, cycle).map((st) => [st.start, st.value]);

// Evaluates one line the way the hosts do: transpiled, every builder in scope (see widgets.test.mjs).
function evalLine(code) {
  const out = injectLocations(code, 0);
  const names = Object.keys(core);
  beginWidgets('a');
  const sig = new Function(...names, `return ${out}`)(...names.map((k) => core[k]));
  takeWidgets();
  return sig;
}

function withResolver(map, fn) {
  setCopyResolver((name) => {
    if (!(name in map)) throw new Error(`no block called ${name}`);
    return map[name]();
  });
  try {
    return fn();
  } finally {
    setCopyResolver(null);
  }
}

// ---------------------------------------------------------------------------------------------
// a held note lands on every hit
// ---------------------------------------------------------------------------------------------

test('the reported case: a steps() row on a synth plays the note on each of its hits', () => {
  const sig = evalLine('struct(steps(". . . . x . . x . x . . . . . .")).synth("Kick").note("F0")');
  assert.deepEqual(hits(sig), [[4 / 16, 29], [7 / 16, 29], [9 / 16, 29]]);
});

test('a held note neither cuts nor adds triggers', () => {
  assert.deepEqual(hits(struct('1 ~ 1 1').note('F0')), [[0, 29], [0.5, 29], [0.75, 29]]);
  assert.deepEqual(hits(struct('1 ~ 1 1').note(60)), [[0, 60], [0.5, 60], [0.75, 60]]);
});

test('a note that changes once a cycle holds within each cycle', () => {
  const sig = struct('1 ~ 1 1').note('<c3 e3>');
  assert.deepEqual(hits(sig, 0), [[0, 60], [0.5, 60], [0.75, 60]]);
  assert.deepEqual(hits(sig, 1), [[0, 64], [0.5, 64], [0.75, 64]]);
});

test('.n() merges the same way', () => {
  assert.deepEqual(hits(struct('1 ~ 1 1').n('0 2')), [[0, 0], [0.5, 2], [0.75, 2]]);
});

// ---------------------------------------------------------------------------------------------
// a patterned note mixes
// ---------------------------------------------------------------------------------------------

test('synth("X").note("c3 e3") cuts the whole-cycle default note in two', () => {
  const sig = synth('X').note('c3 e3');
  assert.deepEqual(grid(sig).map((st) => [st.start, st.end, st.value]), [[0, 0.5, 60], [0.5, 1, 64]]);
  assert.deepEqual(hits(synth('X').n('0 2')), [[0, 0], [0.5, 2]]);
});

test('a faster note pattern cuts each hit: the note sounding at its onset plays', () => {
  assert.deepEqual(hits(struct('1 ~').note('c3 e3 g3 b3')), [[0, 60], [0.25, 64]]);
});

test('a second .note() restamps the first one\'s rhythm', () => {
  assert.deepEqual(hits(note('c3 e3').note('g3')), [[0, 67], [0.5, 67]]);
});

test('a stack restamped to one note collapses to one event', () => {
  assert.deepEqual(hits(note('c3,e3').note('g3')), [[0, 67]]);
});

// ---------------------------------------------------------------------------------------------
// ops before .note() keep their rhythm
// ---------------------------------------------------------------------------------------------

test('.fast() before .note() keeps the faster rhythm', () => {
  const starts = grid(struct('1 ~ 1 1').fast(2).note('c3')).map((st) => st.start);
  assert.deepEqual(starts, [0, 0.25, 0.375, 0.5, 0.75, 0.875]);
});

test('.legato() before .note() keeps its clips', () => {
  const sig = struct('1 ~ 1 1').legato().note('c3');
  assert.deepEqual(grid(sig).map((st) => [st.start, st.clip, st.value]), [[0, 2, 60], [0.5, 1, 60], [0.75, 1, 60]]);
});

test('.vel() before .note() keeps the rhythm and the velocity', () => {
  const sig = struct('1 ~ 1 1').vel(0.5).note('c3');
  assert.deepEqual(hits(sig), [[0, 60], [0.5, 60], [0.75, 60]]);
  assert.equal(sig.noteChannels.vel.sample(0, 1, 0), 0.5, 'the velocity channel carries through');
});

// ---------------------------------------------------------------------------------------------
// the cycle line
// ---------------------------------------------------------------------------------------------

test('a note that changes at the cycle line re-strikes a held note', () => {
  const sig = note('c3').slow(2).note('<c3 e3>');
  assert.deepEqual(grid(sig, 0).map((st) => [st.start, st.end, st.value]), [[0, 1, 60]]);
  const next = grid(sig, 1);
  assert.deepEqual(next.map((st) => [st.start, st.value]), [[0, 64]]);
  assert.ok(!next[0].cont, 'e3 is a fresh strike, not a continuation');
});

test('a note that stays the same across the cycle line keeps the note tied', () => {
  const sig = note('c3').slow(2).note('C2');
  assert.deepEqual(grid(sig, 0).map((st) => [st.start, st.end, st.value]), [[0, 2, 48]]);
  const next = grid(sig, 1);
  assert.deepEqual(next.map((st) => st.value), [48]);
  assert.equal(next[0].cont, true, 'cycle 1 continues the cycle-0 note');
});

// ---------------------------------------------------------------------------------------------
// what still swaps
// ---------------------------------------------------------------------------------------------

test('.copy() swaps its notes into the copied chain', () => {
  withResolver({ kick: () => struct('1 ~ 1 1').synth('Kick') }, () => {
    const sig = note('c2 e2').copy('kick');
    assert.equal(sig.instrument, 'Kick');
    assert.deepEqual(hits(sig), [[0, 48], [0.5, 52]]);
  });
});

test('.pcopy() swaps the copied notes into this chain', () => {
  withResolver({ a: () => note('c2 e2') }, () => {
    const sig = struct('1 ~ 1 1').synth('X').pcopy('a');
    assert.equal(sig.instrument, 'X');
    assert.deepEqual(hits(sig), [[0, 48], [0.5, 52]]);
  });
});

test('.pianoroll() from a control head is the roll the control plays', () => {
  const sig = vel(0.5).pianoroll('60,0,4 64,8,4', { grid: 16, len: 16 });
  assert.deepEqual(hits(sig), [[0, 60], [0.5, 64]]);
});

test('a live source swaps in: the keyboard route plays, with the chain kept', () => {
  const live = midikeys('KeyStep 32')(1);
  const sig = synth('X').note(live);
  assert.equal(sig.instrument, 'X');
  assert.deepEqual(sig.midiNotes, { device: 'KeyStep 32', channel: 1 });
});

// ---------------------------------------------------------------------------------------------
// samplers
// ---------------------------------------------------------------------------------------------

test('a sampler track still repitches on its own grid', () => {
  const sig = s('pluck').note('45 52');
  assert.deepEqual(hits(sig), [[0, 'pluck'], [0.5, 'pluck']]);
  assert.deepEqual(grid(sig).map((st) => st.cfg.note), [45, 52]);
});
