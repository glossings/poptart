// Branches and bands in the browser engine: a routing plan (pattern-core's route.mjs) wired on one
// track, each crossover of a .bands() a Crossover device the track keeps (never one of its slots). The graphs are rendered offline
// from the fake context's record of who feeds whom (fake-render.mjs), by the spec's formulas and
// the Crossover's own processor - so what is checked is the sound: a clean branch and a filtered
// one add up, bands nobody touches sum back to the input, a branch's level and pan are the strip's
// law, and a crossover's frequency is a device control like any other.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { renderFake } from './fake-render.mjs';
import { catalog } from './src/catalog.mjs';
import { Track } from './src/engine/track.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { CROSSOVER, CrossoverProcessor, CROSSOVER_MIN_HZ, CROSSOVER_MAX_HZ } from './src/devices/crossover.mjs';
import { normalize } from './src/descriptor.mjs';
import * as core from '../pattern-core/src/index.mjs';

const { note, s, sine, routePlan } = core;

const SR = 48000;

function rig() {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const master = ctx.createGain();
  const track = new Track(ctx, 't', master, catalog);
  return { ctx, track };
}

function engineRig() {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, routeWaitMs: 1, AudioWorkletNode: fakeWorkletFor(catalog) });
  return { ctx, engine };
}

/**
 * A chain on a track of `engine`, as the scheduler would leave it at time 0: the devices of the
 * catalog it names loaded in their slots, every .param() at its value then, the plan wired and its
 * levels and pans set.
 */
function play(engine, sig, id = 't') {
  engine.createTrack(id);
  assert.ok(!sig.fxChain.includes('Crossover'), 'a crossover is never in the chain');
  sig.fxChain.forEach((device, i) => { if (catalog.get(device)) engine.loadEffect(id, device, i + 1); });
  for (const { slot, name, sig: value } of Object.values(sig.paramSignals)) engine.setParam(id, slot, name, value.sample(0, 1, 0), 0);
  const { plan, controls } = routePlan(sig);
  engine.setRouting(id, plan);
  const track = engine.tracks.get(id);
  for (const [name, c] of Object.entries(controls)) track.setChannel(name, c.sample(0, 1, 0), 0, 0);
  return track;
}

const DEVICES = { [CROSSOVER.processor]: { descriptor: CROSSOVER, make: (sr) => new CrossoverProcessor(sr) } };

const sineWave = (hz, frames, amp = 0.5) => Float64Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));

/** The strip's input (the chain's last node) rendered for a stereo input fed at the chain input. */
function render(ctx, track, input, frames) {
  return renderFake(ctx, track.postGain, { frames, inject: new Map([[track.chainIn, input]]), devices: DEVICES });
}

const rms = (x, from = 0) => {
  let p = 0;
  for (let i = from; i < x.length; i++) p += x[i] * x[i];
  return Math.sqrt(p / (x.length - from));
};
const db = (a, b) => 20 * Math.log10(a / b);

/** A sine's amplitude in `x`, by quadrature over the whole cycles after `from`. */
function amplitude(x, hz, from) {
  const cycles = Math.floor(((x.length - from) * hz) / SR);
  const n = Math.round((cycles * SR) / hz);
  let c = 0;
  let q = 0;
  for (let i = from; i < from + n; i++) {
    const w = (2 * Math.PI * hz * i) / SR;
    c += x[i] * Math.cos(w);
    q += x[i] * Math.sin(w);
  }
  return (2 * Math.hypot(c, q)) / n;
}

// The reference: the cookbook's lowpass/highpass at Butterworth Q, written out on its own, so the
// wiring is checked against arithmetic rather than against itself.
function bq(x, type, f0) {
  const w0 = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const c = Math.cos(w0);
  const [b0, b1, b2] = type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + alpha;
  const y = new Float64Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 + 2 * c * y1 - (1 - alpha) * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const lr4 = (x, type, f) => bq(bq(x, type, f), type, f);

test('a clean branch and a band of the signal add up, sample for sample', () => {
  const { ctx, engine } = engineRig();
  // The clean signal, plus the low band of a 1 kHz crossover at half level.
  const sig = s('x').split((x) => x, (b) => b.bands([1000], (low) => low.postgain(0.5), (high) => high.postgain(0)));
  const track = play(engine, sig);
  const frames = 4096;
  const x = sineWave(700, frames);
  const [l, r] = render(ctx, track, [x, x], frames);
  const want = lr4(x, 'lowpass', 1000).map((v, i) => x[i] + 0.5 * v);
  for (let i = 0; i < frames; i++) {
    assert.ok(Math.abs(l[i] - want[i]) < 1e-9, `sample ${i}: ${l[i]} vs ${want[i]}`);
    assert.ok(Math.abs(r[i] - want[i]) < 1e-9);
  }
});

test('a send written inside a band taps that band: the low band alone reaches its bus', () => {
  const { ctx, engine } = engineRig();
  const sig = s('x').bands([1000], (low) => low.bus('lows'), (high) => high).bus('all');
  const track = play(engine, sig);
  engine.setBusSends('t', [{ name: 'lows', amount: 1, i: 0 }, { name: 'all', amount: 1, i: 1 }]);
  const frames = 4096;
  const x = sineWave(700, frames);
  const [l, r] = renderFake(ctx, engine.buses.get('lows'), { frames, inject: new Map([[track.chainIn, [x, x]]]), devices: DEVICES });
  const want = lr4(x, 'lowpass', 1000);
  for (let i = 0; i < frames; i++) {
    assert.ok(Math.abs(l[i] - want[i]) < 1e-9, `sample ${i}: ${l[i]} vs ${want[i]}`);
    assert.ok(Math.abs(r[i] - want[i]) < 1e-9);
  }
  assert.ok(track.sendFader.outputs.includes(track.sends.get('all')), 'the send after the last device is the post-fader one');
  assert.ok(track.sendPoints.get(0).fader.outputs.includes(track.sends.get('lows')), 'the tapped one leaves from its point');
});

test('bands nobody touches sum back to the input - flat, within the crossovers\' all-pass', () => {
  const { ctx, engine } = engineRig();
  const sig = s('x').bands([250, 2500], (low) => low, (mid) => mid, (high) => high);
  const track = play(engine, sig);
  const frames = SR / 4;
  for (const hz of [40, 120, 250, 800, 2500, 6000, 12000]) {
    const x = sineWave(hz, frames);
    const [l] = render(ctx, track, [x, x], frames);
    const level = db(amplitude(l, hz, frames / 2), 0.5);
    assert.ok(Math.abs(level) < 0.001, `${hz} Hz comes out at ${level.toFixed(4)} dB`);
  }
});

test('four bands sum flat too: each crossover\'s key carries everything below it', () => {
  const { ctx, engine } = engineRig();
  const sig = s('x').bands([120, 900, 6000], (a) => a, (b) => b, (c) => c, (d) => d);
  const track = play(engine, sig);
  const frames = SR / 4;
  for (const hz of [50, 120, 400, 900, 3000, 6000, 15000]) {
    const x = sineWave(hz, frames);
    const [l] = render(ctx, track, [x, x], frames);
    const level = db(amplitude(l, hz, frames / 2), 0.5);
    assert.ok(Math.abs(level) < 0.001, `${hz} Hz comes out at ${level.toFixed(4)} dB`);
  }
});

test('the bands are the isolator\'s: the low band through the upper crossover\'s all-pass', () => {
  const { ctx, engine } = engineRig();
  const sig = s('x').bands([250, 2500], (low) => low, (mid) => mid.postgain(0), (high) => high.postgain(0));
  const track = play(engine, sig);
  const frames = 4096;
  const x = sineWave(180, frames);
  const [l] = render(ctx, track, [x, x], frames);
  const low = lr4(x, 'lowpass', 250);
  const want = lr4(low, 'lowpass', 2500).map((v, i) => v + lr4(low, 'highpass', 2500)[i]);
  for (let i = 0; i < frames; i += 7) assert.ok(Math.abs(l[i] - want[i]) < 1e-9, `sample ${i}`);
});

test('a branch\'s level and pan are the strip\'s law: hard left is the left side at +3 dB', () => {
  const { ctx, engine } = engineRig();
  const sig = note('c2').synth('X').split((b) => b.bands([100], (l) => l.postgain(0), (h) => h.pan(-1).postgain(0.5)));
  const track = play(engine, sig);
  const frames = 8192;
  const x = sineWave(5000, frames);
  const [l, r] = render(ctx, track, [x, x], frames);
  assert.ok(Math.abs(db(rms(l, 4096), rms(x, 4096)) - db(0.5 * Math.SQRT2, 1)) < 0.05, 'left at 0.5 x sqrt(2)');
  assert.ok(rms(r, 4096) < 1e-9, 'nothing on the right');
});

test('a crossover is the track\'s, not a slot: rewiring keeps it, and its frequency control', () => {
  const { engine } = engineRig();
  const sig = s('x').bands([300], (l) => l.fx('Filter'), (h) => h);
  const track = play(engine, sig);
  assert.deepEqual([...track.slots.keys()], [1], 'the user\'s Filter, in the user\'s slot 1, and nothing else');
  assert.equal(track.slots.get(1).descriptor.id, 'Filter');
  assert.deepEqual(Object.keys(track.state()), ['1'], 'no crossover in what a preset or a panel reads');
  const device = track.crossovers.get('x1');
  assert.equal(device.node.processorName, CROSSOVER.processor);
  const freq = device.node.parameters.get('frequency');
  const ctl = track.routeControl('xo1');
  assert.ok(ctl.outputs.includes(freq), 'its frequency is the xo1 control');
  assert.ok(Math.abs(ctl.offset.value - normalize(CROSSOVER.params[0], 300)) < 1e-9, 'set to 300 Hz, as a position');
  track.setRouting(routePlan(sig).plan);
  assert.equal(track.crossovers.get('x1'), device, 'the same device: a modulator on it stays connected');
  track.setRouting(null);
  assert.equal(track.crossovers.size, 0, 'and let go with the bands');
});

test('the Crossover is in no catalog a user or a completion reads', () => {
  assert.equal(catalog.get('Crossover'), null);
  assert.ok(!catalog.list('fx').some((d) => d.id === 'Crossover'));
});

test('the Crossover\'s range is the one pattern-core converts frequencies by', () => {
  assert.equal(CROSSOVER_MIN_HZ, core.CROSSOVER_MIN_HZ);
  assert.equal(CROSSOVER_MAX_HZ, core.CROSSOVER_MAX_HZ);
  assert.equal(CROSSOVER.params[0].min, core.CROSSOVER_MIN_HZ);
  assert.equal(CROSSOVER.params[0].max, core.CROSSOVER_MAX_HZ);
  assert.equal(CROSSOVER.params[0].curve, 'lin');
  assert.equal(CROSSOVER.id, core.CROSSOVER_DEVICE);
});

test('back to the plain line with null: the chain is a line again', () => {
  const { ctx, track } = rig();
  const sig = s('x').split((x) => x, (x) => x);
  track.setRouting(routePlan(sig).plan);
  track.setRouting(null);
  const frames = 512;
  const x = sineWave(1000, frames);
  const [l] = render(ctx, track, [x, x], frames);
  for (let i = 0; i < frames; i++) assert.ok(Math.abs(l[i] - x[i]) < 1e-12);
});

test('a device in a branch is a slot of the track: it reads its branch and feeds the sum', () => {
  const { engine } = engineRig();
  engine.createTrack('lead');
  engine.loadEffect('lead', 'LPG', 1);
  engine.loadEffect('lead', 'LPG', 2);
  const sig = note('c2').synth('X').split((x) => x, (b) => b.fx('LPG'), (b) => b.fx('LPG').postgain(0.7));
  engine.setRouting('lead', routePlan(sig).plan);
  const track = engine.tracks.get('lead');
  const one = track.slots.get(1).built;
  const two = track.slots.get(2).built;
  assert.ok(track.chainIn.reaches(one.input), 'the first gate reads the chain input');
  assert.ok(track.chainIn.reaches(two.input), 'so does the second');
  assert.ok(one.output.reaches(track.postGain), 'and both reach the strip');
  assert.ok(two.output.reaches(track.postGain));
  // A routed note lands on the gate in the branch, as it would in a plain chain.
  engine.injectMidi('lead', 2, 'lead');
  engine.noteOn('lead', 48, 0.9, 0);
  assert.ok(two.node.messages.some((m) => m.kind === 'noteOn' && m.note === 48), 'the second gate is struck');
  assert.ok(!one.node.messages.some((m) => m.kind === 'noteOn'), 'and only the one the notes were routed to');
});

test('a crossover takes an lfo() natively and a pattern by its steps, as any channel control does', () => {
  const { engine } = engineRig();
  const sig = s('x').bands([sine(0.5).range(300, 3000), '<250 4000>'], (l) => l, (m) => m, (h) => h);
  const { controls } = routePlan(sig);
  const track = play(engine, sig, 'd');
  // The lfo on the first crossover drives that crossover's constant - the one its device reads.
  engine.setParamLFO('d', -1, 'xo1', controls.xo1.lfoIR);
  const lfo = engine.modulators.get('d').get('-1:xo1');
  assert.ok(lfo, 'the lfo was set up');
  assert.equal(lfo.target, track.routeControl('xo1').offset);
  // The pattern on the second steps between its values, a cycle each.
  engine.setParam('d', -1, 'xo2', controls.xo2.sample(0, 1, 0), 0.1);
  engine.setParam('d', -1, 'xo2', controls.xo2.sample(1, 1, 1), 2.1);
  const offset = track.routeControl('xo2').offset;
  const at = (hz) => normalize(CROSSOVER.params[0], hz);
  assert.ok(offset.landedOn(at(250), 1e-9) && offset.landedOn(at(4000), 1e-9), JSON.stringify(offset.calls));
});

test('a plan the build cannot wire leaves the track playing its line', () => {
  const ctx = new FakeAudioContext({ sampleRate: SR });
  const warnings = [];
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: (w) => warnings.push(w), routeWaitMs: 1, AudioWorkletNode: fakeWorkletFor(catalog) });
  engine.setRouting('t', { reads: {}, out: { s: { k: 'sum', id: '9' }, g: 0 }, sums: { 9: null } });
  engine.setRouting('t', { out: 3 });
  assert.equal(engine.tracks.get('t').routing, null);
  assert.ok(warnings.some((w) => /could not be wired/.test(w)));
});

// ---- a chain in the Delay's feedback loop -------------------------------------------------------

const loopMessages = (built) => built.node.messages.filter((m) => m.kind === 'loop').map((m) => m.sec);

test('a chain in the Delay\'s loop: its repeats go out, through the chain, and back in through a delay of 0', () => {
  const { engine } = engineRig();
  const sig = note('c2').synth('X').fx('Delay', (x) => x.fx('Filter'));
  const track = play(engine, sig);
  const filter = track.slots.get(1).built;
  const delay = track.slots.get(2).built;
  const out = delay.node.links.find((l) => l.output === 1);
  assert.ok(out, 'the Delay\'s second output is wired');
  assert.ok(out.target.reaches(filter.input), 'into the chain');
  // Back into the Delay's second input, through a DelayNode of 0 (held to a quantum by the browser).
  const back = track.ctx.created.find((n) => n.kind === 'delay' && n.links?.some((l) => l.target === delay.node && l.input === 1));
  assert.ok(back, 'the chain comes back into the Delay\'s key through a delay node');
  assert.equal(back.delayTime.value, 0);
  assert.ok(filter.output.reaches(back), 'what comes back is the chain\'s end');
  assert.ok(delay.output.reaches(track.postGain), 'the Delay\'s own output goes on to the strip');
  assert.deepEqual(loopMessages(delay).at(-1), 128 / SR, 'it is told the way round is one render quantum');
});

test('the way round counts the delay of each device in the loop, and goes when the chain does', () => {
  const { engine } = engineRig();
  const late = catalog.get('Voice').latencySec;
  assert.ok(late > 0);
  const sig = note('c2').synth('X').fx('Delay', (x) => x.fx('Voice').fx('Filter'));
  const track = play(engine, sig);
  const delay = track.slots.get(3).built;
  assert.equal(loopMessages(delay).at(-1), 128 / SR + late);
  // Re-evaluated without the function: no loop, and the Delay is told so.
  engine.setRouting('t', null);
  assert.equal(loopMessages(delay).at(-1), -1);
});

test('a Delay with no function is told it has no loop, and nothing is wired to its second output', () => {
  const { engine } = engineRig();
  engine.createTrack('t');
  engine.loadEffect('t', 'Delay', 1);
  const delay = engine.tracks.get('t').slots.get(1).built;
  assert.deepEqual(loopMessages(delay), [-1]);
  assert.ok(!delay.node.links?.some((l) => l.output === 1), 'the second output goes nowhere');
});
