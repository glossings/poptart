'use strict';

// wireAudio/unwireAudio (engine/routing.js) - one source track feeding SEVERAL sinks at once.
//
// The ordinary parallel-processing shape
//
//   verb: audio("kick").fx("ValhallaRoom").fx("Kickstart 2").audio("kick")
//
// asks the kick for two things - feed this chain's input, and key slot 2's sidechain. The source
// offers its output on a refcounted per-source FEED bus and each route reads its own copy off it.
//
// What this guards: (1) two sinks on one source coexist, reading the same feed bus; (2) dropping
// one route leaves the other playing; (3) dropping the last one frees the feed, so a source that
// stops being read doesn't keep writing into a bus nobody owns.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Synth, Group, Bus } = require('./server/objects');

test('one source track feeds several sinks at once', async () => {
  const { E, S, sent } = fakeEngine();
  // The source's tap and a slot's sidechain bus live on nodes a real track grows - counted here.
  const taps = [];
  E.stripTap = (track, name, out) => taps.push([name, out]);
  E.setScBus = () => {};
  const mkTrack = (born) => ({
    synth: Synth.basicNew('poptart_track_shared', S), group: Group.basicNew(S), inBus: Bus.audio(S, 2),
    controllers: new Map(), born,
  });
  E.tracks.set('kick', mkTrack(1));
  E.tracks.set('verb', mkTrack(2));

  // audio("kick").fx(...).fx(...).audio("kick") - the head input, then slot 2's sidechain.
  await Promise.all([E.wireAudio('verb', 0, 'kick', 1), E.wireAudio('verb', 2, 'kick', 0.5)]);
  const head = E.sidechainByTarget.get(E.scKey('verb', 0));
  const side = E.sidechainByTarget.get(E.scKey('verb', 2));
  const feed = E.sourceFeeds.get('kick');
  assert.ok(head && side, 'both routes must survive - one source, two sinks');
  assert.deepEqual([head.source, side.source], ['kick', 'kick']);
  assert.ok(head.feeder && side.feeder, 'each route reads its own copy off the feed bus');
  assert.equal(feed.refs, 2);
  assert.deepEqual(taps, [['sidechain', feed.bus.index]], "the source's tap is pointed at the feed once");
  assert.notEqual(head.bus.index, side.bus.index, 'each sink needs its own bus');
  assert.ok(![head.bus.index, side.bus.index].includes(feed.bus.index), 'a sink must read a copy, not the feed bus itself');
  // Each reader reads the feed into its sink, at the head of the sink's group.
  const readers = sent.filter((m) => m[0] === '/s_new' && m[1] === 'poptart_busread');
  assert.deepEqual(readers.map((m) => [m[4], m[6], m[8]]),
    [[E.tracks.get('verb').group.nodeID, head.bus.index, feed.bus.index], [E.tracks.get('verb').group.nodeID, side.bus.index, feed.bus.index]]);
  assert.equal(E.sidechainBySource.get('kick').length, 2);
  // The sink sits after the source.
  const levels = E.trackLevels();
  assert.deepEqual([levels.get('kick'), levels.get('verb')], [0, 1]);

  // Dropping the sidechain must leave the head input playing.
  E.unwireAudio('verb', 2);
  assert.ok(E.sidechainByTarget.get(E.scKey('verb', 0)));
  assert.equal(E.sidechainBySource.get('kick').length, 1);
  assert.equal(E.sourceFeeds.get('kick').refs, 1, 'the feed stays up while a route still reads it');

  // ...and dropping the last one gives the bus back and drops the source's tap.
  E.unwireAudio('verb', 0);
  assert.equal(E.sourceFeeds.get('kick'), undefined);
  assert.equal(E.sidechainBySource.get('kick'), undefined);
  assert.deepEqual(taps.at(-1), ['sidechain', null]);
});

test('a hardware input feeds the sink from a SoundIn at the head of the server', async () => {
  const fe = fakeEngine({ config: { server: { inChannels: 4 } } });
  const { E, S, sent } = fe;
  E.tracks.set('vox', { synth: Synth.basicNew('x', S), group: Group.basicNew(S), inBus: Bus.audio(S, 2), controllers: new Map(), born: 1 });
  await E.wireAudio('vox', 0, 'dev:Scarlett', 1, 2, -1);
  const m = sent.find((x) => x[0] === '/s_new');
  assert.deepEqual(m.slice(1, 5), ['poptart_soundin_mono', m[2], 0, 1]);
  assert.equal(m[m.indexOf('inA') + 1], 2);
  assert.match(fe.output, /audio input: ch 3 of 'Scarlett' -> vox \(slot 0\)/);
  // A channel past the device's inputs reads the last one, and says so.
  await E.wireAudio('vox', 0, 'dev:Scarlett', 1, 6, 7);
  assert.match(fe.output, /channel 7\/8 is past the device's 4 input channels - reading the last one/);
  const last = sent.filter((x) => x[0] === '/s_new').at(-1);
  assert.deepEqual([last[last.indexOf('inA') + 1], last[last.indexOf('inB') + 1]], [3, 3]);
});
