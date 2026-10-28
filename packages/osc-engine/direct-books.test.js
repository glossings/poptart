'use strict';

// The books the engine keeps for what Node plays itself (engine/notes.js's /poptart/direct/*
// handlers and engine/ids.js's tell helpers): the voice ceiling still steals the oldest voice
// whoever made it, the held count follows Node's notes, a hush releases a note Node played by name,
// and a channel control coming to rest is the one ramp value Node is told not to send itself.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Group, Synth } = require('./server/objects');

test("what Node plays is on the engine's books: the ceiling, the held count, a hush and the ramps", async () => {
  const { E, S, sent, told } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes'] });
  E.maxVoices = 2;
  const released = [];
  E.tracks.set('kick', {
    key: 'kick', held: 0, envs: new Map(), lfos: new Map(), nodes: new Map(),
    voices: Group.basicNew(S, 50), head: Synth.basicNew('x', S, 51),
    loaded: new Map([[0, 'plugin']]),
    controllers: new Map([[0, { info: { sdkVersion: 'VST 3.7' }, midi: { noteOff: (ch, note) => released.push(note) } }]]),
    sounding: new Map(),
  });
  const kick = E.tracks.get('kick');
  // Three voices Node made, two allowed: the first is released early.
  E.dispatch('/poptart/direct/voice', ['kick', 7001, 'poptart_sample_1', 0.05]);
  E.dispatch('/poptart/direct/voice', ['kick', 7002, 'poptart_sample_1', 5]);
  E.dispatch('/poptart/direct/voice', ['kick', 7003, 'poptart_sample_1', 5]);
  assert.ok(sent.some((m) => m[0] === '/n_set' && m[1] === 7001 && m[2] === 'gate' && m[3] === 0), 'the oldest voice was not released at the ceiling');
  assert.deepStrictEqual([...E.liveVoices].map((s) => s.nodeID), [7002, 7003]);
  assert.equal(kick.held, 3, "each of Node's voices holds the track like one made here");
  E.dispatch('/poptart/direct/held', ['kick', -3]);
  // A note on and its off in five seconds, then a note on with no off yet: a hush releases both.
  E.dispatch('/poptart/direct/note', ['kick', 0, 60, -1]);
  E.dispatch('/poptart/direct/note', ['kick', 0, 60, 5]);
  E.dispatch('/poptart/direct/note', ['kick', 0, 64, -1]);
  assert.equal(kick.held, 1, "Node's note on and off did not move the held count");
  E.hushTrack('kick', 0);
  assert.deepStrictEqual(released.sort(), [60, 64]);
  assert.ok(sent.some((m) => m[0] === '/n_set' && m[1] === 50 && m[2] === 'gate' && m[3] === 0), 'the voices group was not released');
  // The ramps: a plugin value and a channel away from rest go direct; at rest it does not.
  told.length = 0;
  E.tellRamp(kick, 'slot0_Cutoff', 0, Synth.basicNew('r', S, 8001), 0.5);
  E.tellRamp(kick, 'slot-1_gain', -1, Synth.basicNew('r', S, 8002), 1);
  E.tellRamp(kick, 'slot-1_gain', -1, Synth.basicNew('r', S, 8002), 0.7);
  E.tellRamp(kick, 'slot0_Cutoff', null, null, null);
  const ramps = told.filter((m) => m.address === '/poptart/ids/ramp').map((m) => m.args.join(','));
  assert.deepStrictEqual(ramps, ['kick,slot0_Cutoff,8001,0,1', 'kick,slot-1_gain,8002,-1,0,1', 'kick,slot-1_gain,8002,-1,1,1', 'kick,slot0_Cutoff,0,0,0']);
  // Held: after the hush it is 0, so -1 changes nothing (not told) and +1 is told.
  told.length = 0;
  E.heldBy(kick, -1);
  E.heldBy(kick, 1);
  assert.deepStrictEqual(told.filter((m) => m.address === '/poptart/ids/held').map((m) => m.args[1]), [1]);
  // Its own end drops a voice from the count, as voiceDone does for the engine's voices.
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual([...E.liveVoices].map((s) => s.nodeID), [7002, 7003]);
  E.stop();
});

test('a deck player Node spawned is kept, and its position forwarded until it stops', () => {
  const { E, S, told } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes', 'songs'] });
  E.songs.set('deck', { buf: null, synth: null });
  E.dispatch('/poptart/direct/song', ['deck', 7100, 'poptart_song_2', 0.5]);
  const song = E.songs.get('deck');
  assert.equal(song.synth.nodeID, 7100);
  assert.ok(song.spawnUntil > E.elapsed() + 0.4);
  S._dispatch({ address: '/poptart/songPos', args: [7100, -1, 12.5] });
  S._dispatch({ address: '/poptart/songPos', args: [9999, -1, 3] });
  assert.deepStrictEqual(told.filter((m) => m.address === '/poptart/songPos').map((m) => m.args), [['deck', 12.5]]);
  E.dispatch('/poptart/direct/songStop', ['deck', 7100]);
  assert.equal(song.synth, null);
  S._dispatch({ address: '/poptart/songPos', args: [7100, -1, 13] });
  assert.equal(told.filter((m) => m.address === '/poptart/songPos').length, 1, 'a stopped player is no longer forwarded');
});
