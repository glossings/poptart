// arrange(): the painter's clip format, the span/length math both sides read, and the gate the
// host applies to a painted block - events keep their absolute cycle time and are simply rested
// wherever the block isn't painted, looping over the arrangement's length.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  n,
  sine,
  parseArrangement,
  serializeArrangement,
  looksLikeArrangeString,
  normalizeArrangeOpts,
  arrangementLength,
  arrangementSpans,
  arrangementLaneCount,
  inSpans,
} from './src/index.mjs';

test('parse/serialize round-trip, malformed tokens dropped', () => {
  const clips = parseArrangement('bass,1,4,4 drums,0,0,8  nope,x,1,1 drums,0,12,4 hats,2,0.5,0.25');
  assert.deepEqual(clips, [
    { label: 'bass', lane: 1, start: 4, len: 4 },
    { label: 'drums', lane: 0, start: 0, len: 8 },
    { label: 'drums', lane: 0, start: 12, len: 4 },
    { label: 'hats', lane: 2, start: 0.5, len: 0.25 },
  ]);
  assert.equal(serializeArrangement(clips), 'drums,0,0,8 drums,0,12,4 bass,1,4,4 hats,2,0.5,0.25');
  assert.equal(parseArrangement('').length, 0);
  assert.equal(parseArrangement('a,0,0,0').length, 0, 'a zero-length clip is nothing');
});

test('looksLikeArrangeString tells data from anything else', () => {
  assert.ok(looksLikeArrangeString(''));
  assert.ok(looksLikeArrangeString('drums,0,0,8 bass,1,4.5,2'));
  assert.ok(!looksLikeArrangeString('<a b>'));
  assert.ok(!looksLikeArrangeString('drums'));
});

test('options: snap/len/lanes with defaults', () => {
  assert.deepEqual(normalizeArrangeOpts(), { snap: 1, len: null, lanes: [] });
  assert.deepEqual(normalizeArrangeOpts({ snap: 4, len: 16, lanes: ['drums', null, 'bass'] }), { snap: 4, len: 16, lanes: ['drums', '', 'bass'] });
  assert.equal(normalizeArrangeOpts({ len: 0 }).len, null);
});

test('length: explicit, else the last clip end rounded up, never below one', () => {
  const clips = parseArrangement('a,0,0,3.5 b,1,2,1');
  assert.equal(arrangementLength(clips), 4);
  assert.equal(arrangementLength(clips, { len: 8 }), 8);
  assert.equal(arrangementLength([]), 1);
});

test('spans merge per label across lanes and touching clips', () => {
  const spans = arrangementSpans(parseArrangement('a,0,0,2 a,1,2,2 a,0,6,1 b,2,1,1'));
  assert.deepEqual(spans.get('a'), [[0, 4], [6, 7]]);
  assert.deepEqual(spans.get('b'), [[1, 2]]);
  assert.ok(inSpans(spans.get('a'), 3.99));
  assert.ok(!inSpans(spans.get('a'), 4));
  assert.ok(inSpans(spans.get('a'), 6));
});

test('lane count covers every clip and named lane', () => {
  assert.equal(arrangementLaneCount([]), 4);
  assert.equal(arrangementLaneCount(parseArrangement('a,6,0,1')), 7);
  assert.equal(arrangementLaneCount([], { lanes: ['x', 'y', 'z', 'w', 'v'] }), 5);
});

test('_arrangeGate rests events outside the spans and loops over len', () => {
  const sig = n('0 1 2 3')._arrangeGate([[0, 1], [2, 2.5]], 3);
  const values = (cycle) => sig.stepsForCycle(cycle).map((s) => s.value);
  assert.deepEqual(values(0), [0, 1, 2, 3], 'painted: the whole bar plays');
  assert.deepEqual(values(1), [null, null, null, null], 'unpainted: every event rests');
  assert.deepEqual(values(2), [0, 1, null, null], 'half a bar painted: onsets past it rest');
  assert.deepEqual(values(3), [0, 1, 2, 3], 'loops: cycle 3 is cycle 0 again');
  assert.deepEqual(values(4), [null, null, null, null]);
});

test('_arrangeGate keeps the pattern on absolute cycle time', () => {
  const sig = n('<0 1>')._arrangeGate([[1, 2]], 2);
  assert.deepEqual(sig.stepsForCycle(0).map((s) => s.value), [null]);
  assert.deepEqual(sig.stepsForCycle(1).map((s) => s.value), [1], 'the alternation kept counting through the gated-out bar');
});

test('_arrangeGate carries the chain and is a no-op on a gridless signal', () => {
  const sig = n('0').synth('Serum 2')._arrangeGate([[0, 1]], 2);
  assert.equal(sig.instrument, 'Serum 2');
  const lfo = sine(1);
  assert.equal(lfo._arrangeGate([[0, 1]], 2), lfo, 'a control signal has no events to gate');
});
