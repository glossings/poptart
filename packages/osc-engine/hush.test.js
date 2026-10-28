'use strict';

// hushTrack (engine/notes.js) - what playing a stopped track again does to the voices it is still
// sounding.
//
// A stop lets everything ring out; the restart must not play over that, so the host hushes the
// track first. hushTrack releases the sample voices (one gate-off on their group), releases by
// name every note a plugin has not finished sounding, closes the env modulators' gate, zeroes the
// held count and drops notes waiting on a program load - now, and again `again` seconds on. All-
// notes-off goes out behind the named releases for a VST2 plugin only: VST3 has no such message.
//
// What this guards: (1) the immediate release reaches every kind of voice and clears the books;
// (2) the repeat runs on a track still standing; (3) it does NOT run against a track destroyed
// or rebuilt under the same key inside the window; (4) a key with no track is a no-op; (5) a
// plugin note is released exactly when its end is still to come, and a VST3 plugin is never sent
// all-notes-off.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { Group, Synth } = require('./server/objects');

test('a hush releases every voice now, and again on request - on the same track only', async () => {
  const { E, S, sent } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes'] });
  const calls = [];
  const mk = (name, id, sdk = 'VST 2.4') => ({
    key: null,
    voices: Group.basicNew(S, id),
    loaded: new Map([[0, 'plugin']]),
    head: Synth.basicNew('x', S, id + 1000),
    nodes: new Map(),
    controllers: new Map([[0, {
      info: { sdkVersion: sdk },
      midi: {
        allNotesOff: (ch) => calls.push(`ANO<${name}>${ch}`),
        noteOff: (ch, note) => calls.push(`OFF<${name}>${ch},${note}`),
      },
    }], [1, null]]),
    envs: new Map(),
    held: 3,
    sounding: new Map([[0, new Map([[60, Infinity], [64, E.elapsed() + 5], [67, E.elapsed() - 1]])], [1, new Map()]]),
  });
  E.tracks.set('living', mk('living', 100));
  E.tracks.set('rebuilt', mk('old', 200));
  E.tracks.set('gone', mk('gone', 300));
  E.tracks.set('three', mk('three', 500, 'VST 3.7.8'));
  E.tracks.get('living').envs.set('e', { synth: Synth.basicNew('x', S, 150) });
  E.noteQueues.set('living_0', [1]);
  E.noteQueues.set('living_1', [1]);

  E.hushTrack('living', 0.3);
  E.hushTrack('rebuilt', 0.3);
  E.hushTrack('gone', 0.3);
  E.hushTrack('missing', 0.3);
  E.hushTrack('three', 0);

  const living = E.tracks.get('living');
  assert.equal(living.sounding.get(0).size, 0, 'a hush leaves nothing on the books');
  assert.equal(living.held, 0, 'the held-note count was not zeroed');
  assert.ok(!E.noteQueues.has('living_0') && !E.noteQueues.has('living_1'), 'notes waiting on a program load were not dropped');

  // Inside the window one track is destroyed and another rebuilt under its key.
  E.tracks.delete('gone');
  E.tracks.set('rebuilt', mk('new', 400));
  await new Promise((r) => setTimeout(r, 600));
  E.stop();

  const count = (s) => calls.filter((c) => c === s).length;
  const gates = (id) => sent.filter((m) => m[0] === '/n_set' && m[1] === id && m[2] === 'gate' && m[3] === 0).length;
  assert.equal(count('ANO<living>0'), 2, 'the VST2 instrument gets all-notes-off, now and at the repeat');
  assert.equal(count('OFF<living>0,60'), 2, 'the open-ended note must be released, and again at the repeat');
  assert.equal(count('OFF<living>0,64'), 2, 'the note still to end must be released, and again at the repeat');
  assert.equal(calls.filter((c) => /0,67$/.test(c)).length, 0, 'a note that has ended is not released again');
  assert.equal(count('OFF<three>0,60') + count('OFF<three>0,64'), 2, "the VST3 instrument's notes were not released by name");
  assert.equal(calls.filter((c) => c.startsWith('ANO<three>')).length, 0, 'a VST3 plugin must not be sent all-notes-off');
  assert.equal(gates(150), 2, "the env modulator's gate was not closed");
  assert.equal(gates(100), 2, "the living track's voices must be released twice");
  assert.equal(gates(300), 1, "a destroyed track's repeat must not run");
  assert.equal(gates(200), 1, "the replaced track's repeat must not run");
  assert.equal(sent.filter((m) => m[1] === 400).length, 0, "the rebuilt track must not be hushed by its predecessor's stop");
});

test('a finished note leaves the books, per slot', () => {
  const { E } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes'] });
  const t = { sounding: new Map([[0, new Map()], [1, new Map()]]) };
  E.markSounding(t, 0, 72, Infinity);
  E.markSounding(t, 0, 72, E.elapsed() - 0.5);
  E.markSounding(t, 0, 74, Infinity);
  E.markSounding(t, 1, 40, E.elapsed() + 5);
  assert.deepStrictEqual([...t.sounding.get(0).keys()], [74]);
  assert.deepStrictEqual([...t.sounding.get(1).keys()], [40]);
});
