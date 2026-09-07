// _arrange(): the painter's clip format, the span/length math both sides read, and the gate the
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
  arrangementLabels,
  reconcileArrangement,
  baseOf,
  variantOf,
  inSpans,
  ArrangeClock,
} from './src/index.mjs';

test('parse/serialize round-trip, malformed tokens dropped', () => {
  const clips = parseArrangement('bass,4,4 drums,0,8  nope,x,1 drums,12,4 hats,0.5,0.25');
  assert.deepEqual(clips, [
    { label: 'bass', start: 4, len: 4 },
    { label: 'drums', start: 0, len: 8 },
    { label: 'drums', start: 12, len: 4 },
    { label: 'hats', start: 0.5, len: 0.25 },
  ]);
  assert.equal(serializeArrangement(clips), 'bass,4,4 drums,0,8 drums,12,4 hats,0.5,0.25');
  assert.equal(parseArrangement('').length, 0);
  assert.equal(parseArrangement('a,0,0').length, 0, 'a zero-length clip is nothing');
});

test('a clip may name a VARIATION of its track, which sits on the same row', () => {
  const clips = parseArrangement('drums,0,8 drums#fill,12,4');
  assert.deepEqual(clips[1], { label: 'drums#fill', start: 12, len: 4 });
  assert.equal(serializeArrangement(clips), 'drums,0,8 drums#fill,12,4', 'and round-trips');
  assert.equal(baseOf('drums#fill'), 'drums');
  assert.equal(variantOf('drums#fill'), 'fill');
  assert.equal(baseOf('drums'), 'drums');
  assert.equal(variantOf('drums'), null);
});

test('an older arrangement\'s roll binding parses as the plain clip', () => {
  // `drums:fill` once meant "drums, playing the roll called fill". The clip stays where it was
  // painted; the roll it named is a variation away (`drums#fill: pianoroll("fill")…`).
  assert.deepEqual(parseArrangement('drums:fill,12,4'), [{ label: 'drums', start: 12, len: 4 }]);
});

test('a variation joins the arrangement with nothing painted', () => {
  // Filling it would lay it over its base for the whole song; a variation is the thing you paint in.
  const out = reconcileArrangement(parseArrangement('kick,0,16'), { len: 16, tracks: ['kick'] }, ['kick', 'kick#fill']);
  assert.ok(out.changed, 'it does join the membership');
  assert.deepEqual(out.tracks, ['kick', 'kick#fill']);
  assert.deepEqual(out.added, [], 'but no clip is made for it');
});

test('a group joins the arrangement with nothing painted, and keeps its row', () => {
  // A group has no notes of its own - its variations are what goes on its row - so a clip of it
  // would play nothing. It is still a track, and a row.
  const out = reconcileArrangement(parseArrangement('kick#main,0,16'), { len: 16, tracks: [] }, ['kick', 'kick#main', 'hat'], ['kick']);
  assert.deepEqual(out.tracks, ['kick', 'kick#main', 'hat']);
  assert.deepEqual(out.added, [{ label: 'hat', start: 0, len: 16 }], 'the plain track fills; the group does not');
});

test('hand-chosen clip colors are kept, and anything that is not a color is not', () => {
  const o = normalizeArrangeOpts({ colors: { 'kick#fill': '#FF8800', kick: 'red', ' ': '#000000' } });
  assert.deepEqual(o.colors, { 'kick#fill': '#ff8800' });
  assert.deepEqual(normalizeArrangeOpts({}).colors, {});
});

test('an older arrangement\'s lane column parses and is dropped', () => {
  assert.deepEqual(parseArrangement('drums,0,0,8 bass,1,4,4'), [
    { label: 'drums', start: 0, len: 8 },
    { label: 'bass', start: 4, len: 4 },
  ]);
  assert.ok(looksLikeArrangeString('drums,0,0,8 bass,1,4,4'));
});

test('looksLikeArrangeString tells data from anything else', () => {
  assert.ok(looksLikeArrangeString(''));
  assert.ok(looksLikeArrangeString('drums,0,8 bass:fill,4.5,2'));
  assert.ok(!looksLikeArrangeString('<a b>'));
  assert.ok(!looksLikeArrangeString('drums'));
});

test('labels come back in the order the clips first name them', () => {
  assert.deepEqual(arrangementLabels(parseArrangement('b,0,4 a,0,8 b,8,4')), ['b', 'a']);
});

test('options: snap/len/tracks/autos with defaults', () => {
  assert.deepEqual(normalizeArrangeOpts(), { snap: 'auto', len: null, tracks: [], colors: {}, autos: [], loops: [] });
  assert.deepEqual(
    normalizeArrangeOpts({ snap: 4, len: 16, tracks: ['kick', 'kick'], autos: ['filter', 'filter', ''] }),
    { snap: 4, len: 16, tracks: ['kick'], colors: {}, autos: ['filter'], loops: [] },
  );
  assert.equal(normalizeArrangeOpts({ len: 0 }).len, null);
});

// ---------------------------------------------------------------------------------------------
// Membership: which tracks are in the arrangement, and what that makes a new one do
// ---------------------------------------------------------------------------------------------

test('a track that has never been arranged joins it filled', () => {
  const clips = parseArrangement('kick,0,4');
  const out = reconcileArrangement(clips, { len: 16, tracks: ['kick'] }, ['kick', 'bass']);
  assert.ok(out.changed);
  assert.deepEqual(out.tracks, ['kick', 'bass']);
  assert.deepEqual(out.added, [{ label: 'bass', start: 0, len: 16 }], 'the whole song, so it sounds as it did');
  assert.equal(out.clips.length, 2);
});

test('a track whose clips you deleted stays empty - that is what membership is FOR', () => {
  const out = reconcileArrangement(parseArrangement('kick,0,4'), { len: 16, tracks: ['kick', 'bass'] }, ['kick', 'bass']);
  assert.equal(out.changed, false, 'nothing to do: bass is in the arrangement, and silent on purpose');
  assert.deepEqual(out.added, []);
});

test('an old arrangement with no membership recorded fills every unpainted track', () => {
  // Exactly the migration off `$: arrange(…)`: back then an unpainted block played throughout, so
  // the tracks it never mentioned have to come out of this playing throughout too.
  const out = reconcileArrangement(parseArrangement('kick,0,8'), { len: 8 }, ['kick', 'bass', 'pad']);
  assert.deepEqual(out.added.map((c) => c.label), ['bass', 'pad'], 'kick was painted already - it keeps its clips');
  assert.deepEqual(out.added.map((c) => [c.start, c.len]), [[0, 8], [0, 8]]);
  assert.deepEqual(out.tracks, ['kick', 'bass', 'pad'], 'and all three are in it from now on');
});

test('a label that has left the buffer keeps its place only while clips still name it', () => {
  const withClips = reconcileArrangement(parseArrangement('ghost,0,4'), { tracks: ['ghost', 'gone'] }, []);
  assert.deepEqual(withClips.tracks, ['ghost'], 'the orphan stays, the empty one is forgotten');
});

test('the paint grid defaults to auto - the painter divides it by how far it is zoomed in', () => {
  assert.equal(normalizeArrangeOpts({ snap: 'auto' }).snap, 'auto');
  assert.equal(normalizeArrangeOpts({ snap: 'nonsense' }).snap, 'auto', 'unreadable reads as auto, not as 1');
  // A pinned division still pins: a number is a number however it was written.
  assert.equal(normalizeArrangeOpts({ snap: 8 }).snap, 8);
  assert.equal(normalizeArrangeOpts({ snap: '8' }).snap, 8);
  assert.equal(normalizeArrangeOpts({ snap: 0 }).snap, 1, 'and one cell a bar is as coarse as it gets');
  assert.equal(normalizeArrangeOpts({ snap: 3.4 }).snap, 3);
});

test('length: explicit, else the last clip end rounded up, never below one', () => {
  const clips = parseArrangement('a,0,3.5 b,2,1');
  assert.equal(arrangementLength(clips), 4);
  assert.equal(arrangementLength(clips, { len: 8 }), 8);
  assert.equal(arrangementLength([]), 1);
});

test('spans merge per label across touching clips', () => {
  const spans = arrangementSpans(parseArrangement('a,0,2 a,2,2 a,6,1 b,1,1'));
  assert.deepEqual(spans.get('a'), [[0, 4], [6, 7]]);
  assert.deepEqual(spans.get('b'), [[1, 2]]);
  assert.ok(inSpans(spans.get('a'), 3.99));
  assert.ok(!inSpans(spans.get('a'), 4));
  assert.ok(inSpans(spans.get('a'), 6));
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

test('ArrangeClock.seek: from that cycle on the song is at that bar, regions armed afresh', () => {
  const clock = new ArrangeClock({ len: 16, regions: [{ name: 'A', start: 0, end: 4 }] });
  // stopped, so the transport restarts at cycle 0: a seek there is where the song starts
  assert.equal(clock.seek(0, 12), 12);
  assert.equal(clock.posAt(0), 12);
  assert.equal(clock.posAt(3), 15);
  assert.equal(clock.posAt(4), 0, 'the song wraps at 16');
  assert.equal(clock.posAt(9), 1, 'and A, armed, is looping again');
  // a seek mid-play, after a release: the release is forgotten - a seek is a fresh run
  clock.release(9);
  assert.equal(clock.posAt(9), 1);
  assert.equal(clock.seek(10, 8), 8);
  assert.equal(clock.posAt(10), 8);
  assert.equal(clock.posAt(18), 0);
  assert.equal(clock.posAt(23), 1, 'A loops again from the wrap');
  assert.equal(clock.seek(30, 21), 5, 'a bar past the end folds into the song');
  const twin = new ArrangeClock(clock.snapshot());
  for (const c of [0, 3, 9, 10, 18, 23, 30, 33]) assert.equal(twin.posAt(c), clock.posAt(c));
});

test('_arrangeGate takes a position function', () => {
  const clock = new ArrangeClock({ len: 4, regions: [{ name: 'A', start: 0, end: 1 }] });
  const sig = n('0 1')._arrangeGate([[0, 1]], (c) => clock.posAt(c));
  assert.deepEqual(sig.stepsForCycle(3).map((s) => s.value), [0, 1], 'cycle 3 is still bar 0, looping');
});
