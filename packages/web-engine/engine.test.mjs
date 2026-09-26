// The browser engine, tested against a stand-in audio graph (see fake-context.mjs).
//
// The first test here is the important one: it reads the Scheduler's own source and checks this
// engine implements every method it calls. That is the conformance check the desktop side
// learned to need the hard way - routing methods existed on the real engine, the scheduler
// called them, and the wrapper in between quietly did not have them, so every route silently
// did nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { TRACK_BEND_PARAM } from './src/descriptor.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { renderRange, renderShape } from './src/engine/modulators.mjs';
import { SPECTRUM_BAND_FREQS, SpectrumTap } from './src/engine/analysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function schedulerSource() {
  const candidates = [
    path.join(here, '..', 'pattern-core', 'src', 'scheduler.mjs'),
    path.join(here, 'node_modules', '@poptart', 'pattern-core', 'src', 'scheduler.mjs'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  throw new Error('could not find the scheduler to read its engine calls from');
}

/**
 * Every method the Scheduler calls on its engine.
 *
 * The plain `this.engine.x` reads are found by regex, and the four modulator clears are added by
 * hand because they are reached through a computed key (`this.engine[MODULATOR_CLEARS[kind]]`)
 * and no regex over the source will see them. That gap is worth knowing about: it is exactly the
 * kind of call that would be missing from an engine and never show up until a modulator failed
 * to clear on a re-evaluation.
 */
function schedulerEngineCalls() {
  const src = schedulerSource();
  const found = new Set([...src.matchAll(/this\.engine\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  for (const name of ['clearParamLFO', 'clearParamEnv', 'clearParamCC', 'clearParamOSC']) found.add(name);
  return [...found];
}

/** A stand-in for a decoded sample: one channel of a sine. */
function fakeBuffer(length, sampleRate = 48000) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin(i * 0.05);
  return { numberOfChannels: 1, length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
}

function makeEngine({ samples = null } = {}) {
  const ctx = new FakeAudioContext();
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    samples,
    routeWaitMs: 1,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  return { ctx, engine, warnings };
}

test('the engine implements every method the Scheduler calls on it', () => {
  const { engine } = makeEngine();
  const missing = schedulerEngineCalls().filter((name) => typeof engine[name] !== 'function');
  assert.deepEqual(missing, [], `the engine is missing: ${missing.join(', ')}`);
});

test('the modulator clears are covered, including the ones reached by computed name', () => {
  const calls = schedulerEngineCalls();
  for (const name of ['clearParamLFO', 'clearParamEnv', 'clearParamCC', 'clearParamOSC']) {
    assert.ok(calls.includes(name), `${name} should be in the conformance list`);
  }
});

test('every method survives being called with junk, rather than throwing out of a tick', () => {
  // The scheduler calls into the engine from a timer. An exception there stops the music, so a
  // call that makes no sense has to be a no-op and not a throw.
  const { engine } = makeEngine();
  for (const name of schedulerEngineCalls()) {
    if (name === 'getTime') continue;
    assert.doesNotThrow(() => engine[name]('nonesuch', 0, 'param', 0, 0), `${name} threw`);
  }
});

test('the clock is the audio context, which is what every scheduled time is measured against', () => {
  const { ctx, engine } = makeEngine();
  assert.equal(engine.getTime(), 0);
  ctx.advance(1.5);
  assert.equal(engine.getTime(), 1.5);
});

test('creating a track twice does not build a second one', () => {
  const { engine } = makeEngine();
  const a = engine.createTrack('t1');
  const b = engine.createTrack('t1');
  assert.equal(a, b);
  assert.equal(engine.tracks.size, 1);
});

test('a track reaches the master, through its strip, from the moment it exists', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t1');
  assert.ok(track.input.reaches(engine.master), 'a track that cannot reach the master is silent');
});

test('birth values are applied, so a track can be born silent', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t1', { gain: 0, pan: -1 });
  assert.ok(track.chainIn.gain.landedOn(0));
  assert.ok(track.panCtl.offset.landedOn(-1));
  const [left, right] = track.panLaw.map((s) => s.curve);
  assert.ok(Math.abs(left[0] - Math.SQRT2) < 1e-6 && Math.abs(right[0]) < 1e-6, 'hard left: the left side +3 dB, the right silent');
  const mid = (left.length - 1) / 2;
  assert.ok(Math.abs(left[mid] - 1) < 1e-6 && Math.abs(right[mid] - 1) < 1e-6, 'center: both sides at unity');
  assert.ok(track.panLaw[0].outputs.includes(track.panL.gain) && track.panL.gain.value === 0, 'the law is the whole of each side\'s gain');
});

test('an instrument becomes the track source and reaches the master', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  const track = engine.tracks.get('t1');
  assert.ok(track.source, 'the slot should be filled');
  assert.equal(track.slots.get(0).descriptor.id, 'Wavetable');
  assert.ok(track.source.output.reaches(engine.master));
});

test('effects are chained in slot order, between the source and the strip', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Distort', 1);
  engine.loadEffect('t1', 'Reverb', 2);
  const track = engine.tracks.get('t1');
  assert.deepEqual([...track.slots.keys()].sort(), [0, 1, 2]);
  assert.ok(track.chainIn.reaches(track.slots.get(1).built.input), 'the first effect should be fed by the chain input');
  assert.ok(track.slots.get(1).built.output.reaches(track.slots.get(2).built.input), 'and feed the second');
  assert.ok(track.slots.get(2).built.output.reaches(engine.master));
});

test('reloading the same device in a slot leaves it alone, so a re-eval does not cut the sound', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  const first = engine.tracks.get('t1').slots.get(1).built;
  engine.loadEffect('t1', 'Reverb', 1);
  assert.equal(engine.tracks.get('t1').slots.get(1).built, first, 'the same device should not be rebuilt');
});

test('a different device in a slot replaces it', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  const first = engine.tracks.get('t1').slots.get(1).built;
  engine.loadEffect('t1', 'Distort', 1);
  assert.notEqual(engine.tracks.get('t1').slots.get(1).built, first);
  assert.equal(engine.tracks.get('t1').slots.get(1).descriptor.id, 'Distort');
});

test('unloading an effect takes it out of the chain but leaves the track playing', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Distort', 1);
  engine.unloadEffect('t1', 1);
  const track = engine.tracks.get('t1');
  assert.equal(track.slots.has(1), false);
  assert.ok(track.chainIn.reaches(engine.master), 'the track should still reach the master');
});

test('an unknown device warns by name and leaves the slot empty rather than throwing', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('t1', 'Nonesuch');
  assert.ok(warnings.some((w) => w.includes('Nonesuch')), 'the warning should name the device');
  assert.equal(engine.tracks.get('t1').slots.size, 0);
});

test('an effect asked for where an instrument belongs is refused with an explanation', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('t1', 'Reverb');
  assert.ok(warnings.some((w) => w.includes('Reverb') && w.includes('effect')));
  assert.equal(engine.tracks.get('t1').slots.size, 0);
});

test('a parameter set by name takes a position and reaches its AudioParam as one', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParam('t1', 1, 'Cutoff', 0.5, 0);
  const slot = engine.tracks.get('t1').slots.get(1);
  assert.ok(slot.built.params.cutoff.rampedTo(0.5), 'the AudioParam carries the position');
  assert.ok(Math.abs(slot.values.cutoff - Math.sqrt(20 * 20000)) < 1e-6, 'and the slot remembers the real value, on the parameter curve');
});

test('a held parameter goes back to what it was when the pattern took it', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  const slot = engine.tracks.get('t1').slots.get(1);
  // Where the panel (or a preset) had it before the pattern spoke.
  engine.setParam('t1', 1, 'Cutoff', 0.25, 0);
  const before = slot.values.cutoff;
  engine.holdParam('t1', 1, 'Cutoff');
  engine.setParam('t1', 1, 'Cutoff', 0.9, 0);
  engine.setParam('t1', 1, 'Cutoff', 0.7, 0);
  assert.notEqual(slot.values.cutoff, before);
  // A second hold - a fresh Scheduler on the same track - keeps the first reading.
  engine.holdParam('t1', 1, 'Cutoff');
  engine.releaseParam('t1', 1, 'Cutoff', 0);
  assert.equal(slot.values.cutoff, before, 'released, it reads what it did before the pattern');
  assert.ok(slot.built.params.cutoff.rampedTo(0.25), 'and the AudioParam went there');
  // Released twice is nothing: there is nothing held to go back to.
  engine.setParam('t1', 1, 'Cutoff', 0.6, 0);
  engine.releaseParam('t1', 1, 'Cutoff', 0);
  assert.notEqual(slot.values.cutoff, before);
  // A parameter a modulator owns is the modulator's, hold or no hold.
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 1, phaseCycles: 0, min: 0.2, max: 0.8 });
  engine.releaseParam('t1', 1, 'Cutoff', 0);
  assert.ok(engine.modulators.get('t1').has('1:Cutoff'), 'still the modulator\'s');
});

test('a choice steps from one setting to the next, whoever sets it, and a knob still glides', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  const params = engine.tracks.get('t1').slots.get(1).built.params;
  const mode = params.mode ?? engine.tracks.get('t1').slots.get(1).built.node.parameters.get('mode');
  mode.calls.length = 0;
  engine.setParam('t1', 1, 'Mode', 'fold', 0); // as the pattern's poll sends it: no glide given
  assert.equal(mode.calls.some((c) => c.kind === 'ramp'), false, 'a mode ramped plays every mode between');
  const drive = params.drive ?? engine.tracks.get('t1').slots.get(1).built.node.parameters.get('drive');
  drive.calls.length = 0;
  engine.setParam('t1', 1, 'Drive', 0.5, 0);
  assert.ok(drive.calls.some((c) => c.kind === 'ramp'), 'a knob keeps its glide');
});

test('a parameter set out of range is clamped to what the device declares', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParam('t1', 1, 'Cutoff', 999999, 0);
  assert.equal(engine.tracks.get('t1').slots.get(1).values.cutoff, 20000);
  engine.setParam('t1', 1, 'Cutoff', -3, 0);
  assert.equal(engine.tracks.get('t1').slots.get(1).values.cutoff, 20);
});

test('an enum parameter takes its label or its index, and a value it cannot take warns', () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  // A label, wherever the list happens to put it: the index is the list's business and a song
  // is written with the name, so this reads the name back out rather than hard-coding a number.
  const modes = catalog.get('Filter').params.find((p) => p.id === 'mode').options;
  const held = () => engine.tracks.get('t1').slots.get(1).values.mode;
  engine.setParam('t1', 1, 'Mode', 'highpass', 0);
  assert.equal(held(), modes.indexOf('highpass'), 'a label lands on its index');
  engine.setParam('t1', 1, 'Mode', modes.indexOf('ladder'), 0);
  assert.equal(held(), modes.indexOf('ladder'), 'a whole number is an index');
  engine.setParam('t1', 1, 'Mode', 'Ladder', 0);
  assert.equal(held(), modes.indexOf('ladder'), 'spelled any way');
  engine.setParam('t1', 1, 'Mode', 'nonesuch', 0);
  assert.equal(held(), modes.indexOf('ladder'), 'a word that is no label leaves it alone');
  assert.ok(warnings.some((w) => w.includes('cannot take "nonesuch"')));
});

test('a parameter that takes a sample loads it and points the control at the loaded slot', async () => {
  const bytes = new Map();
  const samples = {
    indexOf: (pack, key) => (pack === 'files' && key === 'kick' ? 0 : null),
    bytes: async () => null,
    get: (pack, index) => (pack === 'files' && index === 0 ? { buffer: fakeBuffer(4096) } : null),
  };
  const { engine, warnings } = makeEngine({ samples });
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.setParam('t1', 0, 'Osc 1 Table', 'files:kick', 0);
  const slot = engine.tracks.get('t1').slots.get(0);
  const table = slot.descriptor.params.find((p) => p.id === 'osc1.table');
  assert.equal(slot.values['osc1.table'], table.options.length, 'the first spare slot past the shipped tables');
  assert.equal(slot.extras['osc1.table'][table.options.length], 'files:kick', 'and it is named for the panel');
  await new Promise((r) => setTimeout(r, 5));
  const posted = slot.built.node.messages.find((m) => m.kind === 'sample');
  assert.ok(posted, 'the file reaches the processor');
  assert.equal(posted.index, table.options.length);
  // A wavetable is cut and band-limited on this side: two frames of 2048 out of 4096 samples,
  // each a pyramid, so the audio thread does none of the transforms.
  assert.equal(posted.mips.length, 2);
  assert.ok(posted.mips[0].length > 10, 'with every level of the pyramid');
  assert.equal(slot.tables[table.options.length].frameCount, 2, 'and the frames are kept for the panel\'s picture');
  // The same reference again is a lookup, not a second load.
  engine.setParam('t1', 0, 'Osc 1 Table', 'files:kick', 0);
  assert.equal(slot.built.node.messages.filter((m) => m.kind === 'sample').length, 1);
  engine.setParam('t1', 0, 'Osc 1 Table', 'files:nonesuch', 0);
  assert.ok(warnings.some((w) => w.includes('no sample called "files:nonesuch"')));
  void bytes;
});

test('an unknown parameter warns once, naming the device', () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParam('t1', 1, 'Nonesuch', 1, 0);
  engine.setParam('t1', 1, 'Nonesuch', 2, 0);
  const said = warnings.filter((w) => w.includes('Nonesuch'));
  assert.equal(said.length, 1);
  assert.ok(said[0].includes('Filter'));
});

test('the channel strip controls this build has work; the ones it lacks warn once', () => {
  const { engine, warnings } = makeEngine();
  const track = engine.createTrack('t1');
  engine.setParam('t1', -1, 'gain', 0.5, 0);
  engine.setParam('t1', -1, 'pan', 0.25, 0);
  engine.setParam('t1', -1, 'dry', 0, 0);
  assert.ok(track.chainIn.gain.landedOn(0.5));
  assert.ok(track.panCtl.offset.landedOn(0.25));
  assert.ok(track.dryGain.gain.landedOn(0));

  // Width and bass mono: the side scaled, and high-passed at the cutoff in place of the dry side.
  engine.setParam('t1', -1, 'width', 2, 0);
  assert.ok(track.width.gain.landedOn(2));
  engine.setParam('t1', -1, 'bassmono', 150, 0);
  assert.ok(track.bassHp.frequency.landedOn(150) && track.sideHigh.gain.landedOn(1) && track.sideDry.gain.landedOn(0));
  assert.deepEqual(warnings, []);

  // A DJ desk control is not a thing a track in the browser has.
  engine.setParam('t1', -1, 'djf', 1, 0);
  engine.setParam('t1', -1, 'djf', 1, 0);
  const said = warnings.filter((w) => w.includes('djf'));
  assert.equal(said.length, 1, 'the gap belongs once, not once per tick');
  assert.ok(said[0].includes('not implemented'));
});

test('a per-slot wet level crossfades that slot, and one for an empty slot is not an error', () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  engine.setParam('t1', -1, 'wet1', 0.25, 0);
  const track = engine.tracks.get('t1');
  const slot = track.slots.get(1);
  const ctl = track.wetControl(1);
  assert.ok(ctl.offset.landedOn(0.25));
  assert.ok(slot.wetGain.gain.connectedFrom.includes(ctl) && slot.wetGain.gain.value === 0, 'wet is the control');
  assert.ok(slot.dryGain.gain.connectedFrom.includes(slot.wetInvert) && slot.wetInvert.gain.value === -1 && slot.dryGain.gain.value === 1, 'dry is one minus it');
  engine.setParam('t1', -1, 'wet7', 0.5, 0);
  assert.equal(warnings.filter((w) => w.includes('wet7')).length, 0);
  assert.ok(track.wetControl(7).offset.landedOn(0.5), 'kept for the device that comes to slot 7');
});

test('a wet level belongs to the slot position and carries across a device swap', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  engine.setParam('t1', -1, 'wet1', 0.25, 0);
  const track = engine.tracks.get('t1');
  const old = track.slots.get(1);
  engine.loadEffect('t1', 'Delay', 1);
  const now = track.slots.get(1);
  assert.notEqual(now, old);
  assert.ok(now.wetGain.gain.connectedFrom.includes(track.wetControl(1)), 'the new device is mixed by the same control');
  assert.equal(old.wetGain.gain.connectedFrom.length, 0, 'and the old one is let go');
});

test('a bus send is built once and its level moved after that', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.setBusSends('t1', [{ name: 'reverb', amount: 0.4 }]);
  const track = engine.tracks.get('t1');
  const send = track.sends.get('reverb');
  assert.ok(send, 'the send should exist');
  assert.equal(send.gain.value, 0.4, 'born at its level');
  assert.equal(send.gain.calls.length, 0, 'not at unity and ramped down afterwards');
  assert.ok(track.panner.reaches(engine.buses.get('reverb')));

  engine.setBusSendAmount('t1', 0, 0.9, 0);
  assert.ok(send.gain.rampedTo(0.9));
  assert.equal(track.sends.get('reverb'), send, 'moving a level must not rebuild the send');
});

test('a send the new pattern dropped is torn down', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.setBusSends('t1', [{ name: 'a', amount: 1 }, { name: 'b', amount: 1 }]);
  engine.setBusSends('t1', [{ name: 'a', amount: 1 }]);
  const track = engine.tracks.get('t1');
  assert.deepEqual([...track.sends.keys()], ['a']);
  engine.clearBusSends('t1');
  assert.equal(track.sends.size, 0);
});

test('a track can read a bus, which is how a group hears its members', () => {
  const { engine } = makeEngine();
  engine.createTrack('member');
  engine.setBusSends('member', [{ name: 'drums', amount: 1 }]);
  engine.createTrack('groupTrack');
  engine.setInputSource('groupTrack', 'audio', 'bus:drums', 0, null, null, 0, null);
  const group = engine.tracks.get('groupTrack');
  assert.ok(engine.buses.get('drums').reaches(group.input), 'the group should hear the bus');
  engine.clearInputSource('groupTrack');
  assert.equal(engine.buses.get('drums').reaches(group.input), false);
});

test('a MIDI device route asks the host for MIDI access, and warns about nothing', () => {
  const { engine, warnings } = makeEngine();
  let asked = 0;
  engine.onMidiWanted = () => { asked += 1; };
  engine.setInputSource('t1', 'midi', 'dev:Keystation', 0, null, null, 0, null);
  engine.setMidiNotes('t2', 'Keystation', 0, null, 0, null);
  assert.equal(asked, 2);
  assert.deepEqual(warnings, []);
});

test('an LFO takes the parameter over: a scalar set while it runs is ignored', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 2, phaseCycles: 0, min: 200, max: 4000 });
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  assert.ok(cutoff.connectedFrom.length > 0, 'the LFO should be connected to the parameter');
  const before = cutoff.calls.length;
  engine.setParam('t1', 1, 'Cutoff', 8000, 0);
  assert.equal(cutoff.calls.length, before, 'a polled value must not fight the modulator that owns the control');
});

test('clearing a modulator stops it and hands the parameter back', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 2, min: 0.2, max: 0.8 });
  engine.clearParamLFO('t1', 1, 'Cutoff');
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  engine.setParam('t1', 1, 'Cutoff', 0.75, 0);
  assert.ok(cutoff.rampedTo(0.75), 'once the modulator is gone the parameter is ours again');
});

test('a modulator re-sent with a new range is updated in place, not restarted', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 2, min: 200, max: 4000 });
  const held = engine.modulators.get('t1').get('1:Cutoff');
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 2, min: 200, max: 8000 });
  assert.equal(engine.modulators.get('t1').get('1:Cutoff'), held, 'the connection should survive its own update');
  assert.equal(held.ir.max, 8000);
});

test('an envelope is gated by the notes, not by the clock', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamEnv('t1', 1, 'Cutoff', { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2, min: 200, max: 5000 });
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  const before = cutoff.calls.length;
  engine.noteOn('t1', 60, 1, 0);
  assert.ok(cutoff.calls.length > before, 'a note should write the envelope onto the parameter');
  assert.ok(cutoff.calls.some((c) => c.kind === 'ramp' && c.value === 5000), 'and reach its peak');
  engine.noteOff('t1', 60, 1);
  assert.ok(cutoff.calls.some((c) => c.kind === 'ramp' && c.value === 200), 'and release to its floor');
});

test('a control feed reaches every parameter watching it and nothing else', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamCC('t1', 1, 'Cutoff', { device: 'Keystation', cc: 74, channel: 0, min: 100, max: 1000 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  engine.feedCC('keystation', 74, 0.5, 0);
  assert.ok(conn.node.offset.rampedTo(550), 'the value should land in the modulator range');
  const before = conn.node.offset.calls.length;
  engine.feedCC('keystation', 99, 1, 0);
  assert.equal(conn.node.offset.calls.length, before, 'a controller nobody is watching changes nothing');
});

test('a note reaches the instrument as a message carrying its own time', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.noteOn('t1', 64, 0.8, 1.25);
  engine.noteOff('t1', 64, 1.75);
  const messages = engine.tracks.get('t1').source.node.messages;
  // The port carries notes and nothing else. Every control is an AudioParam, block-rate ones
  // included - see parameterDescriptorsFor - so there is exactly one way a parameter reaches the
  // audio thread, and a mode cannot arrive a block later than the value it belongs with.
  assert.deepEqual(messages, [
    { kind: 'noteOn', note: 64, velocity: 0.8, time: 1.25 },
    { kind: 'noteOff', note: 64, time: 1.75 },
  ]);
});

test('a note for a track with no instrument is dropped rather than throwing', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  assert.doesNotThrow(() => engine.noteOn('t1', 60, 1, 0));
  assert.doesNotThrow(() => engine.noteOn('nonesuch', 60, 1, 0));
});

test('a signal patched onto a parameter is a connection, scaled and offset as asked', () => {
  const { engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('lead');
  engine.loadInstrument('lead', 'Wavetable');
  engine.connectParam('lead', 0, 'Osc 1 Phase', 'mod', 0.5, 0.1);

  const phase = engine.tracks.get('lead').slots.get(0).built.node.parameters.get('osc1.phase');
  assert.ok(phase, 'the phase should be an audio-rate parameter');
  const conn = engine.tracks.get('lead').paramConnections.get('0:Osc 1 Phase');
  assert.ok(conn, 'the connection should be recorded so it can be torn down');
  assert.equal(conn.scale.gain.value, 0.5, 'the .mul() should become the gain');
  assert.equal(conn.bias.offset.value, 0.1, 'and the .add() an offset');
  assert.ok(engine.tracks.get('mod').panner.reaches(conn.scale), 'the source should feed the gain');
  assert.ok(conn.scale.outputs.includes(phase), 'and the gain the parameter');
});

test('a connection with no offset builds no constant source to carry it', () => {
  const { engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('lead');
  engine.loadInstrument('lead', 'Wavetable');
  engine.connectParam('lead', 0, 'Osc 1 Phase', 'mod', 1, 0);
  assert.equal(engine.tracks.get('lead').paramConnections.get('0:Osc 1 Phase').bias, null);
});

test('a connection can be torn down, and re-connecting replaces rather than stacking', () => {
  const { engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('lead');
  engine.loadInstrument('lead', 'Wavetable');
  engine.connectParam('lead', 0, 'Osc 1 Phase', 'mod', 1, 0);
  engine.connectParam('lead', 0, 'Osc 1 Phase', 'mod', 2, 0);
  const phase = engine.tracks.get('lead').slots.get(0).built.node.parameters.get('osc1.phase');
  assert.equal(phase.connectedFrom.length, 1, 'the old connection should have been removed first');
  engine.disconnectParam('lead', 0, 'Osc 1 Phase');
  assert.equal(phase.connectedFrom.length, 0);
  assert.equal(engine.tracks.get('lead').paramConnections.size, 0);
});

test('patching into something that cannot take a signal warns instead of failing quietly', () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('lead');
  engine.loadInstrument('lead', 'Wavetable');
  engine.connectParam('lead', 0, 'Voices', 'mod', 1, 0);   // a k-rate count
  assert.ok(warnings.some((w) => w.includes('Voices') && w.includes('audio rate')));
  assert.equal(engine.tracks.get('lead').paramConnections.size, 0);
});

test('patching from something that does not exist warns and names it', async () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('lead');
  engine.loadInstrument('lead', 'Wavetable');
  engine.connectParam('lead', 0, 'Osc 1 Phase', 'nonesuch', 1, 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(warnings.some((w) => w.includes('nonesuch')));
});

test('a device state round-trips as its parameter map, in real units', async () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParam('t1', 1, 'Cutoff', 0.5, 0);
  const state = await engine.getPluginState('t1', 1);
  // A blob, the way every captured program is: the editor files one into a `_preset(...)`
  // definition and folds it to a chip, and it knows a program by the shape of it.
  assert.match(state, /^[A-Za-z0-9+/=]+$/);
  const cutoff = JSON.parse(Buffer.from(state, 'base64').toString('utf8')).params.cutoff;
  assert.ok(Math.abs(cutoff - Math.sqrt(20 * 20000)) < 1e-6, 'the state records Hz, not a position');

  engine.setParam('t1', 1, 'Cutoff', 0.1, 0);
  assert.equal(await engine.setPluginState('t1', 1, state, 0), true);
  assert.equal(engine.tracks.get('t1').slots.get(1).values.cutoff, cutoff);
  assert.ok(engine.tracks.get('t1').slots.get(1).built.params.cutoff.rampedTo(0.5), 'and puts the position back');

  // One written out by hand loads too - a blob is what gets WRITTEN, not the only thing read.
  engine.setParam('t1', 1, 'Cutoff', 0.1, 0);
  assert.equal(await engine.setPluginState('t1', 1, JSON.stringify({ params: { cutoff } }), 0), true);
  assert.equal(engine.tracks.get('t1').slots.get(1).values.cutoff, cutoff);
});

test('a state that is not readable warns and leaves the slot as it was', async () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParam('t1', 1, 'Cutoff', 0.5, 0);
  const before = engine.tracks.get('t1').slots.get(1).values.cutoff;
  assert.equal(await engine.setPluginState('t1', 1, 'not json at all', 0), false);
  assert.equal(engine.tracks.get('t1').slots.get(1).values.cutoff, before);
  assert.ok(warnings.some((w) => w.includes('preset')));
});

test('getParams describes the device for the panel and the autocomplete', async () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  const params = await engine.getParams('t1', 1);
  assert.ok(params.length > 0);
  const drive = params.find((p) => p.id === 'drive');
  assert.equal(drive.name, 'Drive');
  assert.equal(drive.label, 'dB');
  assert.equal(drive.max, 48);
  assert.deepEqual(await engine.getParams('t1', 9), []);
});

test('a parameter set by value glides, and the caller can say how long for', () => {
  // A device reads each parameter once per audio block, so a value in motion is a staircase at
  // the block rate and the glide is what decides how far it travels per step. Ten milliseconds
  // takes the click off a jump; a control somebody is dragging needs longer, which is why the
  // length is the caller's to choose rather than fixed here.
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  const drive = engine.tracks.get('t1').slots.get(1).built.params.drive;

  drive.calls.length = 0;
  engine.setParam('t1', 1, 'Drive', 0.5, 0);
  const quick = drive.calls.find((c) => c.kind === 'ramp');
  assert.equal(quick.value, 0.5);
  // Five milliseconds of lookahead before the ten of glide: a change asked for "now" is placed
  // just past where the audio thread has already got to, so the ramp joins the curve rather
  // than stepping off a value the thread rendered a moment ago (see rampParam).
  assert.ok(Math.abs(quick.time - 0.015) < 1e-9, `the default glide is ten milliseconds after the lookahead, got ${quick.time}`);

  drive.calls.length = 0;
  engine.setParam('t1', 1, 'Drive', 0.75, 0, 0.03);
  const slow = drive.calls.find((c) => c.kind === 'ramp');
  assert.ok(Math.abs(slow.time - 0.035) < 1e-9, `an asked-for glide is honored, after the lookahead, got ${slow.time}`);

  // Zero is a step, not a very fast ramp: a mode ramped through sweeps every setting on the way.
  drive.calls.length = 0;
  engine.setParam('t1', 1, 'Drive', 0.25, 0, 0);
  assert.equal(drive.calls.some((c) => c.kind === 'ramp'), false);
  assert.equal(drive.calls.find((c) => c.kind === 'set').value, 0.25);
});

test('a slot reports its device and its current values, which is what a panel is drawn from', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  engine.setParam('t1', 1, 'Drive', 0.5, 0);
  const state = engine.deviceState('t1', 1);
  assert.equal(state.descriptor.id, 'Distort');
  assert.equal(state.values.drive, 12, 'half way up a squared 0..48 dB knob is twelve');
  assert.equal(state.values.mix, state.descriptor.params.find((p) => p.id === 'mix').default, 'an untouched parameter reads as its default');
  assert.equal(engine.deviceState('t1', 5), null, 'an empty slot has no panel to draw');
  assert.equal(engine.deviceState('nonesuch', 0), null);
});

test('a parameter something else is driving is reported, by what is driving it', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  engine.loadEffect('t1', 'Reverb', 2);
  engine.setParamLFO('t1', 1, 'Drive', { shape: 'sine', rateHz: 1, min: 0, max: 40 });
  engine.setParamEnv('t1', 2, 'Mix', { shape: 'sine', rateHz: 1, min: 0, max: 1 });

  const driven = engine.drivenParams('t1', 1);
  assert.deepEqual([...driven], [['drive', 'an lfo']], 'named by the id, whatever spelling the pattern used');
  assert.deepEqual([...engine.drivenParams('t1', 2)], [['mix', 'an envelope']], 'and a slot reports only its own');

  // The panel draws a driven control read-only for exactly this reason: the engine will not set it.
  engine.setParam('t1', 1, 'Drive', 0.25, 0);
  assert.notEqual(engine.deviceState('t1', 1).values.drive, 3);

  engine.clearParamLFO('t1', 1, 'Drive');
  assert.deepEqual([...engine.drivenParams('t1', 1)], []);
});

test('a parameter with an audio signal patched into it reads as driven too', () => {
  const { engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.connectParam('t1', 0, 'Osc 1 Phase', 'mod');
  assert.deepEqual([...engine.drivenParams('t1', 0)], [['osc1.phase', 'an audio signal']]);
});

test('a named pack arrives from the scheduler as sp:<id> and is looked up by its bare id', () => {
  const buffer = { duration: 2, length: 96000, sampleRate: 48000 };
  const asked = [];
  const store = { get: (pack, index) => { asked.push([pack, index]); return pack === 'pt_kit' ? buffer : null; } };
  const { engine } = makeEngine({ samples: store });
  engine.createTrack('t1');
  assert.equal(engine.playSample('t1', 'sp:pt_kit', { index: 2 }, 0, 1).skipped, undefined, 'sp("pt_kit:2") plays');
  assert.equal(engine.playSample('t1', 'pt_kit', { index: 2 }, 0, 1).skipped, undefined, 's("pt_kit:2") plays');
  assert.deepEqual(asked, [['pt_kit', 2], ['pt_kit', 2]]);
});

test('a sample plays, and a missing one is reported rather than thrown', () => {
  const buffer = { duration: 2, length: 96000, sampleRate: 48000 };
  const store = { get: (pack) => (pack === 'kit' ? buffer : null) };
  const { engine } = makeEngine({ samples: store });
  engine.createTrack('t1');

  const played = engine.playSample('t1', 'kit', { vel: 0.8, index: 0 }, 0.5, 1);
  assert.equal(played.skipped, undefined);
  assert.equal(played.amp, 0.8);
  assert.equal(played.fileSec, 2);

  assert.deepEqual(engine.playSample('t1', 'nope', {}, 0, 1), { skipped: 'source not ready' });
  // The desktop's words for the same three (osc-engine's playSample), so .log() reads alike.
  assert.deepEqual(engine.playSample('t1', 'kit', { vel: 0 }, 0, 1), { skipped: 'vel 0' });
  assert.deepEqual(engine.playSample('t1', 'kit', { speed: 0 }, 0, 1), { skipped: 'speed 0' });
  assert.deepEqual(engine.playSample('t1', 'kit', { begin: 0.5, end: 0.5 }, 0, 1), { skipped: 'empty begin..end window' });
});

test('a sample note repitches around middle C, as it does on the desktop side', () => {
  const buffer = { duration: 2, length: 96000, sampleRate: 48000 };
  const { ctx, engine } = makeEngine({ samples: { get: () => buffer } });
  engine.createTrack('t1');
  engine.playSample('t1', 'kit', { note: 72, vel: 1 }, 0, 1);
  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  assert.ok(Math.abs(source.playbackRate.value - 2) < 1e-9, 'an octave above middle C should play twice as fast');
});

test('destroying a track takes its modulators and its graph with it', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 1, min: 100, max: 1000 });
  engine.destroyTrack('t1');
  assert.equal(engine.tracks.has('t1'), false);
  assert.equal(engine.modulators.has('t1'), false);
});

test('saw rises and isaw falls, which is poptart own convention and easy to get backwards', () => {
  const saw = renderShape({ shape: 'saw' });
  assert.ok(saw[saw.length - 1] > saw[0], 'saw should rise');
  const isaw = renderShape({ shape: 'isaw' });
  assert.ok(isaw[isaw.length - 1] < isaw[0], 'isaw should fall');
});

test('every shape stays inside its own range, and the range is applied', () => {
  for (const shape of ['sine', 'saw', 'isaw', 'tri', 'square', 'rand', 'perlin']) {
    const unit = renderShape({ shape, seed: 7 });
    for (const v of unit) assert.ok(v >= 0 && v <= 1, `${shape} left 0..1 with ${v}`);
    const ranged = renderRange({ shape, seed: 7, min: -5, max: 5 });
    for (const v of ranged) assert.ok(v >= -5.0001 && v <= 5.0001, `${shape} left its range with ${v}`);
  }
});

test('a drawn shape is read through its breakpoints', () => {
  const points = [[0, 0], [0.5, 1], [1, 0]];
  const rendered = renderShape({ shape: 'custom', points });
  assert.ok(Math.abs(rendered[0]) < 0.01);
  assert.ok(Math.abs(rendered[Math.floor(rendered.length / 2)] - 1) < 0.01);
  assert.ok(rendered[rendered.length - 1] < 0.05);
});

test('a seeded random shape renders the same every time, so a song is reproducible', () => {
  assert.deepEqual([...renderShape({ shape: 'rand', seed: 42 })], [...renderShape({ shape: 'rand', seed: 42 })]);
  assert.notDeepEqual([...renderShape({ shape: 'rand', seed: 42 })], [...renderShape({ shape: 'rand', seed: 43 })]);
});

test('a routing name is the label somebody typed, resolved to the track the host made for it', async () => {
  // The bug this pins: the scheduler passes `audio("kick")` through as the LABEL, the engine
  // keys its tracks by the id the host handed it, and with nothing in between every cross-track
  // route found nothing and warned about a name that was plainly in the buffer.
  const { engine, warnings } = makeEngine();
  engine.setTrackResolver((label) => ({ kick: '#1', bass: '#2' }[label] ?? label));
  engine.createTrack('#1');
  engine.createTrack('#2');
  engine.loadInstrument('#2', 'Wavetable');
  engine.loadEffect('#2', 'Ducker', 1);

  engine.injectAudio('#2', 1, 'kick');
  const held = engine.tracks.get('#2').sidechains.get(1);
  assert.ok(held, 'the label should have resolved to the track');
  assert.ok(engine.tracks.get('#1').panner.reaches(engine.tracks.get('#2').slots.get(1).built.node),
    'and the kick should reach the ducker');
  assert.deepEqual(warnings, []);

  // The same lookup serves a parameter connection and a track reading another track.
  engine.connectParam('#2', 0, 'Osc 1 Phase', 'kick');
  assert.ok(engine.tracks.get('#2').paramConnections.has('0:Osc 1 Phase'));
  engine.setInputSource('#2', 'audio', 'kick');
  assert.ok(engine.tracks.get('#2')._headSource, 'a bare label is a track before it is a bus');

  // A name nothing answers to still warns, by the name that was written, once the evaluation
  // has had time to build whatever it names.
  engine.injectAudio('#2', 1, 'nonesuch');
  assert.equal(warnings.some((w) => w.includes('nonesuch')), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(warnings.some((w) => w.includes('nothing called "nonesuch"')));
});

test('a route naming a track written further down waits for it, and says nothing', async () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('bass');
  engine.loadEffect('bass', 'Ducker', 1);
  engine.loadInstrument('bass', 'Wavetable');
  engine.createTrack('pad');
  // bass: ….fx("Ducker").audio("kick"), a phase patch and a head, all above `kick:`.
  engine.injectAudio('bass', 1, 'kick', 0.5);
  engine.connectParam('bass', 0, 'Osc 1 Phase', 'kick');
  engine.setInputSource('pad', 'audio', 'kick');
  assert.equal(engine.tracks.get('bass').sidechains.size, 0);

  engine.createTrack('kick');
  const kick = engine.tracks.get('kick').panner;
  assert.ok(kick.outputs.includes(engine.tracks.get('bass').sidechains.get(1).level), 'the sidechain is wired when kick arrives');
  assert.ok(engine.tracks.get('bass').paramConnections.get('0:Osc 1 Phase')?.from === kick, 'and the parameter patch');
  assert.equal(engine.tracks.get('pad')._headSource, kick, 'and the head');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(warnings.filter((w) => w.includes('kick')), []);
});

test('a route whose source goes away waits for the name to come back', () => {
  const { engine } = makeEngine();
  engine.createTrack('kick');
  engine.createTrack('bass');
  engine.loadEffect('bass', 'Ducker', 1);
  engine.injectAudio('bass', 1, 'kick', 0.5);
  engine.destroyTrack('kick');
  assert.equal(engine.tracks.get('bass').sidechains.size, 0, 'nothing hangs off a track that is gone');
  engine.createTrack('kick');
  const held = engine.tracks.get('bass').sidechains.get(1);
  assert.ok(engine.tracks.get('kick').panner.outputs.includes(held.level), 'the same label written again feeds it');
  assert.equal(held.level.gain.value, 0.5, 'at the level it was given');
});

test('a waiting route that is cleared stays cleared', () => {
  const { engine } = makeEngine();
  engine.createTrack('bass');
  engine.loadEffect('bass', 'Ducker', 1);
  engine.injectAudio('bass', 1, 'kick');
  engine.clearAudioInject('bass', 1);
  engine.createTrack('kick');
  assert.equal(engine.tracks.get('bass').sidechains.size, 0);
});

test('a sidechain goes in through a level of its own, so .audio() can carry a gain', () => {
  const { engine } = makeEngine();
  engine.createTrack('kick');
  engine.createTrack('bass');
  engine.loadEffect('bass', 'Ducker', 1);
  engine.injectAudio('bass', 1, 'kick', 0.5);
  const held = engine.tracks.get('bass').sidechains.get(1);
  assert.equal(held.level.gain.value, 0.5);
  assert.ok(engine.tracks.get('kick').panner.outputs.includes(held.level));

  // Taken down completely: a half-removed route leaves a track feeding an input nobody reads.
  engine.clearAudioInject('bass', 1);
  assert.equal(engine.tracks.get('bass').sidechains.size, 0);
  assert.equal(engine.tracks.get('kick').panner.outputs.includes(held.level), false);
});

test('an effect with no sidechain says so rather than silently ignoring the route', () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('kick');
  engine.createTrack('bass');
  engine.loadEffect('bass', 'Reverb', 1);
  engine.injectAudio('bass', 1, 'kick');
  assert.equal(engine.tracks.get('bass').sidechains.size, 0);
  assert.ok(warnings.some((w) => w.includes('Reverb') && w.includes('no sidechain input')));
});

test('a device swap carries the sidechain onto the new device, when the new one takes one', () => {
  const { engine } = makeEngine();
  engine.createTrack('kick');
  engine.createTrack('bass');
  engine.loadEffect('bass', 'Ducker', 1);
  engine.injectAudio('bass', 1, 'kick');
  engine.loadEffect('bass', 'Compressor', 1);
  const held = engine.tracks.get('bass').sidechains.get(1);
  assert.ok(held, 'the compressor takes a key too, so the route follows');
  assert.ok(engine.tracks.get('kick').panner.reaches(engine.tracks.get('bass').slots.get(1).built.node));
});

// ---- what the mixer reads ---------------------------------------------------------------------

test('nothing is analyzed until the mixer asks, and turning it off takes the taps out again', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  assert.deepEqual(engine.mixRead(['t1']).levels, {}, 'a read while it is off costs nothing');
  assert.equal(engine.analysis.taps.size, 0);

  engine.setMixMonitor(true);
  const read = engine.mixRead(['t1']);
  assert.ok(read.on);
  assert.deepEqual(Object.keys(read.levels).sort(), ['*', 't1'], 'the strip and the master');
  assert.equal(engine.analysis.taps.size, 2);

  engine.setMixMonitor(false);
  assert.equal(engine.analysis.taps.size, 0, 'off is off: an analyser left running is DSP nobody asked for');
});

test('a strip the desk stops showing hands its analyzer back', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.createTrack('t2');
  engine.setMixMonitor(true);
  engine.mixRead(['t1', 't2']);
  assert.equal(engine.analysis.taps.size, 3);
  engine.mixRead(['t1']);
  assert.deepEqual([...engine.analysis.taps.keys()].sort(), ['*', 't1']);
  // And a track that has gone away is not asked for at all.
  engine.destroyTrack('t1');
  engine.mixRead(['t1']);
  assert.deepEqual([...engine.analysis.taps.keys()], ['*']);
});

test('past the budget the tracks are not analyzed and the panel is told why', () => {
  const { engine } = makeEngine();
  const ids = Array.from({ length: engine.mixTrackMax() + 1 }, (_, i) => `t${i}`);
  for (const id of ids) engine.createTrack(id);
  engine.setMixMonitor(true);

  const within = engine.mixRead(ids.slice(0, engine.mixTrackMax()));
  assert.equal(within.perTrack, true);
  assert.equal(engine.analysis.taps.size, engine.mixTrackMax() + 1);

  const over = engine.mixRead(ids);
  assert.equal(over.perTrack, false, 'the desk says the plots are the master now');
  assert.equal(over.perTrackMax, engine.mixTrackMax());
  assert.deepEqual(Object.keys(over.levels), ['*'], 'and nothing but the master is tapped');
  assert.equal(engine.analysis.taps.size, 1);
});

test('a tap reads its own track, both sides, and a band per plotted frequency', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.setMixMonitor(true);
  engine.mixRead(['t1']);
  const tap = engine.analysis.taps.get('t1');
  assert.ok(engine.tracks.get('t1').panner.reaches(tap.left), 'the track feeds its own analyser');
  assert.ok(engine.tracks.get('t1').panner.reaches(tap.side), 'and the side channel is built from it');

  // A full-scale left and a quiet right: the levels come back per side rather than summed.
  tap.left.feed(1, -6);
  tap.right.feed(0.25, -40);
  const read = engine.mixRead(['t1']);
  const level = read.levels.t1[0];
  assert.equal(level.peakL, 1);
  assert.equal(level.peakR, 0.25);
  assert.ok(level.rmsL > level.rmsR);

  const frame = read.spec.t1;
  assert.equal(frame.length, engine.mixBandFreqs().length, 'a band per frequency the panel draws');
  assert.equal(frame[0].length, 4, 'left, right, mid and side');
  assert.ok(Math.abs(frame[0][0] - 10 ** (-6 / 20)) < 1e-6, 'reported as an amplitude, not decibels');
  assert.ok(frame[0][0] > frame[0][1], 'the loud side reads louder');
});

test('the band centers span the audible range, lowest first, evenly in pitch', () => {
  const { engine } = makeEngine();
  const freqs = engine.mixBandFreqs();
  assert.equal(freqs.length, 96);
  assert.equal(freqs[0], 30);
  assert.equal(freqs[freqs.length - 1], 17000);
  for (let i = 1; i < freqs.length; i++) assert.ok(freqs[i] > freqs[i - 1], 'lowest first');
  // Log-spaced: every step is the same ratio, which is what lets the panel plot them evenly.
  const ratio = freqs[1] / freqs[0];
  assert.ok(Math.abs(freqs[50] / freqs[49] - ratio) < 0.02);
});

// A negative speed is the sample backwards - `s("pt_kit:0").speed("-1")`, which the desktop plays
// through a PlayBuf that reads backwards natively. A buffer source cannot: the spec allows a
// negative playbackRate but no browser renders one, so it goes silent. Played here by reversing
// the audio and mirroring the window into it, which sounds the same and is not a silent no-op.
test('a negative speed plays the sample backwards', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => buffer } });
  const buffer = ctx.createBuffer(1, 8, 8); // one second, one sample a step
  buffer.getChannelData(0).set([0, 1, 2, 3, 4, 5, 6, 7]);
  engine.createTrack('t1');

  const played = engine.playSample('t1', 'kit', { speed: -1, vel: 1 }, 0, 10);
  assert.equal(played.skipped, undefined, 'it must play rather than be dropped');
  assert.equal(played.speed, -1, 'and report the speed it was asked for');

  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  assert.deepEqual([...source.buffer.getChannelData(0)], [7, 6, 5, 4, 3, 2, 1, 0]);
  assert.ok(Math.abs(source.playbackRate.value - 1) < 1e-9, 'the rate is the speed of it, not the direction');
});

test('a reversed sample is cut where the window says, entered from the far end', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => buffer } });
  const buffer = ctx.createBuffer(1, 8, 4); // two seconds
  engine.createTrack('t1');

  // .loop(0): one backwards pass. The window is 0.5s..1.0s of a two-second file, so reversed it
  // starts 1.0s from the far end.
  engine.playSample('t1', 'kit', { speed: -1, begin: 0.25, end: 0.5, vel: 1, loop: 0 }, 0, 10);
  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  assert.ok(Math.abs(source.started.offset - 1) < 1e-9, `entered at ${source.started.offset}`);
  assert.ok(Math.abs(source.started.duration - 0.5) < 1e-9, `for ${source.started.duration}`);
});

test('a negative speed loops by default, backwards out of begin round the whole file, as on the desktop', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => buffer } });
  const buffer = ctx.createBuffer(1, 8, 4); // two seconds
  engine.createTrack('t1');
  const info = engine.playSample('t1', 'kit', { speed: -1, begin: 0.25, vel: 1 }, 0, 10);
  assert.equal(info.loop, 1);
  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  assert.equal(source.loop, true);
  assert.ok(Math.abs(source.started.offset - 1.5) < 1e-9, 'entered at begin, mirrored into the reversed copy');
  assert.deepEqual([source.loopStart, source.loopEnd], [0, 2], 'the loop is the whole file');
});

test('the reversed copy of a sample is made once, however many notes play it', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => buffer } });
  const buffer = ctx.createBuffer(1, 8, 8);
  engine.createTrack('t1');

  for (let i = 0; i < 5; i++) engine.playSample('t1', 'kit', { speed: -1, vel: 1 }, i, i + 1);
  const sources = ctx.created.filter((n) => n.kind === 'bufferSource');
  const reversed = new Set(sources.slice(-5).map((n) => n.buffer));
  assert.equal(reversed.size, 1, 'every note reads the same reversed copy');
  assert.notEqual([...reversed][0], buffer, 'and it is not the original');
});

test('a positive speed is untouched by any of that', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => buffer } });
  const buffer = ctx.createBuffer(1, 8, 8);
  engine.createTrack('t1');

  engine.playSample('t1', 'kit', { speed: 2, begin: 0.25, vel: 1 }, 0, 10);
  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  assert.equal(source.buffer, buffer, 'it plays the file it was given');
  assert.ok(Math.abs(source.started.offset - 0.25) < 1e-9, 'from where begin said');
});

// --- the spectrum behind an equalizer's curve ------------------------------------------------


test('a spectrum tap reads the loudest bin of each band, over the audible range', () => {
  const ctx = new FakeAudioContext();
  const source = ctx.createGain();
  const tap = new SpectrumTap(ctx, source);
  assert.equal(tap.freqs.length, SPECTRUM_BAND_FREQS.length);
  assert.ok(Math.abs(tap.freqs[0] - 20) < 1e-9);
  assert.ok(Math.abs(tap.freqs[tap.freqs.length - 1] - 20000) < 1e-6);
  // One harmonic in one bin, at the top of the band: a band up there covers many bins, and an
  // average over them would have buried it.
  const bins = tap.freq.length;
  tap.node.getFloatFrequencyData = (into) => { into.fill(-100); into[Math.round(bins * 0.8)] = -10; };
  const db = tap.bands();
  assert.equal(db.length, tap.freqs.length);
  assert.equal(Math.max(...db), -10, 'the harmonic is read at its level');
  assert.equal(db.filter((v) => v === -10).length, 1, 'in one band');
  tap.dispose();
});

// --- bend, and which outputs a track plays to ---------------------------------------------------

test('.bend() is one constant in semitones: the instrument reads it as a signal, every sample voice as detune', () => {
  const { engine, warnings } = makeEngine({ samples: { get: () => ({ buffer: fakeBuffer(4800), rootNote: 60 }) } });
  engine.loadInstrument('t1', 'Wavetable');
  const track = engine.tracks.get('t1');
  const synth = track.source.node;
  assert.ok(track.bendNode.outputs.includes(synth.parameters.get(TRACK_BEND_PARAM)), 'wired into the instrument\'s bend input');
  engine.setParam('t1', -1, 'bend', 2, 1.5);
  assert.ok(track.bendNode.offset.landedOn(2), 'in semitones');
  assert.deepEqual(synth.messages.filter((m) => m.kind === 'bend'), [], 'a signal, not a message');
  engine.playSample('t1', 'pt_kit', { vel: 1 }, 2, 2.5);
  const voice = engine.ctx.created.filter((n) => n.kind === 'bufferSource').at(-1);
  assert.equal(track.bendCents.gain.value, 100, 'a sample voice\'s detune is in cents');
  assert.ok(track.bendCents.outputs.includes(voice.detune), 'a voice follows the bend while it sounds');
  engine.setParam('t1', -1, 'bend', 12, 0);
  engine.setParam('t1', -1, 'bendrange', 12, 0);
  assert.deepEqual(warnings, [], 'the range is a MIDI matter, and quietly accepted');
});

test('an lfo() on bend drives the track\'s bend constant, and owns it until it is cleared', () => {
  const { engine, warnings } = makeEngine();
  engine.loadInstrument('t1', 'Wavetable');
  const track = engine.tracks.get('t1');
  engine.setParamLFO('t1', -1, 'bend', { shape: 'sine', rateHz: 6, min: -0.3, max: 0.3 });
  const offset = track.bendNode.offset;
  assert.ok(offset.connectedFrom.length > 0, 'the LFO is connected to the bend, in its own semitones');
  const before = offset.calls.length;
  engine.setParam('t1', -1, 'bend', 5, 0);
  assert.equal(offset.calls.length, before, 'a polled bend must not fight the modulator that owns it');
  engine.clearParamLFO('t1', -1, 'bend');
  assert.ok(offset.landedOn(0), 'cleared, the bend comes back to rest rather than where the sweep stopped');
  engine.setParam('t1', -1, 'bend', 1, 0);
  assert.ok(offset.landedOn(1), 'and is the pattern\'s again');
  assert.deepEqual(warnings, []);
});

test('a modulator on a channel control that cannot take one warns rather than doing nothing silently', () => {
  const { engine, warnings } = makeEngine();
  engine.createTrack('t1');
  engine.setParamLFO('t1', -1, 'out', { shape: 'sine', rateHz: 1, min: 1, max: 2 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"out" channel control cannot be driven/);
});

test('an lfo() drives a channel control in its own units, and is let go where it had it', () => {
  const { ctx, engine, warnings } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  const track = engine.tracks.get('t1');
  const lfo = (min, max) => ({ shape: 'sine', rateHz: 1, min, max });
  const targets = {
    gain: track.chainIn.gain, postgain: track.postGain.gain, dry: track.dryGain.gain, width: track.width.gain,
    pan: track.panCtl.offset, wet1: track.wetControl(1).offset, bassmono: track.bassHp.frequency,
  };
  for (const [name, param] of Object.entries(targets)) {
    engine.setParamLFO('t1', -1, name, name === 'bassmono' ? lfo(80, 300) : lfo(-1, 1));
    assert.equal(param.connectedFrom.length, 1, `${name}: the lfo is plugged into it`);
  }
  assert.deepEqual(warnings, []);
  assert.ok(track.sideHigh.gain.rampedTo(1) && track.sideDry.gain.rampedTo(0), 'bass mono driven is bass mono on');

  // A set value does not fight the modulator that owns the control.
  engine.setParam('t1', -1, 'pan', 0.5, 0);
  assert.equal(track.panCtl.offset.rampedTo(0.5), false);

  ctx.advance(0.25);  // a quarter of a sine from its midpoint: the top
  engine.clearParamLFO('t1', -1, 'pan');
  assert.equal(track.panCtl.offset.connectedFrom.length, 0);
  assert.ok(Math.abs(track.panValue - 1) < 1e-3, `left where the lfo had it (${track.panValue})`);
});

test('a grain control an lfo() drives is read at each grain\'s own start', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => ({ buffer: fakeBuffer(48000), rootNote: 60 }) } });
  engine.createTrack('t1');
  engine.setParam('t1', -1, 'grainrate', 40, 0);
  // A saw over 100 ms from a 10 ms grain to a 90 ms one.
  engine.setParamLFO('t1', -1, 'grainsize', { shape: 'saw', rateHz: 10, min: 0.01, max: 0.09 });
  const before = ctx.created.filter((n) => n.kind === 'bufferSource').length;
  engine.playSample('t1', 'pt_kit', { vel: 1, grain: 1 }, 0, 1);
  const grains = ctx.created.filter((n) => n.kind === 'bufferSource').slice(before);
  const sizes = grains.map((g) => Math.round((g.stopped.when - g.started.when - 0.005) * 1000));
  assert.deepEqual(sizes, [10, 30, 50, 70], 'each grain is as long as the saw was when it started');
});

test('.o() puts a track on the pair it names, wrapped at the pairs the output has', () => {
  const { ctx, engine } = makeEngine();
  ctx.destination.maxChannelCount = 8;
  assert.deepEqual(engine.outputChannelChoices(), [2, 4, 6, 8]);
  engine.createTrack('t1');
  const track = engine.tracks.get('t1');
  engine.setParam('t1', -1, 'out', 3, 0);
  assert.ok(track.dryGain.outputs.includes(engine.master), 'stereo: every pair folds onto the first');
  assert.equal(engine.setOutputChannels(6), 6);
  assert.equal(ctx.destination.channelCount, 6);
  const [split] = track._outNodes;
  const merge = track._outNodes[1];
  assert.deepEqual(split.links.filter((l) => l.target === merge).map((l) => [l.output, l.input]), [[0, 4], [1, 5]], '.o(3) is channels 5 and 6');
  engine.setParam('t1', -1, 'out', 4, 0);
  assert.ok(track.dryGain.outputs.includes(engine.master), '.o(4) of three pairs wraps to the first');
  assert.equal(engine.setOutputChannels(7), 6, 'an odd count is taken down to a pair');
});

test('.grain() plays a cloud: a grain every 1/rate seconds, read where the track says, leveled by overlap', () => {
  const { ctx, engine } = makeEngine({ samples: { get: () => ({ buffer: fakeBuffer(48000), rootNote: 60 }) } });
  engine.createTrack('t1');
  engine.setParam('t1', -1, 'grainrate', 40, 0);
  engine.setParam('t1', -1, 'grainsize', 0.05, 0);
  const before = ctx.created.filter((n) => n.kind === 'bufferSource').length;
  const info = engine.playSample('t1', 'pt_kit', { vel: 1, grain: 1, begin: 0.5 }, 0, 1);
  assert.equal(info.grain, true);
  const grains = ctx.created.filter((n) => n.kind === 'bufferSource').slice(before);
  // The first lay reaches 100 ms ahead: at 40 a second that is grains at 0, 25, 50 and 75 ms.
  assert.deepEqual(grains.map((g) => Math.round(g.started.when * 1000)), [0, 25, 50, 75]);
  assert.ok(grains.every((g) => Math.abs(g.started.offset - 0.5) < 1e-9), 'read from the event\'s begin, half way into the file');
  assert.ok(grains.every((g) => Math.abs(g.stopped.when - g.started.when - 0.055) < 1e-9), 'each as long as the grain size');
  // An event's own seed values win for its first grains.
  engine.playSample('t1', 'pt_kit', { vel: 1, grain: 1, grainRate: 10, grainSize: 0.2 }, 0, 1);
  assert.equal(engine.tracks.get('t1').grain.rate, 10);
});

test('a strip control\'s first value is where the track starts; later ones glide', () => {
  // Glided to from the node's default, a new track's first hit played louder than its postgain -
  // by 1.7x at postgain 0.25, measured in the browser.
  const { engine } = makeEngine();
  const track = engine.createTrack('t1');
  engine.setParam('t1', -1, 'postgain', 0.25, 0);
  assert.deepEqual(track.postGain.gain.calls.map((c) => c.kind).filter((k) => k !== 'hold'), ['set'], 'stepped, not ramped from 1');
  engine.setParam('t1', -1, 'postgain', 0.5, 0);
  assert.ok(track.postGain.gain.rampedTo(0.5), 'a change after that glides, so a fader move does not click');
});
