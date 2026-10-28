'use strict';

// The sampler's voice ceiling (engine/notes.js: voiceBorn/voiceDone).
//
// Every sample event is a NEW synth, the one thing in poptart that can allocate without limit -
// and what it spends is the server's real-time memory, which, run out, stops scsynth creating
// anything for the rest of the session. So past the ceiling the OLDEST voice is released to make
// room, as a hardware sampler does: a moment too dense loses its tail instead of the drums stopping
// for the night.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Synth } = require('./server/objects');
const { poptartOptions } = require('./server/server');

function rig() {
  const f = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes'] });
  f.E.maxVoices = 4;
  const made = [1, 2, 3, 4, 5, 6, 7].map((i) => Synth.basicNew('x', f.S, i));
  const gated = () => f.sent.filter((m) => m[0] === '/n_set' && m[2] === 'gate' && m[3] === 0).map((m) => m[1]);
  const live = () => [...f.E.liveVoices].map((s) => s.nodeID);
  return Object.assign(f, { made, gated, live });
}

test('voices up to the ceiling all sound, and none is disturbed', () => {
  const { E, made, gated, live } = rig();
  for (let i = 0; i < 4; i++) E.voiceBorn(made[i]);
  assert.deepEqual(live(), [1, 2, 3, 4]);
  assert.deepEqual(gated(), []);
});

test('past the ceiling the OLDEST voice is released, and only it - and it keeps being the oldest', () => {
  const { E, made, gated, live } = rig();
  for (let i = 0; i < 5; i++) E.voiceBorn(made[i]);
  assert.deepEqual(gated(), [1]);
  assert.deepEqual(live(), [2, 3, 4, 5]);
  E.voiceBorn(made[5]);
  assert.deepEqual(gated(), [1, 2]);
  assert.deepEqual(live(), [3, 4, 5, 6]);
});

test('a voice that ends on its own makes room without anything being stolen', () => {
  const { E, made, gated, live } = rig();
  for (let i = 0; i < 4; i++) E.voiceBorn(made[i]);
  E.voiceDone(made[2]);
  assert.equal(E.liveVoices.size, 3);
  E.voiceBorn(made[4]);
  assert.deepEqual(gated(), []);
  assert.deepEqual(live(), [1, 2, 4, 5]);
});

test('hitting the ceiling is reported, but not once per voice', () => {
  const f = rig();
  f.E.voiceCapSaidAt = -100; // as long after boot as a set is
  for (let i = 0; i < 7; i++) f.E.voiceBorn(f.made[i]);
  assert.equal(f.output.split('\n').filter((l) => /WARNING: poptart: 4 sample voices are already sounding/.test(l)).length, 1);
});

test('the ceiling is a guard on the server, not a musical limit', () => {
  const { E } = fakeEngine({ sections: ['notes'] });
  assert.ok(E.maxVoices >= 256, `${E.maxVoices} voices is low enough to be heard as a limit`);
  assert.ok(E.maxVoices < poptartOptions().maxNodes / 2, 'the voices would leave nothing of the node table for tracks');
});

test("a voice Node played itself counts toward the ceiling, and leaves it when it is done", async () => {
  const { E } = rig();
  E.tracks.set('hats', { key: 'hats', held: 0 });
  E.dispatch('/poptart/direct/voice', ['hats', 9001, 'poptart_sample_2', 0.05]);
  assert.equal(E.liveVoices.size, 1);
  assert.equal(E.tracks.get('hats').held, 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(E.liveVoices.size, 0);
  E.stop();
});
