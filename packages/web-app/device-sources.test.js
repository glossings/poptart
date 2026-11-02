'use strict';

// A device window's picture of a file on the desktop: the outline the window draws a loaded
// sample (or a synthesized space) as, and the frames it draws a loaded table as, which the
// browser's engine keeps as `waves` and `tables` and the desktop reads from the file itself
// (device-sources.js). Both have to be the SAME picture, so each is checked against the browser
// engine's own, run here on a stand-in audio context.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { OscEngine } = require('@poptart/osc-engine');
const { encodeWav } = require('@poptart/osc-engine/wav');
const { deviceSources, withLoadedTables } = require('./device-sources');

const WEB_ENGINE = path.join(__dirname, '..', 'web-engine');
const load = (file) => import(pathToFileURL(path.join(WEB_ENGINE, file)).href);

/** The pieces of web-engine device-sources.js reads, loaded as server.js's deviceKit loads them. */
async function kit() {
  const [wavfile, outline, builtins, catalog, descriptor, figures, tables] = await Promise.all([
    load('src/dsp/wavfile.mjs'), load('src/dsp/outline.mjs'), load('src/devices/builtins.mjs'),
    load('src/catalog.mjs'), load('src/descriptor.mjs'), load('src/figures.mjs'), load('src/dsp/tables.mjs'),
  ]);
  return { wavfile, outline, builtins, catalog, descriptor, figures, tables };
}

/** A two-second stereo WAV on disk, with a shape an outline can tell apart from another. */
function writeTestWav() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-sources-'));
  const file = path.join(dir, 'loop.wav');
  const sampleRate = 44100;
  const frames = sampleRate * 2;
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const env = Math.exp(-3 * (i % 22050) / 22050);
    data[i * 2] = env * Math.sin(i * 0.031);
    data[i * 2 + 1] = 0.5 * Math.sin(i * 0.007);
  }
  fs.writeFileSync(file, encodeWav({ sampleRate, channels: 2, data }));
  return file;
}

/** The desktop engine with one pack in, as sclang's buffers would have it (no boot). */
function desktop(file) {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0;
  e._send = () => {};
  e._warnOnce = () => {};
  e._packs.set('files', { status: 'ready', stable: true, files: [{ path: file, duration: 2, channels: 2 }] });
  return e;
}

/** The browser engine with the same file in its store, as the web build reads it. */
async function browser(file) {
  const { FakeAudioContext, fakeWorkletFor } = await load('fake-context.mjs');
  const { catalog } = await load('src/catalog.mjs');
  const { WebAudioEngine } = await load('src/engine/web-audio-engine.mjs');
  const bytes = fs.readFileSync(file);
  const samples = {
    indexOf: (pack, key) => (pack === 'files' && key === 'loop' ? 0 : null),
    bytes: async (pack, index) => (pack === 'files' && index === 0 ? new Uint8Array(bytes) : null),
    get: () => null,
  };
  const ctx = new FakeAudioContext();
  // The stand-in has no convolver node; the convolver's graph needs one to hold its buffer.
  ctx.createConvolver ??= function createConvolver() { return this.createWaveShaper(); };
  return new WebAudioEngine(ctx, {
    registry: catalog, samples, routeWaitMs: 1, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog),
  });
}

/** Desktop waves and tables for a slot, as server.js's deviceInSlot builds them. */
async function desktopWaves(k, e, track, slot) {
  const at = e.deviceSlot(track, slot);
  const descriptor = k.catalog.DEVICES.find((d) => d.id === at.id);
  const values = {};
  for (const p of descriptor.params) {
    if (at.positions[p.id] !== undefined) values[p.id] = k.descriptor.denormalize(p, at.positions[p.id]);
  }
  return { at, descriptor, values, ...(await deviceSources(k, descriptor, values, at)) };
}

test('a file loaded onto the granulator is drawn from the same outline on both engines', async () => {
  const k = await kit();
  const file = writeTestWav();

  const e = desktop(file);
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'files:loop');
  const { at, descriptor, values, waves } = await desktopWaves(k, e, 'cloud', 0);
  const index = Object.keys(at.files.sample)[0];
  assert.deepEqual(at.sources, { [index]: { name: 'files:loop', path: file, table: false } });

  const web = await browser(file);
  web.createTrack('cloud');
  web.loadInstrument('cloud', 'Granular');
  web.setParam('cloud', 0, 'sample', 'files:loop', 0);
  const filled = web.tracks.get('cloud').slots.get(0);
  await filled.loading;
  assert.ok(filled.waves?.[index], 'the browser filed it under the same option slot');
  assert.deepEqual(waves[index], filled.waves[index], 'the same name, peaks and length');
  assert.ok(waves[index].peaks.length > 100 && Math.abs(waves[index].seconds - 2) < 1e-9);

  // And the window's picture of it is no longer an empty file.
  const figure = k.figures.figuresFor(descriptor, 'sample', values, { waves, extras: at.files })
    .find((f) => f.kind === 'sample');
  assert.equal(figure.name, 'files:loop');
  assert.deepEqual(figure.peaks, filled.waves[index].peaks);
});

test('a file is read once while it is the same file, and again once it changes', async () => {
  const k = await kit();
  const file = writeTestWav();
  const e = desktop(file);
  e.loadInstrument('cloud', 'Granular');
  e.setParam('cloud', 0, 'sample', 'files:loop');
  let reads = 0;
  const resolve = async (p) => { reads++; return { path: p }; };
  const at = e.deviceSlot('cloud', 0);
  const descriptor = k.catalog.DEVICES.find((d) => d.id === 'Granular');
  const first = await deviceSources(k, descriptor, {}, at, { resolve });
  await deviceSources(k, descriptor, {}, at, { resolve });
  assert.equal(reads, 1, 'a window polling its picture does not read the file each time');
  fs.writeFileSync(file, encodeWav({ sampleRate: 44100, channels: 1, data: new Float32Array(4410).fill(0.25) }));
  const second = await deviceSources(k, descriptor, {}, at, { resolve });
  assert.equal(reads, 2);
  assert.notDeepEqual(second, first);
});

test('a convolver draws its synthesized space as the browser\'s does', async () => {
  const k = await kit();
  const e = desktop(writeTestWav());
  e.loadEffect('verb', 'Convolver', 1);
  e.setParam('verb', 1, 'size', 3);
  const { descriptor, values, waves } = await desktopWaves(k, e, 'verb', 1);
  const index = Math.round(values.ir);

  const web = await browser(writeTestWav());
  web.createTrack('verb');
  web.loadEffect('verb', 'Convolver', 1);
  web.setParam('verb', 1, 'size', 3, 0);
  const built = web.tracks.get('verb').slots.get(1).built;
  assert.deepEqual(waves[index], built.outlines[index]);
  // Drawn at the size set, not the default: a hall's tail is 1.6 times it.
  const size = k.descriptor.denormalize(descriptor.params.find((p) => p.id === 'size'), e.deviceSlot('verb', 1).positions.size);
  assert.notEqual(size, descriptor.params.find((p) => p.id === 'size').default);
  assert.ok(Math.abs(waves[index].seconds - 1.6 * size) < 1e-3, `${waves[index].seconds}`);
});

test('a file loaded as the convolver\'s impulse takes the place of a space', async () => {
  const k = await kit();
  const file = writeTestWav();
  const e = desktop(file);
  e.loadEffect('verb', 'Convolver', 1);
  e.setParam('verb', 1, 'ir', 'files:loop');
  const { at, values, waves } = await desktopWaves(k, e, 'verb', 1);
  const index = Math.round(values.ir);
  assert.equal(at.files.ir[index], 'files:loop');
  assert.equal(waves[index].name, 'files:loop');
  assert.ok(Math.abs(waves[index].seconds - 2) < 1e-9);
});

test('a table loaded onto the wavetable synth is drawn from the same frames on both engines', async () => {
  const k = await kit();
  // Three frames of 2048, stereo, each a different shape.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-sources-'));
  const file = path.join(dir, 'loop.wav');
  const frames = 3 * 2048;
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const f = Math.floor(i / 2048);
    data[i * 2] = Math.sin((2 * Math.PI * (f + 1) * (i % 2048)) / 2048);
    data[i * 2 + 1] = 0.5 * ((i % 2048) / 1024 - 1);
  }
  fs.writeFileSync(file, encodeWav({ sampleRate: 44100, channels: 2, data }));

  const e = desktop(file);
  e.loadInstrument('wt', 'Wavetable');
  e.setParam('wt', 0, 'Osc 1 Table', 'files:loop');
  const { at, descriptor, values, waves, tables } = await desktopWaves(k, e, 'wt', 0);
  assert.equal(waves, null, 'a table is not drawn as a waveform');
  const index = Object.keys(at.files['osc1.table'])[0];

  const web = await browser(file);
  web.createTrack('wt');
  web.loadInstrument('wt', 'Wavetable');
  web.setParam('wt', 0, 'Osc 1 Table', 'files:loop', 0);
  const filled = web.tracks.get('wt').slots.get(0);
  await filled.loading;
  assert.ok(filled.tables?.[index], 'the browser filed it under the same option slot');
  assert.deepEqual(tables[index], filled.tables[index], 'the same name and frames');
  assert.equal(tables[index].frameCount, 3);

  // And the window's picture of it is the table rather than one still loading.
  const shipped = k.tables.sharedBuiltInTables();
  const drawn = k.figures.figuresFor(descriptor, 'osc1.table', values, { tables: withLoadedTables(shipped, tables), extras: at.files })
    .find((f) => f.kind === 'wavetable');
  assert.equal(drawn.frameCount, 3);
  assert.ok(!drawn.loading);
});

test('server.js hands the waves and the loaded tables to every figure it draws', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const opts = src.slice(src.indexOf('function deviceFigureOpts'), src.indexOf('const LIVE_DEVICE_FIGURES'));
  assert.match(opts, /waves: state\.waves/);
  assert.match(opts, /tables: withLoadedTables\(state\.kit\.tables\.sharedBuiltInTables\(\), state\.tables/);
  const slot = src.slice(src.indexOf('async function deviceInSlot'), src.indexOf('function deviceFigureOpts'));
  assert.match(slot, /await deviceSources\(/);
});

test('a file picked in the window is waited for before the window is answered', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const set = src.slice(src.indexOf('async function setDeviceParam'));
  const picked = set.slice(set.indexOf("typeof body.sample === 'string'"));
  const wait = picked.indexOf('await engine.sampleSettled?.(');
  assert.ok(wait > 0, 'the answer waits on the load');
  assert.ok(wait < picked.indexOf('await deviceInSlot('), 'before it reads the slot back');
});
