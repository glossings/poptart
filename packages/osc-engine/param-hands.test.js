'use strict';

// What the desktop engine tells sclang about a polled plugin parameter a hand may take in the
// plugin's own window (see takeHand in sc/poptart.scd): a hold says whether the code SETS the value
// - only a setting may be taken - and releaseParamHands gives one, or a whole track's, back to the
// poll. No scsynth: the engine is built offline and its sends recorded.

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index');

function engine() {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0;
  e.sent = [];
  e._send = (address, args) => e.sent.push([address, ...args]);
  return e;
}

test('a hold tells sclang whether the value is a setting', () => {
  const e = engine();
  e.holdParam('lead', 1, 'Cutoff', { steady: true });
  e.holdParam('lead', 1, 'Resonance', { steady: false });
  e.holdParam('lead', 1, 'Drive');
  assert.deepStrictEqual(e.sent, [
    ['/poptart/holdParam', 'lead', 1, 'Cutoff', 1],
    ['/poptart/holdParam', 'lead', 1, 'Resonance', 0],
    ['/poptart/holdParam', 'lead', 1, 'Drive', 0],
  ]);
});

test('hands are given back one at a time, or a whole track at once', () => {
  const e = engine();
  e.releaseParamHands('lead', 1, 'Cutoff');
  e.releaseParamHands('lead');
  assert.deepStrictEqual(e.sent, [
    ['/poptart/releaseHands', 'lead', 1, 'Cutoff'],
    ['/poptart/releaseHands', 'lead'],
  ]);
});
