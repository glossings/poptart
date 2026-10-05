'use strict';

// Double-clicking `synth("Wavetable")` has to open something.
//
// A plugin brings its own editor window and the server only asks for it to be opened. One of
// poptart's own devices has none - a scsynth UGen has no GUI - so the window is GENERATED from
// the device's descriptor by web-engine's panel.mjs, which is the same module (not a copy of it)
// that generates the window in the browser build, drawn by the same editor code.
//
// Two halves are checked here. The first is real: every device the UGen ships is built into a
// panel, from the positions the engine starts it at, so a device that cannot be drawn fails here
// rather than on a double-click. The second is source-shape, because the routes are handlers on
// a live engine (see device-browser.test.js for the same shape).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  nativeDevices, nativeDevice, devicePositions,
} = require('@poptart/osc-engine/native-devices');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const WEB_ENGINE_SRC = path.join(__dirname, '..', 'web-engine', 'src');

/** The body of one route handler, from its key to the next route key. */
function route(key) {
  const at = SRC.indexOf(`'${key}'`);
  assert.ok(at > 0, `${key} is not a route in server.js - this test needs updating`);
  const next = SRC.indexOf("\n  '", at + key.length);
  return SRC.slice(at, next > at ? next : at + 2000);
}

/** The panel generator, loaded exactly as server.js loads it. */
async function kit() {
  const load = (file) => import(pathToFileURL(path.join(WEB_ENGINE_SRC, file)).href);
  const [panel, figures, descriptor, catalog, tables] = await Promise.all([
    load('panel.mjs'), load('figures.mjs'), load('descriptor.mjs'), load('catalog.mjs'), load('dsp/tables.mjs'),
  ]);
  return { panel, figures, descriptor, catalog, tables };
}

// ---------------------------------------------------------------------------------------------
// The window itself
// ---------------------------------------------------------------------------------------------

test('every device the engine can host has a window that can be drawn', async () => {
  const { panel, descriptor, catalog, tables } = await kit();
  const opts = { tables: tables.sharedBuiltInTables(), sampleRate: 48000 };
  const devices = nativeDevices();
  assert.ok(devices.length > 20, `expected the whole catalog, got ${devices.length}`);
  for (const device of devices) {
    const spec = catalog.DEVICES.find((d) => d.id === device.id);
    assert.ok(spec, `${device.id} is in the extension but has no descriptor to draw a window from`);
    // Built from where the engine puts the controls when the slot is filled, which is what a
    // window opened before any `.param()` has run is drawn from.
    const values = {};
    for (const [id, position] of Object.entries(devicePositions(device))) {
      const found = descriptor.findParam(spec, id);
      if (found) values[id] = descriptor.denormalize(found, position);
    }
    const built = panel.buildPanel(spec, values, new Map(), opts);
    const widgets = built.sections.reduce((n, s) => n + s.widgets.length, 0);
    const figures = built.sections.reduce((n, s) => n + (s.figures?.length ?? 0), 0) + (built.figures?.length ?? 0);
    assert.ok(built.title, `${device.id}: a window needs a name`);
    assert.ok(widgets + figures > 0, `${device.id}: a window with nothing on it`);
  }
});

test('a control on the desktop is the same control in the window', async () => {
  // The window is generated from the browser's descriptor and the sound is played by the
  // extension's own catalog, and the two are generated from one source
  // (web-engine/build/devices/native.mjs). If they ever disagree about a control's range or its
  // curve, every knob in that device's window is pointed somewhere other than where it reads.
  const { catalog, descriptor } = await kit();
  let checked = 0;
  for (const device of nativeDevices()) {
    const spec = catalog.DEVICES.find((d) => d.id === device.id);
    for (const p of device.params) {
      const found = descriptor.findParam(spec, p.id);
      assert.ok(found, `${device.id} plays a control called "${p.id}" that its descriptor does not have`);
      assert.equal(found.min, p.min, `${device.id}.${p.id}: min`);
      assert.equal(found.max, p.max, `${device.id}.${p.id}: max`);
      assert.equal(found.curve, p.curve, `${device.id}.${p.id}: curve`);
      assert.equal(found.name, p.name, `${device.id}.${p.id}: name`);
      // The position a knob opens at, and the position the UGen holds the control at, are the
      // same number computed by two codebases - the one place a rounding difference would show.
      const mine = devicePositions(device)[p.id];
      assert.ok(Math.abs(mine - descriptor.normalize(found, found.default)) < 1e-6,
        `${device.id}.${p.id}: the default rests in two different places`);
      checked += 1;
    }
  }
  assert.ok(checked > 400, `expected the whole catalog's controls, compared ${checked}`);
});

test("an enum's labels reach the window, so a choice reads as a word", async () => {
  const { panel, descriptor, catalog, tables } = await kit();
  const device = nativeDevice('Filter');
  const spec = catalog.DEVICES.find((d) => d.id === 'Filter');
  const values = {};
  for (const [id, position] of Object.entries(devicePositions(device))) {
    const found = descriptor.findParam(spec, id);
    if (found) values[id] = descriptor.denormalize(found, position);
  }
  const built = panel.buildPanel(spec, values, new Map(), { tables: tables.sharedBuiltInTables(), sampleRate: 48000 });
  const widgets = built.sections.flatMap((s) => s.widgets);
  const mode = widgets.find((w) => w.id === 'mode');
  assert.ok(mode, "the filter's mode is on its window");
  assert.equal(mode.widget, 'enum');
  assert.ok(mode.options.length > 1, 'and it is a list of named modes');
  assert.equal(typeof mode.text, 'string');
});

// ---------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------

test('showEditor answers with a panel for a device and opens a window for a plugin', () => {
  const body = route('POST /api/showEditor');
  assert.match(body, /deviceInSlot\(trackId, slot\)/, 'what is in the slot decides which answer');
  const panel = body.indexOf('panel: deviceWindow(device)');
  const plugin = body.indexOf('engine.showPluginEditor');
  assert.ok(panel > 0, 'a device is answered with the panel to draw');
  assert.ok(plugin > panel, 'and the plugin path is only reached when there was no device');
  assert.match(body, /takeSlotByHand\(trackId, slot\)/, 'either way the slot is held while the window is up');
});

test('the window is generated by web-engine, not by a second copy of the idea', () => {
  assert.match(SRC, /WEB_ENGINE_SRC = path\.join\(__dirname, '\.\.', 'web-engine', 'src'\)/);
  for (const file of ['panel.mjs', 'figures.mjs', 'descriptor.mjs', 'catalog.mjs', 'dsp/tables.mjs']) {
    assert.ok(SRC.includes(`load('${file}')`), `${file} is what the window is built with`);
  }
  // Loaded on demand: a session that never opens a device window should not pay to parse the
  // figure maths for every device poptart ships.
  assert.match(SRC, /function deviceKit\(\) \{\n  if \(!devicePanelKit\)/);
});

test('a control moved in the window lands on the engine as a position', () => {
  const setter = SRC.slice(SRC.indexOf('async function setDeviceParam('), SRC.indexOf('// ---', SRC.indexOf('async function setDeviceParam(')));
  assert.match(setter, /valueFromPosition\(descriptor, found\.id, body\.position\)/, 'a gesture sends a position');
  assert.match(setter, /found\.options\s*\n?\s*\? Math\.round\(value\)/, 'and a choice is sent as its index');
  assert.match(setter, /mappedEngine\?\.setParam\(engineTrack\(trackLabel\), slot, found\.id/);
  assert.match(setter, /figuresFor\(descriptor, found\.id/, 'the pictures the control is in come back with it');
});

test('a finished gesture is written the way a plugin gesture is', () => {
  const note = SRC.slice(SRC.indexOf('function noteDeviceEdit('), SRC.indexOf('/** The window closed'));
  assert.match(note, /conf && conf\.trackId === trackLabel/, 'conf armed: the gesture is written as .param()');
  assert.match(note, /conf\.touched\.set/);
  assert.match(note, /handlePluginEdited\(trackLabel, slot\)/, 'otherwise the whole device is captured, as a plugin is');
});

test('closing the window reads the sound out before handing the slot back', () => {
  const body = route('POST /api/deviceWatch');
  assert.match(body, /releaseDeviceSlot\(trackId, slot\)/);
  const release = SRC.slice(SRC.indexOf('function releaseDeviceSlot('), SRC.indexOf('/**', SRC.indexOf('function releaseDeviceSlot(')));
  const capture = release.indexOf('captureOpenEditors([key])');
  const hold = release.indexOf('syncStateHold(key)');
  assert.ok(capture > 0 && hold > capture, 'the capture is queued before the hold is lifted');
});

test('the live poll answers with nothing rather than with a guess', () => {
  // scsynth has no way to read a UGen's controls back - a modulator is a bus mapped onto an
  // input, read by nobody - so a driven knob is drawn where the modulator was pointed. The
  // editor treats a null as "not following" (startDeviceLive in client.js).
  const body = route('POST /api/deviceLive');
  assert.match(body, /values: null, figures: \[\]/);
});
