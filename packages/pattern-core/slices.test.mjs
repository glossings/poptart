// Slice sets - `.slices()`, the `_slices()` registry, and the positions format the slice editor
// reads and writes. Pure pattern math against the store; no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, note, _slices, liveSlices, setPatternWarn } from './src/signal.mjs';
import { clearRolls, setRollLayer, lookupSlices, sliceSetIds } from './src/rolls.mjs';
import {
  normalizeSlicePositions, parseSlicePositions, serializeSlicePositions,
  normalizeSliceSet, parseSliceSet, serializeSliceSet, slicePositionsFor, sliceSetIsEmpty,
} from './src/slices.mjs';

// Each test owns the store: the buffer layer is rebuilt per evaluation in the real host too.
const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

/** What the scheduler reads off the channel at one onset (see _sampleConfigAt). */
const setAt = (sig, cycle = 0) => sig.sampler.slices.sample(cycle, 1, cycle);

// --- the positions format ---------------------------------------------------------------------

test('normalizeSlicePositions sorts, clamps and drops duplicates', () => {
  assert.deepEqual(normalizeSlicePositions([0.5, 0, 0.25]), [0, 0.25, 0.5]);
  assert.deepEqual(normalizeSlicePositions([-1, 0.5, 2]), [0, 0.5, 1]);
  assert.deepEqual(normalizeSlicePositions([0.25, 0.25, 0.25]), [0.25]);
  assert.deepEqual(normalizeSlicePositions(['0.5', 'nope', 0.1]), [0.1, 0.5]);
});

test('a set need not start at 0 - the pickup before the first marker is simply never a slice', () => {
  assert.deepEqual(normalizeSlicePositions([0.1, 0.6]), [0.1, 0.6]);
});

test('parse and serialize round-trip a definition body', () => {
  assert.deepEqual(parseSlicePositions('[0, 0.131, 0.27]'), [0, 0.131, 0.27]);
  // Hand-edited spacing, a trailing comma, a stray comment: still just the numbers.
  assert.deepEqual(parseSlicePositions('[ 0 , .5, ] // two'), [0, 0.5]);
  assert.equal(serializeSlicePositions([0.5, 0, 0.123456789]), '[0, 0.12346, 0.5]');
});

// --- the set: markers per file -------------------------------------------------------------------

test('a set is keyed by file, and round-trips through the definition body', () => {
  const set = { 'breaks/amen.wav': [0.5, 0], 'breaks/think.wav': [0, 0.25] };
  assert.deepEqual(normalizeSliceSet(set), { 'breaks/amen.wav': [0, 0.5], 'breaks/think.wav': [0, 0.25] });
  const text = serializeSliceSet(set);
  assert.equal(text, '{ "breaks/amen.wav": [0, 0.5], "breaks/think.wav": [0, 0.25] }');
  assert.deepEqual(parseSliceSet(text), normalizeSliceSet(set));
});

test('a file with no markers left is dropped from the set, not kept as an empty entry', () => {
  assert.deepEqual(normalizeSliceSet({ 'a.wav': [0, 0.5], 'b.wav': [] }), { 'a.wav': [0, 0.5] });
  assert.ok(sliceSetIsEmpty(normalizeSliceSet({ 'a.wav': [] })));
  assert.equal(serializeSliceSet({}), '{}');
});

test('a bare list is still a set - one map, for whatever plays', () => {
  assert.deepEqual(parseSliceSet('[0, 0.5]'), [0, 0.5]);
  assert.deepEqual(slicePositionsFor([0, 0.5], 'anything.wav'), [0, 0.5]);
});

test('a keyed set answers for the file it names and for nothing else', () => {
  const set = { 'breaks/amen.wav': [0, 0.5] };
  assert.deepEqual(slicePositionsFor(set, 'breaks/amen.wav'), [0, 0.5]);
  // null, not [] - "this set says nothing about that sample", which downstream means its own
  // transients chop it (see playSample).
  assert.equal(slicePositionsFor(set, 'breaks/think.wav'), null);
});

// --- the registry ------------------------------------------------------------------------------

test('_slices files a set under a name, tidied', () => {
  fresh();
  _slices('break', [0.5, 0, 0.25]);
  assert.deepEqual(lookupSlices('break'), [0, 0.25, 0.5]);
  assert.deepEqual(sliceSetIds().map((e) => e.id), ['break']);
});

test('_slices files a per-file set the same way, so one name covers a folder of breaks', () => {
  fresh();
  _slices('main', { 'breaks/think.wav': [0, 0.25], 'breaks/amen.wav': [0.5, 0] });
  assert.deepEqual(lookupSlices('main'), { 'breaks/think.wav': [0, 0.25], 'breaks/amen.wav': [0, 0.5] });
});

test('_slices warns when the buffer defines one id twice; liveSlices does not', () => {
  fresh();
  _slices('break', [0, 0.5]);
  assert.match(capture(() => _slices('break', [0, 0.25])).lines[0] ?? '', /defined twice/);
  fresh();
  _slices('break', [0, 0.5]);
  assert.deepEqual(capture(() => liveSlices('break', [0, 0.25])).lines, []);
});

test('a slice-set definition is marked as one, so a block of them is not a track', () => {
  fresh();
  assert.equal(_slices('break', [0, 0.5]).isDef, 'break');
  assert.equal(_slices('break2', [0, 0.5]).sample(0, 1, 0), null);
});

test('a slice-set id has to be one plain word', () => {
  fresh();
  assert.throws(() => _slices('two words', [0, 0.5]), /one plain word/);
  assert.throws(() => _slices('<a b>', [0, 0.5]), /one plain word/);
  assert.throws(() => _slices({}, [0, 0.5]), /takes a number or a name/);
});

// --- .slices() as a channel ---------------------------------------------------------------------

test('.slices([...]) carries the positions themselves', () => {
  fresh();
  assert.deepEqual(setAt(s('breaks').slice(0).slices([0, 0.25, 0.5])), [0, 0.25, 0.5]);
});

test('.slices() carries a per-file set through whole - which file it answers for is the engine\'s', () => {
  fresh();
  _slices('main', { 'breaks/amen.wav': [0, 0.5] });
  // The scheduler puts this on the event as it stands (see _sampleConfigAt): only the engine knows
  // what s("breaks").i(19) resolved to on disk, so only the engine can pick the entry.
  assert.deepEqual(setAt(s('breaks').slice(0).slices('main')), { 'breaks/amen.wav': [0, 0.5] });
  assert.deepEqual(setAt(s('breaks').slice(0).slices({ 'x.wav': [0.5, 0] })), { 'x.wav': [0, 0.5] });
});

test('.slices([...]) tidies its list rather than trusting the order it was given', () => {
  fresh();
  assert.deepEqual(setAt(s('breaks').slices([0.5, 0, 0.5])), [0, 0.5]);
});

test('.slices([]) is refused - an empty list defines no slices at all', () => {
  fresh();
  assert.throws(() => s('breaks').slices([]), /at least|no slices/);
});

test('.slices("name") resolves through the registry at emit time, not at build time', () => {
  fresh();
  const track = s('breaks').slice(0).slices('break'); // built BEFORE anything defines the name
  _slices('break', [0, 0.4]);
  assert.deepEqual(setAt(track), [0, 0.4]);
  // ...and re-filing it under the same name is heard by the same pattern object, never rebuilt -
  // which is what lets the slice editor be heard mid-drag (see liveSlices).
  liveSlices('break', [0, 0.7]);
  assert.deepEqual(setAt(track), [0, 0.7]);
});

test('.slices("<tight loose>") takes a set per cycle', () => {
  fresh();
  _slices('tight', [0, 0.1]);
  _slices('loose', [0, 0.9]);
  const track = s('breaks').slice(0).slices('<tight loose>');
  assert.deepEqual(setAt(track, 0), [0, 0.1]);
  assert.deepEqual(setAt(track, 1), [0, 0.9]);
  assert.deepEqual(setAt(track, 2), [0, 0.1]);
});

test('a set adds no events of its own - it is a map of the sample, not a rhythm', () => {
  fresh();
  _slices('tight', [0, 0.1]);
  // Four slice steps stay four events whether or not a two-name set pattern is laid over them.
  const plain = s('breaks').slice('0 1 2 3');
  const named = s('breaks').slice('0 1 2 3').slices('<tight loose>');
  assert.equal(named.stepsForCycle(0).length, plain.stepsForCycle(0).length);
  // ...even where the set pattern would have split the cycle if it were a control like the others.
  assert.equal(s('breaks').slice(0).slices('tight loose').stepsForCycle(0).length, 1);
});

test('an unknown name warns once and falls back to the sample\'s own transients', () => {
  fresh();
  const track = s('breaks').slice(0).slices('nope');
  const { lines } = capture(() => {
    assert.equal(setAt(track, 0), null); // null = nothing on the event, so the engine auto-detects
    setAt(track, 1);
    setAt(track, 2);
  });
  assert.equal(lines.length, 1, 'one line per unknown name, not one per event');
  assert.match(lines[0], /no slice set called "nope"/);
});

test('a named-but-empty set plays the automatic chops, like a named-but-uncaptured preset', () => {
  fresh();
  _slices('break', {});
  const track = s('breaks').slice(0).slices('break');
  const { value, lines } = capture(() => setAt(track));
  assert.deepEqual(value, {}); // empty, so _sampleConfigAt leaves cfg.slices unset
  assert.deepEqual(lines, [], 'a name the editor has just written is not a mistake');
});

test('.slices() with nothing in it is the moment before the editor names it, not an error', () => {
  fresh();
  assert.equal(setAt(s('breaks').slices()), null);
});

test('.slices() only applies to a sampler pattern', () => {
  fresh();
  assert.throws(() => note('60 62').slices([0, 0.5]), /sampler pattern/);
});
