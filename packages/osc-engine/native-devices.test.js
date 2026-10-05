'use strict';

// poptart's own devices on the desktop: the catalog, how a name in a pattern resolves, and what
// a `.param()` argument means once it has.
//
// The point of the whole port is that a song means the same thing on either engine, so the
// argument rules are tested AGAINST THE BROWSER'S OWN - the functions the web build resolves
// with, imported here - rather than against a second copy of what they are believed to do. An
// enum's number is the case that matters: on the web `.param("Engine", 14)` is an index, and
// passed through as a 0..1 position it would pin the control at the end of the list instead.
//
// No engine boot: the OSC sends are captured, as in midi-fanout.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OscEngine } = require('./index.js');
const {
  nativeDevice, nativeDevices, deviceParam, deviceParamArgs, paramPosition, forgetNativeDevices,
} = require('./native-devices');

const DESCRIPTOR = path.join(__dirname, '..', 'web-engine', 'src', 'descriptor.mjs');

function engine() {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0;
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  const warned = [];
  e._warnOnce = (key, message) => warned.push(message);
  return { e, sent, warned };
}

test('the catalog is the list of what this build can host', () => {
  const devices = nativeDevices();
  assert.ok(devices.length >= 8, `expected the shipped devices, got ${devices.length}`);
  for (const d of devices) {
    assert.ok(d.id && (d.kind === 'synth' || d.kind === 'fx'), `${d.id} has no kind`);
    assert.ok(d.params.length > 0, `${d.id} has no controls`);
    for (const p of d.params) {
      assert.ok(typeof p.id === 'string' && p.id.length, `${d.id} has a control with no id`);
      assert.ok(Number.isFinite(p.min) && Number.isFinite(p.max), `${d.id}.${p.id} has no range`);
    }
  }
  // Warps is compiled by the build and deliberately not in the catalog (see
  // web-engine/src/devices/mutable.mjs) - the desktop must offer exactly what the browser does.
  assert.strictEqual(nativeDevice('Warps'), null, 'Warps is not a shipped device');
});

test('a device name resolves however it is spelled, and a plugin name does not resolve at all', () => {
  assert.strictEqual(nativeDevice('Plaits').id, 'Plaits');
  assert.strictEqual(nativeDevice('plaits').id, 'Plaits');
  assert.strictEqual(nativeDevice('  GALACTIC  ').id, 'Galactic');
  assert.strictEqual(nativeDevice('Serum 2'), null);
  assert.strictEqual(nativeDevice(''), null);
  assert.strictEqual(nativeDevice(undefined), null);
});

test('a load sends the device and its controls, and leaves plugin names alone', () => {
  const { e, sent } = engine();
  e.loadInstrument('t', 'Plaits');
  e.loadEffect('t', 'Galactic', 1);
  e.loadInstrument('u', 'Serum 2');
  e.loadEffect('u', 'ValhallaDelay', 2);

  const [device, fx, plugin, pluginFx] = sent;
  assert.strictEqual(device.addr, '/poptart/loadDevice');
  assert.deepStrictEqual(device.args.slice(0, 3), ['t', 0, 'Plaits']);
  // The controls ride along as id/name pairs - all sclang needs to resolve `.param()` by name.
  const pairs = device.args.slice(3);
  assert.strictEqual(pairs.length, nativeDevice('Plaits').params.length * 2);
  assert.deepStrictEqual(pairs.slice(0, 4), ['engine', 'Engine', 'harmonics', 'Harmonics']);
  assert.strictEqual(fx.addr, '/poptart/loadDevice');
  assert.deepStrictEqual(fx.args.slice(0, 3), ['t', 1, 'Galactic']);
  assert.strictEqual(plugin.addr, '/poptart/loadInstrument');
  assert.deepStrictEqual(plugin.args, ['u', 'Serum 2']);
  assert.strictEqual(pluginFx.addr, '/poptart/loadEffect');
  assert.deepStrictEqual(pluginFx.args, ['u', 'ValhallaDelay', 2]);
});

test('a device in the wrong half of the chain warns instead of loading', () => {
  const { e, sent, warned } = engine();
  e.loadInstrument('t', 'Galactic');
  e.loadEffect('t', 'Plaits', 1);
  assert.deepStrictEqual(sent, [], 'nothing should have been loaded');
  assert.match(warned[0], /Galactic is an effect.*\.fx\("Galactic"\)/);
  assert.match(warned[1], /Plaits is an instrument.*\.synth\("Plaits"\)/);
});

test('a control argument reaches sclang as a position, and an unknown one warns', () => {
  const { e, sent, warned } = engine();
  e.loadInstrument('t', 'Plaits');
  e.setParam('t', 0, 'Engine', 'Chord', 0);
  e.setParam('t', 0, 'Harmonics', 0.25, 0);
  e.setParam('t', 0, 'Nonesuch', 0.5, 0);
  e.setParam('t', 0, 'Engine', 'Nonesuch', 0);

  const params = sent.filter((m) => m.addr === '/poptart/setParam');
  assert.strictEqual(params.length, 2, 'only the two it can take are sent');
  assert.strictEqual(params[0].args[2], 'Engine');
  assert.ok(Math.abs(params[0].args[3] - 14 / 23) < 1e-9, `the chord engine sits at 14 of 23, got ${params[0].args[3]}`);
  assert.strictEqual(params[1].args[3], 0.25, 'a plain control takes the position it was given');
  assert.match(warned[0], /no control called "Nonesuch"/);
  assert.match(warned[1], /is not a value Plaits's "Engine" can take/);
});

test('a plugin slot keeps the plugin rule: numbers only, straight through', () => {
  const { e, sent } = engine();
  e.loadInstrument('t', 'Serum 2');
  e.setParam('t', 0, 'Filter 1 Freq', 0.5, 0);
  e.setParam('t', 0, 'Filter 1 Freq', 'Chord', 0);
  const params = sent.filter((m) => m.addr === '/poptart/setParam');
  assert.strictEqual(params.length, 1);
  assert.strictEqual(params[0].args[3], 0.5);
});

test('a slot stops being a device when something else takes it', () => {
  const { e, sent } = engine();
  e.loadInstrument('t', 'Plaits');
  e.loadInstrument('t', 'Serum 2');          // the plugin takes the instrument slot back
  e.setParam('t', 0, 'Engine', 'Chord', 0);  // ...so a label means nothing again
  e.loadEffect('t', 'Galactic', 1);
  e.unloadEffect('t', 1);
  e.setParam('t', 1, 'Mix', 'Chord', 0);
  assert.strictEqual(sent.filter((m) => m.addr === '/poptart/setParam').length, 0);
});

test('every argument means on the desktop what it means in the browser', async () => {
  const { argToValue, normalize } = await import(DESCRIPTOR);
  // The browser's OWN descriptors, not a reconstruction: this compares the desktop's answer
  // against the real contract, and catches a catalog that dropped a field the rule depends on
  // (a step, a curve, an option list) as well as a rule that drifted.
  const lists = await Promise.all([
    import(path.join(__dirname, '..', 'web-engine', 'src', 'devices', 'airwindows.mjs')),
    import(path.join(__dirname, '..', 'web-engine', 'src', 'devices', 'cloudseed.mjs')),
    import(path.join(__dirname, '..', 'web-engine', 'src', 'devices', 'stretch.mjs')),
    import(path.join(__dirname, '..', 'web-engine', 'src', 'devices', 'mutable.mjs')),
  ]);
  const web = new Map();
  for (const mod of lists) {
    for (const key of Object.keys(mod)) {
      if (!key.endsWith('_DEVICES')) continue;
      for (const d of mod[key]) web.set(d.id, d);
    }
  }

  const args = [0, 0.25, 0.5, 0.75, 1, 1.5, -1, 2, 14, '14', 'Chord', 'chord', 'nope', '', true];
  let compared = 0;
  for (const device of nativeDevices()) {
    const theirs = web.get(device.id);
    assert.ok(theirs, `${device.id} is in the desktop catalog but not in the browser's`);
    assert.strictEqual(device.params.length, theirs.params.length, `${device.id} has a different control count`);
    for (const p of theirs.params) {
      for (const arg of args) {
        const value = argToValue(p, arg);
        const want = value === null ? null : normalize(p, value);
        const got = paramPosition(device, p.id, arg);
        const same = want === null ? got === null : got !== null && Math.abs(got - want) < 1e-9;
        assert.ok(same, `${device.id}.${p.id} given ${JSON.stringify(arg)}: desktop ${got}, browser ${want}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 1000, `expected a real grid of comparisons, made ${compared}`);
});

test('no catalog at all means every name is a plugin name, as it was before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-nodevices-'));
  forgetNativeDevices();
  try {
    assert.deepStrictEqual(nativeDevices({ catalogPath: path.join(dir, 'missing.json') }), []);
    assert.strictEqual(nativeDevice('Plaits', { catalogPath: path.join(dir, 'missing.json') }), null);
  } finally {
    forgetNativeDevices();
  }
  assert.ok(deviceParam(nativeDevice('Plaits'), 'engine'), 'the real catalog is readable again');
  assert.ok(deviceParamArgs(nativeDevice('Plaits')).length > 0);
});
