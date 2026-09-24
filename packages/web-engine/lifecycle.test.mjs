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

test('swapping a drawn LFO to another of its shapes keeps its phase and lands when asked', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  const shapes = [
    [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 1 }, { x: 1, y: 0 }],
  ];
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'custom', points: shapes[0], shapes, rateHz: 1, min: 200, max: 4000 });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  ctx.advance(0.3);
  engine.setParamShape('t1', 1, 'Cutoff', 1, ctx.currentTime + 0.1);
  assert.ok(Math.abs(conn.startPhase - 0.4) < 1e-9, `at 1 Hz, 0.4 s in, the new shape should start at phase 0.4, not ${conn.startPhase}`);
  assert.ok(Math.abs(conn.node.started.when - (ctx.currentTime + 0.1)) < 1e-9, 'and start at the time the scheduler asked for');
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
