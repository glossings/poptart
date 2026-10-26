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
  devicePositions, paramPosition, forgetNativeDevices, deviceStateText, readDeviceState, readDeviceLive,
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
  // The controls ride along as id, name and default position - what sclang needs to resolve
  // `.param()` by name, and where its record of each control starts.
  const triples = device.args.slice(3);
  const plaits = nativeDevice('Plaits');
  assert.strictEqual(triples.length, plaits.params.length * 3);
  assert.deepStrictEqual(triples.slice(0, 6), [
    'engine', 'Engine', devicePositions(plaits).engine,
    'harmonics', 'Harmonics', devicePositions(plaits).harmonics,
  ]);
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
  // The last is the frame length a wavetable file declares: none, for a control that plays audio.
  assert.deepStrictEqual(sampleSends(sent), [['cloud', 0, paramIndex, slot, 'break', 1, 0]]);
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

// --- presets: one format on both engines ---------------------------------------------------------

const decodeText = (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));

test('a device preset is the browser\'s format: real units by control id, the version and the files', async () => {
  // Checked against the browser's own descriptors and defaults, which is what its getPluginState
  // writes ({ device, version, params: { ...values }, files }) for a device nobody has touched.
  const { defaultValues } = await import(DESCRIPTOR);
  const { DEVICES } = await import(path.join(__dirname, '..', 'web-engine', 'src', 'catalog.mjs'));
  const web = new Map(DEVICES.map((d) => [d.id, d]));
  for (const device of nativeDevices()) {
    const theirs = web.get(device.id);
    const doc = decodeText(deviceStateText(device, devicePositions(device)));
    assert.deepStrictEqual(Object.keys(doc), ['device', 'version', 'params', 'files']);
    assert.strictEqual(doc.device, theirs.id);
    assert.strictEqual(doc.version, theirs.version, `${device.id}: version`);
    assert.deepStrictEqual(Object.keys(doc.params), Object.keys(defaultValues(theirs)), `${device.id}: control ids`);
    for (const [id, want] of Object.entries(defaultValues(theirs))) {
      assert.ok(Math.abs(doc.params[id] - want) < 1e-5, `${device.id}.${id}: ${doc.params[id]}, browser default ${want}`);
    }
    assert.deepStrictEqual(doc.files, {});
  }
});

test('a control nobody touched is captured at its default, not at the bottom of its range', () => {
  // Shift's pitch rests at 0 semitones, which is position 0.5. A record that started every control
  // at 0 wrote -24 semitones into every capture, and the preset then played two octaves down.
  const { e } = engine();
  e.loadEffect('t', 'Shift', 1);
  return e.getPluginState('t', 1).then((text) => {
    assert.deepStrictEqual(decodeText(text).params, { pitch: 0, formant: 0, tonality: 8000 });
  });
});

test('a device is captured from where its controls are, without asking sclang', async () => {
  const { e, sent } = engine();
  e.loadEffect('t', 'Shift', 1);
  e.setParam('t', 1, 'Pitch', 0.75);
  const doc = decodeText(await e.getPluginState('t', 1));
  assert.strictEqual(doc.params.pitch, 12);
  assert.ok(!sent.some((m) => m.addr === '/poptart/getPluginState'), 'a device capture never goes to sclang');
});

test('a preset reads back to the positions it was written from, on every device', () => {
  for (const device of nativeDevices()) {
    const positions = {};
    device.params.forEach((p, i) => { positions[p.id] = paramPosition(device, p.id, ((i * 37) % 100) / 100); });
    const back = readDeviceState(device, decodeText(deviceStateText(device, positions)));
    for (const p of device.params) {
      // Every position here is one paramPosition produced, so a stepped control is already on
      // its step and comes back where it went in.
      const want = positions[p.id];
      assert.ok(Math.abs(back.positions[p.id] - want) < 1e-5, `${device.id}.${p.id}: ${back.positions[p.id]} vs ${want}`);
    }
  }
});

test('a state names controls by id or by name, and another device\'s state is not read', () => {
  const shift = nativeDevice('Shift');
  assert.deepStrictEqual(readDeviceState(shift, { device: 'Shift', params: { Pitch: 12, nope: 1 } }).positions, { pitch: 0.75 });
  assert.strictEqual(readDeviceState(shift, { device: 'Plaits', params: { pitch: 0 } }), null);
  assert.strictEqual(readDeviceState(shift, null), null);
  assert.strictEqual(readDeviceState(shift, { device: 'Shift' }), null);
});

/** The program a restore handed sclang, read out of the file it wrote. */
function restoredProgram(sent) {
  const msg = sent.filter((m) => m.addr === '/poptart/setPluginState').at(-1);
  assert.ok(msg, 'a program went to sclang');
  const program = JSON.parse(fs.readFileSync(msg.args[2], 'utf8'));
  fs.unlinkSync(msg.args[2]);
  return program;
}

test('a preset made in the browser restores onto the desktop device as positions', async () => {
  const { e, sent } = engine();
  e.loadEffect('t', 'Shift', 1);
  // Exactly what the browser writes: base64 of plain JSON, real units, by id.
  const browser = Buffer.from(JSON.stringify({ device: 'Shift', version: 1, params: { pitch: 12, formant: -6, tonality: 0 }, files: {} })).toString('base64');
  e.setStateResolver(async (id) => (id === 'abc' ? browser : null));
  e.setPluginState('t', 1, '@abc');
  await e._stateIdle();
  assert.deepStrictEqual(restoredProgram(sent), { device: 'Shift', params: { pitch: 0.75, formant: 0.25, tonality: 0 } });
  // The record follows, so the window and the next capture start from the preset.
  assert.deepStrictEqual(e.deviceSlot('t', 1).positions, { pitch: 0.75, formant: 0.25, tonality: 0 });
  assert.deepStrictEqual(decodeText(await e.getPluginState('t', 1)).params, { pitch: 12, formant: -6, tonality: 0 });
});

test('a gzipped state and JSON typed out by hand are read too', async () => {
  const zlib = require('node:zlib');
  const { e, sent } = engine();
  e.loadEffect('t', 'Shift', 1);
  e.setPluginState('t', 1, zlib.gzipSync(JSON.stringify({ device: 'Shift', params: { pitch: -24 } })).toString('base64'));
  await e._stateIdle();
  assert.deepStrictEqual(restoredProgram(sent).params, { pitch: 0 });
  e.setPluginState('t', 1, '{ "device": "Shift", "params": { "Pitch": 24 } }');
  await e._stateIdle();
  assert.deepStrictEqual(restoredProgram(sent).params, { pitch: 1 });
});

test('a state that is not this device\'s warns and changes nothing', async () => {
  const { e, sent, warned } = engine();
  e.loadEffect('t', 'Shift', 1);
  e.setPluginState('t', 1, Buffer.from(JSON.stringify({ device: 'Plaits', params: { engine: 3 } })).toString('base64'));
  await e._stateIdle();
  assert.ok(!sent.some((m) => m.addr === '/poptart/setPluginState'));
  assert.ok(warned.some((w) => /not a Shift state/.test(w)), warned.join('\n'));
  assert.strictEqual(e.deviceSlot('t', 1).positions.pitch, 0.5);
});

test('a preset carries the files on its controls, and restoring one loads them', async () => {
  const { e, sent } = withPack();
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'break:1');
  const text = await e.getPluginState('cloud', 0);
  assert.deepStrictEqual(decodeText(text).files, { sample: 'break:1' });

  const fresh = withPack();
  fresh.e.loadInstrument('cloud', 'Granular');
  fresh.e.setPluginState('cloud', 0, text);
  await fresh.e._stateIdle();
  restoredProgram(fresh.sent);
  assert.deepStrictEqual(sampleSends(fresh.sent).map((a) => a.slice(4, 6)), [['break', 1]]);
  assert.deepStrictEqual(fresh.e.deviceSlot('cloud', 0).files.sample, { [deviceParam(nativeDevice('Granular'), 'sample').options.length]: 'break:1' });
});

// --- latency: what the scheduler plays a track's notes early by --------------------------------

test('a device\'s delay is the one the browser declares, and a slot reports it', async () => {
  const { DEVICES } = await import(path.join(__dirname, '..', 'web-engine', 'src', 'catalog.mjs'));
  const web = new Map(DEVICES.map((d) => [d.id, d]));
  for (const device of nativeDevices()) {
    assert.strictEqual(device.latencySec ?? 0, web.get(device.id).latencySec ?? 0, `${device.id}: desktop and browser disagree on its delay`);
  }
  assert.strictEqual(nativeDevice('Shift').latencySec, 0.12);

  const { e } = engine();
  e.loadInstrument('t', 'Plaits');
  e.loadEffect('t', 'Shift', 1);
  e.loadEffect('t', 'ValhallaDelay', 2); // a plugin: taken to be on time
  e.loadEffect('t', 'Filter', 3);
  assert.deepStrictEqual(e.slotLatencies('t'), [0, 0.12, 0, 0]);
  assert.deepStrictEqual(e.slotLatencies('nobody'), []);
});

// --- what else a device is handed: a wavetable's frame length, a drawn curve -------------------

test('a table file sends the frame length its header declares, read from the file itself', () => {
  const { encodeWav } = require('./wav.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wt-'));
  const file = path.join(dir, 'table.wav');
  const wav = encodeWav({ sampleRate: 48000, channels: 1, data: new Float32Array(512) });
  const text = Buffer.from('<!>256 10000000 wavetable', 'latin1');
  const head = Buffer.alloc(8);
  head.write('clm ', 0, 'latin1');
  head.writeUInt32LE(text.length, 4);
  const out = Buffer.concat([wav.subarray(0, 12), head, text, Buffer.alloc(text.length & 1), wav.subarray(12)]);
  out.writeUInt32LE(out.length - 8, 4);
  fs.writeFileSync(file, out);
  const { e, sent } = engine();
  e._packs.set('wt', { status: 'ready', stable: true, files: [{ path: file, duration: 0.01, channels: 1 }] });
  e.loadInstrument('lead', 'Wavetable');
  e.setParam('lead', 0, 'osc1.table', 'wt:0');
  const [one] = sampleSends(sent);
  assert.strictEqual(one.at(-1), 256, 'the declared frame length rides on the message');
  // A file that declares none says 0, which the device reads as the usual 2048.
  e.setParam('lead', 0, 'osc2.table', 'wt:0');
  fs.writeFileSync(file, wav);
  e.setParam('lead', 0, 'osc1.table', 'wt:missing');
  const { e: e2, sent: sent2 } = engine();
  e2._packs.set('wt', { status: 'ready', stable: true, files: [{ path: file, duration: 0.01, channels: 1 }] });
  e2.loadInstrument('lead', 'Wavetable');
  e2.setParam('lead', 0, 'osc1.table', 'wt:0');
  assert.strictEqual(sampleSends(sent2)[0].at(-1), 0);
});

/** An engine that can read drawn curves, with pattern-core's own shape functions. */
async function withShapes() {
  const core = await import('@poptart/pattern-core');
  const made = engine();
  const defined = new Map();
  made.e.shapeReader = {
    looksLikeShapeData: core.looksLikeShapeData,
    parseShapePoints: core.parseShapePoints,
    sampleShape: core.sampleShape,
    lookupShape: (name) => defined.get(name) ?? null,
  };
  return { ...made, core, defined };
}

const shapeSends = (sent) => sent.filter((m) => m.addr === '/poptart/deviceShape').map((m) => m.args);

test('a drawn curve is sampled as the browser samples it, sent as its points, and pointed at', async () => {
  const { e, sent, core } = await withShapes();
  e.loadEffect('t', 'Distort', 1);
  e.setParam('t', 1, 'mode', '0,0 0.5,1 1,0');
  const device = nativeDevice('Distort');
  const slot = deviceParam(device, 'mode').options.length;
  const [one] = shapeSends(sent);
  assert.deepStrictEqual(one.slice(0, 4), ['t', 1, device.params.findIndex((p) => p.id === 'mode'), slot]);
  const points = one.slice(4);
  assert.strictEqual(points.length, 256, "the browser engine's SHAPE_POINTS");
  const parsed = core.parseShapePoints('0,0 0.5,1 1,0');
  points.forEach((v, i) => assert.strictEqual(v, core.sampleShape(parsed, i / 255)));
  // The table first and the control second, so the device never plays the empty slot.
  const shapeAt = sent.findIndex((m) => m.addr === '/poptart/deviceShape');
  const setAt = sent.findIndex((m, i) => i > shapeAt && m.addr === '/poptart/setParam');
  assert.ok(setAt > shapeAt);
  assert.strictEqual(sent[setAt].args[3], paramPosition(device, 'mode', slot));
  // A named option is still an option, not a curve.
  e.setParam('t', 1, 'mode', 'fold');
  assert.strictEqual(shapeSends(sent).length, 1);
});

test('a named curve keeps its slot when it is redrawn, and an evaluation resends it', async () => {
  const { e, sent, defined } = await withShapes();
  e.loadInstrument('g', 'Granular');
  defined.set('swell', [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  e.setParam('g', 0, 'window', 'swell');
  const slot = deviceParam(nativeDevice('Granular'), 'window').options.length;
  assert.strictEqual(shapeSends(sent).length, 1);
  e.setParam('g', 0, 'window', 'swell');
  assert.strictEqual(shapeSends(sent).length, 1, 'the same curve named again is a lookup');
  // Redrawn: the next evaluation sends the new points into the slot it already holds, and does
  // not move the control.
  defined.set('swell', [{ x: 0, y: 1 }, { x: 1, y: 0 }]);
  const params = paramSends(sent).length;
  e.refreshNamedShapes();
  const sends = shapeSends(sent);
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(sends[1][3], slot);
  assert.notDeepStrictEqual(sends[1].slice(4), sends[0].slice(4));
  assert.strictEqual(paramSends(sent).length, params);
  // And the window can name it and draw it.
  assert.strictEqual(e.deviceSlot('g', 0).files.window[slot], 'swell');
  assert.strictEqual(e.deviceSlot('g', 0).shapes[slot].points.length, 256);
});

test('an unknown curve warns and keeps playing, and so does a host with no shape reader', async () => {
  const { e, sent, warned } = await withShapes();
  e.loadInstrument('g', 'Granular');
  e.setParam('g', 0, 'window', 'nobody-drew-this');
  assert.strictEqual(shapeSends(sent).length, 0);
  assert.match(warned.at(-1), /no shape called "nobody-drew-this"/);
  const bare = engine();
  bare.e.loadInstrument('g', 'Granular');
  bare.e.setParam('g', 0, 'window', '0,0 1,1');
  assert.match(bare.warned.at(-1), /cannot read drawn shapes/);
});

test('a preset carries a drawn curve by name, and restoring it draws it again', async () => {
  const { e, defined } = await withShapes();
  defined.set('grit', [{ x: 0, y: 0.2 }, { x: 1, y: 0.9 }]);
  e.loadEffect('t', 'Distort', 1);
  e.setParam('t', 1, 'mode', 'grit');
  const text = await e.getPluginState('t', 1);
  assert.strictEqual(decodeText(text).files.mode, 'grit');
  const fresh = await withShapes();
  fresh.defined.set('grit', defined.get('grit'));
  fresh.e.loadEffect('t', 'Distort', 1);
  fresh.e.setPluginState('t', 1, text);
  await fresh.e._stateIdle();
  assert.strictEqual(shapeSends(fresh.sent).length, 1);
});

// --- where a device's controls actually are -----------------------------------------------------

test('a live answer is read back as positions by id and the device\'s own report', () => {
  const granular = nativeDevice('Granular');
  const n = granular.params.length;
  const positions = Array.from({ length: n }, (_, i) => i / n);
  const live = readDeviceLive(granular, [n, ...positions, 8, 0.1, 0.5, -0.2, 0.05, 0.3, 0.9, 0.4, -0.01]);
  assert.strictEqual(live.positions[granular.params[3].id], positions[3]);
  assert.deepStrictEqual(live.report, { grains: [[0.1, 0.5, -0.2, 0.05], [0.3, 0.9, 0.4, -0.01]] });
  const distort = nativeDevice('Distort');
  const m = distort.params.length;
  assert.deepStrictEqual(readDeviceLive(distort, [m, ...new Array(m).fill(0), 2, -3, 0.5]).report, { meters: { autogain: -3, level: 0.5 } });
  // A device with nothing to report, and no answer at all.
  const filter = nativeDevice('Filter');
  assert.strictEqual(readDeviceLive(filter, [filter.params.length, ...new Array(filter.params.length).fill(0.5), 0]).report, null);
  assert.strictEqual(readDeviceLive(filter, [-1]), null);
});

test('deviceLive asks sclang and resolves with the answer, or with null when none comes', async () => {
  const { e, sent } = engine();
  e._port = {};
  e.loadEffect('t', 'Filter', 1);
  const asked = e.deviceLive('t', 1);
  const ask = sent.find((m) => m.addr === '/poptart/deviceLive');
  assert.deepStrictEqual(ask.args.slice(1), ['t', 1]);
  const filter = nativeDevice('Filter');
  e._handleMessage({
    address: '/poptart/deviceLive.data',
    args: [ask.args[0], filter.params.length, ...filter.params.map(() => 0.25), 0],
  });
  const live = await asked;
  assert.strictEqual(live.positions[filter.params[0].id], 0.25);
  // Nothing in the slot: nothing asked.
  assert.strictEqual(await e.deviceLive('t', 3), null);
});

test('the two oscillators load into one bank of tables, so their files take different slots', () => {
  const { e, sent } = withPack();
  e.loadInstrument('lead', 'Wavetable');
  e.setParam('lead', 0, 'Osc 1 Table', 'break:0');
  e.setParam('lead', 0, 'Osc 2 Table', 'break:1');
  const slots = sampleSends(sent).map((args) => args[3]);
  assert.equal(slots.length, 2);
  assert.notEqual(slots[0], slots[1], 'each file has a table of its own');
  // Either oscillator can play either, so the window lists both under both.
  const { files } = e.deviceSlot('lead', 0);
  for (const id of ['osc1.table', 'osc2.table']) {
    assert.equal(files[id][slots[0]], 'break:0');
    assert.equal(files[id][slots[1]], 'break:1');
  }
});
