// Notes from one track played on another: the routing rules, the engine that delivers them, and
// the one effect played by them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { DEFAULT_ROUTE_NOTE, MidiRoutes, NOTE_OFF_EARLY_SEC } from './src/engine/midi-routes.mjs';
import { DUCKER, DuckerProcessor } from './src/devices/ducker.mjs';
import { defaultValues } from './src/descriptor.mjs';

/** A router whose deliveries are recorded as [on, target, slot, note, velocity, time]. */
function rig(resolve) {
  const out = [];
  const routes = new MidiRoutes({ deliver: (...edge) => out.push(edge), resolve });
  return { routes, out };
}

// --- the rules ---------------------------------------------------------------------------------

test('a track\'s notes reach the tracks routed from it, and no others', () => {
  const { routes, out } = rig();
  routes.add('lead', 'bass', 0);
  routes.noteEdge('lead', 64, 0.8, 1, true);
  routes.noteEdge('drums', 36, 1, 1, true);
  assert.deepEqual(out, [[true, 'bass', 0, 64, 0.8, 1]]);
});

test('a name is resolved to the track id the host gave it', () => {
  const { routes, out } = rig((name) => (name === 'lead' ? 't7' : null));
  routes.add('lead', 'bass', 0);
  routes.noteEdge('t7', 60, 1, 0, true);
  assert.equal(out.length, 1);
  routes.add('track:lead', 'pad', 0);
  routes.noteEdge('t7', 62, 1, 0, true);
  assert.equal(out.filter((e) => e[1] === 'pad').length, 1, 'the explicit spelling resolves too');
  routes.add('dev:Keystep', 'keys', 0);
  routes.noteEdge('dev:Keystep', 60, 1, 0, true);
  assert.equal(out.filter((e) => e[1] === 'keys').length, 0, 'a device is never a track');
});

test('a head route applies its pitch ops; the off releases what the on played', () => {
  const { routes, out } = rig();
  routes.add('lead', 'bass', 0, { transpose: -12, pcs: [0, 2, 4, 5, 7, 9, 11] });
  routes.noteEdge('lead', 61, 1, 0, true);       // c#4 -12 = c#3 -> nearest in c major, ties down: c3
  assert.deepEqual(out.at(-1), [true, 'bass', 0, 48, 1, 0]);
  // A map that changes over time: the off still releases the pitch the on played.
  let shift = 0;
  routes.add('lead', 'pad', 0, { noteMap: (n) => n + shift });
  routes.noteEdge('lead', 60, 1, 1, true);
  shift = 5;
  routes.noteEdge('lead', 60, 0, 2, false);
  const pad = out.filter((e) => e[1] === 'pad');
  assert.deepEqual(pad.map((e) => [e[0], e[3]]), [[true, 60], [false, 60]]);
});

test('a map that answers null silences that note on that route', () => {
  const { routes, out } = rig();
  routes.add('lead', 'bass', 0, { noteMap: (n) => (n > 70 ? null : n) });
  routes.noteEdge('lead', 72, 1, 0, true);
  routes.noteEdge('lead', 72, 0, 1, false);
  assert.deepEqual(out, []);
});

test('an injector may pin the pitch it plays', () => {
  const { routes, out } = rig();
  routes.add('kick', 'bass', 2, { note: 36 });
  routes.noteEdge('kick', 60, 1, 0, true);
  assert.deepEqual(out, [[true, 'bass', 2, 36, 1, 0]]);
});

test('a sampler event routes as a pair, its off pulled early, a drum at the default pitch', () => {
  const { routes, out } = rig();
  routes.add('kick', 'bass', 1);
  routes.sampleEvent('kick', 0.9, 2, 2.5);
  assert.deepEqual(out, [[true, 'bass', 1, DEFAULT_ROUTE_NOTE, 0.9, 2], [false, 'bass', 1, DEFAULT_ROUTE_NOTE, 0, 2.5 - NOTE_OFF_EARLY_SEC]]);
  out.length = 0;
  routes.sampleEvent('kick', 1, 3, 3.5, 67);
  assert.equal(out[0][3], 67, 'a melodic sampler line routes as its own pitch');
});

test('one route per sink, and taking it away releases what it holds', () => {
  const { routes, out } = rig();
  routes.add('lead', 'bass', 0);
  routes.add('pad', 'bass', 0);
  routes.noteEdge('lead', 60, 1, 0, true);
  assert.equal(out.length, 0, 'the second route replaced the first');
  routes.noteEdge('pad', 60, 1, 0, true);
  routes.noteEdge('pad', 64, 1, 0, true);
  routes.remove('bass', 0, 9);
  assert.deepEqual(out.slice(2).map((e) => [e[0], e[3], e[5]]), [[false, 60, 9], [false, 64, 9]]);
  assert.equal(routes.size, 0);
});

// --- the engine --------------------------------------------------------------------------------

function makeEngine() {
  const ctx = new FakeAudioContext();
  const warnings = [];
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: (line) => warnings.push(line), AudioWorkletNode: fakeWorkletFor(catalog) });
  return { ctx, engine, warnings };
}

const instrumentOf = (engine, id) => engine.tracks.get(id).source.node;
const slotNode = (engine, id, slot) => engine.tracks.get(id).slots.get(slot).built.node;
const notes = (node) => node.messages.filter((m) => m.kind === 'noteOn' || m.kind === 'noteOff');

test('midi("lead") as a source plays this track\'s instrument from lead\'s notes', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('lead', 'Wavetable');
  engine.loadInstrument('bass', 'Wavetable');
  engine.setInputSource('bass', 'midi', 'lead', 0, null, null, -12, null);
  engine.noteOn('lead', 64, 0.7, 1);
  engine.noteOff('lead', 64, 1.5);
  assert.deepEqual(notes(instrumentOf(engine, 'bass')).map((m) => [m.kind, m.note, m.time]), [['noteOn', 52, 1], ['noteOff', 52, 1.5]]);
  assert.deepEqual(notes(instrumentOf(engine, 'lead')).map((m) => m.note), [64, 64], 'and lead still plays its own');
  assert.deepEqual(warnings, []);
  engine.clearInputSource('bass');
  engine.noteOn('lead', 65, 1, 2);
  assert.equal(notes(instrumentOf(engine, 'bass')).length, 2, 'cleared, nothing more arrives');
});

test('.fx("Ducker").midi("kick") plays the ducker from the kick\'s sampler events', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('keys', 'Wavetable');
  engine.loadEffect('keys', 'Ducker', 1);
  engine.injectMidi('keys', 1, 'kick', null);
  const ducker = slotNode(engine, 'keys', 1);
  assert.ok(ducker.messages.some((m) => m.kind === 'noteRoute' && m.on === true), 'the ducker is told it is being played');
  engine.playSample('kick', 'sp:pt_kit', { vel: 1 }, 4, 4.25);
  assert.deepEqual(notes(ducker).map((m) => [m.kind, m.time]), [['noteOn', 4], ['noteOff', 4.25 - NOTE_OFF_EARLY_SEC]]);
  assert.deepEqual(warnings, []);
  engine.clearMidiInject('keys', 1);
  assert.ok(ducker.messages.some((m) => m.kind === 'noteRoute' && m.on === false));
});

test('.midi() into an effect that is not played by notes says so by name', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('keys', 'Wavetable');
  engine.loadEffect('keys', 'Reverb', 1);
  engine.injectMidi('keys', 1, 'kick', null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"Reverb" is not played by notes/);
  assert.match(warnings[0], /Ducker/, 'and names the ones that are');
  engine.playSample('kick', 'sp:pt_kit', { vel: 1 }, 4, 4.25);
  assert.equal(notes(slotNode(engine, 'keys', 1)).length, 0);
});

test('a MIDI device is still refused by name, and says a track\'s notes do work', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('keys', 'Wavetable');
  engine.setInputSource('keys', 'midi', 'dev:Keystep', 0);
  assert.match(warnings.join('\n'), /MIDI devices are not wired up/);
  assert.match(warnings.join('\n'), /track's notes/);
});

// --- the ducker, played by notes ---------------------------------------------------------------

const SR = 48000;
const BLOCK = 128;

/** Runs a ducker for `blocks` blocks of steady input starting at `t0`, returning its gain per block. */
function runDucker(fx, blocks, t0 = 0, over = {}) {
  const params = { ...defaultValues(DUCKER), amount: 0.8, attack: 0, ...over };
  const inL = new Float32Array(BLOCK).fill(0.5);
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const gains = [];
  for (let b = 0; b < blocks; b++) {
    fx.process([inL, inL], out, BLOCK, params, null, t0 + (b * BLOCK) / SR);
    gains.push(out[0].slice());
  }
  return gains;
}

test('a routed ducker dips at the note\'s own sample and nowhere else', () => {
  const fx = new DuckerProcessor(SR);
  fx.setNoteRoute(true);
  // A note three quarters into the third block.
  const at = (2 * BLOCK + 96) / SR;
  fx.noteOn(36, 1, at);
  const blocks = runDucker(fx, 6);
  const flat = blocks.flatMap((b) => [...b]);
  const first = flat.findIndex((v) => v < 0.49);
  assert.equal(first, 2 * BLOCK + 96, 'the dip starts on the note\'s sample');
  assert.ok(flat.slice(0, first).every((v) => Math.abs(v - 0.5) < 1e-6), 'and the clock dipped nothing before it');
  assert.equal(fx.report().trigger, 'notes');
});

test('an unrouted ducker follows the clock, and a note with no velocity triggers nothing', () => {
  const fx = new DuckerProcessor(SR);
  fx.noteOn(36, 0, 0.001);
  assert.equal(fx.noteRouted, false);
  assert.equal(fx.report().trigger, 'clock');
  fx.setNoteRoute(true);
  fx.noteOn(36, 1, 0.5);
  fx.setNoteRoute(false);
  assert.deepEqual(fx.pending, [], 'clearing the route forgets notes still to come');
});
