'use strict';

// Pitch bend in the engine - Sig#bend's two destinations. The bend channel is an ordinary channel
// control on the way in, and splits in two on the way out: the head republishes it on a control bus
// of the track's own, the sample voices MAP that bus and fold it into their playback rate, and a
// SendReply turns it into MIDI pitch bend for the plugin in slot 0 (engine/params.js's bendOut
// listener). What this guards: the defs carry the bend controls where they should (built by
// ../synthdef, as the engine boots with them), the semitone -> 14-bit conversion, and that a
// posted bend reaches the instrument in slot 0 only while it is live.

const { test } = require('node:test');
const assert = require('node:assert');
const synthdef = require('./synthdef');
const { fakeEngine } = require('./test-support/fake-engine');

const defs = synthdef.defsFor({});
const def = (name) => defs.find((d) => d.name === name).def;
const SAMPLE_DEFS = ['poptart_sample_', 'poptart_sample_loop_', 'poptart_sample_warp_', 'poptart_sample_warp_loop_'];

test('every sample voice builds with a bend control, at both channel counts', () => {
  for (const name of SAMPLE_DEFS) {
    for (const nc of [1, 2]) {
      const bend = def(`${name}${nc}`).allControlNames.find((c) => c.name === 'bend');
      assert.ok(bend, `${name}${nc} should carry a bend control`);
      // A def whose bend defaulted to anything else would detune every unbent sample on the track.
      assert.equal(bend.defaultValue, 0, `${name}${nc}'s bend should rest at 0`);
    }
  }
});

test("the track's head republishes its bend on a bus and posts it for MIDI", () => {
  const head = def('poptart_head');
  const ctl = (n) => head.allControlNames.find((c) => c.name === n);
  assert.equal(ctl('bend')?.defaultValue, 0, 'bend rests at centre');
  // pattern-core's DEFAULT_BEND_RANGE: the +/-2 semitones nearly every plugin powers up with.
  assert.equal(ctl('bendrange')?.defaultValue, 2, 'bendrange defaults to 2 semitones');
  assert.ok(ctl('bendOut'));
  const kinds = head.children.map((u) => `${u.constructor.name}:${u.rate}`);
  // A control bus is never cleared between blocks, so an Out here would accumulate the bend.
  assert.ok(kinds.includes('ReplaceOut:control'), 'the bend bus is written with ReplaceOut');
  assert.ok(!kinds.includes('Out:control'), 'nothing else writes a control bus with Out');
  assert.ok(head.children.some((u) => /^SendReply/.test(u.constructor.name)), 'the MIDI sender has something to listen to');
});

test("semitones become a 14-bit bend against the plugin's own range, sent to slot 0 while it is live", () => {
  const { E, S } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'params'] });
  const { Synth } = require('./server/objects');
  const sent = [];
  const head = Synth.basicNew('poptart_head', S, 4321);
  const track = {
    key: 't', head, controllers: new Map([[0, { midi: { bend: (chan, v) => sent.push([chan, v]) } }]]),
    loaded: new Map([[0, 'Synth']]), nodes: new Map(),
  };
  E.tracks.set('t', track);
  E.bendTracks.set(4321, 't');
  const post = (semis, range) => S._dispatch({ address: '/poptart/bendOut', args: [4321, -1, semis, range] });
  const encode = (semis, range) => { sent.length = 0; post(semis, range); return sent[0]?.[1]; };
  assert.equal(encode(0, 2), 8192, 'no bend is dead centre');
  assert.equal(encode(2, 2), 16383, 'a full bend up saturates at the top');
  assert.equal(encode(-2, 2), 0, 'and a full bend down at the bottom');
  assert.equal(encode(1, 2), 12288, 'half the range is half the throw');
  assert.equal(encode(1, 12), 8875, 'the same semitone is a smaller throw on a wider range');
  assert.equal(encode(12, 12), 16383, '...and an octave fills it');
  assert.equal(encode(9, 2), 16383, 'past the range the message can only saturate');
  assert.equal(encode(-9, 2), 0);
  assert.equal(sent[0][0], 0, 'on channel 0');
  // A slot whose synth the server said it does not have gets nothing.
  E.deadNodes.add(4321);
  assert.equal(encode(1, 2), undefined);
  E.deadNodes.delete(4321);
  track.loaded.clear();
  assert.equal(encode(1, 2), undefined, 'nor one with nothing open');
});
