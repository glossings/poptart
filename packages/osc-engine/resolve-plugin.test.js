'use strict';

// resolvePlugin (engine/loads.js): `.fx("Kickstart 2")` names a plugin by its display name, and
// VSTPlugin keys a VST2 by that bare name and a VST3 by "Name.vst3". For a plugin installed in both
// formats the VST2 owns the bare name - and loading it would fold the sidechain into extra channels
// on one input bus, so `.audio(...)` would wire a route the plugin has no input for. The VST3 has to
// win; anything unambiguous resolves as written.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');

// A plugin installed twice as VSTPlugin caches it: the VST2 owns the bare display name, the VST3
// carries the extension, and each desc is reachable by its file path too.
const vst2 = { name: 'Kickstart 2', key: 'Kickstart 2' };
const vst3 = { name: 'Kickstart 2', key: 'Kickstart 2.vst3' };
const DICT = new Map([
  ['Kickstart 2', vst2],
  ['/Library/Audio/Plug-Ins/VST/Kickstart 2.vst', vst2],
  ['Kickstart 2.vst3', vst3],
  ['/Library/Audio/Plug-Ins/VST3/Kickstart 2.vst3', vst3],
  ['kHs Compressor.vst3', { name: 'kHs Compressor', key: 'kHs Compressor.vst3' }],
  ['OnlyVst2', { name: 'OnlyVst2', key: 'OnlyVst2' }],
]);

const CASES = [
  // The regression: a bare display name shadowed by a VST2 must still reach the VST3.
  ['Kickstart 2', 'Kickstart 2.vst3'],
  ['Kickstart 2.vst3', 'Kickstart 2.vst3'],
  ['kHs Compressor', 'kHs Compressor.vst3'],
  // A shadowed VST2 stays reachable - by its file path.
  ['/Library/Audio/Plug-Ins/VST/Kickstart 2.vst', 'Kickstart 2'],
  ['OnlyVst2', 'OnlyVst2'],
  // Unknown names pass straight through for VSTPlugin itself to complain about.
  ['NotInstalled', 'NotInstalled'],
];

test('resolvePlugin prefers the VST3 when a VST2 shadows the display name', () => {
  const { E } = fakeEngine();
  E.vst = { plugins: () => DICT };
  for (const [input, expected] of CASES) assert.strictEqual(E.resolvePlugin(input), expected, `resolvePlugin(${JSON.stringify(input)})`);
  // A host with no plugins at all passes names through.
  E.vst = null;
  assert.strictEqual(E.resolvePlugin('Kickstart 2'), 'Kickstart 2');
});

test('resolveParamIndex takes a name, or Name#N for a name a plugin reuses', () => {
  const { E } = fakeEngine();
  const params = [{ name: 'Frequency' }, { name: 'Res' }, { name: 'Frequency' }, { name: 'Odd#Name' }];
  const info = { parameters: params, findParamIndex: (n) => { const i = params.findIndex((p) => p.name === n); return i < 0 ? null : i; } };
  assert.equal(E.resolveParamIndex(info, 'Frequency'), 0);
  assert.equal(E.resolveParamIndex(info, 'Frequency#2'), 2);
  assert.equal(E.resolveParamIndex(info, 'Odd#Name'), 3, 'a real name containing # resolves as itself');
  assert.equal(E.resolveParamIndex(info, 'Frequency#9'), null, 'an index past the list is nothing');
  assert.equal(E.resolveParamIndex(info, 'Nope'), null);
  assert.equal(E.resolveParamIndex(null, 'Frequency'), null);
});
