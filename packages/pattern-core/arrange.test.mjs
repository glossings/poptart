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
  arrangementEnd,
  arrangementLoops,
  arrangementSpans,
  arrangementLabels,
  reconcileArrangement,
  inSpans,
  ArrangeClock,
  songSteps,
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

test('the retired clip spellings are not special-cased - the mute flag or nothing', () => {
  // A lane column (`drums,0,0,8`) and a roll binding (`drums:fill,12,4`) were both migrated out
  // of every saved pattern when their eras ended; the parser carries no memory of them. A stray
  // one is an ordinary malformed-or-orphan token, visible in the painter rather than quietly
  // reinterpreted. The fourth field carries the mute flag now, which is why it is the LITERAL `m`
  // and not a truthy value: the retired lane column was a number there, and a saved pattern from
  // that era must never come back as a song with parts silently muted.
  assert.deepEqual(parseArrangement('drums,0,0,8'), [], 'a lane column is still malformed');
  assert.deepEqual(parseArrangement('drums,0,8,1'), [], '...whatever number is in it');
  assert.deepEqual(parseArrangement('drums:fill,12,4'), [{ label: 'drums:fill', start: 12, len: 4 }],
    'a : label matches no block, so it draws as an orphan row instead of silently rebinding');
});

test('a muted clip keeps its place and its bars, and sounds nothing', () => {
  // Mute is the one thing about a clip that changes what is HEARD without changing where the clip
  // is, so it round-trips through the string and drops out of the spans - and only there.
  const clips = parseArrangement('a,0,2,m a,4,2 b,0,8,m');
  assert.deepEqual(clips, [
    { label: 'a', start: 0, len: 2, mute: true },
    { label: 'a', start: 4, len: 2 },
    { label: 'b', start: 0, len: 8, mute: true },
  ]);
  assert.equal(serializeArrangement(clips), 'a,0,2,m a,4,2 b,0,8,m');
  assert.ok(looksLikeArrangeString('a,0,2,m a,4,2'), 'the editor still folds it as clip data');
  assert.equal(arrangementEnd(clips), 8, 'the song is as long as the muted clip still makes it');
  const spans = arrangementSpans(clips);
  assert.deepEqual(spans.get('a'), [[4, 6]], 'only the unmuted clip sounds');
  assert.equal(spans.get('b'), undefined, 'every clip muted is a silent track, like an emptied row');
});

test('a clip can carry a color of its own, and only six hex digits reads as one', () => {
  // The `colors` option is the same choice made for a whole TRACK; this one is a clip saying it
  // is different from the rest of its row, which is what right-clicking one and picking a color
  // writes. Normalized to a lowercase #rrggbb on the way in, as the option's are.
  const clips = parseArrangement('kick,0,4,cFF8800 kick,4,4 hat,0,4,m,c00ff00');
  assert.deepEqual(clips, [
    { label: 'kick', start: 0, len: 4, color: '#ff8800' },
    { label: 'kick', start: 4, len: 4 },
    { label: 'hat', start: 0, len: 4, mute: true, color: '#00ff00' },
  ], 'and the clip beside it is untouched - a color is one clip\'s, not the row\'s');
  assert.equal(serializeArrangement(clips), 'hat,0,4,m,c00ff00 kick,0,4,cff8800 kick,4,4');
  assert.ok(looksLikeArrangeString('kick,0,4,cff8800'), 'the editor still folds it as clip data');
  assert.deepEqual(parseArrangement('kick,0,4,cxyzxyz'), [], 'not hex, not a color');
  assert.deepEqual(parseArrangement('kick,0,4,c1234567'), [], 'seven digits is not a color either');
  assert.deepEqual(parseArrangement('kick,0,4,c'), [], 'and neither is nothing');
});

test('a group joins the arrangement with nothing painted, and keeps its row', () => {
  // A group has no notes of its own - what sounds on it is its members - so a clip of it would
  // play nothing. It is still a track, and a row: the one its members fold away under.
  const out = reconcileArrangement(parseArrangement('kickMain,0,16'), { len: 16, tracks: [] }, ['kick', 'kickMain', 'hat'], ['kick']);
  assert.deepEqual(out.tracks, ['kick', 'kickMain', 'hat']);
  assert.deepEqual(out.added, [{ label: 'hat', start: 0, len: 16 }], 'the plain track fills; the group does not');
});

test('hand-chosen clip colors are kept, and anything that is not a color is not', () => {
  const o = normalizeArrangeOpts({ colors: { 'kick#fill': '#FF8800', kick: 'red', ' ': '#000000' } });
  assert.deepEqual(o.colors, { 'kick#fill': '#ff8800' });
  assert.deepEqual(normalizeArrangeOpts({}).colors, {});
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
  assert.deepEqual(normalizeArrangeOpts(), { snap: 'auto', len: null, tracks: [], colors: {}, autos: [], loops: [], wholeLoop: true });
  assert.deepEqual(
    normalizeArrangeOpts({ snap: 4, len: 16, tracks: ['kick', 'kick'], autos: ['filter', 'filter', ''] }),
    { snap: 4, len: 16, tracks: ['kick'], colors: {}, autos: ['filter'], loops: [], wholeLoop: true },
  );
  assert.equal(normalizeArrangeOpts({ loops: [] }).wholeLoop, false, 'a call that writes `loops`, even empty, plays through');
  assert.equal(normalizeArrangeOpts({ len: 0 }).len, null);
});

// ---------------------------------------------------------------------------------------------
// Membership: which tracks are in the arrangement, and what that makes a new one do
// ---------------------------------------------------------------------------------------------

test('a track that has never been arranged joins it filled', () => {
  const clips = parseArrangement('kick,0,4 hat,8,8');
  const out = reconcileArrangement(clips, { loops: [['A', 0, 32]], tracks: ['kick', 'hat'] }, ['kick', 'hat', 'bass']);
  assert.ok(out.changed);
  assert.deepEqual(out.tracks, ['kick', 'hat', 'bass']);
  assert.deepEqual(out.added, [{ label: 'bass', start: 0, len: 16 }], 'from the top to the last clip\'s right edge');
  assert.equal(out.clips.length, 3);
});

test('with nothing painted anywhere a joining track fills the last loop region, else the default length', () => {
  const looped = reconcileArrangement([], { loops: [['A', 0, 4], ['B', 4, 12]], tracks: [] }, ['kick']);
  assert.deepEqual(looped.added, [{ label: 'kick', start: 0, len: 12 }]);
  const bare = reconcileArrangement([], { loops: [], tracks: [] }, ['kick']);
  assert.deepEqual(bare.added, [{ label: 'kick', start: 0, len: 8 }]);
});

test('a track whose clips you deleted stays empty - that is what membership is FOR', () => {
  const out = reconcileArrangement(parseArrangement('kick,0,4'), { loops: [], tracks: ['kick', 'bass'] }, ['kick', 'bass']);
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

test('the song ends at the right edge of its last clip', () => {
  assert.equal(arrangementEnd(parseArrangement('a,0,3.5 b,2,1')), 3.5, 'the edge itself, not rounded to a bar');
  assert.equal(arrangementEnd([]), 0);
});

test('loops: a call that writes the key plays exactly those regions, empty included', () => {
  const clips = parseArrangement('a,0,16');
  assert.deepEqual(arrangementLoops(clips, { loops: [] }), [], 'no loops is a song that plays through');
  assert.deepEqual(arrangementLoops(clips, { loops: [['A', 0, 4]], len: 32 }), [{ name: 'A', start: 0, end: 4 }], 'and the retired len means nothing beside it');
});

test('loops: a call without the key looped over its whole length, and is read as that region', () => {
  const clips = parseArrangement('a,0,3.5 b,2,1');
  assert.deepEqual(arrangementLoops(clips), [{ name: 'song', start: 0, end: 4 }], 'the last clip end rounded up');
  assert.deepEqual(arrangementLoops(clips, { len: 8 }), [{ name: 'song', start: 0, end: 8 }], 'or the length it named');
  assert.deepEqual(arrangementLoops([]), [{ name: 'song', start: 0, end: 1 }], 'never less than a bar');
  const opts = normalizeArrangeOpts({ len: 8 });
  assert.deepEqual(arrangementLoops(clips, normalizeArrangeOpts(opts)), [{ name: 'song', start: 0, end: 8 }], 'normalizing twice reads the same');
});

test('spans merge per label across touching clips', () => {
  const spans = arrangementSpans(parseArrangement('a,0,2 a,2,2 a,6,1 b,1,1'));
  assert.deepEqual(spans.get('a'), [[0, 4], [6, 7]]);
  assert.deepEqual(spans.get('b'), [[1, 2]]);
  assert.ok(inSpans(spans.get('a'), 3.99));
  assert.ok(!inSpans(spans.get('a'), 4));
  assert.ok(inSpans(spans.get('a'), 6));
});

test('_arrangeGate rests events outside the spans, and everything past the last one', () => {
  const sig = n('0 1 2 3')._arrangeGate([[0, 1], [2, 2.5]]);
  const values = (cycle) => sig.stepsForCycle(cycle).map((s) => s.value);
  assert.deepEqual(values(0), [0, 1, 2, 3], 'painted: the whole bar plays');
  assert.deepEqual(values(1), [null, null, null, null], 'unpainted: every event rests');
  assert.deepEqual(values(2), [0, 1, null, null], 'half a bar painted: onsets past it rest');
  assert.deepEqual(values(3), [null, null, null, null], 'past the end nothing comes round again');
  assert.deepEqual(values(40), [null, null, null, null]);
});

test('_arrangeGate keeps the pattern on absolute cycle time', () => {
  const sig = n('<0 1>')._arrangeGate([[1, 2]]);
  assert.deepEqual(sig.stepsForCycle(0).map((s) => s.value), [null]);
  assert.deepEqual(sig.stepsForCycle(1).map((s) => s.value), [1], 'the alternation kept counting through the gated-out bar');
});

test('_arrangeGate carries the chain and is a no-op on a gridless signal', () => {
  const sig = n('0').synth('Serum 2')._arrangeGate([[0, 1]]);
  assert.equal(sig.instrument, 'Serum 2');
  const lfo = sine(1);
  assert.equal(lfo._arrangeGate([[0, 1]]), lfo, 'a control signal has no events to gate');
});

test('options: loops are named, ordered, and junk is dropped', () => {
  const { loops } = normalizeArrangeOpts({ loops: [['chorus', 8, 16], ['', 0, 4], ['bad', 4, 4], ['x', 'y', 2]] });
  assert.deepEqual(loops, [{ name: 'loop2', start: 0, end: 4 }, { name: 'chorus', start: 8, end: 16 }]);
});

test('ArrangeClock without regions is the cycle itself, and runs on past the end', () => {
  const clock = new ArrangeClock({ end: 4 });
  assert.equal(clock.posAt(0), 0);
  assert.equal(clock.posAt(2), 2);
  assert.equal(clock.posAt(5.5), 5.5, 'nothing wraps at the end: stopping there is the host\'s job');
  assert.equal(clock.endCycle(), 4);
});

test('ArrangeClock loops an armed region until released, then runs on to the end', () => {
  const clock = new ArrangeClock({ end: 8, regions: [{ name: 'A', start: 2, end: 4 }, { name: 'B', start: 6, end: 7 }] });
  assert.equal(clock.posAt(1), 1);
  assert.equal(clock.posAt(3), 3);
  assert.equal(clock.posAt(4), 2, 'reaching A\'s end wraps to its start');
  assert.equal(clock.posAt(5.5), 3.5);
  assert.equal(clock.posAt(9), 3, 'still looping A a few passes later');
  assert.deepEqual(clock.stateAt(9), { pos: 3, looping: 'A', released: [] });
  assert.equal(clock.endCycle(), null, 'an armed region ahead: no end to name yet');
  assert.equal(clock.release(9), 'A');
  assert.equal(clock.posAt(9), 3, 'a release moves nothing');
  assert.equal(clock.posAt(10), 4, 'past A now');
  assert.equal(clock.posAt(12), 6);
  assert.equal(clock.posAt(13), 6, 'B loops next');
  assert.equal(clock.endCycle(), null);
  assert.equal(clock.release(13), 'B');
  assert.equal(clock.posAt(14), 7);
  assert.equal(clock.endCycle(), 15, 'nothing armed ahead: the song ends a bar on');
  assert.equal(clock.posAt(15), 8);
  assert.equal(clock.posAt(17), 10, 'and the clock does not come round again');
  assert.equal(clock.release(1), null, 'nothing looping there');
});

test('ArrangeClock: the end moves no position', () => {
  const clock = new ArrangeClock({ end: 8, regions: [{ name: 'A', start: 0, end: 4 }] });
  assert.equal(clock.posAt(13), 1);
  clock.setEnd(32);
  assert.equal(clock.posAt(13), 1, 'painting the song longer leaves the playhead where it is');
  clock.release(13);
  assert.equal(clock.endCycle(), 13 + 31);
  clock.setEnd(16);
  assert.equal(clock.endCycle(), 13 + 15);
});

test('ArrangeClock.rebuilt: new regions, the same place in the song', () => {
  const clock = new ArrangeClock({ end: 16, regions: [{ name: 'A', start: 0, end: 4 }, { name: 'B', start: 8, end: 12 }] });
  clock.release(9); // in A's third pass, at bar 1
  assert.equal(clock.posAt(10), 2);
  const moved = clock.rebuilt({ regions: [{ name: 'A', start: 0, end: 4 }, { name: 'C', start: 4, end: 6 }] }, 10);
  assert.equal(moved.end, 16);
  assert.deepEqual(moved.stateAt(10), { pos: 2, looping: null, released: ['A'] }, 'A stays let go of');
  assert.equal(moved.posAt(13), 5);
  assert.equal(moved.posAt(14), 4, 'and the new region loops when it is reached');
  const gone = clock.rebuilt({ regions: [] }, 10);
  assert.deepEqual(gone.stateAt(10), { pos: 2, looping: null, released: [] }, 'a region that no longer exists is forgotten');
  assert.equal(gone.endCycle(), 24);
  // a seek (the marker) survives a region edit too - the case that used to jump back to the walk from 0
  const sought = new ArrangeClock({ end: 16, regions: [{ name: 'A', start: 0, end: 4 }] });
  sought.seek(0, 12);
  assert.equal(sought.rebuilt({ regions: [{ name: 'A', start: 0, end: 2 }] }, 1.5).posAt(2), 14);
});

test('ArrangeClock: walking ahead then releasing re-walks, and a snapshot replays identically', () => {
  const clock = new ArrangeClock({ end: 8, regions: [{ name: 'A', start: 0, end: 2 }] });
  assert.equal(clock.posAt(20), 0, 'walked far ahead through ten passes');
  clock.release(3);
  assert.equal(clock.posAt(9), 7, 'the early walk is discarded past the release: it runs on');
  assert.equal(clock.posAt(20), 18, 'and keeps running: a released region stays released');
  const twin = new ArrangeClock(clock.snapshot());
  for (const c of [0, 1, 2.5, 3, 5, 9, 12]) assert.equal(twin.posAt(c), clock.posAt(c));
  assert.equal(twin.endCycle(), clock.endCycle());
});

test('ArrangeClock.seek: from that cycle on the song is at that bar, regions armed afresh', () => {
  const clock = new ArrangeClock({ end: 16, regions: [{ name: 'A', start: 0, end: 4 }] });
  // stopped, so the transport restarts at cycle 0: a seek there is where the song starts
  assert.equal(clock.seek(0, 12), 12);
  assert.equal(clock.posAt(0), 12);
  assert.equal(clock.posAt(3), 15);
  assert.equal(clock.endCycle(), 4, 'A is behind the playhead, so the song ends four bars on');
  // a seek mid-play, after a release: the release is forgotten - a seek is a fresh run
  assert.equal(clock.seek(5, 1), 1);
  clock.release(9);
  assert.equal(clock.posAt(9), 1);
  assert.equal(clock.seek(10, 2), 2);
  assert.equal(clock.posAt(12), 0, 'A loops again');
  assert.equal(clock.posAt(29), 1);
  assert.equal(clock.seek(30, 21), 21, 'a bar past the end stays where it was put');
  assert.equal(clock.endCycle(), 30, 'and is a song already over');
  assert.equal(clock.seek(31, -3), 0, 'before the top is the top');
  const twin = new ArrangeClock(clock.snapshot());
  for (const c of [0, 3, 9, 10, 18, 23, 30, 33]) assert.equal(twin.posAt(c), clock.posAt(c));
});

test('segments cut a transport span where the song clock jumps', () => {
  const clock = new ArrangeClock({ end: 8, regions: [{ name: 'A', start: 1, end: 2.5 }] });
  assert.deepEqual(clock.segments(0, 2), [{ from: 0, to: 2, delta: 0 }]);
  assert.deepEqual(clock.segments(2, 4), [{ from: 2, to: 2.5, delta: 0 }, { from: 2.5, to: 4, delta: -1.5 }]);
  clock.seek(4, 6);
  assert.deepEqual(clock.segments(3.5, 5), [{ from: 3.5, to: 4, delta: -1.5 }, { from: 4, to: 5, delta: 2 }]);
});

test('songSteps reads each step at its song position', () => {
  const clock = new ArrangeClock({ end: 4 });
  clock.seek(0, 1.5);
  const got = songSteps(n('<[0 1] [2 3]>').stepsForCycle, 0, 1, clock)
    .map(({ step, cycle, delta }) => [cycle + step.start - delta, step.value]);
  assert.deepEqual(got, [[0, 3], [0.5, 0]], 'bar 1\'s second half, then bar 2\'s downbeat');
});

test('songSteps without a clock is the pattern as it lies', () => {
  const steps = n('0 1').stepsForCycle;
  assert.deepEqual(songSteps(steps, 3, 4).map((e) => [e.cycle, e.step.value, e.delta]), [[3, 0, 0], [3, 1, 0]]);
  assert.deepEqual(songSteps(steps, 3.5, 4.25).map((e) => e.cycle + e.step.start), [3.5, 4], 'a window mid-cycle keeps only its own onsets');
});

test('_arrangeGate takes a position function', () => {
  const clock = new ArrangeClock({ end: 4, regions: [{ name: 'A', start: 0, end: 1 }] });
  const sig = n('0 1')._arrangeGate([[0, 1]], (c) => clock.posAt(c));
  assert.deepEqual(sig.stepsForCycle(3).map((s) => s.value), [0, 1], 'cycle 3 is still bar 0, looping');
});
