'use strict';

// What happens when scsynth says it has no such node (engine/notes.js: nodeGone, nodeFailId,
// nodeMissing, outOfRoom, serverFail).
//
// scsynth ANSWERS a command it could not carry out with /fail. Most are a one-off diagnosis. One
// repeats: a polled control re-sends its value every 30ms and moves the SAME ramp synth, so a ramp
// node the server does not have becomes a storm of failed writes with the parameter frozen. So the
// server is taken at its word: the entry pointing at that node is dropped, and the next poll
// rebuilds the ramp. Pinned here: the drop really happens, it is reported, the id is read out of
// whichever shape the reply takes, the unrepairable commands are attributed once, and running out
// of room is said loudly and first.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Synth, Bus } = require('./server/objects');
const { poptartOptions } = require('./server/server');

function rig() {
  const f = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes'] });
  const { E, S } = f;
  const kick = { key: 'kick', ramps: new Map(), loaded: new Map(), nodes: new Map(), head: null };
  kick.ramps.set('slot0_Cutoff', { synth: Synth.basicNew('poptart_ramp', S, 4242), bus: new Bus(S, 'control', 7, 1), index: 3, slot: 0 });
  kick.ramps.set('slot1_Drive', { synth: Synth.basicNew('poptart_ramp', S, 9999), bus: new Bus(S, 'control', 8, 1), index: 4, slot: 1 });
  E.tracks.set('kick', kick);
  const warnings = () => f.output.split('\n').filter((l) => l.startsWith('WARNING: '));
  return { ...f, kick, warnings };
}

test('a failed write to a ramp drops it, so the next poll rebuilds it', () => {
  const { E, kick, warnings, told } = rig();
  E.nodeGone(4242);
  assert.ok(!kick.ramps.has('slot0_Cutoff'), 'the dead ramp is still there - rampTo will go on setting it forever');
  assert.ok(kick.ramps.has('slot1_Drive'), 'an unrelated ramp was taken down with it');
  const warned = warnings().filter((l) => l.includes("kick's polled control slot0_Cutoff"));
  assert.equal(warned.length, 1, 'the repair has to be reported');
  assert.match(warned[0], /4242/);
  assert.match(warned[0], /rebuilding/);
  assert.ok(told.some((m) => m.address === '/poptart/ids/ramp' && m.args[1] === 'slot0_Cutoff' && m.args[2] === 0),
    'Node is told the ramp is gone, so the direct path stops writing to it');
});

test('a node nobody holds is reported once and not once per message', () => {
  const { E, warnings } = rig();
  for (let i = 0; i < 30; i++) E.nodeGone(777);
  for (let i = 0; i < 10; i++) E.nodeGone(888);
  assert.equal(warnings().filter((l) => /the server has no node \d+/.test(l)).length, 2);
});

test('nothing is dropped, or said, for a null id', () => {
  const { E, kick, warnings } = rig();
  E.nodeGone(null);
  assert.equal(kick.ramps.size, 2);
  assert.equal(warnings().length, 0);
});

test('the node id is read out of either shape of /fail reply', () => {
  const { E } = rig();
  assert.equal(E.nodeFailId(['/fail', '/n_set', 'Node 7961 not found']), 7961);
  assert.equal(E.nodeFailId(['/fail', '/n_set', 'Node not found', 7961]), 7961);
  assert.equal(E.nodeFailId(['/fail', '/n_set', 'wat']), null, 'no id must read as null, not node 0');
});

test('a failure names whose node it was, even for a track that has gone, once per node', () => {
  const { E, warnings, told } = rig();
  E.nodeOwns(5523, "bass's track synth, which its plugins live in");
  E.nodeOwns(3794, "kick's group");
  for (let i = 0; i < 20; i++) E.nodeMissing('/u_cmd', 5523);
  E.nodeMissing('/s_new', 3794);
  E.nodeMissing('/u_cmd', 111);
  const w = warnings().join('\n');
  assert.match(w, /no node 5523 \(bass's track synth[^)]*\)/);
  assert.match(w, /\/u_cmd could not be delivered/);
  assert.match(w, /no node 3794 \(kick's group\)/);
  assert.match(w, /no node 111 \(nothing poptart has a record of\)/);
  assert.equal((w.match(/no node 5523/g) ?? []).length, 1);
  assert.ok(told.some((m) => m.address === '/poptart/ids/dead' && m.args[0] === 5523));
});

test('a plugin on a node the server has lost is not written to again', () => {
  const { E, S, kick } = rig();
  kick.loaded = new Map([[0, 'serum']]);
  kick.head = Synth.basicNew('x', S, 5523);
  assert.equal(E.slotLive(kick, 0), true);
  E.nodeMissing('/u_cmd', 5523);
  assert.equal(E.slotLive(kick, 0), false, 'the node is gone - nothing else should be sent at it');
  assert.equal(E.slotLive(kick, 1), false, 'an empty slot was never writable');
});

test('the repairable family and the attributable family are kept apart, and /n_free is neither', () => {
  const { E, kick, warnings } = rig();
  E.serverFail(['/fail', '/n_set', 'Node 4242 not found']);
  assert.ok(!kick.ramps.has('slot0_Cutoff'), '/n_set is repaired');
  E.serverFail(['/fail', '/u_cmd', 'Node 6000 not found']);
  assert.ok(E.deadNodes.has(6000), '/u_cmd is attributed');
  E.serverFail(['/fail', '/n_free', 'Node 6100 not found']);
  assert.ok(!warnings().some((l) => l.includes('6100')), 'a failed /n_free is the teardown saying so');
});

test('the server\'s own /fail reaches the repair, and a relay of the same one is not counted twice', () => {
  const { E, S, warnings } = rig();
  S._dispatch({ address: '/fail', args: ['/n_set', 'Node 31337 not found'] });
  E.dispatch('/poptart/fail', ['/n_set', 'Node 31337 not found']);
  assert.equal(warnings().filter((l) => l.includes('31337')).length, 1);
  E.dispatch('/poptart/fail', ['/u_cmd', 'Node 31338 not found']);
  assert.ok(E.deadNodes.has(31338), 'a relay the server did not also send is still handled');
});

test('running out of room is reported, loudly, once per reason, before anything looks for a node', () => {
  const { E, warnings } = rig();
  for (let i = 0; i < 40; i++) E.serverFail(['/fail', '/s_new', 'out of real time memory']);
  E.serverFail(['/fail', '/s_new', 'too many nodes']);
  E.serverFail(['/fail', '/n_set', 'Node 4242 alloc failed']);
  const said = warnings().filter((l) => l.includes('OUT OF ROOM'));
  assert.equal(said.length, 3);
  assert.match(said[0], /out of real time memory/);
  assert.match(said[0], /Restart the engine/);
  assert.ok(!warnings().some((l) => l.includes("polled control slot0_Cutoff")), 'the room check comes first');
});

test('the allocations poptart asks for are its own, not the stock defaults', () => {
  const o = poptartOptions();
  assert.ok(o.memSize >= 65536, `memSize is ${o.memSize}KB, not enough headroom for a set`);
  assert.ok(o.maxNodes > 1024, 'maxNodes is back at the stock default');
});
