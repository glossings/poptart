'use strict';

// The DJ deck meter (poptart_deck_meter, synthdef/defs.js) and the engine's deckMeters handler
// (engine/mixer.js): a level feed per deck plus the three band energies that COLOR the deck's
// waveform strip. The bands have to split where a song file's offline analysis splits them
// (wav.js, the same 200Hz / 2kHz one-pole split), or two stacked decks are colored by two rules.
//
// The second test runs on a real-time scsynth (sandbox off, port 57401) and is skipped without one.

const { test } = require('node:test');
const assert = require('node:assert');
const synthdef = require('./synthdef');
const { decodeScgf } = require('./synthdef/decode');
const { ugen, G } = require('./test-support/nrt');
const U = require('./synthdef/ugens');
const { bootEngine, skipReason } = require('./test-support/scsynth');
const { sendDefs } = require('./server/defs');
const { Synth } = require('./server/objects');

const SinOsc = ugen('SinOsc', [440, 0]);

const deckMeter = () => decodeScgf(synthdef.defsFor().find((e) => e.name === 'poptart_deck_meter').bytes)[0];

test('the deck meter def builds, and its reply carries the deck id before the bands', () => {
  const d = deckMeter();
  assert.ok(d.ugens.length > 10, `the def has only ${d.ugens.length} UGens - the bands are missing`);
  const replies = d.ugens.filter((u) => u.name === 'SendReply');
  assert.equal(replies.length, 1, 'one band reply');
  const r = replies[0];
  // SendReply's inputs: [trig, replyID, name length, ...name, ...values]. The deck id travels as
  // the replyID - a control, not a constant, or both decks would reply under one id.
  assert.ok('u' in r.inputs[1] && d.ugens[r.inputs[1].u].name === 'Control', 'the reply does not carry the deck id');
  const nameLen = r.inputs[2].c;
  const name = r.inputs.slice(3, 3 + nameLen).map((x) => String.fromCharCode(x.c)).join('');
  assert.equal(name, '/poptart/deckBands');
  assert.equal(r.inputs.length - 3 - nameLen, 3, 'the reply should carry three band energies');
  const level = d.ugens.find((u) => u.name === 'SendPeakRMS');
  // SendPeakRMS's inputs: [replyRate, peakLag, replyID, ...].
  assert.ok(level && 'u' in level.inputs[2], 'the level feed carries the deck id too');
});

test('the bands split where the file analysis splits, for both decks, through the handler', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const rig = await bootEngine({ port: 57401, sections: ['mixer'] });
  try {
    const { S, E, told } = rig;
    const tone = new G.SynthDef('deck_tone', { bus: 0, freq: 100 }, (c) => {
      const s = SinOsc.ar(c.freq, 0);
      U.Out.ar(c.bus, [G.mul(s, 0.5), G.mul(s, 0.5)]);
    });
    await sendDefs(S, [{ def: tone }]);
    E.dispatch('/poptart/deckMeters', [1]);
    E.dispatch('/poptart/deckMeters', [1]); // idempotent
    await S.sync();
    assert.equal(E.deckMeterSynths.length, 2);
    const shares = async (deck, freq) => {
      const node = Synth.new(S, 'deck_tone', ['bus', E.deckMeterBus.index + deck * 2, 'freq', freq], E.levelGroups[0], 'addToTail');
      await new Promise((r) => setTimeout(r, 400)); // the 10Hz smoother settles
      const from = told.length;
      await new Promise((r) => setTimeout(r, 200));
      node.free();
      await S.sync();
      await new Promise((r) => setTimeout(r, 300)); // let the meter fall back before the next tone
      const frames = told.slice(from).filter((m) => m.address === '/poptart/deckBands');
      const mine = frames.filter((m) => m.args[0] === deck);
      assert.ok(mine.length > 0, `no band frames for deck ${deck}`);
      const e = mine.at(-1).args.slice(1).map((v) => Math.max(0, v));
      const total = e[0] + e[1] + e[2];
      assert.ok(total > 1e-9, `deck ${deck} heard silence`);
      const other = frames.filter((m) => m.args[0] !== deck).at(-1);
      if (other) {
        const o = other.args.slice(1).reduce((a, b) => a + Math.max(0, b), 0);
        assert.ok(o < total * 0.01, `deck ${1 - deck} heard deck ${deck}'s tone`);
      }
      return e.map((v) => v / total);
    };
    for (const deck of [0, 1]) {
      const low = await shares(deck, 60);
      const mid = await shares(deck, 700);
      const high = await shares(deck, 6000);
      assert.ok(low[0] > 0.8, `deck ${deck}: 60Hz read as ${low.map((v) => v.toFixed(2))} - it belongs in the low band`);
      assert.ok(mid[1] > 0.6, `deck ${deck}: 700Hz read as ${mid.map((v) => v.toFixed(2))} - it belongs in the mid band`);
      assert.ok(high[2] > 0.8, `deck ${deck}: 6kHz read as ${high.map((v) => v.toFixed(2))} - it belongs in the high band`);
    }
    const levels = told.filter((m) => m.address === '/poptart/deckLevel');
    assert.ok(levels.some((m) => m.args[0] === 0) && levels.some((m) => m.args[0] === 1), 'both decks report levels');
    E.dispatch('/poptart/deckMeters', [0]);
    assert.equal(E.deckMeterSynths, null);
  } finally {
    await rig.quit();
  }
});
