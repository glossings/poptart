// The graph's lifecycle: what happens when a device is replaced, a chain rebuilt, a track
// destroyed, a modulator re-sent.
//
// Every test here stands for something that made no sound and raised no error. That is the
// shape of the whole file: building a graph correctly is easy and is covered elsewhere, and
// REBUILDING one correctly is where the bugs are - a slot rewired without regard for what fed
// it, a node unwired but left running, a connection dropped from a map without being unpicked
// from the graph. None of those throw, and none of them are audible until something goes quiet
// in the middle of a set.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, FakeParam, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { rampParam } from './src/engine/track.mjs';
import { cyclesFor, renderShape } from './src/engine/modulators.mjs';
import { DelayLine } from './src/dsp/reverb.mjs';

function makeEngine() {
  const ctx = new FakeAudioContext();
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  return { ctx, engine, warnings };
}

// ---- the chain ---------------------------------------------------------------------------

test('an instrument keeps reaching the master once effects are added to the track', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  const track = engine.tracks.get('t1');
  engine.loadEffect('t1', 'Filter', 1);
  assert.ok(track.source.output.reaches(track.input), 'the instrument still feeds the track input');
  assert.ok(track.source.output.reaches(engine.master), 'and the track still reaches the master');
  engine.loadEffect('t1', 'Distort', 2);
  engine.unloadEffect('t1', 1);
  assert.ok(track.source.output.reaches(engine.master), 'through every rebuild of the chain around it');
});

test('the effects stay in slot order however they were added', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Reverb', 2);
  engine.loadEffect('t1', 'Distort', 1);
  const track = engine.tracks.get('t1');
  assert.ok(track.chainIn.reaches(track.slots.get(1).built.input), 'slot 1 comes first');
  assert.ok(track.slots.get(1).built.output.reaches(track.slots.get(2).built.input), 'then slot 2');
  assert.ok(track.source.output.reaches(engine.master), 'and the instrument is still heard');
});

// ---- telling a processor to stop ----------------------------------------------------------

test('a replaced device is told to stop, because disconnecting one does not end it', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  const first = engine.tracks.get('t1').slots.get(1).built.node;
  engine.loadEffect('t1', 'Distort', 1);
  assert.ok(first.messages.some((m) => m.kind === 'dispose'), 'the reverb should have been told to stop');
});

test('unloading an effect and destroying a track both stop the processors they take away', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Distort', 1);
  const synth = engine.tracks.get('t1').slots.get(0).built.node;
  const fx = engine.tracks.get('t1').slots.get(1).built.node;
  engine.unloadEffect('t1', 1);
  assert.ok(fx.messages.some((m) => m.kind === 'dispose'));
  engine.destroyTrack('t1');
  assert.ok(synth.messages.some((m) => m.kind === 'dispose'));
});

test('reloading the same device does not stop it, so a re-eval does not cut the sound', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Reverb', 1);
  const node = engine.tracks.get('t1').slots.get(1).built.node;
  engine.loadEffect('t1', 'Reverb', 1);
  assert.equal(node.messages.some((m) => m.kind === 'dispose'), false);
});

test('a device that cannot be built costs that device, not the whole evaluation', () => {
  // This throws from deep in the browser - a processor name nothing registered, a worklet file
  // that did not load - and the frame above it is the scheduler's setPattern, halfway through
  // an evaluation. Letting it out stops every track in the buffer over one bad slot.
  const { engine, warnings } = makeEngine();
  engine.AudioWorkletNodeCtor = class { constructor() { throw new Error('no processor registered'); } };
  engine.createTrack('t1');
  assert.doesNotThrow(() => engine.loadInstrument('t1', 'Wavetable'));
  assert.ok(warnings.some((w) => w.includes('Wavetable') && w.includes('no processor registered')), `warned: ${warnings.join(' | ')}`);
  assert.equal(engine.tracks.get('t1').source, null, 'the slot is left empty rather than half-built');
  assert.doesNotThrow(() => engine.noteOn('t1', 60, 1, 0), 'and a note aimed at it is dropped quietly');
});

// ---- connections onto parameters ----------------------------------------------------------

test('destroying a track unpicks the signals patched onto its parameters', () => {
  const { engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('lead');
  engine.loadInstrument('lead', 'Wavetable');
  engine.connectParam('lead', 0, 'Osc 1 Phase', 'mod', 2, 0.25);
  const conn = engine.tracks.get('lead').paramConnections.get('0:Osc 1 Phase');
  engine.destroyTrack('lead');
  const modPanner = engine.tracks.get('mod').panner;
  assert.equal(modPanner.outputs.includes(conn.scale), false, 'the source should no longer feed the gain');
  assert.ok(conn.bias.stopped, 'and the constant carrying the offset should have been stopped');
});

test('swapping the device in a slot carries what was driving it onto the new device, by name', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  engine.setParamLFO('t1', 1, 'Mix', { shape: 'sine', rateHz: 1, min: 0, max: 1 });
  engine.connectParam('t1', 1, 'Drive', 'mod', 2, 0.25);
  const oldLfo = engine.modulators.get('t1').get('1:Mix');
  const oldConn = engine.tracks.get('t1').paramConnections.get('1:Drive');

  engine.loadEffect('t1', 'Reverb', 1);    // has a Mix, has no Drive
  const track = engine.tracks.get('t1');
  const reverb = track.slots.get(1);
  assert.equal(reverb.descriptor.id, 'Reverb');

  // The old modulator and connection are gone from the graph, not merely from the maps.
  assert.ok(oldLfo.node === null || oldLfo.node.stopped, 'the old LFO source should have been stopped');
  assert.equal(engine.tracks.get('mod').panner.outputs.includes(oldConn.scale), false, 'the old connection should be unpicked');
  assert.ok(oldConn.bias.stopped, 'and its offset source stopped');

  // The LFO follows the name onto the new device; the connection has nowhere to go and says so.
  const carried = engine.modulators.get('t1').get('1:Mix');
  assert.ok(carried && carried !== oldLfo, 'the LFO should have been programmed again');
  assert.ok(carried.node.outputs.includes(reverb.built.node.parameters.get('mix')), 'onto the new device\'s Mix');
  assert.equal(track.paramConnections.size, 0, 'a name the new device lacks is not connected to anything');
  assert.deepEqual([...engine.drivenParams('t1', 1)], [['mix', 'an lfo']]);

  // And the new device's other parameters are ordinary again: nothing stale claims them.
  engine.setParam('t1', 1, 'Decay', 0.5, ctx.currentTime);
  assert.ok(Math.abs(engine.deviceState('t1', 1).values.decay - Math.sqrt(0.05 * 30)) < 1e-6, 'half way up an exp control is its geometric middle');
});

test('unloading an effect takes its modulators down with it', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Distort', 1);
  engine.setParamLFO('t1', 1, 'Mix', { shape: 'sine', rateHz: 1, min: 0, max: 1 });
  const lfo = engine.modulators.get('t1').get('1:Mix');
  engine.unloadEffect('t1', 1);
  assert.ok(lfo.node === null, 'the LFO should have been stopped');
  assert.equal(engine.modulators.get('t1').size, 0);
});

test('swapping a drawn LFO to another of its shapes starts the new one from its beginning, when asked', () => {
  // The scheduler re-bases its phase anchors to the swap, and the desktop starts the new shape
  // from zero there. Carrying the old phase across played b at a's phase until the next anchor
  // dragged it back.
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  const shapes = [
    [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 1 }, { x: 1, y: 0 }],
  ];
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points: shapes[0], shapes, rateHz: 1, min: 0, max: 1 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  ctx.advance(0.3);
  engine.setParamShape('t1', 1, 'Cutoff', 1, ctx.currentTime + 0.1);
  assert.equal(conn.startPhase, 0, 'the new shape starts at its own beginning');
  assert.ok(Math.abs(conn.node.started.when - (ctx.currentTime + 0.1)) < 1e-9, 'at the time the scheduler asked for');
  assert.equal(conn.node.started.offset, 0);
  assert.ok(Math.abs(conn.valueAt(ctx.currentTime + 0.1) - 1) < 1e-3, 'reading the second shape from its top');
  const node = conn.node;
  engine.setParamShape('t1', 1, 'Cutoff', 1, ctx.currentTime + 0.2);
  assert.equal(conn.node, node, 'a swap to the shape already playing changes nothing');
});

test('a swap with a glide eases the step between the two shapes away', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  const shapes = [
    [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 1 }, { x: 1, y: 0 }],
  ];
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points: shapes[0], shapes, rateHz: 1, glide: 0.5, min: 0, max: 1 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  const at = 0.25;
  engine.setParamShape('t1', 1, 'Cutoff', 1, at);
  const glide = conn.glide.node;
  // Shape a was at 0.25 there and shape b starts at 1: the difference, decaying over half a period.
  assert.ok(conn.target.connectedFrom.includes(glide), 'the glide rides on the same parameter');
  assert.equal(glide.started.when, at);
  assert.ok(glide.offset.calls.some((c) => c.kind === 'set' && Math.abs(c.value - -0.75) < 1e-3 && c.time === at));
  assert.ok(glide.offset.rampedTo(0), 'down to nothing');
  assert.ok(Math.abs(conn.valueAt(at) - 0.25) < 1e-3, 'so the parameter does not step at the swap');
  assert.ok(Math.abs(conn.valueAt(at + 0.5) - 0.5) < 1e-3, 'and is on the new shape once the glide is over');
});

// ---- a re-sent modulator -----------------------------------------------------------------------
//
// The scheduler keeps a modulator of the same kind in place across an evaluation and re-sends it.
// A re-send that only moved it must not restart it - that is a click on every evaluation - and one
// that changed what it IS has to be heard.

function lfoOn(engine, ir) {
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', ir);
  return engine.modulators.get('t1').get('1:Cutoff');
}

test('an unchanged LFO re-sent after an evaluation is left running', () => {
  const { engine } = makeEngine();
  const ir = { shape: 'custom', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], mode: 'free', rateHz: 1, phaseCycles: 0, min: 0, max: 1 };
  const conn = lfoOn(engine, ir);
  const node = conn.node;
  engine.setParamLFO('t1', 1, 'Cutoff', { ...ir, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  assert.equal(conn.node, node, 'the same source plays on');
});

test('an LFO re-sent with a new shape plays the new shape', () => {
  const { ctx, engine } = makeEngine();
  const conn = lfoOn(engine, { shape: 'sine', rateHz: 1, phaseCycles: 0, min: 0, max: 1 });
  ctx.advance(0.1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'saw', rateHz: 1, phaseCycles: 0, min: 0, max: 1 });
  assert.equal(engine.modulators.get('t1').get('1:Cutoff'), conn, 'the connection is kept');
  assert.equal(conn.node.buffer.getChannelData(0)[0], 0, 'the buffer is the saw now, from its bottom');
  assert.ok(Math.abs(conn.node.started.when - 0.1) < 1e-9, 'restarted at the phase the new one asks for');
});

test('an LFO re-sent with new drawn points, a new mode or a new seed is rebuilt', () => {
  const { engine } = makeEngine();
  const up = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const down = [{ x: 0, y: 1 }, { x: 1, y: 0 }];
  const conn = lfoOn(engine, { shape: 'custom', points: up, mode: 'free', rateHz: 1, min: 0, max: 1 });
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points: down, mode: 'free', rateHz: 1, min: 0, max: 1 });
  assert.equal(conn.node.buffer.getChannelData(0)[0], 1, 'the new drawing is rendered');
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points: down, mode: 'envelope', rateHz: 1, min: 0, max: 1 });
  assert.equal(conn.mode(), 'envelope');
  assert.equal(conn.node.buffer.length, 2049, 'and the new mode');

  const { engine: e2 } = makeEngine();
  const rand = lfoOn(e2, { shape: 'rand', seed: 3, rateHz: 1, min: 0, max: 1 });
  const before = Array.from(rand.node.buffer.getChannelData(0).slice(0, 4096));
  e2.setParamLFO('t1', 1, 'Cutoff', { shape: 'rand', seed: 4, rateHz: 1, min: 0, max: 1 });
  assert.notDeepEqual(Array.from(rand.node.buffer.getChannelData(0).slice(0, 4096)), before, 'a new seed is a new walk');
});

test('a midicc() or osc() re-sent on another controller listens to the new one', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamCC('t1', 1, 'Cutoff', { device: 'Keys', cc: 74, min: 0, max: 1 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  engine.setParamCC('t1', 1, 'Cutoff', { device: 'Keys', cc: 71, min: 0, max: 1 });
  engine.feedCC('keys', 74, 0.5, 0);
  assert.equal(conn.node.offset.calls.length, 0, 'the old controller is not heard any more');
  engine.feedCC('keys', 71, 0.5, 0);
  assert.ok(conn.node.offset.rampedTo(0.5), 'the new one is');
  assert.equal(engine.feeds.get('cc|keys|74')?.size ?? 0, 0);

  engine.loadEffect('t1', 'Filter', 2);
  engine.setParamOSC('t1', 2, 'Cutoff', { osc: '/a', index: 0, min: 0, max: 1 });
  const osc = engine.modulators.get('t1').get('2:Cutoff');
  engine.setParamOSC('t1', 2, 'Cutoff', { osc: '/b', index: 0, min: 0, max: 1 });
  engine.feedOsc('/a', 0, 0.25, 0);
  assert.equal(osc.node.offset.calls.length, 0);
  engine.feedOsc('/b', 0, 0.25, 0);
  assert.ok(osc.node.offset.rampedTo(0.25));
});

// ---- note-gated drawn LFOs ---------------------------------------------------------------------

test('a retrigger LFO starts again from its phase on every note; a free one ignores notes', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points, mode: 'retrigger', rateHz: 1, phaseCycles: 0.25, min: 0, max: 1 });
  engine.loadEffect('t1', 'Filter', 2);
  engine.setParamLFO('t1', 2, 'Cutoff', { shape: 'custom', points, mode: 'free', rateHz: 1, min: 0, max: 1 });
  const retrig = engine.modulators.get('t1').get('1:Cutoff');
  const free = engine.modulators.get('t1').get('2:Cutoff');
  const freeNode = free.node;
  ctx.advance(0.4);
  engine.noteOn('t1', 60, 1, 0.5);
  assert.ok(Math.abs(retrig.node.started.when - 0.5) < 1e-9, 'restarted at the note');
  assert.equal(retrig.startPhase, 0.25, 'from the phase it was given');
  assert.equal(free.node, freeNode, 'a free LFO keeps its own clock');
  const node = retrig.node;
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.9, 0.6);
  assert.equal(retrig.node, node, 'and a note-gated one is never anchored to the grid');
});

test('an envelope-mode LFO plays once from each note and holds its end', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  const points = [{ x: 0, y: 0.2 }, { x: 0.5, y: 1 }, { x: 1, y: 0.6 }];
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points, mode: 'envelope', rateHz: 2, phaseCycles: 0.5, min: 0, max: 1 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  engine.noteOn('t1', 60, 1, 1);
  const node = conn.node;
  assert.ok(Math.abs(node.started.when - 1) < 1e-9);
  assert.equal(node.started.offset, 0, 'from the beginning, whatever the phase');
  const data = node.buffer.getChannelData(0);
  assert.ok(Math.abs(data[data.length - 1] - 0.6) < 1e-6, 'the last sample is the end of the shape');
  assert.ok(Math.abs(node.loopStart - 2048 / ctx.sampleRate) < 1e-12 && Math.abs(node.loopEnd - 2049 / ctx.sampleRate) < 1e-12, 'and it is all that loops');
  ctx.advance(3);
  assert.ok(Math.abs(conn.valueAt(ctx.currentTime) - 0.6) < 1e-6, 'held there long after the pass');
});

test('in the note-gated modes a shape swap waits for the next note', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  const shapes = [[{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 1 }, { x: 1, y: 0 }]];
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points: shapes[0], shapes, mode: 'retrigger', rateHz: 1, min: 0, max: 1 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  const node = conn.node;
  engine.setParamShape('t1', 1, 'Cutoff', 1, ctx.currentTime + 0.1);
  assert.equal(conn.node, node, 'nothing changes at the step');
  engine.noteOn('t1', 60, 1, 0.5);
  assert.equal(conn.current, 1, 'the note takes the new shape');
  assert.equal(conn.node.buffer.getChannelData(0)[0], 1, 'from its top');
  assert.ok(Math.abs(conn.node.started.when - 0.5) < 1e-9);
});

// ---- letting go of a parameter -----------------------------------------------------------------
//
// A modulator or a patched signal zeroes the parameter it owns, because what arrives adds to it.
// Letting go has to put a value back, or a cleared cutoff sits at the bottom of its range.

test('a cleared LFO leaves the parameter where the LFO had it', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'saw', rateHz: 1, phaseCycles: 0, min: 0.2, max: 0.6 });
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  assert.equal(cutoff.value, 0, 'zeroed while the LFO owns it');
  ctx.advance(0.5);
  engine.clearParamLFO('t1', 1, 'Cutoff');
  assert.ok(Math.abs(cutoff.value - 0.4) < 1e-3, `halfway up the saw is 0.4, not ${cutoff.value}`);
  assert.equal(cutoff.connectedFrom.length, 0);
  const pos = engine.deviceState('t1', 1).values.cutoff;
  assert.ok(Number.isFinite(pos), 'and the slot records the value it was left on');
});

test('a cleared envelope holds where it had got to rather than jumping', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamEnv('t1', 1, 'Cutoff', { attack: 1, decay: 1, sustain: 0.5, release: 1, curve: 0, min: 0, max: 1 });
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  engine.noteOn('t1', 60, 1, 0);
  const before = cutoff.calls.length;
  engine.clearParamEnv('t1', 1, 'Cutoff');
  const after = cutoff.calls.slice(before);
  assert.deepEqual(after.map((c) => c.kind), ['hold'], 'held at now, nothing stepped');
});

test('a cleared midicc() leaves the last value it carried', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamCC('t1', 1, 'Cutoff', { device: 'Keys', cc: 74, min: 0.2, max: 0.6 });
  engine.feedCC('keys', 74, 0.5, 0);
  engine.clearParamCC('t1', 1, 'Cutoff');
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  assert.ok(Math.abs(cutoff.value - 0.4) < 1e-9);
});

test('an unpatched signal hands the parameter back at its last set value', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParam('t1', 1, 'Cutoff', 0.7, ctx.currentTime);
  engine.connectParam('t1', 1, 'Cutoff', 'mod', 1, 0);
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  assert.equal(cutoff.value, 0);
  engine.disconnectParam('t1', 1, 'Cutoff');
  assert.ok(Math.abs(cutoff.value - 0.7) < 1e-9, `back at 0.7, not ${cutoff.value}`);
});

// ---- env() gating ------------------------------------------------------------------------------

function envTrack(ir) {
  const made = makeEngine();
  made.engine.createTrack('t1');
  made.engine.loadInstrument('t1', 'Wavetable');
  made.engine.loadEffect('t1', 'Filter', 1);
  made.engine.setParamEnv('t1', 1, 'Cutoff', { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.2, min: 0, max: 1, ...ir });
  return { ...made, cutoff: made.engine.tracks.get('t1').slots.get(1).built.params.cutoff };
}

test('a chord keeps its envelope open until its last note ends', () => {
  const { engine, cutoff } = envTrack({ curve: 0 });
  const base = cutoff.calls.filter((c) => c.kind === 'hold').length;
  const holds = () => cutoff.calls.filter((c) => c.kind === 'hold').length - base;
  engine.noteOn('t1', 60, 1, 0);
  engine.noteOn('t1', 64, 1, 0);
  assert.equal(holds(), 1, 'the second note of the chord does not retrigger it');
  engine.noteOff('t1', 60, 1);
  assert.equal(holds(), 1, 'nor does the first note off release it');
  engine.noteOff('t1', 64, 1.5);
  assert.equal(holds(), 2, 'the last one does');
  assert.equal(cutoff.calls.at(-1).value, 0, 'down to the floor');
  assert.ok(Math.abs(cutoff.calls.at(-1).time - 1.7) < 1e-9);
});

test('a note landing mid-release attacks from where the envelope is, not from the floor', () => {
  const { engine, cutoff } = envTrack({ curve: 0 });
  engine.noteOn('t1', 60, 1, 0);
  engine.noteOff('t1', 60, 1);         // sustain 0.5, releasing to 0 over 0.2 s
  const before = cutoff.calls.length;
  engine.noteOn('t1', 62, 1, 1.1);     // halfway down: 0.25
  const calls = cutoff.calls.slice(before);
  assert.equal(calls[0].kind, 'hold', 'held where it is');
  assert.equal(calls.some((c) => c.kind === 'set'), false, 'never set back to the floor');
  assert.ok(Math.abs(engine.modulators.get('t1').get('1:Cutoff').valueAt(1.1) - 0.25) < 1e-9);
});

test('an envelope segment follows the curve it was given', () => {
  const { engine, cutoff } = envTrack({ curve: -4 });
  engine.noteOn('t1', 60, 1, 0);
  const attack = cutoff.calls.filter((c) => c.kind === 'ramp' && c.time <= 0.1 + 1e-9);
  assert.ok(attack.length > 1, 'a curve is written as several ramps');
  const first = attack[0];
  assert.ok(first.value > first.time / 0.1 + 0.05, `a -4 curve rises faster than a line at first (${first.value} at ${first.time})`);
  assert.equal(attack.at(-1).value, 1, 'and lands on the peak');
});

test('an envelope made while notes are held starts open', () => {
  const { engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  engine.noteOn('t1', 60, 1, 0);
  engine.setParamEnv('t1', 1, 'Cutoff', { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.2, curve: 0, min: 0, max: 1 });
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  assert.ok(cutoff.rampedTo(1), 'it attacks at once');
});

// ---- taking a track down -----------------------------------------------------------------------

test('destroying a track takes down what feeds it and what it started', () => {
  const { engine } = makeEngine();
  engine.createTrack('src');
  engine.createTrack('t1');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadEffect('t1', 'Ducker', 1);
  const track = engine.tracks.get('t1');
  engine.setInputSource('t1', 'audio', 'bus:drums');
  const bus = engine.buses.get('drums');
  assert.ok(bus.outputs.includes(track.input));
  engine.setParam('t1', -1, 'bend', 2, 0);
  const bend = track.bendNode;
  const hw = new (class { constructor() { this.outputs = []; } connect(n) { this.outputs.push(n); return n; } disconnect() { this.outputs = []; } })();
  engine.setHardwareInput(hw, 2);
  engine.injectAudio('t1', 1, 'dev:Mic', 1, [0, 1]);
  engine.setInputSource('t1', 'midi', 'src', 0, null, null, 0, null);
  engine.tapTrack('t1', true);
  engine.noteOn('src', 60, 1, 0);

  engine.destroyTrack('t1');
  assert.equal(bus.outputs.includes(track.input), false, 'the bus no longer feeds it');
  assert.ok(bend.stopped, 'the bend constant is stopped, not just unplugged');
  assert.equal([...engine._hwRoutes.keys()].some((k) => k.includes('t1')), false, 'its hardware routes are gone');
  assert.equal(engine.midiRoutes.routes.some((r) => r.targetTrackId === 't1'), false, 'and the routes into it');
  assert.equal(engine._taps.has('t1'), false, 'and its recorder tap');
});

test('a track taken away releases the notes it was routing into other tracks', () => {
  const { engine } = makeEngine();
  engine.createTrack('src');
  engine.createTrack('dst');
  engine.loadInstrument('dst', 'Wavetable');
  engine.setInputSource('dst', 'midi', 'src', 0, null, null, 0, null);
  engine.noteOn('src', 60, 1, 0);
  const port = engine.tracks.get('dst').source.node;
  engine.destroyTrack('src');
  assert.ok(port.messages.some((m) => m.kind === 'noteOff' && m.note === 60), 'its off will never come, so it is released');
});

// ---- the bend's connections into voices ----------------------------------------------------------

test('a finished sample voice is unplugged from the track bend as well', () => {
  const buffer = { duration: 1, length: 48000, sampleRate: 48000, numberOfChannels: 1 };
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog), samples: { get: () => buffer } });
  engine.createTrack('t1');
  engine.setParam('t1', -1, 'bend', 1, 0);
  engine.playSample('t1', 'kit', { vel: 1 }, 0, 0.5);
  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  const bend = engine.tracks.get('t1').bendNode;
  assert.ok(bend.outputs.includes(source.detune));
  source.onended();
  assert.equal(bend.outputs.includes(source.detune), false);
});

// ---- hush ----------------------------------------------------------------------------------------

test('hush releases everything a track is sounding, as the desktop does', () => {
  const buffer = { duration: 1, length: 48000, sampleRate: 48000, numberOfChannels: 1 };
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog), samples: { get: () => buffer } });
  engine.createTrack('t1');
  engine.createTrack('dst');
  engine.loadInstrument('t1', 'Wavetable');
  engine.loadInstrument('dst', 'Wavetable');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamEnv('t1', 1, 'Cutoff', { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.2, curve: 0, min: 0, max: 1 });
  engine.setInputSource('dst', 'midi', 't1', 0, null, null, 0, null);
  engine.noteOn('t1', 60, 1, 0);
  engine.noteOn('t1', 64, 1, 0.1);
  engine.noteOff('t1', 64, 0.3);             // ends before the hush: nothing to release
  engine.noteOn('t1', 67, 1, 1.2);           // sent a lookahead early, not begun
  const synth = engine.tracks.get('t1').source.node;
  const dst = engine.tracks.get('dst').source.node;
  const cutoff = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  engine.playSample('t1', 'kit', { vel: 1 }, 0.5, 2);
  const early = ctx.created.filter((n) => n.kind === 'gain').pop();
  ctx.advance(1);

  synth.messages.length = 0;
  dst.messages.length = 0;
  engine.hush('t1', 0.2);
  const offs = synth.messages.filter((m) => m.kind === 'noteOff');
  assert.deepEqual(offs.map((m) => `${m.note}@${m.time}`).sort(), ['60@1', '60@1.2', '67@1', '67@1.2'], 'by name, now and again');
  assert.ok(synth.messages.some((m) => m.kind === 'allNotesOff'));
  assert.equal(cutoff.calls.at(-1).value, 0, 'the envelope is released');
  assert.ok(dst.messages.some((m) => m.kind === 'noteOff' && m.note === 60), 'the notes it routed elsewhere are released there');
  assert.ok(early.gain.rampedTo(0), 'the sample voice fades out');
  // With nothing held any more, the next note opens the envelope again.
  const holds = cutoff.calls.filter((c) => c.kind === 'hold').length;
  engine.noteOn('t1', 60, 1, 2);
  assert.equal(cutoff.calls.filter((c) => c.kind === 'hold').length, holds + 1);
});

test('hush silences a sample voice that was sent early and has not begun', () => {
  const buffer = { duration: 1, length: 48000, sampleRate: 48000, numberOfChannels: 1 };
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog), samples: { get: () => buffer } });
  engine.createTrack('t1');
  engine.playSample('t1', 'kit', { vel: 1 }, 0.1, 0.5);
  const amp = ctx.created.filter((n) => n.kind === 'gain').pop();
  const source = ctx.created.filter((n) => n.kind === 'bufferSource').pop();
  engine.hush('t1');
  assert.deepEqual(amp.gain.calls.slice(-2).map((c) => c.kind), ['cancel', 'set']);
  assert.equal(amp.gain.value, 0);
  assert.equal(source.stopped.when, 0, 'and stopped before it starts');
});

// ---- a parameter move on a browser without cancelAndHoldAtTime -----------------------------

test('a parameter still ramps in a browser with no cancelAndHoldAtTime', () => {
  const param = new FakeParam(100, 'cutoff');
  param.cancelAndHoldAtTime = undefined;      // what Firefox looks like
  rampParam(param, 4000, 1, 0.5);
  assert.ok(param.rampedTo(4000), 'the ramp is the part that matters; the cancel is an optimization');
  assert.equal(param.calls.some((c) => c.kind === 'set'), false, 'and nothing should have stepped the value');
});

// ---- modulator shapes ----------------------------------------------------------------------
//
// The phase origin is the thing worth testing. A shape that is a quarter cycle out still sounds
// like a modulation, so nothing draws attention to it - but the pattern language samples the
// same signal itself for the editor, and the two readings have to agree.

test('sine starts at its midpoint and rises, the same as the pattern language reads it', () => {
  const sine = renderShape({ shape: 'sine' });
  assert.ok(Math.abs(sine[0] - 0.5) < 0.01, `sine should start at its midpoint, not at ${sine[0]}`);
  assert.ok(sine[1] > sine[0], 'and rise from there');
  const quarter = sine[Math.floor(sine.length / 4)];
  assert.ok(Math.abs(quarter - 1) < 0.01, 'peaking a quarter of the way through');
});

test('tri starts at zero and peaks halfway, which is where the desktop side puts it', () => {
  const tri = renderShape({ shape: 'tri' });
  assert.ok(Math.abs(tri[0]) < 0.01);
  assert.ok(Math.abs(tri[Math.floor(tri.length / 2)] - 1) < 0.01);
});

test('square is high for the first half of the cycle', () => {
  const sq = renderShape({ shape: 'square' });
  assert.equal(sq[0], 1);
  assert.equal(sq[Math.floor(sq.length * 0.75)], 0);
});

test('a random shape holds one value per cycle and does not repeat the next cycle', () => {
  const buf = renderShape({ shape: 'rand', seed: 5 });
  const span = cyclesFor('rand');
  const perCycle = buf.length / span;
  for (let i = 1; i < perCycle; i++) {
    assert.equal(buf[i], buf[0], 'a value is held for the whole cycle');
  }
  const seen = new Set();
  for (let c = 0; c < span; c++) seen.add(buf[c * perCycle]);
  assert.ok(seen.size > span * 0.9, `a random modulator that repeats is a rhythm; got ${seen.size} distinct values`);
});

test('perlin drifts rather than stepping, and keeps drifting past the first cycle', () => {
  const buf = renderShape({ shape: 'perlin', seed: 5 });
  const perCycle = buf.length / cyclesFor('perlin');
  let biggestStep = 0;
  for (let i = 1; i < buf.length; i++) biggestStep = Math.max(biggestStep, Math.abs(buf[i] - buf[i - 1]));
  assert.ok(biggestStep < 0.2, `perlin should wander, not jump; biggest step was ${biggestStep}`);
  assert.ok(Math.abs(buf[0] - buf[perCycle * 3]) > 0.01, 'and it should not be back where it started three cycles later');
});

test('anchoring re-pins an ordinary LFO and leaves a random one alone', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 2, min: 200, max: 4000 });
  const sources = () => ctx.created.filter((n) => n.kind === 'bufferSource').length;
  const beforeSine = sources();
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.25, ctx.currentTime);
  assert.ok(sources() > beforeSine, 'an ordinary LFO is restarted at the phase the grid asks for');

  engine.loadEffect('t1', 'Filter', 2);
  engine.setParamLFO('t1', 2, 'Cutoff', { shape: 'rand', rateHz: 2, min: 200, max: 4000 });
  const beforeRand = sources();
  engine.anchorParamLFO('t1', 2, 'Cutoff', 0.25, ctx.currentTime);
  assert.equal(sources(), beforeRand, 'pinning a random walk to a phase would make it repeat at the anchor rate');
});

test('an anchor a lookahead ahead keeps the old LFO source on the parameter until the new one starts', () => {
  // The scheduler anchors every few seconds, at a time a lookahead ahead of now. Unplugging the
  // old source at the time of the call left the parameter with nothing on it until the new one
  // started: a hundred and fifty milliseconds at its intrinsic zero, which on a cutoff is a drop
  // to twenty hertz, every four seconds, at anchors that otherwise change nothing.
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 2, min: 200, max: 4000 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  const previous = conn.node;
  const at = ctx.currentTime + 0.15;
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.25, at);
  assert.notEqual(conn.node, previous, 'the anchor builds a new source');
  assert.ok(Math.abs(conn.node.started.when - at) < 1e-9, 'which starts at the time asked for');
  assert.ok(Math.abs(previous.stopped.when - at) < 1e-9, 'and the old one stops at that same time');
  assert.ok(conn.target.connectedFrom.includes(previous), 'the old source is still on the parameter until then');
  assert.ok(conn.target.connectedFrom.includes(conn.node), 'alongside the new one');
  previous.onended();
  assert.ok(!conn.target.connectedFrom.includes(previous), 'and is unplugged once it has stopped');
  assert.ok(conn.target.connectedFrom.includes(conn.node), 'leaving the new one in place');
});

test('an LFO whose range is swept keeps the phase it had reached', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 1, phaseCycles: 0.25, min: 200, max: 4000 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  assert.ok(Math.abs(conn.startPhase - 0.25) < 1e-9, 'it starts where it was asked to');
  ctx.advance(0.5);
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'sine', rateHz: 1, phaseCycles: 0.25, min: 200, max: 6000 });
  assert.ok(Math.abs(conn.startPhase - 0.75) < 1e-9, `half a second later at 1 Hz it should be at 0.75, not ${conn.startPhase}`);
});

// ---- the reverb's modulated delay ----------------------------------------------------------

test('a delay line reads between samples, so a moving length moves smoothly', () => {
  const line = new DelayLine(64);
  for (let i = 0; i < 32; i++) line.write(i);
  // The most recent sample written is at delay 1, so delay d holds the value 32 - d.
  assert.equal(line.read(1), 31);
  assert.equal(line.read(2), 30);
  assert.ok(Math.abs(line.readLinear(1.5) - 30.5) < 1e-9, 'halfway between two samples is halfway between their values');
  assert.ok(Math.abs(line.readLinear(1) - 31) < 1e-9, 'and a whole delay still reads exactly');
});
