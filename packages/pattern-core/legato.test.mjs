// .legato(): every note rings until the next onset - gaps close, overlaps stop at the next note,
// chords reach together, and the last note of a cycle reaches the first of the next. The reach is
// written as the event's clip, so it composes like any other control.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, clip, vel, soundingEnd, channelAt, setPatternWarn } from './src/index.mjs';

// [start, soundingEnd, value] per sounding step of `cycle`, in that cycle's time.
const rings = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle)
    .filter((s) => s.value != null && !s.cont)
    .map((s) => [round(s.start), round(soundingEnd(s, sig.noteChannels, cycle + s.start, 1, cycle + s.start)), s.value]);
const round = (v) => Math.round(v * 1000) / 1000;

test('legato closes the gaps between notes', () => {
  assert.deepEqual(rings(note('c3 ~ e3 ~').legato()), [[0, 0.5, 60], [0.5, 1, 64]]);
  assert.deepEqual(rings(note('c3 ~ ~ e3 ~ ~ ~ ~').legato()), [[0, 0.375, 60], [0.375, 1, 64]]);
});

test('notes that start together reach the next onset together', () => {
  assert.deepEqual(rings(note('[c3,e3] ~ ~ g3').legato()), [[0, 0.75, 60], [0, 0.75, 64], [0.75, 1, 67]]);
});

test('a note that ran past the next onset stops there: an earlier clip is replaced', () => {
  assert.deepEqual(rings(note('c3 e3').clip(4).legato()), [[0, 0.5, 60], [0.5, 1, 64]]);
  assert.deepEqual(rings(note('c3 e3').clip('4 0.25').legato()), [[0, 0.5, 60], [0.5, 1, 64]], 'a per-step clip too');
  assert.equal(note('c3').clip(2).legato().noteChannels.clip, undefined, 'the clip channel is gone too');
});

test("the last note of a cycle reaches the next cycle's first note", () => {
  const two = note('<c3 ~>').legato();
  assert.deepEqual(rings(two, 0), [[0, 2, 60]]);
  assert.deepEqual(rings(two, 1), []);
  const alt = note('<[c3 ~ ~ ~] [~ ~ e3 ~]>').legato();
  assert.deepEqual(rings(alt, 0), [[0, 1.5, 60]]);
  assert.deepEqual(rings(alt, 1), [[0.5, 1, 64]], "e3 reaches cycle 2's c3 on the downbeat");
});

test('a note with nothing after it within reach keeps its own length', () => {
  assert.deepEqual(rings(note('<c3 ~!40>').legato()), [[0, 1, 60]]);
});

test('a tie is one note, not a second onset', () => {
  const tied = note('<c3 _ e3>').legato();
  assert.deepEqual(rings(tied, 0), [[0, 2, 60]]);
  assert.deepEqual(rings(tied, 2), [[0, 1, 64]]);
});

test('arithmetic after legato composes with the reach', () => {
  assert.deepEqual(rings(note('c3 ~ e3 ~').legato().mul(clip(0.9))), [[0, 0.45, 60], [0.5, 0.95, 64]]);
});

test('other channels ride along untouched', () => {
  const sig = note('c3 ~ e3').vel('0.3 0.7').nudge(0.1).legato();
  const steps = sig.stepsForCycle(0).filter((s) => s.value != null);
  assert.deepEqual(steps.map((s) => [s.vel, channelAt('nudge', s, sig.noteChannels, s.start)]), [[0.3, 0.1], [0.7, 0.1]]);
});

test('a signal with no events of its own warns and is left as it was', () => {
  const warnings = [];
  setPatternWarn((m) => warnings.push(m));
  try {
    const v = vel(0.5);
    assert.equal(v.legato(), v);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /needs a pattern with events/);
  } finally {
    setPatternWarn(null);
  }
});
