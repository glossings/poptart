'use strict';

// poptart's own devices are in the lists the editor reads: the plugin browser's rows and the
// names `synth("`/`fx("` completes against, which on the desktop are both the plugin-list
// endpoints, plus the control names `.param("` completes against.
//
// A device that `.synth()` accepts and the editor never offers is a feature nobody finds - that
// was the first thing asked about the port. These are source-shape assertions: the endpoints are
// handlers on a live engine, which a unit test can't drive (see scan-restart-guard.test.js for
// the same shape), so what is checked is that the merge is in both lists and that the catalog
// answers chainParams without the plugin retry loop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

/** The body of one route handler, from its key to the next route key. */
function route(key) {
  const at = SRC.indexOf(`'${key}'`);
  assert.ok(at > 0, `${key} is not a route in server.js - this test needs updating`);
  const next = SRC.indexOf("\n  '", at + key.length);
  return SRC.slice(at, next > at ? next : at + 2000);
}

test('server.js takes its device rows from the engine package', () => {
  assert.match(
    SRC,
    /require\('@poptart\/osc-engine\/native-devices'\)/,
    'the catalog is the engine package\'s, not a second list kept here',
  );
});

test('the known-plugin list leads with the devices', () => {
  const body = route('GET /api/knownPlugins');
  assert.match(body, /deviceRows\(\)/, 'devices are in the list the browser loads at startup');
  assert.match(body, /\.\.\.deviceRows\(\),/, 'and they come first, before the scanned plugins');
});

test('a rescan still answers with the devices', () => {
  // The browser REPLACES its list from the scan's answer (renderPlugins in client.js), so a scan
  // that returned plugins only would take the devices back out of the browser and out of
  // autocomplete until the next reload.
  const body = route('POST /api/scanPlugins');
  assert.match(body, /deviceRows\(\)/, 'a scan answers with the devices too');
});

test('neither list filters a device by plugin format', () => {
  for (const key of ['GET /api/knownPlugins', 'POST /api/scanPlugins']) {
    const body = route(key);
    const merge = body.indexOf('deviceRows()');
    const filter = body.lastIndexOf('preferVst3');
    assert.ok(filter < merge, `${key}: prefer-VST3 runs on the scanned plugins, before the merge`);
  }
});

test("a device's controls are answered from the catalog, not by asking the engine", () => {
  const body = route('GET /api/chainParams');
  assert.match(body, /nativeDevice\(plugin\)/, 'the chain names are resolved against the catalog');
  assert.match(body, /deviceParamRows\(device\)/, 'and a device answers with its own controls');
  const shortcut = body.indexOf('deviceParamRows(device)');
  const wait = body.indexOf('getParamsWhenLoaded');
  assert.ok(shortcut > 0 && wait > shortcut, 'the catalog answers before the plugin retry loop');
  assert.match(body.slice(shortcut, wait), /continue;/, 'and a device never enters that loop');
});
