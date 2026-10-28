'use strict';

// The headphone section (poptart_headphones in synthdef/defs.js): the node after the master meter
// that turns the summed cue sends into what the headphones play - the cue/main blend and the level.
//
// What this guards: it reads the main mix from every output BUT the cue pair, plus the cue pair
// itself, and it writes once, replacing the cue pair - adding to it would play the cue twice, and
// writing anywhere else would put the headphones in the room. An engine with no cue pair builds
// none (the def used to be built anyway and died on `nil + 1` at boot, 2026-10-25).

const { test } = require('node:test');
const assert = require('node:assert');
const synthdef = require('./synthdef');
const { decodeScgf } = require('./synthdef/decode');

const OUTS = new Set(['Out', 'ReplaceOut', 'OffsetOut', 'XOut', 'LocalOut']);
const phones = (outputs, cueOffset) => synthdef.defsFor({ numOutputBusChannels: outputs, cueOffset })
  .find((d) => d.name === 'poptart_headphones');

test('the headphones read the main outputs and the cue pair, and replace only the cue pair', () => {
  const e = phones(6, 2);
  assert.ok(e, 'no headphones def with a cue pair');
  const d = decodeScgf(e.bytes)[0];
  // Outputs 1-2 and 5-6 are the main mix, one channel each; 3-4 the cue sum, read as a pair.
  const ins = d.ugens.filter((u) => u.name === 'In').map((u) => `${u.inputs[0].c}x${u.outputs.length}`).sort();
  assert.deepStrictEqual(ins, ['0x1', '1x1', '2x2', '4x1', '5x1']);
  const outs = d.ugens.filter((u) => OUTS.has(u.name)).map((u) => `${u.name}@${u.inputs[0].c}x${u.inputs.length - 1}`);
  assert.deepStrictEqual(outs, ['ReplaceOut@2x2'], 'the headphones must replace the cue pair and write nothing else');
  assert.deepStrictEqual(d.paramNames.map((p) => p.name), ['level', 'mix']);
});

test('an engine with no cue pair builds no headphones, and does not crash building them', () => {
  assert.strictEqual(phones(2, null), undefined, 'the headphones were built with no cue pair');
});
