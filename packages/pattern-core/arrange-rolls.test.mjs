// Per-clip roll binding: a clip may name the roll its TRACK plays over its own bars, so a fill is
// painted at the phrase ends rather than patterned into the block (see arrange.mjs, and
// withArrangeRoll in signal.mjs).
//
// The swap is a host hook, not a userland one, so it is tested the way the host drives it: label
// the block being built, file the bindings the painter would have written, and read the steps back.
// The two things worth pinning are that the substitute plays on ABSOLUTE cycle time - a clip is a
// window onto a running pattern, not a trigger - and that a binding never silences anything: a
// track whose bound roll has been deleted goes on playing its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _roll,
  pianoroll,
  parseArrangement,
  arrangementRollBindings,
  setBlockLabel,
  setArrangeRolls,
  rollOwners,
  clearRollOwners,
  clearRolls,
} from './src/index.mjs';

/** The block the host is building, as evalBlock frames each one. */
function asTrack(label, build) {
  setBlockLabel(label, 'a');
  try {
    return build();
  } finally {
    setBlockLabel(null, 'a');
  }
}

const notesAt = (sig, cycle) => sig.stepsForCycle(cycle).filter((s) => s.value != null).map((s) => s.value);

function setup() {
  clearRolls('buffer');
  clearRollOwners();
  setArrangeRolls(null, null, 'a');
  // one note a bar each, so which roll is playing is the note that comes out
  _roll('kick', '60,0,1', { grid: 1, len: 1 });
  _roll('fill', '72,0,1', { grid: 1, len: 1 });
}

test('a bound clip swaps the track\'s roll over its own bars', () => {
  setup();
  const clips = parseArrangement('kick,0,16 kick:fill,12,4');
  const track = asTrack('kick', () => pianoroll('kick'));
  setArrangeRolls(arrangementRollBindings(clips), (c) => c % 16, 'a');

  assert.deepEqual(notesAt(track, 0), [60], 'its own roll before the clip');
  assert.deepEqual(notesAt(track, 11), [60]);
  assert.deepEqual(notesAt(track, 12), [72], 'the fill, from the bar the clip starts');
  assert.deepEqual(notesAt(track, 15), [72]);
  assert.deepEqual(notesAt(track, 16), [60], 'and back, the song having wrapped');
});

test('a binding is one track\'s: another track playing the same roll is untouched', () => {
  setup();
  const clips = parseArrangement('kick:fill,0,4');
  const kick = asTrack('kick', () => pianoroll('kick'));
  const other = asTrack('layer', () => pianoroll('kick'));
  setArrangeRolls(arrangementRollBindings(clips), (c) => c % 8, 'a');

  assert.deepEqual(notesAt(kick, 0), [72]);
  assert.deepEqual(notesAt(other, 0), [60]);
});

test('a roll that no longer exists plays the track\'s own, never silence', () => {
  setup();
  const clips = parseArrangement('kick:gone,0,4');
  const track = asTrack('kick', () => pianoroll('kick'));
  setArrangeRolls(arrangementRollBindings(clips), (c) => c % 8, 'a');

  assert.deepEqual(notesAt(track, 0), [60]);
});

test('the bindings are per deck, so one song\'s arrangement never reaches the other\'s tracks', () => {
  setup();
  const bindings = arrangementRollBindings(parseArrangement('kick:fill,0,4'));
  const deckA = asTrack('kick', () => pianoroll('kick'));
  setBlockLabel('kick', 'b');
  const deckB = pianoroll('kick');
  setBlockLabel(null, 'b');
  setArrangeRolls(bindings, (c) => c % 8, 'b');

  assert.deepEqual(notesAt(deckA, 0), [60], 'deck A has no arrangement filed');
  assert.deepEqual(notesAt(deckB, 0), [72]);
  setArrangeRolls(null, null, 'b');
});

test('rollOwners names the tracks a clip could rebind at all', () => {
  setup();
  asTrack('kick', () => pianoroll('kick'));
  asTrack('$3', () => pianoroll('fill')); // an anonymous block is not a track
  const owners = rollOwners();
  assert.ok(owners.has('kick'));
  assert.ok(!owners.has('$3'));
  clearRollOwners();
  assert.equal(rollOwners().size, 0);
});
