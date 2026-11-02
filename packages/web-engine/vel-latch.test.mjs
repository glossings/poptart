// The bare `vel` in the browser: setParamEnv with `latch: 'vel'` drives the parameter with each
// note-on's velocity, set at the note's own time and held to the next - what poptart_vel does on
// the desktop. A sample is a note to the track's modulators here as it is there.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { LatchConnection } from './src/engine/modulators.mjs';

function makeEngine({ samples = null } = {}) {
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, samples, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog) });
  return { ctx, engine };
}

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const sets = (param, from = 0) => param.calls.slice(from).filter((c) => c.kind === 'set').map((c) => [c.value, c.time]);

function velTrack(ir = {}) {
  const made = makeEngine();
  made.engine.createTrack('t1');
  made.engine.loadInstrument('t1', 'Wavetable');
  made.engine.loadEffect('t1', 'Filter', 1);
  made.engine.setParamEnv('t1', 1, 'Cutoff', { latch: 'vel', min: 0.2, max: 0.6, ...ir });
  return { ...made, cutoff: made.engine.tracks.get('t1').slots.get(1).built.params.cutoff };
}

test('each note-on sets the velocity at its own time, in the range, and a note-off leaves it', () => {
  const { engine, cutoff } = velTrack();
  near(cutoff.value, 0.2, 'rests at its floor before the first note');
  const from = cutoff.calls.length;
  engine.noteOn('t1', 60, 0.5, 1);
  engine.noteOff('t1', 60, 1.4);
  engine.noteOn('t1', 62, 1, 1.5);
  engine.noteOff('t1', 62, 1.9);
  assert.deepEqual(sets(cutoff, from), [[0.4, 1], [0.6, 1.5]]);
  assert.equal(engine.drivenParams('t1', 1).get('cutoff'), 'velocity');
});

test('a chord\'s last note-on wins, as on the desktop', () => {
  const { engine, cutoff } = velTrack({ min: 0, max: 1 });
  const from = cutoff.calls.length;
  engine.noteOn('t1', 60, 0.3, 1);
  engine.noteOn('t1', 64, 0.9, 1);
  assert.deepEqual(sets(cutoff, from).at(-1), [0.9, 1]);
});

test('a new range rewrites the value now and the note-ons still to come', () => {
  const ctx = { currentTime: 0 };
  const calls = [];
  const target = { value: 0, cancelScheduledValues: (t) => calls.push(['cancel', t]), setValueAtTime: (v, t) => calls.push(['set', v, t]) };
  const latch = new LatchConnection(ctx, target, { latch: 'vel', min: 0, max: 1 });
  latch.latch(0.5, 0.1);
  latch.latch(0.25, 0.3);
  ctx.currentTime = 0.2;
  calls.length = 0;
  latch.update({ min: 0.5, max: 1 });
  assert.deepEqual(calls, [['cancel', 0.2], ['set', 0.75, 0.2], ['set', 0.625, 0.3]]);
  near(latch.stop(), 0.75, 'stops where it is');
});

test('an env() and a vel on one parameter are not each other', () => {
  const { engine, cutoff } = velTrack();
  engine.setParamEnv('t1', 1, 'Cutoff', { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.2, min: 0, max: 1 });
  assert.equal(engine.drivenParams('t1', 1).get('cutoff'), 'an envelope');
  const from = cutoff.calls.length;
  engine.noteOn('t1', 60, 0.5, 1);
  assert.ok(cutoff.calls.slice(from).some((c) => c.kind !== 'set'), 'the envelope ramps');
});

test('a sample is a note to the track\'s modulators: its gain is the velocity, and it opens env()', () => {
  const buffer = { duration: 0.5, length: 24000, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(24000) };
  const { engine } = makeEngine({ samples: { get: () => buffer } });
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  engine.loadEffect('t1', 'Filter', 2);
  engine.setParamEnv('t1', 1, 'Cutoff', { latch: 'vel', min: 0, max: 1 });
  engine.setParamEnv('t1', 2, 'Cutoff', { attack: 0.01, decay: 0.01, sustain: 0.5, release: 0.05, min: 0, max: 1 });
  const vel = engine.tracks.get('t1').slots.get(1).built.params.cutoff;
  const env = engine.tracks.get('t1').slots.get(2).built.params.cutoff;
  const velFrom = vel.calls.length;
  const envFrom = env.calls.length;
  assert.equal(engine.playSample('t1', 'kit', { vel: 0.7 }, 1, 1.25).skipped, undefined);
  assert.deepEqual(sets(vel, velFrom), [[0.7, 1]]);
  assert.ok(env.calls.slice(envFrom).some((c) => c.kind !== 'set' && c.time > 1), 'the envelope attacks at the hit');
  assert.equal(engine.held.get('t1'), 0, 'and closes at its end');
  // A silent hit plays nothing, and moves nothing.
  const quiet = vel.calls.length;
  assert.equal(engine.playSample('t1', 'kit', { vel: 0 }, 2, 2.25).skipped, 'vel 0');
  assert.deepEqual(sets(vel, quiet), []);
});
