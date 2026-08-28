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
  ArrangeClock,
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
  assert.deepEqual(normalizeArrangeOpts(), { snap: 1, len: null, lanes: [], loops: [] });
  assert.deepEqual(normalizeArrangeOpts({ snap: 4, len: 16, lanes: ['drums', null, 'bass'] }), { snap: 4, len: 16, lanes: ['drums', '', 'bass'], loops: [] });
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

test('options: loops are named, ordered, and junk is dropped', () => {
  const { loops } = normalizeArrangeOpts({ loops: [['chorus', 8, 16], ['', 0, 4], ['bad', 4, 4], ['x', 'y', 2]] });
  assert.deepEqual(loops, [{ name: 'loop2', start: 0, end: 4 }, { name: 'chorus', start: 8, end: 16 }]);
});

test('ArrangeClock without regions is cycle mod len', () => {
  const clock = new ArrangeClock({ len: 4 });
  assert.equal(clock.posAt(0), 0);
  assert.equal(clock.posAt(5.5), 1.5);
  assert.equal(clock.posAt(2), 2);
});

test('ArrangeClock loops an armed region until released, then runs on; the song end re-arms', () => {
  const clock = new ArrangeClock({ len: 8, regions: [{ name: 'A', start: 2, end: 4 }, { name: 'B', start: 6, end: 7 }] });
  assert.equal(clock.posAt(1), 1);
  assert.equal(clock.posAt(3), 3);
  assert.equal(clock.posAt(4), 2, 'reaching A\'s end wraps to its start');
  assert.equal(clock.posAt(5.5), 3.5);
  assert.equal(clock.posAt(9), 3, 'still looping A a few passes later');
  assert.deepEqual(clock.stateAt(9), { pos: 3, looping: 'A', released: [] });
  assert.equal(clock.release(9), 'A');
  assert.equal(clock.posAt(9), 3, 'a release moves nothing');
  assert.equal(clock.posAt(10), 4, 'past A now');
  assert.equal(clock.posAt(12), 6);
  assert.equal(clock.posAt(13), 6, 'B loops next');
  assert.equal(clock.release(13), 'B');
  assert.equal(clock.posAt(14), 7);
  assert.equal(clock.posAt(15), 0, 'the song wraps at 8');
  assert.equal(clock.posAt(17), 2);
  assert.equal(clock.posAt(19), 2, 'A is armed again after the wrap');
  assert.equal(clock.release(1), null, 'nothing looping there');
});

test('ArrangeClock: walking ahead then releasing re-walks, and a snapshot replays identically', () => {
  const clock = new ArrangeClock({ len: 8, regions: [{ name: 'A', start: 0, end: 2 }] });
  assert.equal(clock.posAt(20), 0, 'walked far ahead through ten passes');
  clock.release(3);
  assert.equal(clock.posAt(9), 7, 'the early walk is discarded past the release: it runs on');
  assert.equal(clock.posAt(20), 0, 'wrapped at 8, A re-armed, looping again');
  const twin = new ArrangeClock(clock.snapshot());
  for (const c of [0, 1, 2.5, 3, 5, 9, 12]) assert.equal(twin.posAt(c), clock.posAt(c));
});

test('_arrangeGate takes a position function', () => {
  const clock = new ArrangeClock({ len: 4, regions: [{ name: 'A', start: 0, end: 1 }] });
  const sig = n('0 1')._arrangeGate([[0, 1]], (c) => clock.posAt(c));
  assert.deepEqual(sig.stepsForCycle(3).map((s) => s.value), [0, 1], 'cycle 3 is still bar 0, looping');
});
