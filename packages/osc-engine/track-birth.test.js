'use strict';

// A track whose build never finishes can be built again, and the evaluation sweep that clears
// trailing fx slots does no work for an empty one (engine/tracks.js, engine/loads.js).
//
// createTrack reserves its key with 'pending' and writes the real track only at the end of an async
// build. A build that ends without committing used to leave 'pending' for good, and every note aimed
// at the key was dropped. awaitTrack hands a reservation it has waited out to reclaimStuckTrack,
// which clears it so the key can be built again; a generation counter keeps that safe when the build
// was merely slow (it wakes to a stale claim and frees what it made). And the scheduler clears every
// fx slot past its chain's end on every evaluation - unloadEffect decides synchronously and starts
// a routine only for a slot with something in it.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Synth } = require('./server/objects');

test('a track build that never commits is given up on, and the key can be built again', async () => {
  const { E } = fakeEngine();
  const firstGen = (E.trackGen.get('a') ?? 0) + 1;
  E.trackGen.set('a', firstGen);
  E.tracks.set('a', 'pending');
  assert.equal(await E.awaitTrack('a', 0.2), null, 'a stuck reservation answers nothing');
  assert.equal(E.tracks.get('a'), undefined, 'and is cleared');
  const secondGen = (E.trackGen.get('a') ?? 0) + 1;
  assert.notEqual(secondGen, firstGen, 'the stale build is refused');
  E.tracks.set('b', { synth: 1 });
  E.trackGen.set('b', 5);
  assert.ok(await E.awaitTrack('b', 0.2));
  assert.equal(E.trackGen.get('b'), 5, 'a live track is left alone');
  assert.equal(await E.awaitTrack('c', 0.2), null);
  assert.equal(E.tracks.get('c'), undefined);
  assert.equal(E.trackGen.get('c'), undefined, 'an unknown key is left alone');
});

test('a build that wakes after it was given up on frees what it made instead of committing', async () => {
  const fe = fakeEngine();
  const { E, sent } = fe;
  const output = () => fe.output;
  // The build waits on the server's sync; hold it there until the reclaim has happened.
  const releases = [];
  E.S.sync = () => new Promise((r) => { releases.push(r); });
  const build = E.buildTrack('slow', []);
  E.reclaimStuckTrack('slow');
  const rebuild = E.buildTrack('slow', []); // the rebuild takes the key
  releases[0](true);
  await build;
  const freedGroups = sent.filter((m) => m[0] === '/n_free').length;
  assert.equal(freedGroups, 1, 'the stale build frees its group');
  assert.equal(E.tracks.get('slow'), 'pending', 'and does not commit over the rebuild');
  assert.match(output(), /finished building after it was given up on/);
  releases[1](true);
  await rebuild;
  assert.ok(E.isTrack(E.tracks.get('slow')), 'the rebuild commits');
});

test("clearing an empty fx slot takes no routine, so a whole song's sweep costs nothing", async () => {
  const { E, S } = fakeEngine();
  let forks = 0;
  const fork = E.fork.bind(E);
  E.fork = (fn) => { forks += 1; return fork(fn); };
  let closed = 0;
  let ramped = 0;
  E.dropSlotRamps = () => { ramped += 1; };
  const bypassed = [];
  const node = (id) => Object.assign(Synth.basicNew('x', S, id), { set: (...a) => bypassed.push([id, ...a]) });
  const live = {
    key: 'live', loaded: new Map(), wanted: new Map(), controllers: new Map(), editWatch: new Map(),
    nodes: new Map([[3, node(3)], [5, node(5)]]), wired: new Set([3, 5]), synth: node(1),
  };
  E.tracks.set('live', live);
  E.tracks.set('born', 'pending');
  const unload = (key, slot) => E.dispatch('/poptart/unloadEffect', [key, slot]);
  for (let i = 0; i < 1500; i++) unload('live', 1 + (i % 20));
  for (let i = 0; i < 1500; i++) unload('born', 1 + (i % 20));
  assert.equal(forks, 0, 'an empty slot is decided without a routine');
  assert.equal(E.tracks.get('born'), 'pending');
  live.loaded.set(3, 'Pro-Q 3');
  live.controllers.set(3, { close: () => { closed += 1; } });
  unload('live', 3);
  live.wanted.set(5, 'Serum 2');
  assert.equal(E.slotLive(live, 5), false, 'an open still in flight is not live');
  live.loaded.set(5, 'Serum 2');
  assert.equal(E.slotLive(live, 5), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(forks, 1);
  assert.deepEqual([closed, ramped, bypassed, live.loaded.get(3)], [1, 1, [[3, 'active', 0]], undefined]);
  // A slot the chain still runs through keeps its node.
  assert.ok(live.nodes.get(3));
});
