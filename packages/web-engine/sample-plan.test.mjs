// The sampler's event plan: the desktop's resolution rules (osc-engine's playSample), and the
// browser engine playing a plan - slices, fit, splice, flip, ping-pong loops and the warp voice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectOnsets, planSample, sliceEntryFor } from './src/engine/sample-plan.mjs';
import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';

const file = { duration: 4, rootNote: 60 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('fit makes the whole file last the cycles asked, auto the nearest power of two', () => {
  // A four-second file at two seconds a cycle is two cycles long.
  assert.ok(near(planSample(file, { fit: 4, secPerCycle: 2 }, 0, 1).speed, 0.5), 'fitted to four: half speed');
  assert.ok(near(planSample({ duration: 3 }, { fit: 'auto', secPerCycle: 1 }, 0, 1).speed, 3 / 4), 'three cycles rounds to four');
  // An authored set's fit applies where the chain has none, and loses to one it has.
  assert.ok(near(planSample(file, { secPerCycle: 2 }, 0, 1, { authoredFit: 1 }).speed, 2));
  assert.ok(near(planSample(file, { fit: 4, secPerCycle: 2 }, 0, 1, { authoredFit: 1 }).speed, 0.5));
});

test('a slice indexes the marks, wraps, and waits while the transients are being found', () => {
  const p = planSample(file, { slice: 5 }, 0, 1, { slices: [0, 0.25, 0.5, 0.75] });
  assert.deepEqual([p.begin, p.end], [0.25, 0.5], 'slice 5 of 4 wraps to slice 1');
  assert.deepEqual(planSample(file, { slice: 3 }, 0, 1, { slices: [0, 0.25, 0.5, 0.75] }).end, 1, 'the last runs to the end');
  assert.deepEqual(planSample(file, { slice: 0 }, 0, 1, { slices: undefined }), { skipped: 'analyzing slices' });
  assert.equal(planSample(file, { slice: 0 }, 0, 1, { slices: null }).noSlices, true);
});

test('splice fits the window to its own event, by rate or by stretch', () => {
  // A one-second slice spliced into half a second: twice the speed, or half the stretch.
  const byRate = planSample(file, { splice: 1, begin: 0, end: 0.25 }, 0, 0.5);
  assert.ok(near(byRate.speed, 2));
  const byStretch = planSample(file, { splice: 1, spliceMode: 1, begin: 0, end: 0.25 }, 0, 0.5);
  assert.ok(near(byStretch.speed, 1) && near(byStretch.stretch, 0.5));
});

test('flip reverses and lands on begin at the event end; a negative speed loops unless told not to', () => {
  const flipped = planSample(file, { flip: 1, begin: 0.5 }, 0, 0.5);
  assert.ok(flipped.speed < 0 && flipped.loop === 0, 'a flip is one anchored pass');
  assert.ok(near(flipped.end, 0.5 + 0.5 / 4), 'trimmed to one event of audio past begin');
  assert.equal(planSample(file, { speed: -1 }, 0, 1).loop, 1);
  assert.equal(planSample(file, { speed: -1, loop: 0 }, 0, 1).loop, 0);
});

test('a note repitches around the file\'s own root, or middle C', () => {
  assert.ok(near(planSample(file, { note: 72 }, 0, 1).speed, 2));
  assert.ok(near(planSample({ duration: 1, rootNote: 64 }, { note: 76 }, 0, 1).speed, 2));
});

test('the envelope is in seconds times envscale, with the desktop\'s 50 ms default release', () => {
  const p = planSample(file, { attack: 0.1, decay: 0.2, sustain: 0.5, envScale: 2 }, 0, 1);
  assert.deepEqual([p.attack, p.decay, p.sustain, p.release], [0.2, 0.4, 0.5, 0.1]);
});

test('an authored set speaks for the files it names, and a bare list for any', () => {
  assert.deepEqual(sliceEntryFor([0, 0.5], 'x/y.wav'), { marks: [0, 0.5], fit: null });
  assert.deepEqual(sliceEntryFor({ 'kit/break.wav': { marks: [0, 0.5], fit: 2 } }, 'kit/break.wav'), { marks: [0, 0.5], fit: 2 });
  assert.equal(sliceEntryFor({ 'kit/break.wav': [0, 0.5] }, 'kit/other.wav'), null);
});

test('the transient detector finds the hits of a drum loop', () => {
  const sr = 48000;
  const samples = new Float32Array(sr * 2);
  for (const hit of [0.5, 1.0, 1.5]) for (let i = 0; i < 2400; i++) samples[Math.round(hit * sr) + i] = Math.exp(-i / 480) * (i % 2 ? 1 : -1);
  const onsets = detectOnsets(samples, sr);
  assert.equal(onsets[0], 0);
  const found = onsets.slice(1).map((o) => o * 2);
  assert.equal(found.length, 3);
  for (const [k, hit] of [0.5, 1.0, 1.5].entries()) assert.ok(Math.abs(found[k] - hit) < 0.05, `hit at ${hit}, found ${found[k]}`);
});

// --- played -------------------------------------------------------------------------------------

function rig() {
  const ctx = new FakeAudioContext();
  const buffer = ctx.createBuffer(1, 16000, 4000); // four seconds
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog), samples: { get: () => buffer, fileKey: () => 'kit/loop.wav' } });
  engine.createTrack('t1');
  const sources = () => ctx.created.filter((n) => n.kind === 'bufferSource');
  return { ctx, engine, buffer, sources };
}

test('a ping-pong loop plays its window forwards then backwards, as one buffer', () => {
  const { engine, sources } = rig();
  engine.playSample('t1', 'kit', { loop: 1, loopWrap: 1, loopDir: 1, begin: 0.25, end: 0.5 }, 0, 4);
  const src = sources().at(-1);
  assert.equal(src.loop, true);
  assert.equal(src.buffer.length, 2 * 4000, 'the window twice: there and back');
});

test('an authored slice set plays its marks for the file it names', () => {
  const { engine, sources } = rig();
  const info = engine.playSample('t1', 'kit', { slice: 1, slices: { 'kit/loop.wav': [0, 0.5, 0.75] }, loop: 0 }, 0, 4);
  assert.deepEqual([info.begin, info.end], [0.5, 0.75]);
  const src = sources().at(-1);
  assert.ok(near(src.started.offset, 2) && near(src.started.duration, 1));
});

test('a stretch plays through the warp voice: grains along a pointer, at the rate', () => {
  const { engine, sources } = rig();
  const before = sources().length;
  const info = engine.playSample('t1', 'kit', { stretch: 2, begin: 0, end: 0.25 }, 0, 10);
  assert.equal(info.stretch, 2);
  const grains = sources().slice(before);
  // The first lay covers 100 ms: eight overlaps of a 100 ms grain is 80 a second - eight, or
  // nine where the running sum lands a hair inside the horizon.
  assert.ok(grains.length === 8 || grains.length === 9, `${grains.length} grains`);
  assert.ok(grains.every((g) => g.playbackRate.value === 1), 'the pitch is the rate');
  assert.ok(grains[7].started.offset > grains[0].started.offset - 0.01, 'the pointer walks forward');
});

test('a recording cut as a held note loops its sustain section until the note ends', () => {
  const ctx = new FakeAudioContext();
  const buffer = ctx.createBuffer(1, 4000, 4000); // one second
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog), samples: { get: () => ({ buffer, rootNote: 60, loop: { start: 1000, end: 3000 } }) } });
  engine.createTrack('t1');
  const info = engine.playSample('t1', 'keys', { note: 60 }, 0, 5);
  const src = ctx.created.filter((n) => n.kind === 'bufferSource').at(-1);
  assert.equal(info.sustainLoop, true);
  assert.equal(src.loop, true);
  assert.deepEqual([src.loopStart, src.loopEnd], [0.25, 0.75]);
  assert.ok(src.stopped.when > 5, 'held to the note\'s end and released after it');
  // Asked to play backwards, or told to loop, it does as it is told instead.
  assert.equal(engine.playSample('t1', 'keys', { note: 60, loop: 0, speed: -1 }, 0, 5).sustainLoop, undefined);
});
