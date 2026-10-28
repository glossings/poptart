'use strict';

// The master meter (poptart_master in synthdef/defs.js): the last node in the tree, which sums
// every hardware output to one stereo pair and reports the peak of that - the whole song's level.
//
// What this guards: it only listens (it sits after every sound the engine makes, so it must never
// write to an output), it reads every output, and it leaves the headphone cue pair out.

const { test } = require('node:test');
const assert = require('node:assert');
const synthdef = require('./synthdef');
const { decodeScgf } = require('./synthdef/decode');

const OUTS = new Set(['Out', 'ReplaceOut', 'OffsetOut', 'XOut', 'LocalOut']);

function master(outputs, cueOffset) {
  const e = synthdef.defsFor({ numOutputBusChannels: outputs, cueOffset }).find((d) => d.name === 'poptart_master');
  assert.ok(e, 'no poptart_master def');
  return decodeScgf(e.bytes)[0];
}

const reads = (d) => d.ugens.filter((u) => u.name === 'In').map((u) => u.inputs[0].c).sort((a, b) => a - b);

test('the master meter reads every output and writes to none', () => {
  const d = master(4, null);
  assert.deepStrictEqual(reads(d), [0, 1, 2, 3], 'the meter should read all four outputs');
  assert.strictEqual(d.ugens.filter((u) => OUTS.has(u.name)).length, 0, 'the meter writes to an output - it must only listen');
  const feeds = d.ugens.filter((u) => u.name === 'SendPeakRMS');
  assert.strictEqual(feeds.length, 1, 'the meter should send one peak feed');
  // SendPeakRMS's inputs are [reply rate, peak lag, replyID, channel count, ...channels, name...].
  assert.strictEqual(feeds[0].inputs[3].c, 2, 'four outputs should be measured as ONE summed stereo pair, not four channels');
});

test('the headphone cue pair is not part of the master', () => {
  assert.deepStrictEqual(reads(master(4, 2)), [0, 1], 'with the cue on outputs 3-4 the meter should read 1-2 only');
});
