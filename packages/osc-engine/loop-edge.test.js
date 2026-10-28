'use strict';

// Feedback between tracks (engine/tracks.js's trackLevels and reorderTracks): the edge that closes a
// loop reads the block before (poptart_busread with fb 1, an InFeedback), and every other edge this
// block's audio. Which edge is chosen is in node-order.test.js; this renders both readers on a real
// scsynth, both run BEFORE the writer of the bus they read, as a closing edge does: the closing one
// carries the signal, an ordinary one would hear silence.
//
// Needs scsynth and an audio device; skipped without them. Nothing sounds - all private buses.

const { test } = require('node:test');
const assert = require('node:assert');
const { bootEngine, skipReason } = require('./test-support/scsynth');
const { captureBus } = require('./test-support/capture');
const { Synth, Bus } = require('./server/objects');

test('a closing edge plays the block before; an ordinary one would hear silence', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { S, E, quit } = await bootEngine({ port: 57475, sections: [] });
  try {
    const src = Bus.audio(S, 2);
    const fbOut = Bus.audio(S, 2);
    const plainOut = Bus.audio(S, 2);
    const g = E.levelGroups[0];
    // Readers first, then the writer of `src` after them: 0.5 on both sides.
    Synth.new(S, 'poptart_busread', ['out', fbOut.index, 'in', src.index, 'fb', 1], g, 'addToTail');
    Synth.new(S, 'poptart_busread', ['out', plainOut.index, 'in', src.index, 'fb', 0], g, 'addToTail');
    Synth.new(S, 'poptart_lfo_square_ar', ['out', src.index, 'lo', 0.5, 'hi', 0.5], g, 'addToTail');
    await S.sync();
    const fb = await captureBus(S, fbOut.index, 0.3, { target: E.recGroup });
    const plain = await captureBus(S, plainOut.index, 0.3, { target: E.recGroup });
    assert.ok(fb.frames > 4800, `recorded ${fb.frames} frames`);
    const mid = Math.floor(fb.frames / 2);
    assert.ok(Math.abs(fb.at(0, mid) - 0.5) < 1e-6, `the loop's closing edge is silent (${fb.at(0, mid)})`);
    assert.ok(Math.abs(fb.at(1, mid) - 0.5) < 1e-6);
    assert.ok(Math.abs(plain.at(0, Math.floor(plain.frames / 2))) < 1e-6, 'an ordinary read of a later writer hears nothing');
  } finally {
    await quit();
  }
});
