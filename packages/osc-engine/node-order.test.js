'use strict';

// trackLevels/reorderTracks (engine/tracks.js) - the node order between tracks that read each other.
//
// scsynth zeroes its buses every block, so a track ordered before what it reads hears silence. The
// order is a DEPTH worked out from every route at once - 0 for a track that reads nothing, one past
// the deepest thing routed into it otherwise - and one Group per depth, in order. A loop (two tracks
// reading each other, or one reading a bus it writes) has no order that runs every reader after its
// writer: the edge that closes it, walking upstream in the order the tracks were made (as the
// browser engine does), reads the block before.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Group } = require('./server/objects');

const mkTrack = (E, extra = {}) => ({ group: Group.basicNew(E.S), ...extra });
const route = (targetKey, source, busName) => ({ targetKey, source, busName });

test('tracks are ordered by how deep their reads go', () => {
  const { E, sent } = fakeEngine();
  // kick and hat send to "drums"; drums reads that bus and sends on to "mix"; master reads "mix".
  // verb reads the kick track's output directly. building is still being built.
  E.tracks.set('kick', mkTrack(E, { busSends: ['drums'] }));
  E.tracks.set('hat', mkTrack(E, { busSends: ['drums'] }));
  E.tracks.set('drums', mkTrack(E, { busSends: ['mix'] }));
  E.tracks.set('master', mkTrack(E));
  E.tracks.set('verb', mkTrack(E));
  E.tracks.set('building', 'pending');
  E.sidechainByTarget.set('drums_0', route('drums', null, 'drums'));
  E.sidechainByTarget.set('master_0', route('master', null, 'mix'));
  E.sidechainByTarget.set('verb_0', route('verb', 'kick', null));
  E.sidechainByTarget.set('building_0', route('building', 'kick', null));
  E.tracks.set('a', mkTrack(E));
  E.tracks.set('b', mkTrack(E));
  E.sidechainByTarget.set('a_0', route('a', 'b', null));
  E.sidechainByTarget.set('b_0', route('b', 'a', null));

  const levels = E.trackLevels();
  assert.equal(levels.get('kick'), 0);
  assert.equal(levels.get('hat'), 0);
  assert.equal(levels.get('drums'), 1, 'a bus reader sits one past the deepest writer');
  assert.equal(levels.get('master'), 2, 'and a reader of what it writes on, one past that');
  assert.equal(levels.get('verb'), 1, 'a track source counts like a bus');
  assert.equal(levels.get('building'), undefined, 'a pending track has no place yet');
  assert.deepEqual([levels.get('a'), levels.get('b')].sort(), [0, 1], 'a feedback pair is broken at one edge');
  E.reorderTracks();
  assert.equal(E.levelGroups.length, 3, 'one level group per depth, made as the depth appears');
  // Each new level group goes before recGroup, and every track's group heads its level's.
  const before = sent.filter((m) => m[0] === '/g_new' && m[2] === 2 && m[3] === E.recGroup.nodeID);
  assert.equal(before.length, 2);
  const master = E.tracks.get('master').group.nodeID;
  assert.ok(sent.some((m) => m[0] === '/g_head' && m[1] === E.levelGroups[2].nodeID && m[2] === master));
});

test('the edge that closes a loop is chosen by creation order', () => {
  const { E } = fakeEngine();
  // b was made before a: b's walk reaches a, and a's read of b closes the loop.
  E.tracks.set('b', mkTrack(E, { born: 1 }));
  E.tracks.set('a', mkTrack(E, { born: 2 }));
  // c sends to bus "loop" and reads it back.
  E.tracks.set('c', mkTrack(E, { born: 3, busSends: ['loop'] }));
  const ab = route('a', 'b', null);
  const ba = route('b', 'a', null);
  const cc = route('c', null, 'loop');
  E.sidechainByTarget.set('ab', ab);
  E.sidechainByTarget.set('ba', ba);
  E.sidechainByTarget.set('cc', cc);
  E.trackLevels();
  assert.deepEqual([...E.loopEdges].sort(), ['a|b', 'c|c']);
  assert.deepEqual([ab, ba, cc].map((e) => E.routeCloses(e.targetKey, e)), [true, false, true]);
  // The other way round: a made first, so b's read of a closes it.
  E.tracks.get('a').born = 0;
  E.trackLevels();
  assert.deepEqual([...E.loopEdges].sort(), ['b|a', 'c|c']);
});

test('a closing edge reads its feeder from the block before', () => {
  const { E, sent } = fakeEngine();
  E.tracks.set('b', mkTrack(E, { born: 1 }));
  E.tracks.set('a', mkTrack(E, { born: 2 }));
  const fa = { set: (...a) => sent.push(['fa', ...a]) };
  const fb = { set: (...a) => sent.push(['fb', ...a]) };
  E.sidechainByTarget.set('ab', { ...route('a', 'b', null), feeder: fa });
  E.sidechainByTarget.set('ba', { ...route('b', 'a', null), feeder: fb });
  E.reorderTracks();
  assert.deepEqual(sent.filter((m) => m[0] === 'fa' || m[0] === 'fb'), [['fa', 'fb', 1], ['fb', 'fb', 0]]);
});
