// The host's route table.
//
// The tests that earn their keep here are the two at the end. One reads the paths the EDITOR
// asks for out of client.js and checks the browser host has something to say about every one.
// The desktop learned this lesson with the engine wrapper - a method the caller used and the
// wrapper did not have, silently doing nothing - and a route table has exactly the same failure
// mode. A path with no handler is a button that does nothing, with no error anywhere near the
// button. The other reads what the editor PULLS OUT of each answer and checks it is there,
// because the first version of this table was written against its own idea of each response,
// and an answer in the wrong shape is the same button doing nothing.
//
// Every other test here asserts the shape the editor reads, never the shape the host finds
// convenient; where the two differed, the desktop server's answer is the reference.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as patternCore from '@poptart/pattern-core';
import { FakeAudioContext, fakeWorkletFor } from '../web-engine/fake-context.mjs';
import { catalog } from '../web-engine/src/catalog.mjs';
import { clampParam, findParam, formatValue, normalize } from '../web-engine/src/descriptor.mjs';
import { buildPanel, paramArgFor, valueFromPosition } from '../web-engine/src/panel.mjs';
import { figuresFor } from '../web-engine/src/figures.mjs';
import { sharedBuiltInTables } from '../web-engine/src/dsp/tables.mjs';
import { WebAudioEngine } from '../web-engine/src/engine/web-audio-engine.mjs';
import { memoryStore } from './public/web/kv.mjs';
import { createStorage } from './public/web/storage.mjs';
import { createBlobs } from './public/web/blobs.mjs';
import { createEvaluator } from './public/web/evaluate.mjs';
import { createSampleStore, registerPacks } from './public/web/samples.mjs';
import { createHost } from './public/web/host.mjs';
import { WEB_SKETCH } from './build-web.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const meta = require('./public/pattern-meta.js');
const shippedPacks = ['pt_kit', 'pt_keys'].map((id) => require(`../web-engine/public/packs/${id}/manifest.json`));

const KIT = { id: 'pt_kit', title: 'Kit', kind: 'drums', files: [{ file: 'kick.wav' }, { file: 'snare.wav' }] };
const PIANO = { id: 'pt_piano', title: 'Piano', kind: 'melodic', files: [{ file: 'c3.wav', rootNote: 60 }] };
const cdn = (id, file) => `https://cdn.invalid/${id}/${file}`;

function makeHost({ builtIn = [], library = { packs: [], problems: [], urlFor: cdn } } = {}) {
  const ctx = new FakeAudioContext();
  // The sample store is built first and handed to the engine, exactly as the page does it: a
  // device that loads a file - a wavetable, an impulse response - asks the engine, which asks
  // the store, and an engine built without one can only report that nothing is there.
  const samples = createSampleStore({ context: null, store: null, fetchImpl: null });
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    samples,
    warn: () => {},
    AudioWorkletNode: fakeWorkletFor(catalog),
    // The same reader the page hands in: a curve drawn in the shape editor and a curve played
    // by a device have to be the same curve.
    shapes: {
      looksLikeShapeData: patternCore.looksLikeShapeData,
      parseShapePoints: patternCore.parseShapePoints,
      sampleShape: patternCore.sampleShape,
    },
  });
  const transport = new patternCore.Transport(() => engine.getTime(), { cps: 0.5, paused: true });
  const evaluator = createEvaluator({ patternCore, engine, transport });
  const store = memoryStore();
  const blobs = createBlobs(store);
  const storage = createStorage(store, { meta, blobs });
  const host = createHost({
    patternCore, engine, transport, evaluator, storage, samples, catalog,
    panel: { buildPanel, valueFromPosition, paramArgFor, formatValue, clampParam, normalize, findParam, figuresFor },
    tables: sharedBuiltInTables,
    builtIn,
    builtInUrl: (id, file) => `/web-engine/packs/${id}/${file}`,
    library,
  });
  const rig = { host, engine, transport, evaluator, storage, ctx, samples };
  liveRigs.add(rig);
  return rig;
}

// A scheduler runs on a timer, so a rig left running keeps the whole test process alive: one
// failed assertion before its shutdown() and the suite hangs instead of reporting that failure.
// Every rig is registered here and stopped at the end whatever happened, so a failure is only
// ever a failure.
const liveRigs = new Set();
const shutdown = (rig) => {
  for (const s of rig.evaluator.schedulers.values()) s.stop();
  liveRigs.delete(rig);
};
after(() => { for (const rig of liveRigs) for (const s of rig.evaluator.schedulers.values()) s.stop(); });

// ---- the three kinds of route -------------------------------------------------------------------

test('the editor is told the engine is up, because in this build it always is', async () => {
  const rig = makeHost();
  const status = await rig.host.call('GET', '/api/status');
  assert.equal(status.loaded, true);
  assert.equal(status.error, null);
  assert.equal(status.build, 'web');
});

test('a route with nothing to say answers empty rather than failing', async () => {
  const rig = makeHost();
  assert.deepEqual((await rig.host.call('GET', '/api/recordings')).items, []);
  assert.deepEqual(await rig.host.call('GET', '/api/midiDevices'), []);
  // The editor polls this twice a second for as long as the page is open. A refusal each time
  // would fill the console with the same sentence and teach somebody to stop reading it.
  assert.deepEqual((await rig.host.call('POST', '/api/pluginEdits', {})).edits, []);
});

test('an empty answer is a fresh object, so one caller cannot edit what the next one gets', async () => {
  const rig = makeHost();
  const first = await rig.host.call('GET', '/api/recordings');
  first.items.push('nonsense');
  assert.deepEqual((await rig.host.call('GET', '/api/recordings')).items, []);
});

test('something the browser cannot do is refused by name, with the reason', async () => {
  const rig = makeHost();
  await assert.rejects(
    () => rig.host.call('POST', '/api/locateSample', {}),
    (err) => err.unsupported && /finding a dropped file on disk/.test(err.message) && /cannot see your disk/.test(err.message),
  );
});

test('a path with no handler is refused rather than answered empty', async () => {
  const rig = makeHost();
  await assert.rejects(() => rig.host.call('GET', '/api/nonesuch'), /no route for GET \/api\/nonesuch/);
});

// ---- the routes that carry the work ----------------------------------------------------------------

test('a buffer is evaluated, highlighted and stopped through the table', async () => {
  const rig = makeHost();
  const result = await rig.host.call('POST', '/api/evaluate', { code: 'kick: s("bd*4")' });
  assert.equal(result.tracks.length, 1);
  const grid = await rig.host.call('GET', '/api/highlight?from=0&count=4');
  assert.equal(grid.gridCount, 4);
  assert.equal(grid.tracks[0].label, 'kick');
  const stopped = await rig.host.call('POST', '/api/stop', {});
  assert.ok(stopped.transport);
  assert.equal(rig.transport.paused, true);
  shutdown(rig);
});

test('a query string reaches the handler that needs it', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'kick: s("bd*4")' });
  const grid = await rig.host.call('GET', '/api/highlight?from=16&count=2');
  assert.equal(grid.gridFrom, 16);
  assert.equal(grid.tracks[0].grid[0].cycle, 16);
  shutdown(rig);
});

test('a pattern saved through the table comes back through it', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/patterns/save', { name: 'song', code: 'kick: s("bd*4")' });
  const listing = await rig.host.call('GET', '/api/patterns');
  assert.deepEqual(listing.patterns.map((p) => p.name), ['song']);
  const loaded = await rig.host.call('POST', '/api/patterns/load', { name: 'song' });
  assert.equal(loaded.code, 'kick: s("bd*4")');
  await rig.host.call('POST', '/api/patterns/delete', { name: 'song' });
  assert.deepEqual((await rig.host.call('GET', '/api/patterns')).patterns, []);
});

test('loading a pattern that is not there says so rather than returning nothing', async () => {
  const rig = makeHost();
  await assert.rejects(() => rig.host.call('POST', '/api/patterns/load', { name: 'ghost' }), /no pattern called/);
});

test('a snapshot round-trips, which is what the shareable link is built on', async () => {
  const rig = makeHost();
  const { id } = await rig.host.call('POST', '/api/snapshot', { code: 'kick: s("bd*4")' });
  const back = await rig.host.call('GET', `/api/snapshot?id=${id}`);
  assert.equal(back.code, 'kick: s("bd*4")');
});

test('a device reports its parameters the way the panel and autocomplete read them', async () => {
  const rig = makeHost();
  const { params } = await rig.host.call('POST', '/api/params', { plugin: 'Wavetable' });
  assert.ok(params.length > 10);
  const detune = params.find((p) => p.name === 'Osc 1 Detune');
  assert.equal(detune.label, 'ct', 'the unit is what the readout prints');
  assert.equal(detune.max, 100);
});

test('the chain of every playing track is reported one slot per row, so parameter names autocomplete', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Distort")' });
  const { slots } = await rig.host.call('GET', '/api/chainParams');
  assert.deepEqual(slots.map((s) => [s.track, s.slot, s.plugin]), [['lead', 0, 'Wavetable'], ['lead', 1, 'Distort']]);
  assert.ok(slots[1].params.some((p) => p.name === 'Drive'));
  shutdown(rig);
});

test('an evaluated track is reported the way the track list draws it', async () => {
  const rig = makeHost();
  const { tracks } = await rig.host.call('POST', '/api/evaluate', {
    code: 'lead: n("0 2").synth("Wavetable").fx("Distort")\n\n_hat: s("hh*8")',
  });
  const lead = tracks.find((t) => t.label === 'lead');
  assert.deepEqual([lead.instrument, ...lead.fxChain], ['Wavetable', 'Distort'], 'the list concatenates these');
  assert.ok(Array.isArray(lead.paramNames));
  assert.equal(lead.active, true);
  assert.equal(lead.muted, false);
  const hat = tracks.find((t) => t.label === 'hat');
  assert.ok(hat, 'a muted track is listed, with a badge, rather than left out');
  assert.equal(hat.muted, true);
  assert.equal(hat.active, false);
  assert.equal(hat.grid, null);
  shutdown(rig);
});

test('the sketch a fresh page opens on evaluates, and names only what is here', async () => {
  const rig = makeHost();
  patternCore.clearRolls('prebake');
  registerPacks(patternCore, shippedPacks);
  const { tracks } = await rig.host.call('POST', '/api/evaluate', { code: WEB_SKETCH });
  assert.deepEqual(tracks.map((t) => t.label), ['kick', 'hat', 'keys']);
  const keys = tracks.find((t) => t.label === 'keys');
  assert.deepEqual([keys.instrument, ...keys.fxChain], ['Wavetable', 'Filter', 'Reverb']);
  shutdown(rig);
});

test('the macro knobs read and write, one row per knob', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/macros/set', { index: 1, value: 0.75 });
  const { macros } = await rig.host.call('GET', '/api/macros');
  assert.equal(macros.length, patternCore.MACRO_COUNT);
  assert.deepEqual(Object.keys(macros[0]).sort(), ['index', 'name', 'value']);
  assert.equal(macros[0].index, 1);
  assert.ok(Math.abs(macros[0].value - 0.75) < 1e-9);
  assert.equal(macros[0].name, 'Macro 1');
  assert.deepEqual(await rig.host.call('POST', '/api/macros/name', { index: 1, name: 'cutoff' }), { name: 'cutoff' });
  assert.equal((await rig.host.call('GET', '/api/macros')).macros[0].name, 'cutoff');
});

// ---- the generated device window ---------------------------------------------------------------------

test('a device with no window of its own is answered with the panel to draw instead', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Distort")' });

  const res = await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 1 });
  assert.equal(res.trackId, 'lead');
  assert.equal(res.slot, 1);
  assert.equal(res.panel.id, 'Distort');
  assert.ok(res.panel.sections.length, 'a panel with no sections is a window with nothing in it');
  const drive = res.panel.sections.flatMap((s) => s.widgets).find((w) => w.id === 'drive');
  assert.equal(drive.widget, 'knob');
  assert.equal(drive.text, '6.0 dB', 'the readout is printed in the parameter\'s own unit, at a width that does not change as it is dragged');
  shutdown(rig);
});

test('a slot the buffer no longer fills says so rather than opening an empty window', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });
  await assert.rejects(rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 3 }), /no device in slot 3/);
  shutdown(rig);
});

test('a knob position becomes a real value, a printed readout and the text to write down', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Distort")' });

  const res = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'drive', position: 0.5 });
  assert.equal(res.name, 'Drive', 'the display name, because that is what a .param() call names');
  assert.equal(res.value, 12, 'half way up a squared 0..48 dB knob');
  assert.equal(res.text, '12.0 dB');
  assert.equal(res.arg, '0.5', 'written as the position, which is what .param() takes');
  // Set live, so the sound is already what the readout says before anything is written down.
  assert.equal(rig.engine.deviceState(rig.evaluator.trackIds.get('lead'), 1).values.drive, 12);

  // And a discrete control sends its value rather than a position.
  const mode = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'mode', value: 2 });
  assert.equal(mode.arg, '"fold"', 'an enum is written as its label, not its index');
  shutdown(rig);
});

test('a dragged control glides and a switched one steps, because a device reads once per block', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Distort")' });
  const slot = rig.engine.tracks.get(rig.evaluator.trackIds.get('lead')).slots.get(1);
  // Audio-rate params are reached through the built device, block-rate ones through the node -
  // the same two places the engine looks, since a worklet declares both kinds as AudioParams.
  const paramNamed = (id) => slot.built.params[id] ?? slot.built.node.parameters.get(id);

  const drive = paramNamed('drive');
  drive.calls.length = 0;
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'drive', position: 0.5 });
  const ramp = drive.calls.find((c) => c.kind === 'ramp');
  assert.ok(ramp, 'a continuous control has to arrive as a ramp, or the staircase is heard');
  assert.ok(ramp.time >= 0.02, `and over more than the engine's own glide, got ${ramp.time}`);

  const mode = paramNamed('mode');
  mode.calls.length = 0;
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'mode', value: 2 });
  assert.equal(mode.calls.some((c) => c.kind === 'ramp'), false, 'ramping an enum sweeps the modes in between');
  // The AudioParam carries a position: the third of nine modes sits a quarter of the way up.
  assert.ok(Math.abs(mode.calls.find((c) => c.kind === 'set').value - 0.25) < 1e-9);
  assert.equal(rig.engine.deviceState(rig.evaluator.trackIds.get('lead'), 1).values.mode, 2);
  shutdown(rig);
});

test('a position is read on the parameter curve, so an exp knob is not linear', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Filter")' });
  const mid = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'cutoff', position: 0.5 });
  assert.ok(Math.abs(mid.value - Math.sqrt(20 * 20000)) < 1, `half a cutoff sweep should be the geometric middle, got ${mid.value}`);
  assert.ok(Math.abs(mid.position - 0.5) < 1e-9, 'and the position comes back where it was put');
  shutdown(rig);
});

test('a parameter under a modulator is drawn read-only, and named by what is moving it', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', {
    code: 'lead: n("0 2").synth("Wavetable").fx("Filter").param("Cutoff", lfo("0,0 1,1", { rate: 1 }))',
  });
  const { panel } = await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 1 });
  const cutoff = panel.sections.flatMap((s) => s.widgets).find((w) => w.id === 'cutoff');
  assert.equal(cutoff.modulatedBy, 'an lfo');
  shutdown(rig);
});

test('a parameter the device does not have is refused by name rather than quietly doing nothing', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });
  await assert.rejects(
    rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'nonesuch', position: 1 }),
    /no parameter called "nonesuch"/,
  );
  shutdown(rig);
});

test('the devices are listed where the plugin browser and the synth("/fx(" completion read them', async () => {
  const rig = makeHost();
  const plugins = await rig.host.call('GET', '/api/knownPlugins');
  assert.ok(Array.isArray(plugins), 'the editor maps over this');
  const byName = new Map(plugins.map((p) => [p.name, p]));
  assert.equal(byName.get('Wavetable').isInstrument, true);
  assert.equal(byName.get('Distort').isInstrument, false);
  for (const p of plugins) assert.equal(typeof p.format, 'string', 'printed beside every name');
  // A rescan replaces the list with its answer, so the answer has to be the list again.
  const scan = await rig.host.call('POST', '/api/scanPlugins', { extraPaths: [] });
  assert.deepEqual(scan.plugins, plugins);
  assert.deepEqual(scan.crashed, []);
});

test('the sounds tab lists the built-in packs and the library, files in index order', async () => {
  const rig = makeHost({ builtIn: [KIT], library: { packs: [PIANO], problems: [], urlFor: cdn } });
  const { root, packs } = await rig.host.call('GET', '/api/samples');
  assert.equal(typeof root, 'string');
  assert.deepEqual(packs.map((p) => [p.name, p.files]), [['pt_kit', ['kick.wav', 'snare.wav']], ['pt_piano', ['c3.wav']]]);
});

test('holding a sample row is answered with where the file is, since there is nothing to stream from', async () => {
  const rig = makeHost({ builtIn: [KIT], library: { packs: [PIANO], problems: [], urlFor: cdn } });
  assert.deepEqual(await rig.host.call('GET', '/api/sampleAudio?pack=pt_kit&i=1'), { url: '/web-engine/packs/pt_kit/snare.wav' });
  assert.deepEqual(await rig.host.call('GET', '/api/sampleAudio?pack=pt_piano&i=0'), { url: cdn('pt_piano', 'c3.wav') });
  await assert.rejects(rig.host.call('GET', '/api/sampleAudio?pack=pt_kit&i=9'), /there is no sample/);
});

test('a registered pack is listed with its files and survives an evaluation', async () => {
  const rig = makeHost();
  patternCore.clearRolls('prebake');
  registerPacks(patternCore, [KIT]);
  await rig.host.call('POST', '/api/evaluate', { code: 'kick: sp("pt_kit:1*4")' });
  const { packs } = await rig.host.call('GET', '/api/rolls');
  const kit = packs.find((p) => p.id === 'pt_kit');
  assert.ok(kit, 'evaluating the buffer clears the buffer layer, and the pack must not be in it');
  assert.equal(kit.library, true);
  assert.deepEqual(kit.files, ['pt_kit/kick.wav', 'pt_kit/snare.wav']);
  shutdown(rig);
});

test('a piano-roll drag re-files the roll with its notes, not an empty one', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/liveRoll', { id: 'dragged', notes: '0,0,1 4,7,1', opts: {} });
  assert.ok(patternCore.lookupRoll('dragged'), 'the roll is filed');
  assert.ok(patternCore.rollIds().some((r) => r.id === 'dragged'));
  await assert.rejects(rig.host.call('POST', '/api/liveRoll', { notes: '' }), /needs the roll id/);
});

test('running off the end of an arrangement is reported as ended, so the editor lands the stop', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'kick: s("bd*4")' });
  const res = await rig.host.call('POST', '/api/arrangeEnd', { deck: 'a' });
  assert.equal(res.ended, true);
  assert.equal(res.transport.paused, true);
  shutdown(rig);
});

test('the playlists are kept in the desktop shape, and a write answers with what was kept', async () => {
  const rig = makeHost();
  assert.deepEqual(await rig.host.call('GET', '/api/library'), { version: 1, playlists: [], active: null });
  const kept = await rig.host.call('POST', '/api/library', {
    playlists: [{ id: 'p1', name: 'set', items: ['song', { kind: 'file', path: '/x.wav', bpm: 128 }, { junk: 1 }] }],
    active: 'p1',
  });
  assert.deepEqual(kept.playlists[0].items, ['song', { kind: 'file', path: '/x.wav', bpm: 128 }]);
  assert.equal(kept.active, 'p1');
  assert.deepEqual(await rig.host.call('GET', '/api/library'), kept);
});

test('sessions and saved patterns are listed apart, as the files tab draws them', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/patterns/save', { name: 'song', code: 'kick: s("bd")' });
  await rig.host.call('POST', '/api/patterns/wip/save', { id: '2026-09/2026-09-22-120000', code: 'hat: s("hh")' });
  const { patterns, wip } = await rig.host.call('GET', '/api/patterns');
  assert.deepEqual(patterns.map((p) => p.name), ['song']);
  assert.deepEqual(wip.map((w) => w.id), ['2026-09/2026-09-22-120000']);
});

test('a state or a snapshot that is not in the store reads as gone, not as an error', async () => {
  const rig = makeHost();
  assert.deepEqual(await rig.host.call('GET', '/api/blobs/stat?id=000000000000'), { bytes: null });
  assert.deepEqual(await rig.host.call('GET', '/api/snapshot?id=nothing'), { code: null });
});

test('the whole store can be carried out and back in', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/patterns/save', { name: 'song', code: 'kick: s("bd*4")' });
  const bundle = await rig.host.call('GET', '/api/export');
  assert.ok(bundle.files['patterns/song.js']);
  const fresh = makeHost();
  const result = await fresh.host.call('POST', '/api/import', { bundle });
  assert.equal(result.written, 1);
  assert.equal((await fresh.host.call('POST', '/api/patterns/load', { name: 'song' })).code, 'kick: s("bd*4")');
});

// ---- the drift guard ---------------------------------------------------------------------------------

test('every path the editor asks for is one the host has an answer for', () => {
  const rig = makeHost();
  const client = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

  // Only the calls written as plain literals are read. A path built from a template is checked
  // by its own test above or by the ones that exercise it; what this catches is the ordinary
  // case, which is nearly all of them.
  const asked = new Set();
  for (const m of client.matchAll(/\bapi\(\s*'(GET|POST|PUT|DELETE)'\s*,\s*'([^']+)'/g)) {
    asked.add(`${m[1]} ${m[2].split('?')[0]}`);
  }
  for (const m of client.matchAll(/\bapi\(\s*'(GET|POST|PUT|DELETE)'\s*,\s*`([^`$]+)`/g)) {
    asked.add(`${m[1]} ${m[2].split('?')[0]}`);
  }
  assert.ok(asked.size > 20, `the scan should have found the editor's calls, found ${asked.size}`);

  // Routes the editor only reaches through a desktop-only panel. Each one is a feature that is
  // not in this build at all, rather than a gap: the panel that calls it is not shown. Listed
  // here by hand so that a NEW route arriving in the editor fails this test instead of joining
  // them silently.
  // An entry here is a promise that nothing reaches the route without a click on a control that
  // is not drawn, or behind a door that is refused first. It is NOT a place to put a route that
  // simply has no answer yet: the settings tab's folder and plugin rows were listed here on the
  // belief that the tab hid them, it does not, and the page logged an error per row on load.
  // The test below this one is what keeps the list honest.
  const desktopOnly = new Set([
    // a toggle drawn disabled: the host answers `available: false` for it
    'POST /api/link',
    // the DJ desk's song player: DJ mode is refused at its opener (client.js, desktopOnly)
    'POST /api/song/play', 'POST /api/song/cue', 'POST /api/song/pause', 'POST /api/song/seek',
    'POST /api/song/stop', 'POST /api/song/meta', 'POST /api/song/nudge',
    'GET /api/song/onsets', 'GET /api/song/waveform',
    // the organizer's disk tab: not drawn, and refused at setOrgPane3
    'GET /api/songfiles/find',
    // asked inside a try whose failure is expected: a playlist's file rows render as missing
    'POST /api/songfiles/stat',
    // the headphone cue device row, drawn disabled from cueAvailable: false
    'POST /api/audioCueDevice',
  ]);

  // An entry that has since been given a handler is a stale promise: take it off the list.
  const answeredAnyway = [...desktopOnly].filter((key) => rig.host.routes[key]);
  assert.deepEqual(answeredAnyway, [], 'these are answered now and belong off the desktop-only list');

  const unanswered = [...asked].filter((key) => !rig.host.routes[key] && !desktopOnly.has(key));
  assert.deepEqual(unanswered, [], 'a path with no handler is a button that does nothing');
});

test('opening a sidebar tab asks for nothing the host cannot answer', () => {
  // The exemption list above is a claim that a route is only reached through a control that is
  // not drawn. Switching tabs draws no control and passes no door, so every route a tab switch
  // reaches has to be answered outright - this is the check the list cannot talk its way past.
  const rig = makeHost();
  const client = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

  // `function name(...) { ... }`, by brace depth, so a body can be read back by name.
  const bodies = new Map();
  for (const m of client.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < client.length; i += 1) {
      if (client[i] === '{') depth += 1;
      else if (client[i] === '}' && (depth -= 1) === 0) {
        bodies.set(m[1], client.slice(m.index, i + 1));
        break;
      }
    }
  }
  assert.ok(bodies.has('activateTab'), 'the tab switch should be readable by name');

  // What the tab switch calls, and what those go on to call - two levels, not a fixed point.
  // A call site here is a mention in the source rather than a branch that was taken, so following
  // it all the way reaches half the editor through conditions a tab switch never meets. Two
  // levels is what a refresh takes to get to its request (`refreshMapSources` → `mapFetchSources`)
  // and is still shallow enough that everything in it genuinely runs.
  const reached = new Set();
  let frontier = ['activateTab'];
  for (let depth = 0; depth <= 2; depth += 1) {
    const next = [];
    for (const name of frontier) {
      if (reached.has(name) || !bodies.has(name)) continue;
      reached.add(name);
      for (const c of bodies.get(name).matchAll(/\b([A-Za-z0-9_$]+)\s*\(/g)) next.push(c[1]);
      // `refreshSamplesDir().then(refreshMapSources)` - the continuation runs on the same click.
      for (const c of bodies.get(name).matchAll(/\.then\(\s*([A-Za-z0-9_$]+)\s*\)/g)) next.push(c[1]);
    }
    frontier = next;
  }
  for (const name of ['refreshSamplesDir', 'refreshPreferVst3', 'mapFetchSources']) {
    assert.ok(reached.has(name), `${name} should be reachable by opening the settings tab`);
  }

  const missing = [];
  for (const name of reached) {
    for (const m of bodies.get(name).matchAll(/\bapi\(\s*'(GET|POST|PUT|DELETE)'\s*,\s*[`']([^`'?$]+)/g)) {
      const key = `${m[1]} ${m[2]}`;
      if (!rig.host.routes[key]) missing.push(`${key} (from ${name})`);
    }
  }
  assert.deepEqual(missing.sort(), [], 'a tab that logs an error as it opens is a broken tab');
});

test('what the editor pulls out of an answer is in the answer', async () => {
  const rig = makeHost();
  const client = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

  // `const { a, b } = await api('GET', '/api/x')` and `({ a } = await api(...))`, with or without
  // a query string. A destructuring with a default or a nested pattern is not read; the tests
  // above cover those routes one by one.
  const re = /\{([^{}=]+)\}\s*=\s*await\s+api\(\s*'(GET|POST)'\s*,\s*[`']([^`'?$]+)[^`']*[`']/g;
  const checked = new Map();
  const missing = [];
  for (const m of client.matchAll(re)) {
    const keys = m[1].split(',').map((k) => k.trim().split(':')[0].trim()).filter(Boolean);
    const route = `${m[2]} ${m[3]}`;
    if (!rig.host.routes[route]) continue; // the drift guard above is the test for that
    let answer;
    try {
      answer = await rig.host.call(m[2], m[3], {});
    } catch {
      continue; // needs a body this test does not know, or is refused by name
    }
    if (!answer || typeof answer !== 'object') continue;
    for (const key of keys) {
      if (!(key in answer)) missing.push(`${route} answers without "${key}"`);
    }
    checked.set(route, keys);
  }
  shutdown(rig);
  assert.deepEqual(missing, [], 'each of these is something the editor reads out of the answer');
  for (const route of ['GET /api/status', 'GET /api/macros', 'GET /api/chainParams', 'GET /api/patterns', 'GET /api/samples']) {
    assert.ok(checked.has(route), `${route} should have been checked; the scan found ${checked.size} routes`);
  }
});

// --- the figures in that window ---------------------------------------------------------------

test('the window a Wavetable opens carries its pictures, drawn from the table it is playing', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });
  const { panel } = await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });

  const figures = panel.sections.flatMap((s) => s.figures);
  assert.deepEqual(figures.map((f) => f.id),
    ['osc1.wave', 'osc1.spread', 'osc2.wave', 'osc2.spread', 'ampenv']);
  assert.equal(panel.width, 920, 'wide enough for the two oscillators side by side');
  assert.deepEqual(panel.rows.map((row) => row.map((i) => panel.sections[i].title)), [['Osc 1', 'Osc 2'], ['Osc 1 Unison', 'Osc 2 Unison'], ['Sub', 'Amp Env', 'Voice']]);

  // The frames come from the shared table the synth in the audio thread is reading, so the picture
  // is of the sound and not of a second copy of it.
  const wave = figures.find((f) => f.id === 'osc1.wave');
  assert.equal(wave.table, 'Basic');
  assert.ok(wave.wave.length > 0, 'and there are points to draw');

  // The four envelope TIMES stay as knobs beside the picture, and stay together: they are the
  // numbers somebody types. The three curves are the picture's own, set by the wheel over the
  // stage each one bends, so they are not knobs here at all.
  const env = panel.sections.find((s) => s.title === 'Amp Env');
  assert.deepEqual(env.widgets.map((w) => w.id), [
    'ampenv.attack', 'ampenv.decay', 'ampenv.sustain', 'ampenv.release', 'env.scale',
  ]);
  assert.equal(env.figures.length, 1);
  shutdown(rig);
});

test('moving a parameter answers with the pictures it appears in, and only those', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Filter")' });

  const cutoff = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'cutoff', position: 0.5 });
  assert.deepEqual(cutoff.figures.map((f) => f.id), ['response']);
  // Redrawn against the value that just landed, not the one before it.
  assert.ok(Math.abs(cutoff.figures[0].corner - cutoff.value) < 1, 'the corner moved with the knob');

  const position = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'osc1.position', position: 1 });
  assert.deepEqual(position.figures.map((f) => f.id), ['osc1.wave']);
  assert.equal(position.figures[0].position, 1, 'and the waveform is the one at the end of the stack');

  // A parameter no picture is drawn from answers with none rather than with all of them.
  const level = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'level', position: 0.3 });
  assert.deepEqual(level.figures, []);
  shutdown(rig);
});

test('a device with no figures declared opens a window of knobs, as it did before', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable").fx("Crush")' });
  const { panel } = await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 1 });
  assert.deepEqual(panel.sections.flatMap((s) => s.figures), []);
  assert.ok(panel.sections.every((s) => s.widgets.length > 0), 'and every section still has its knobs');
  const moved = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 1, id: 'mix', position: 0.5 });
  assert.deepEqual(moved.figures, [], 'a knob on it asks for no picture');
  shutdown(rig);
});

test('a figure says what is driving a parameter, so its axis can refuse to be dragged', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', {
    code: 'lead: n("0 2").synth("Wavetable").fx("Filter").param("Cutoff", lfo("0,0 1,1", { rate: 1 }))',
  });
  const { panel } = await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 1 });
  const response = panel.sections.flatMap((s) => s.figures).find((f) => f.id === 'response');
  assert.deepEqual(response.driven, { cutoff: 'an lfo' });
  shutdown(rig);
});

test('a wavetable folder read into the page is what the table control offers', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });

  // The control says what it takes and where a file picked for it is kept. The list itself is
  // NOT on the control: a wavetable folder is a couple of thousand files, which is the picker's
  // business, and it asks for them when it opens.
  const before = await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });
  // Drawn on the heading of the picture of the table, not in the row of knobs under it.
  const tableOf = (panel) => panel.sections.flatMap((s) => s.figures).flatMap((f) => f.widgets ?? []).find((w) => w.id === 'osc1.table');
  assert.equal(tableOf(before.panel).takes, 'sample');
  assert.equal(tableOf(before.panel).sampleAs, 'wavetable');
  assert.equal(tableOf(before.panel).pack, 'wt');

  // A folder read in through the settings tab lands under `wt` and is listed there.
  const bytes = new TextEncoder().encode('a table').buffer;
  const added = await rig.host.call('POST', '/api/files/add', { name: 'saw.wav', bytes, pack: 'wt' });
  assert.equal(added.ref, 'wt:saw.wav');
  await rig.host.call('POST', '/api/files/add', { name: 'kick.wav', bytes, pack: 'files' });
  assert.deepEqual((await rig.host.call('GET', '/api/files?pack=wt')).files, ['saw.wav'], 'the wavetables, and not the one-shots');

  // And both packs are in the sounds tab beside the shipped ones, which is the list the picker
  // reads when a control takes a sample rather than a table.
  const { packs } = await rig.host.call('GET', '/api/samples');
  assert.deepEqual(packs.filter((p) => p.name === 'wt' || p.name === 'files').map((p) => p.name).sort(), ['files', 'wt']);

  // Forgetting empties it.
  await rig.host.call('POST', '/api/files/clear', { pack: 'wt' });
  assert.deepEqual((await rig.host.call('GET', '/api/files?pack=wt')).files, []);
  shutdown(rig);
});

test('picking a wavetable points the control at it and writes the name into the code', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });
  const bytes = new TextEncoder().encode('a table').buffer;
  await rig.host.call('POST', '/api/files/add', { name: 'saw.wav', bytes, pack: 'wt' });

  const res = await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'osc1.table', sample: 'wt:saw.wav' });
  const shipped = catalog.get('Wavetable').params.find((p) => p.id === 'osc1.table').options.length;
  assert.equal(res.value, shipped, 'the first slot past the shipped tables');
  assert.equal(res.text, 'wt:saw.wav', 'and the readout says which file it is');
  assert.equal(res.arg, '"wt:saw.wav"', 'so the call written down loads it again');
  assert.equal(res.options[shipped], 'wt:saw.wav', 'the list the control redraws with holds it');
  shutdown(rig);
});

// ---- what a finished gesture is written as ------------------------------------------------------

test('a gesture finished in a device window is captured whole, not written control by control', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });

  // Mid-drag: nothing is filed. The value is live, and only the end of the gesture is a decision.
  await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'level', position: 0.3 });
  assert.deepEqual((await rig.host.call('POST', '/api/pluginEdits', {})).edits, []);

  // And the end of a gesture is not filed either, while the window is still open. It cannot be:
  // writing the code re-evaluates, which pushes the state back into the device and over whatever
  // knob is under your hand by then. Closing the window is what says the edit is finished.
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'level', position: 0.3, commit: true });
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'glide', position: 0.6, commit: true });
  assert.deepEqual((await rig.host.call('POST', '/api/pluginEdits', {})).edits, [], 'nothing while the window is open');

  await rig.host.call('POST', '/api/deviceWatch', { trackId: 'lead', slot: 0, on: false });
  const { edits } = await rig.host.call('POST', '/api/pluginEdits', {});
  assert.equal(edits.length, 1, 'one capture for the whole session, however many knobs were turned');
  const [edit] = edits;
  assert.equal(edit.trackId, 'lead');
  assert.equal(edit.slot, 0);
  assert.equal(edit.plugin, 'Wavetable', 'written against a call naming this device and no other');
  assert.equal(edit.replacesParams, true, 'the preset says every setting, so the .param() calls go');

  // A blob, like every other captured program: the editor writes it into a `_preset(...)`
  // definition and folds it to a chip, and it knows one by the shape of it.
  assert.match(edit.state, /^[A-Za-z0-9+/=]+$/);
  // Under which is the whole device in its own units, which plays back into a fresh one.
  const held = JSON.parse(Buffer.from(edit.state, 'base64').toString('utf8'));
  assert.equal(held.device, 'Wavetable');
  assert.ok(Math.abs(held.params.level - 0.3) < 1e-9);
  assert.ok(Object.keys(held.params).length > 20, 'every control, not the one that moved');

  // Drained on read: the same edit is not written into the code twice.
  assert.deepEqual((await rig.host.call('POST', '/api/pluginEdits', {})).edits, []);
  shutdown(rig);
});

test('a control pointed at a file is captured by the file\'s name, not by the slot it landed in', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });
  const bytes = new TextEncoder().encode('a table').buffer;
  await rig.host.call('POST', '/api/files/add', { name: 'saw.wav', bytes, pack: 'wt' });

  await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'osc1.table', sample: 'wt:saw.wav', commit: true });
  await rig.host.call('POST', '/api/deviceWatch', { trackId: 'lead', slot: 0, on: false });
  const { edits } = await rig.host.call('POST', '/api/pluginEdits', {});
  assert.equal(JSON.parse(Buffer.from(edits[0].state, 'base64').toString('utf8')).files['osc1.table'], 'wt:saw.wav');

  // And restoring it points the control back at that file rather than at an option index that
  // means nothing to a device which has not loaded it.
  const tid = rig.evaluator.trackIds.get('lead');
  await rig.engine.setPluginState(tid, 0, edits[0].state);
  const after = rig.engine.deviceState(tid, 0);
  const table = catalog.get('Wavetable').params.find((p) => p.id === 'osc1.table');
  assert.equal(after.extras['osc1.table'][after.values['osc1.table']], 'wt:saw.wav');
  assert.ok(after.values['osc1.table'] >= table.options.length);
  shutdown(rig);
});

test('an open window holds its slot, so a preset coming round cannot undo what you just did', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', {
    code: '_preset("lead", "Wavetable", "e30=")\nlead: n("0 2").synth("Wavetable").preset("lead")',
  });
  const scheduler = rig.evaluator.schedulers.get('lead');

  await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });
  assert.equal(scheduler._stateHold.has(0), true, 'the window is up, so the slot is yours');
  const { holds } = await rig.host.call('POST', '/api/pluginEdits', {});
  // Named for the code to draw. The preset is whichever one is SOUNDING, which with the clock
  // stopped is none yet - the editor falls back to the `.preset(...)` call it can read itself.
  assert.deepEqual(holds, [{ trackId: 'lead', slot: 0, preset: null, why: 'hand' }]);

  // Closing the window gives it back - and the pattern's next swap loads rather than being
  // skipped, because what is in there now is whatever your hands left.
  await rig.host.call('POST', '/api/deviceWatch', { trackId: 'lead', slot: 0, on: false });
  assert.equal(scheduler._stateHold.has(0), false);
  assert.deepEqual((await rig.host.call('POST', '/api/pluginEdits', {})).holds, []);

  // A click in the buffer says the same thing about every window at once.
  await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });
  await rig.host.call('POST', '/api/releaseEditors', {});
  assert.equal(scheduler._stateHold.has(0), false);
  shutdown(rig);
});

test('with conf on for a track, the same gesture writes a .param() call instead', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'lead: n("0 2").synth("Wavetable")' });
  assert.deepEqual(await rig.host.call('POST', '/api/confMode', { trackId: 'lead', on: true }), { on: true, trackId: 'lead' });

  await rig.host.call('POST', '/api/showEditor', { trackId: 'lead', slot: 0 });
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'level', position: 0.25, commit: true });
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'lead', slot: 0, id: 'level', position: 0.4, commit: true });
  await rig.host.call('POST', '/api/deviceWatch', { trackId: 'lead', slot: 0, on: false });
  const drained = await rig.host.call('POST', '/api/confPending', { trackId: 'lead' });
  assert.equal(drained.active, true);
  // One entry, at the position the gesture ended on: a knob swept between two polls lands once.
  assert.deepEqual(drained.params, [{ slot: 0, name: 'Level', id: 'level', value: '0.4' }]);
  // And nothing was captured, because the track being configured is the one saying what it wants.
  assert.deepEqual((await rig.host.call('POST', '/api/pluginEdits', {})).edits, []);

  assert.deepEqual((await rig.host.call('POST', '/api/confPending', { trackId: 'lead' })).params, [], 'drained on read');
  await rig.host.call('POST', '/api/confMode', { trackId: 'lead', on: false });
  assert.equal((await rig.host.call('POST', '/api/confPending', { trackId: 'lead' })).active, false);
  shutdown(rig);
});

test('the mixer is answered from the page: its tracks, its meters and its band centers', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'kick: s("pt_kit:0*4")\nbass: n("0").synth("Wavetable")' });

  // Off until the desk says otherwise, and the desk is told so rather than being refused.
  const idle = await rig.host.call('GET', '/api/mixer/status?strips=');
  assert.equal(idle.on, false);
  assert.deepEqual(idle.tracks, ['kick', 'bass'], 'the strips it should draw');
  assert.ok(idle.bandFreqs.length > 0);

  assert.deepEqual(await rig.host.call('POST', '/api/mixer/monitor', { on: true }), { on: true });
  const live = await rig.host.call('GET', '/api/mixer/status?strips=kick,bass');
  assert.equal(live.on, true);
  // Keyed by the labels the desk knows, not by the ids the engine gave them.
  assert.deepEqual(Object.keys(live.levels).sort(), ['*', 'bass', 'kick']);
  assert.equal(live.spec.kick.length, live.bandFreqs.length);
  assert.equal(live.perTrack, true);
  assert.ok(live.transport, 'the desk draws a playhead, so the transport rides along');

  // What the desk is showing is what gets analyzed: folding a group is one fewer tap.
  await rig.host.call('GET', '/api/mixer/status?strips=kick');
  assert.deepEqual([...rig.engine.analysis.taps.keys()].sort(), ['*', rig.evaluator.trackIds.get('kick')].sort());

  await rig.host.call('POST', '/api/mixer/monitor', { on: false });
  assert.equal(rig.engine.analysis.taps.size, 0);
  shutdown(rig);
});

test('a strip the buffer no longer has is not analyzed, however the desk asks', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'kick: s("pt_kit:0*4")' });
  await rig.host.call('POST', '/api/mixer/monitor', { on: true });
  const res = await rig.host.call('GET', '/api/mixer/status?strips=kick,gone');
  assert.deepEqual(Object.keys(res.levels).sort(), ['*', 'kick']);
  shutdown(rig);
});

test('a curve drawn for a device control is sampled and written into the code as its points', async () => {
  const rig = makeHost();
  await rig.host.call('POST', '/api/evaluate', { code: 'pad: n("0").synth("Granular")' });
  const tid = rig.evaluator.trackIds.get('pad');
  const window = catalog.get('Granular').params.find((p) => p.id === 'window');

  const res = await rig.host.call('POST', '/api/deviceParam', {
    trackId: 'pad', slot: 0, id: 'window', sample: '0,0 0.1,1 1,0', commit: true,
  });
  assert.equal(res.value, window.options.length, 'the first slot past the shapes it ships with');
  assert.equal(res.arg, '"0,0 0.1,1 1,0"', 'and the call written down draws it again');
  assert.equal(rig.engine.deviceState(tid, 0).shapes[res.value].points.length, 256, 'sampled into a table');

  // The picture is drawn from that same table, so what is on screen is what is being played.
  const grain = res.figures.find((f) => f.kind === 'grain');
  assert.equal(grain.data, '0,0 0.1,1 1,0');
  const peak = grain.points.reduce((b, p) => (p.y > b.y ? p : b));
  assert.ok(Math.abs(peak.x - 0.1) < 0.05, `the drawn peak is where it was put, found ${peak.x}`);
  shutdown(rig);
});

test('a drawn curve that is not one is refused by name rather than played as silence', async () => {
  const rig = makeHost();
  const warnings = [];
  rig.engine.warn = (line) => warnings.push(line);
  await rig.host.call('POST', '/api/evaluate', { code: 'pad: n("0").synth("Granular")' });
  await rig.host.call('POST', '/api/deviceParam', { trackId: 'pad', slot: 0, id: 'window', sample: 'not a curve' });
  assert.ok(warnings.some((w) => /is not a drawn shape/.test(w)), warnings.join(' / '));
  shutdown(rig);
});

// --- the slice editor ------------------------------------------------------------------------

test('a sampler source names its files by the key a slice set uses, and says when it has none', async () => {
  const rig = makeHost();
  await rig.samples.addFile('kick.wav', new Uint8Array([1, 2, 3]));
  await rig.samples.addFile('loops/amen.wav', new Uint8Array([4, 5, 6]));
  const file = await rig.host.call('GET', '/api/sampleFile?ref=files&i=1&names=1');
  assert.deepEqual([file.file, file.key, file.index, file.count], ['files/loops/amen.wav', 'files/loops/amen.wav', 1, 2]);
  assert.deepEqual(file.names, ['kick.wav', 'amen.wav']);
  assert.equal((await rig.host.call('GET', '/api/sampleFile?ref=files&i=5')).index, 1, 'an index past the end wraps');
  assert.deepEqual(await rig.host.call('GET', '/api/sampleFile?ref=nothing'), { ref: 'nothing', file: null, count: 0 });
  await assert.rejects(rig.host.call('GET', '/api/sampleSlices?file=files/nope.wav'), /no sample called/);
  shutdown(rig);
});

test('auditioning a chop needs an evaluated track, and stopping one hushes it', async () => {
  const rig = makeHost();
  assert.deepEqual(await rig.host.call('POST', '/api/previewSlice', { trackId: 'drums', ref: 'files', begin: 0, end: 1 }), { ok: false, why: 'track not evaluated' });
  await rig.host.call('POST', '/api/evaluate', { code: 'drums: s("pt_kit:0")' });
  assert.deepEqual(await rig.host.call('POST', '/api/previewSlice', { trackId: 'drums', stop: true }), { ok: true });
  assert.deepEqual(await rig.host.call('POST', '/api/previewSlice', { trackId: 'drums', ref: 'files' }), { ok: false, why: 'bad request' });
  shutdown(rig);
});

test('the pack panel browses the packs as folders, and a pick is the "pack/file" a _pack() list plays', async () => {
  const rig = makeHost({
    builtIn: [{ id: 'pt_kit', files: [{ file: 'bd.wav' }, { file: 'sd.wav' }] }],
    library: { packs: [{ id: 'breaks', files: [{ file: 'Amen/amen.wav' }] }], problems: [], urlFor: cdn },
  });
  const root = await rig.host.call('GET', '/api/browseDir?path=');
  assert.deepEqual(root, { path: '/packs', parent: null, dirs: ['breaks', 'pt_kit'], files: [], samplesRoot: '/packs' });
  const pack = await rig.host.call('GET', '/api/browseDir?path=/packs/breaks/');
  assert.deepEqual(pack.files, ['Amen/amen.wav']);
  assert.equal(pack.parent, '/packs');
  // Anything else - a desktop path in a setting, a pack that is gone - opens at the root.
  assert.equal((await rig.host.call('GET', '/api/browseDir?path=/Users/someone')).path, '/packs');

  const all = await rig.host.call('GET', '/api/findSamples?path=/packs&q=');
  assert.deepEqual(all.files, ['pt_kit/bd.wav', 'pt_kit/sd.wav', 'breaks/Amen/amen.wav']);
  const found = await rig.host.call('GET', '/api/findSamples?path=/packs&q=amen%20BREAKS');
  assert.deepEqual(found.files, ['breaks/Amen/amen.wav'], 'every word, any case');
  const inPack = await rig.host.call('GET', '/api/findSamples?path=/packs/pt_kit&q=sd');
  assert.deepEqual(inPack.files, ['sd.wav'], 'relative to the folder asked about');

  const { url } = await rig.host.call('GET', '/api/sampleAudio?file=/packs/pt_kit/sd.wav');
  assert.equal(url, '/web-engine/packs/pt_kit/sd.wav', 'the panel\'s spelling plays the same file');
});
