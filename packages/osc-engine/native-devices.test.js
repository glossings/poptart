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
  nativeDevice, nativeDevices, deviceParam, deviceParamArgs, deviceParamRows, deviceRows,
  devicePositions, paramPosition, forgetNativeDevices,
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
  const { DEVICES } = await import(path.join(__dirname, '..', 'web-engine', 'src', 'catalog.mjs'));
  const web = new Map(DEVICES.map((d) => [d.id, d]));

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

// ---------------------------------------------------------------------------------------------
// What the editor is offered: the plugin browser's rows, and the control lists `.param("`
// completes against. Shaped like the browser build's (web-app/public/web/host.mjs) so a row and
// a completion read the same on either engine.
// ---------------------------------------------------------------------------------------------

test('every device is offered as a browser row, instruments marked', () => {
  const rows = deviceRows();
  assert.strictEqual(rows.length, nativeDevices().length);
  for (const row of rows) {
    assert.strictEqual(row.format, 'built in');
    assert.strictEqual(typeof row.name, 'string');
    assert.strictEqual(typeof row.isInstrument, 'boolean');
  }
  const plaits = rows.find((r) => r.name === 'Plaits');
  const galactic = rows.find((r) => r.name === 'Galactic');
  assert.ok(plaits?.isInstrument, 'Plaits is an instrument');
  assert.strictEqual(galactic?.isInstrument, false, 'Galactic is an effect');
  // The name a row carries is a name a pattern can use, which is the only reason the row is there.
  for (const row of rows) assert.ok(nativeDevice(row.name), `${row.name} resolves back to a device`);
});

test('a device answers its own control list, by index', () => {
  const rows = deviceParamRows(nativeDevice('Plaits'));
  const device = nativeDevice('Plaits');
  assert.strictEqual(rows.length, device.params.length);
  rows.forEach((row, i) => {
    assert.strictEqual(row.index, i, 'the index is the position in the list');
    assert.strictEqual(row.id, device.params[i].id);
    assert.strictEqual(row.name, device.params[i].name);
  });
  const engineRow = rows.find((r) => r.id === 'engine');
  assert.ok(Array.isArray(engineRow.options) && engineRow.options.length > 1, 'an enum carries its labels');
  assert.strictEqual(deviceParamRows(null).length, 0, 'a name that is no device has no controls');
});

test('a unit is the label a params panel prints', () => {
  const rows = deviceParamRows(nativeDevice('Shift'));
  assert.strictEqual(rows.find((r) => r.id === 'pitch').label, 'st', "Shift's pitch is in semitones");
  for (const row of rows) assert.strictEqual(typeof row.label, 'string', 'never undefined - it is printed');
});

// ---------------------------------------------------------------------------------------------
// Where a device's controls are.
//
// Nothing reads a UGen's controls back: the engine hands scsynth a position and scsynth has no
// way of saying what it did with it. So the half that sends them remembers them, and that record
// is what a device window is drawn from (web-app's device window) - which makes it the only
// answer to "what is this device set to", and worth testing like one.
// ---------------------------------------------------------------------------------------------

test('a control rests where its descriptor says, as a position', () => {
  const positions = devicePositions(nativeDevice('Filter'));
  const cutoff = deviceParam(nativeDevice('Filter'), 'cutoff');
  assert.strictEqual(Object.keys(positions).length, nativeDevice('Filter').params.length);
  // An exponential sweep's default is not where a reader would guess, which is the whole reason
  // a position is computed rather than assumed.
  const want = Math.log(cutoff.default / cutoff.min) / Math.log(cutoff.max / cutoff.min);
  assert.ok(Math.abs(positions.cutoff - want) < 1e-9, `${positions.cutoff} should be ${want}`);
  for (const p of Object.values(positions)) assert.ok(p >= 0 && p <= 1, 'every control is in range');
  assert.deepStrictEqual(devicePositions(null), {}, 'no device, no controls');
});

test('a filled slot says what is in it and where its controls are', () => {
  const { e } = engine();
  e.loadInstrument('lead', 'Wavetable');
  const at = e.deviceSlot('lead', 0);
  assert.strictEqual(at.id, 'Wavetable');
  assert.strictEqual(at.kind, 'synth');
  assert.deepStrictEqual(at.positions, devicePositions(nativeDevice('Wavetable')));
  assert.deepStrictEqual(at.driven, {}, 'nothing is driving anything yet');
  // A plugin has its own window and its own way of being asked; an empty slot has nothing.
  e.loadInstrument('other', 'Serum 2');
  assert.strictEqual(e.deviceSlot('other', 0), null);
  assert.strictEqual(e.deviceSlot('lead', 3), null);
});

test('a control set by a pattern is where the window finds it', () => {
  const { e } = engine();
  e.loadEffect('drums', 'Filter', 1);
  e.setParam('drums', 1, 'cutoff', 0.25);
  // By display name as well as by id: `.param()` takes either, and the window is drawn by id.
  e.setParam('drums', 1, 'Resonance', 0.75);
  const at = e.deviceSlot('drums', 1);
  assert.strictEqual(at.positions.cutoff, 0.25);
  assert.strictEqual(at.positions.resonance, 0.75);
  // An enum takes a label, and what is remembered is the position that label meant.
  e.setParam('drums', 1, 'mode', 'highpass');
  assert.strictEqual(at.id, 'Filter');
  assert.strictEqual(e.deviceSlot('drums', 1).positions.mode,
    paramPosition(nativeDevice('Filter'), 'mode', 'highpass'));
});

test('an evaluation reloading the same device leaves its controls alone', () => {
  // Every evaluation reloads every chain. Resetting to the defaults here would undo the
  // `.param()` calls of the very evaluation doing the reloading.
  const { e } = engine();
  e.loadEffect('drums', 'Filter', 1);
  e.setParam('drums', 1, 'cutoff', 0.25);
  e.loadEffect('drums', 'Filter', 1);
  assert.strictEqual(e.deviceSlot('drums', 1).positions.cutoff, 0.25);
  // A DIFFERENT device in the slot is a different set of controls, at their own defaults.
  e.loadEffect('drums', 'Crush', 1);
  assert.strictEqual(e.deviceSlot('drums', 1).id, 'Crush');
  assert.deepStrictEqual(e.deviceSlot('drums', 1).positions, devicePositions(nativeDevice('Crush')));
});

test('an emptied slot, and a destroyed track, remember nothing', () => {
  const { e } = engine();
  e.loadEffect('drums', 'Filter', 1);
  e.unloadEffect('drums', 1);
  assert.strictEqual(e.deviceSlot('drums', 1), null);
  e.loadInstrument('lead', 'Wavetable');
  e.destroyTrack('lead');
  assert.strictEqual(e.deviceSlot('lead', 0), null);
});

test('a control something else is driving says so, and says what', () => {
  // A window draws a driven control as one it does not own - turning it would only be overwritten
  // on the next block, and whoever is looking wants to know what is moving it.
  const { e } = engine();
  e.loadEffect('drums', 'Filter', 1);
  e.setParamLFO('drums', 1, 'cutoff', { shape: 'sine', rateHz: 1, phaseCycles: 0, min: 0, max: 1 });
  e.holdParam('drums', 1, 'Resonance');
  assert.deepStrictEqual(e.deviceSlot('drums', 1).driven, { cutoff: 'lfo', resonance: 'pattern' });
  e.clearParamLFO('drums', 1, 'cutoff');
  e.releaseParam('drums', 1, 'resonance');
  assert.deepStrictEqual(e.deviceSlot('drums', 1).driven, {}, 'a modulator that stops is not still there');
  // A control that is not the device's, and a slot that holds a plugin, are not errors.
  e.setParamLFO('drums', 1, 'nonesuch', { shape: 'sine', rateHz: 1, phaseCycles: 0, min: 0, max: 1 });
  e.setParamLFO('nowhere', 0, 'cutoff', { shape: 'sine', rateHz: 1, phaseCycles: 0, min: 0, max: 1 });
  assert.deepStrictEqual(e.deviceSlot('drums', 1).driven, {});
});

// ---------------------------------------------------------------------------------------------
// A file on a device's control: `.param("sample", "break:2")`.
//
// Two devices play one - the granulator its sample, the convolver its impulse response - and
// what makes this more than a parameter is that the file has to be FOUND, read and handed over
// before the control can point at it. The slot it lands in is the browser's own rule, because an
// index is what a saved song holds: `.param("sample", 1)` has to mean the same file on both
// engines (see _loadDeviceSample, and web-audio-engine.mjs's _spareOption).
// ---------------------------------------------------------------------------------------------

/** An engine with one pack already loaded, as sclang's buffers would have it. */
function withPack(files = ['one.wav', 'two.wav', 'three.wav']) {
  const { e, sent } = engine();
  e._packs.set('break', {
    status: 'ready',
    stable: true,
    files: files.map((f) => ({ path: `/samples/break/${f}`, duration: 1, channels: 2 })),
  });
  return { e, sent };
}

const sampleSends = (sent) => sent.filter((m) => m.addr === '/poptart/deviceSample').map((m) => m.args);
const paramSends = (sent) => sent.filter((m) => m.addr === '/poptart/setParam').map((m) => m.args);

test('a named file is loaded onto the control and the control is pointed at it', () => {
  const { e, sent } = withPack();
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'break:1');
  const device = nativeDevice('Granular');
  const control = deviceParam(device, 'sample');
  const paramIndex = device.params.findIndex((p) => p.id === 'sample');
  // The slot it lands in is the first past the options the descriptor ships with.
  const slot = control.options.length;
  assert.deepStrictEqual(sampleSends(sent), [['cloud', 0, paramIndex, slot, 'break', 1]]);
  // And the control now carries that slot as its value, so the next poll is a lookup.
  const [, , , position] = paramSends(sent).at(-1);
  assert.strictEqual(position, paramPosition(device, 'sample', slot));
  assert.strictEqual(e.deviceSlot('cloud', 0).positions.sample, position);
  assert.deepStrictEqual(e.deviceSlot('cloud', 0).files, { sample: { [slot]: 'break:1' } });
});

test('the same file named again is a lookup, not a second load', () => {
  const { e, sent } = withPack();
  e.loadInstrument('cloud', 'Granular');
  for (let i = 0; i < 5; i++) e.setParam('cloud', 0, 'sample', 'break:1');
  assert.strictEqual(sampleSends(sent).length, 1, 'read once, however often the pattern says it');
  assert.strictEqual(paramSends(sent).length, 5, 'and pointed at it every time, as a poll does');
});

test('two files take two slots, and an index then means the same file it means in the browser', () => {
  const { e, sent } = withPack();
  e.loadEffect('verb', 'Convolver', 2);
  const control = deviceParam(nativeDevice('Convolver'), 'ir');
  const first = control.options.length;
  e.setParam('verb', 2, 'ir', 'break:0');
  e.setParam('verb', 2, 'ir', 'break:2');
  assert.deepStrictEqual(sampleSends(sent).map((a) => [a[3], a[5]]), [[first, 0], [first + 1, 2]]);
  assert.deepStrictEqual(e.deviceSlot('verb', 2).files.ir, { [first]: 'break:0', [first + 1]: 'break:2' });
});

test('a file is named by its name as well as by its number', () => {
  const { e, sent } = withPack();
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'break:two.wav');
  e.setParam('cloud', 0, 'sample', 'break:three');
  assert.deepStrictEqual(sampleSends(sent).map((a) => a[5]), [1, 2], 'with the extension or without');
});

test('a pack still loading is waited for rather than dropped', () => {
  const { e, sent } = engine();
  e.loadInstrument('cloud', 'Granular');
  // What _ensurePack leaves behind while sclang is reading the files.
  const entry = { status: 'loading', files: [], stable: true, triedAt: Date.now() };
  e._packs.set('break', entry);
  e.setParam('cloud', 0, 'sample', 'break:0');
  assert.deepStrictEqual(sampleSends(sent), [], 'nothing to load from yet');
  assert.strictEqual(entry.waiting.length, 1, 'but it is remembered');
  // A `.param()` is a setting rather than a stream of notes: dropping it would leave the device
  // silent until somebody touched that line again.
  entry.status = 'ready';
  entry.files = [{ path: '/samples/break/one.wav', duration: 1, channels: 2 }];
  entry.waiting[0]();
  assert.deepStrictEqual(sampleSends(sent).map((a) => a[5]), [0]);
});

test('a name that is no sample at all loads nothing and leaves the control where it was', () => {
  const { e, sent } = withPack();
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'nonsense');          // no pack and no file in it
  e.setParam('cloud', 0, 'sample', 'nosuchpack:1');      // a pack that is not there
  e.setParam('cloud', 0, 'sample', 'break:nosuchfile');  // a file that is not in it
  assert.deepStrictEqual(sampleSends(sent), []);
  assert.strictEqual(paramSends(sent).length, 0);
});

test('an index past the end of a pack wraps, the way every other index on this engine does', () => {
  // `s("break:7")` on a pack of three plays the second file (see playSample's wrap), and a
  // control that names a file reads the name the same way the sampler does.
  const { e, sent } = withPack();
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'break:7');
  assert.deepStrictEqual(sampleSends(sent).map((a) => a[5]), [1]);
});

test('a different device in the slot forgets what was loaded on the last one', () => {
  // Control 3 of one device is not control 3 of another, so the UGen drops a device's files when
  // it is replaced (PoptartDevice.cpp's install) - and this half has to agree, or a control
  // would be pointed at a slot holding nothing.
  const { e, sent } = withPack();
  e.loadEffect('verb', 'Convolver', 1);
  e.setParam('verb', 1, 'ir', 'break:0');
  e.loadEffect('verb', 'Reverb', 1);
  e.loadEffect('verb', 'Convolver', 1);
  e.setParam('verb', 1, 'ir', 'break:0');
  assert.strictEqual(sampleSends(sent).length, 2, 'the file is read in again for the new device');
  // Reloading the SAME device does not: an evaluation reopens every chain, and re-reading every
  // sample on every evaluation is work nobody asked for.
  e.loadEffect('verb', 'Convolver', 1);
  e.setParam('verb', 1, 'ir', 'break:0');
  assert.strictEqual(sampleSends(sent).length, 2);
});
