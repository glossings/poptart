// The sampler's event plan: the desktop's resolution rules (osc-engine's playSample), and the
// browser engine playing a plan - slices, fit, splice, flip, ping-pong loops and the warp voice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectOnsets, planSample, sliceEntryFor } from './src/engine/sample-plan.mjs';
import * as core from '../pattern-core/src/index.mjs';
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

test('a stretch plays through the warp voice: one worklet, a pointer over the window, at the rate', () => {
  const { engine } = rig();
  const before = engine.ctx.created.length;
  const info = engine.playSample('t1', 'kit', { stretch: 2, begin: 0, end: 0.25 }, 0, 10);
  assert.equal(info.stretch, 2);
  const made = engine.ctx.created.slice(before);
  assert.equal(made.filter((n) => n.kind === 'bufferSource').length, 0, 'no node per grain');
  const voices = made.filter((n) => n.processorName === 'poptart-grains');
  assert.equal(voices.length, 1);
  const o = voices[0].options.processorOptions;
  assert.equal(o.mode, 'warp');
  assert.ok(Math.abs(o.rate - 4000 / 48000) < 1e-12, 'the pitch is the rate, in the file\'s own frames');
  assert.deepEqual([o.begin, o.end01], [0, 0.25]);
  assert.ok(Math.abs(o.durSec - info.durSec) < 1e-9, 'the pointer takes the event\'s own time');
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

test('fit by stretch holds the rate and reports its length', () => {
  const p = planSample(file, { fit: 4, fitMode: 1, secPerCycle: 2 }, 0, 1);
  assert.ok(near(p.speed, 1) && near(p.stretch, 2), 'two cycles of file over four: stretch 2, rate 1');
  assert.equal(p.fitCycles, 4);
  assert.equal(planSample(file, { secPerCycle: 2 }, 0, 1).fitCycles, null);
});

// .play() as the scheduler sends it: begin left to the engine through cfg.atLength (see
// pattern-core's withSampleLength), worked out here with the event's sample length.
function beginsOf(sig, from, to, f = { duration: 4.8, rootNote: 60 }) {
  const seen = [];
  const sched = new core.Scheduler(new Proxy(
    { getTime: () => 0, playSample: (trackId, pack, cfg) => { seen.push(cfg); } },
    { get: (t, k) => (k in t ? t[k] : () => {}) },
  ), { trackId: 't', cps: 0.5 });
  sched.setPattern(sig);
  sched._scheduleNoteEdges(from, to);
  return seen.map((cfg) => {
    const p = planSample(f, cfg, 0, 2);
    assert.equal(p.end, 1, 'each plays on to the end of the file, cut at its event');
    return p.begin;
  });
}
const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a}, not ${b}`);

test('.play() plays one slice per cycle, over the fitted length', () => {
  beginsOf(core.s('breaks').fit(4, 'stretch').play(), 0, 4).forEach((b, k) => close(b, k / 4, `cycle ${k}`));
  // The auto fit: 4.8 s at 2 s a cycle is 2.4 cycles, rounded to 2.
  beginsOf(core.s('breaks').fit().play(), 0, 3).forEach((b, k) => close(b, (k % 2) / 2, `auto, cycle ${k}`));
});

test('.play() from cycle 5 reads 5/L; without a fit L is the natural, fractional length', () => {
  close(beginsOf(core.s('breaks').fit(8).play(), 5, 6)[0], 5 / 8, 'fit(8), cycle 5');
  close(beginsOf(core.s('breaks').play(), 1, 2)[0], 1 / 2.4, 'natural 2.4 cycles, cycle 1');
  close(beginsOf(core.s('breaks').play(), 3, 4)[0], 3 / 2.4 - 1, 'natural, wrapped');
});

test('.play() composes with arithmetic on begin, and .seg(4) plays four slices a cycle', () => {
  close(beginsOf(core.s('breaks').fit(4).play().mul(core.begin(0.5)), 3, 4)[0], 0.375, 'mul');
  close(beginsOf(core.s('breaks').fit(4).play().add(core.begin(0.125)), 1, 2)[0], 0.375, 'add');
  beginsOf(core.s('breaks').fit(8).play().seg(4), 1, 2).forEach((b, k) => close(b, (1 + k / 4) / 8, `seg, step ${k}`));
});

test('a control mixing the sample length with dur() reads the event\'s own dur() when the engine resolves it', () => {
  // A one-cycle event at 2 s a cycle lasts 2 s: begin = frac(t / L) + dur() * 0.1 = 1/4 + 0.2.
  close(beginsOf(core.s('breaks').fit(4).play().add(core.begin(core.dur().mul(0.1))), 1, 2)[0], 0.45, 'play + dur');
  // .play().add(dur().mul(0)) is .play().
  close(beginsOf(core.s('breaks').fit(4).play().add(core.begin(core.dur().mul(0))), 1, 2)[0], 0.25, 'play + 0 * dur');
});
