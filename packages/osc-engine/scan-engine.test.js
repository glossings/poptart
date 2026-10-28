'use strict';

// The plugin list and the scan on the Node engine (engine/scan.js), against a stand-in VSTPlugin
// host: one search per folder, bracketed by the '/poptart/scanState' messages OscEngine counts the
// probes between, the list falling back to the on-disk cache before any search, and the rescan
// handler answering with the list.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { fakeEngine } = require('./test-support/fake-engine');

const desc = (key, extra = {}) => ({
  key, name: key, vendor: 'v', category: 'c', sdkVersion: 'VST 3', synth: false,
  inputs: [{ channels: 2 }], outputs: [{ channels: 2 }], numParameters: 3, ...extra,
});

function stubHost() {
  const searched = [];
  const live = new Map();
  return {
    searched,
    plugins: () => live,
    readPlugins: () => new Map([['Cached', desc('Cached')]]),
    pluginCount: () => live.size,
    search: async ({ dir, options, verbose }) => {
      searched.push({ dir, options, verbose });
      await new Promise((r) => setTimeout(r, 5));
      live.set(`P${searched.length}`, desc(`P${searched.length}`, { synth: true }));
    },
  };
}

test('runScan searches folder by folder, bracketed for OscEngine, then lists what it found', async () => {
  const { E, told } = fakeEngine({ sections: ['scan'], config: { searchDirs: ['/a', '/b'], excludePaths: ['/x'] } });
  E.vst = stubHost();
  assert.deepStrictEqual(E.pluginList().map((p) => p.id), ['Cached'], 'before a search the list is the cache');
  let done = false;
  await E.runScan(() => { done = true; });
  assert.ok(done);
  assert.deepStrictEqual(E.vst.searched.map((s) => s.dir), ['/a', '/b']);
  assert.ok(E.vst.searched.every((s) => s.verbose && s.options.exclude[0] === '/x' && s.options.timeout === 20));
  assert.deepStrictEqual(told.filter((m) => m.address === '/poptart/scanState').map((m) => m.args),
    [['started', 2], ['folder', 1], ['folder', 2], ['finished', 2]]);
  assert.strictEqual(E.scanning, false);
  const list = E.pluginList();
  assert.deepStrictEqual(list.map((p) => p.id), ['P1', 'P2']);
  assert.deepStrictEqual(list[0], {
    id: 'P1', name: 'P1', manufacturer: 'v', category: 'c', format: 'VST 3', isInstrument: true,
    numInputChannels: 2, numOutputChannels: 2, numParameters: 3,
  });
});

test('with no folders it searches VSTPlugin\'s own locations, and the rescan answers with the list', async () => {
  const { E, told } = fakeEngine({ sections: ['scan'] });
  E.vst = stubHost();
  E.dispatch('/poptart/scanPlugins', [7]);
  let reply;
  for (let i = 0; i < 100 && !reply; i++) {
    await new Promise((r) => setTimeout(r, 5));
    reply = told.find((m) => m.address === '/poptart/scanPlugins.reply');
  }
  assert.ok(reply, 'no reply');
  assert.deepStrictEqual(E.vst.searched.map((s) => s.dir), [null]);
  const body = JSON.parse(fs.readFileSync(reply.args[1], 'utf8'));
  fs.unlinkSync(reply.args[1]);
  assert.deepStrictEqual(body.plugins.map((p) => p.id), ['P1']);
  assert.deepStrictEqual(body.crashed, []);
});
