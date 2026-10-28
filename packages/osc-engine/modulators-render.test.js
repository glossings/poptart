'use strict';

// The modulator and expression defs through a real scsynth, rendered offline (test-support/nrt.js)
// from the defs the engine boots with (../synthdef). What has to hold:
//
//   - a drawn lfo() shape redrawn while it plays carries its phase across and follows the new
//     shape from there; an anchor after it takes the phase over; the sample-rate twin plays the
//     same shape and moves every sample (the engine writes its tables no smaller than 4096 points);
//   - the native saw, driven by a real Scheduler's anchors for a patterned rate, plays the JS count;
//   - a param expression sums two sources onto one of poptart's own devices' controls per sample,
//     gates audio by a control signal, multiplies an envelope by an LFO sample for sample, updates
//     a constant on the same node, clips a plugin-bound output to 0..1, and maps log units.
//
// Skipped, not failed, where scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { renderNRT, ugen, G } = require('./test-support/nrt');
const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
const { OscEngine } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { nativeDevice } = require('./native-devices');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');

const SR = 48000;
const BLOCK = 64;
const { SynthDef, mul, add } = G;
const { In, Out, K2A, Select, DC, PoptartDevice } = U;
const SinOsc = ugen('SinOsc', [440, 0]);
const LFPulse = ugen('LFPulse', [440, 0, 0.5]);

const flags = extensionFlags(locateServer().extensionsDir);
const bootDef = (name) => synthdef.defsFor(flags).find((d) => d.name === name).def;

const readKr = new SynthDef('t_read', { out: 0, bus: 0 }, (c) => { Out.ar(c.out, K2A.ar(In.kr(c.bus))); });
const readAr = new SynthDef('t_read_ar', { out: 0, bus: 0 }, (c) => { Out.ar(c.out, In.ar(c.bus, 1)); });

// What the engine writes for a set of shapes: the table files, as it sends them.
let serial = 0;
function tables(shapes) {
  const engine = { _shapeKeys: new Map(), _shapeFileSerial: (serial += 1000) };
  const [, paths] = OscEngine.prototype._shapeTables.call(engine, 't', 1, 'x', shapes);
  return JSON.parse(paths);
}

test('the engine writes a drawn shape as a table no smaller than 4096 points, larger for a busy shape', () => {
  const few = tables([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const many = tables([Array.from({ length: 1000 }, (_, i) => ({ x: i / 999, y: i % 2 }))]);
  try {
    const a = readWavRaw(few[0]);
    const b = readWavRaw(many[0]);
    assert.equal(a.data.length, 4096);
    assert.ok(Math.abs(a.data[2048] - 2048 / 4095) < 1e-5, 'a ramp is a ramp');
    assert.equal(b.data.length, 16384, 'sixteen points per breakpoint');
  } finally {
    for (const f of [...few, ...many]) fs.rmSync(f, { force: true });
  }
});

test('a drawn shape redrawn while it plays carries its phase across, and follows the new shape from there', (t) => {
  // A ramp from 0 to 1 over a period, redrawn as a ramp from 0 to 0.5.
  const files = tables([[{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0.5 }]]);
  try {
    const r = renderNRT([
      [0, ['/d_recv', bootDef('poptart_shape_lfo')]],
      [0, ['/d_recv', bootDef('poptart_shape_lfo_ar')]],
      [0, ['/d_recv', readKr]],
      [0, ['/d_recv', readAr]],
      [0, ['/b_allocRead', 0, files[0]]],
      [0, ['/b_allocRead', 1, files[1]]],
      [0, ['/s_new', 'poptart_shape_lfo', 1000, 0, 0, 'out', 3, 'buf', 0, 'rate', 1, 'phase', 0]],
      [0, ['/s_new', 'poptart_shape_lfo_ar', 1001, 0, 0, 'out', 20, 'buf', 0, 'rate', 1, 'phase', 0]],
      [0, ['/s_new', 't_read', 1100, 1, 0, 'out', 0, 'bus', 3]],
      [0, ['/s_new', 't_read_ar', 1101, 1, 0, 'out', 1, 'bus', 20]],
      // The redraw: the running synths are pointed at the new table.
      [0.3, ['/n_set', 1000, 'buf', 1]],
      [0.3, ['/n_set', 1001, 'buf', 1]],
      // An anchor after it: the anchored phase takes over.
      [0.7, ['/n_set', 1000, 't_trig', 1, 'phase', 0.25]],
      [0.7, ['/n_set', 1001, 't_trig', 1, 'phase', 0.25]],
    ], { duration: 1, outChannels: 2 });
    if (!r.data) { t.skip(r.why); return; }
    const slack = (2 * BLOCK) / SR;
    for (const ch of [0, 1]) {
      const what = ch ? 'at the sample rate' : 'at the control rate';
      const v = (sec) => r.at(ch, Math.floor(sec * SR));
      assert.ok(Math.abs(v(0.25) - 0.25) < slack, `${what}, before the redraw: ${v(0.25)}`);
      assert.ok(Math.abs(v(0.5) - 0.25) < slack, `${what}, after it, half of phase 0.5: ${v(0.5)}`);
      assert.ok(Math.abs(v(0.8) - 0.175) < slack, `${what}, the anchored phase: ${v(0.8)}`);
    }
    const at = Math.floor(0.5 * SR) + 3;
    assert.ok(r.at(1, at + 1) !== r.at(1, at), 'the sample-rate shape holds still within a block');
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
  }
});

test("the native saw, driven by the scheduler's anchors, plays the JS count", async (t) => {
  const { saw, note, lfoPhaseCount } = await import('../pattern-core/src/signal.mjs');
  const { Scheduler } = await import('../pattern-core/src/scheduler.mjs');
  const lfo = saw('<0.25 1 [2 4] 3>');
  const cps = 0.5;
  const DURATION = 8;
  // A real Scheduler against a recording engine, ticked the way its timer would.
  const calls = [];
  const state = { now: 0 };
  const engine = new Proxy({ getTime: () => state.now }, {
    get: (o, p) => (p in o ? o[p] : (...args) => { calls.push({ method: p, args }); }),
  });
  const sch = new Scheduler(engine, { trackId: 't', cps });
  sch.setPattern(note('c').synth('X').param('Cutoff', lfo));
  sch.start(0);
  clearInterval(sch._timer);
  for (state.now = 0; state.now < DURATION; state.now += 0.03) sch._tick();
  const seed = calls.find((c) => c.method === 'setParamLFO').args[3];
  const anchors = calls.filter((c) => c.method === 'anchorParamLFO').map((c) => c.args);
  assert.ok(anchors.length > 4);
  const r = renderNRT([
    [0, ['/d_recv', bootDef('poptart_lfo_saw')]],
    [0, ['/d_recv', readKr]],
    [0, ['/s_new', 'poptart_lfo_saw', 1000, 0, 0, 'out', 5, 'freq', seed.rateHz, 'phase', 0, 'lo', 0, 'hi', 1]],
    [0, ['/s_new', 't_read', 1001, 1, 0, 'out', 0, 'bus', 5]],
    ...anchors.filter((a) => a[4] < DURATION)
      .map((a) => [a[4], ['/n_set', 1000, 't_trig', 1, 'phase', a[3], 'freq', a[5]]]),
  ], { duration: DURATION, outChannels: 1 });
  if (!r.data) { t.skip(r.why); return; }
  // Offline, every timestamp lands on a control block, and the Sweep counts in blocks too.
  const first = anchors[0][4];
  let checked = 0;
  let worst = 0;
  for (let sec = first + 0.05; sec < DURATION - 0.05; sec += 0.0371) {
    const want = ((lfoPhaseCount(lfo.lfoIR, sec, cps, sec * cps) % 1) + 1) % 1;
    if (want < 0.02 || want > 0.98) continue; // the saw's wrap: a block either side is all of it
    const got = r.at(0, Math.round(sec * SR));
    worst = Math.max(worst, Math.abs(got - want));
    checked++;
  }
  t.diagnostic(`${checked} points, worst ${worst.toFixed(4)} turns`);
  assert.ok(checked > 100);
  assert.ok(worst < 0.01, `the native saw strays ${worst.toFixed(4)} turns from the JS count`);
});

// The trees, as the scheduler sends them.
const c = (v) => ({ k: 'const', v });
const inp = (i, rate, source) => ({ k: 'in', i, rate, ...(source ? { source } : {}) });
const op = (o, ...a) => ({ k: 'op', op: o, a });
const TREES = {
  // 0.5 * square + 0.25 * one: two sources summed (0.75 / 0.25).
  sum: [op('add', op('mul', inp(0, 'ar', 'sq'), c(0.5)), op('mul', inp(1, 'ar', 'one'), c(0.25))), 'device'],
  // A sine times a 4 Hz gate: a VCA.
  vca: [op('mul', inp(0, 'ar', 'sine'), inp(1, 'kr')), 'device'],
  // An audio-rate envelope times a control-rate LFO.
  env: [op('mul', inp(0, 'ar'), inp(1, 'kr')), 'device'],
  // A constant plus an input nothing drives (reads 0), bound for a plugin: clipped to 0..1.
  constant: [op('add', c(0.2), inp(0, 'kr')), 'plugin'],
  // 1000 Hz on a 20..20000 Hz log control is position log(50)/log(1000).
  map: [{ k: 'map', min: 20, max: 20000, curve: 'log', a: [c(1000)] }, 'plugin'],
};

test('a param expression sums sources, gates audio, multiplies modulators per sample, and updates its constants in place', (t) => {
  if (!flags.nativeDevices) { t.skip('poptart\'s own devices are not installed'); return; }
  const NOISE = nativeDevice('Noise');
  const indexOf = (id) => NOISE.params.findIndex((p) => p.id === id);
  const ex = Object.fromEntries(Object.entries(TREES).map(([k, [tree, outKind]]) => [k, synthdef.exprDef(tree, { outKind })]));
  const dev = new SynthDef('t_dev', { out: 0 }, (cc) => { Out.ar(cc.out, PoptartDevice.ar([], 2, 0, null, 'slot0')); });
  const devIndex = synthdef.defMeta(dev).poptartDevices.slot0;
  const src = new SynthDef('t_src', { bus: 0, kind: 0 }, (cc) => {
    const sig = Select.ar(cc.kind, [LFPulse.ar(3000), DC.ar(1), SinOsc.ar(441)]);
    Out.ar(cc.bus, [sig, sig]);
  });
  const lfoKr = new SynthDef('t_lfokr', { bus: 0, kind: 0 }, (cc) => {
    Out.kr(cc.bus, Select.kr(cc.kind, [LFPulse.kr(4), add(mul(SinOsc.kr(3), 0.5), 0.5)]));
  });
  const n = (k) => ex[k].name;
  const r = renderNRT([
    ...[dev, bootDef('poptart_env_ar'), src, lfoKr, readAr, readKr, ...Object.values(ex).map((e) => e.def)]
      .map((d) => [0, ['/d_recv', d]]),
    // Everything at the tail, in order: sources, then the expressions, then what reads them.
    [0, ['/s_new', 't_src', 2000, 1, 0, 'bus', 20, 'kind', 0]],
    [0, ['/s_new', 't_src', 2001, 1, 0, 'bus', 22, 'kind', 1]],
    [0, ['/s_new', 't_src', 2002, 1, 0, 'bus', 24, 'kind', 2]],
    [0, ['/s_new', 't_lfokr', 2003, 1, 0, 'bus', 5, 'kind', 0]],
    [0, ['/s_new', 't_lfokr', 2004, 1, 0, 'bus', 6, 'kind', 1]],
    [0, ['/s_new', 'poptart_env_ar', 2005, 1, 0, 'out', 26, 'atk', 0.05, 'dec', 0.05, 'sus', 0.5, 'rel', 0.1, 'curve', 0]],
    [0.1, ['/n_set', 2005, 'gate', 1]],
    [0, ['/s_new', n('sum'), 3000, 1, 0, 'out', 30, 'c0', 0.5, 'c1', 0.25, 'a0', 20, 'a1', 22, 'k0', -1, 'k1', -1]],
    [0, ['/s_new', n('vca'), 3001, 1, 0, 'out', 32, 'a0', 24, 'k0', -1, 'k1', 5, 'a1', -1]],
    [0, ['/s_new', n('env'), 3002, 1, 0, 'out', 34, 'a0', 26, 'k0', -1, 'k1', 6, 'a1', -1]],
    [0, ['/s_new', n('constant'), 3003, 1, 0, 'out', 7, 'c0', 0.2, 'k0', -1]],
    [0, ['/s_new', n('map'), 3004, 1, 0, 'out', 8, 'c0', 20, 'c1', 20000, 'c2', 1000]],
    [0.5, ['/n_set', 3003, 'c0', 0.7]],
    [0.75, ['/n_set', 3003, 'c0', 1.5]],
    [0, ['/s_new', 't_read_ar', 4000, 1, 0, 'out', 0, 'bus', 30]],
    [0, ['/s_new', 't_read_ar', 4001, 1, 0, 'out', 4, 'bus', 32]],
    [0, ['/s_new', 't_read_ar', 4002, 1, 0, 'out', 5, 'bus', 24]],
    [0, ['/s_new', 't_read_ar', 4003, 1, 0, 'out', 6, 'bus', 34]],
    [0, ['/s_new', 't_read_ar', 4004, 1, 0, 'out', 7, 'bus', 26]],
    [0, ['/s_new', 't_read', 4005, 1, 0, 'out', 8, 'bus', 6]],
    [0, ['/s_new', 't_read', 4006, 1, 0, 'out', 9, 'bus', 7]],
    [0, ['/s_new', 't_read', 4007, 1, 0, 'out', 10, 'bus', 8]],
    [0, ['/s_new', 't_read', 4008, 1, 0, 'out', 11, 'bus', 5]],
    // The device on outputs 2/3, its level driven by the summed expression.
    [0, ['/s_new', 't_dev', 5000, 1, 0, 'out', 2]],
    [0, ['/u_cmd', 5000, devIndex, '/open', 'Noise']],
    [0.05, ['/u_cmd', 5000, devIndex, '/set', indexOf('ampenv.attack'), 0.0, indexOf('ampenv.sustain'), 1.0]],
    [0.06, ['/u_cmd', 5000, devIndex, '/mapa', indexOf('level'), 30, 1.0, 0.0]],
    [0.1, ['/u_cmd', 5000, devIndex, '/noteOn', 60.0, 1.0]],
  ].map(([tt, m]) => [tt, m.map((v, i) => (i > 0 && typeof v === 'number' && !Number.isInteger(v) ? { type: 'f', value: v } : v))]),
  { duration: 1, outChannels: 12 });
  if (!r.data) { t.skip(r.why); return; }
  const at = (second) => Math.floor(second * SR);
  const s = (ch, i) => r.at(ch, i);
  const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} is not ${b}`);
  // Two sources summed: only ever 0.75 or 0.25, switching 6000 times a second.
  const values = new Set();
  let edges = 0;
  for (let i = at(0.2); i < at(0.4); i++) {
    values.add(Math.round(s(0, i) * 1000) / 1000);
    if (s(0, i) !== s(0, i - 1)) edges++;
  }
  assert.deepStrictEqual([...values].sort(), [0.25, 0.75], `the sum took values ${[...values]}`);
  assert.ok(edges / 0.2 > 5500 && edges / 0.2 < 6500, `the sum switched ${edges / 0.2} times a second`);
  // ...and the device's level follows it per sample: louder where the sum is 0.75, never silent.
  let hi = 0; let lo = 0; let nHi = 0; let nLo = 0;
  for (let i = at(0.2); i < at(0.9); i++) {
    const e = s(2, i) ** 2;
    if (s(0, i) > 0.5) { hi += e; nHi++; } else { lo += e; nLo++; }
  }
  const ratio = Math.sqrt(hi / nHi) / Math.sqrt(lo / nLo);
  assert.ok(lo > 0, 'the device went silent where the sum was 0.25');
  assert.ok(ratio > 1.8, `the device should be louder on the 0.75 samples (ratio ${ratio.toFixed(2)})`);
  // The VCA: the sine times the 4 Hz gate at every sample.
  let vca = 0; let shut = 0; let openPeak = 0;
  for (let i = at(0.05); i < at(0.95); i++) {
    vca = Math.max(vca, Math.abs(s(4, i) - s(5, i) * s(11, i)));
    if (s(11, i) === 0) shut = Math.max(shut, Math.abs(s(4, i)));
    if (s(11, i) === 1) openPeak = Math.max(openPeak, Math.abs(s(4, i)));
  }
  assert.ok(vca < 1e-6, `the output should be the sine times the gate (off by ${vca})`);
  assert.ok(shut < 1e-9, `with the gate shut the output should be silent (peak ${shut})`);
  assert.ok(openPeak > 0.99, `with the gate open the sine should pass whole (peak ${openPeak})`);
  // env * lfo: the product of the two, sample for sample, with an attack that ramps per sample.
  let worst = 0; let worstStep = 0;
  for (let i = at(0.1); i < at(0.95); i++) worst = Math.max(worst, Math.abs(s(6, i) - s(7, i) * s(8, i)));
  for (let i = at(0.1); i < at(0.15); i++) worstStep = Math.max(worstStep, Math.abs(s(6, i + 1) - s(6, i)));
  assert.ok(worst < 1e-5, `env * lfo is off the product of the two by ${worst}`);
  assert.ok(worstStep < 0.002, `the product moved ${worstStep} in one sample - a block step, not a ramp`);
  // A constant updated on the same node, and the plugin-bound output clipped to 0..1.
  near(s(9, at(0.4)), 0.2, 1e-6, 'the constant before the update');
  near(s(9, at(0.6)), 0.7, 1e-6, 'the constant after /n_set c0 0.7');
  near(s(9, at(0.9)), 1.0, 1e-6, 'a plugin-bound expression is clipped at 1');
  // 1000 Hz on a 20..20000 log control.
  near(s(10, at(0.5)), Math.log(50) / Math.log(1000), 1e-5, 'the log map');
});

test('audio patched onto a native control is read every sample, and an audio-rate env() ramps and retriggers', (t) => {
  if (!flags.nativeDevices) { t.skip('poptart\'s own devices are not installed'); return; }
  const NOISE = nativeDevice('Noise');
  const indexOf = (id) => NOISE.params.findIndex((p) => p.id === id);
  const dev = new SynthDef('t_dev', { out: 0 }, (cc) => { Out.ar(cc.out, PoptartDevice.ar([], 2, 0, null, 'slot0')); });
  const index = synthdef.defMeta(dev).poptartDevices.slot0;
  // The source: a 3 kHz square from 0 to 1 on both sides of a stereo bus, the shape a track's
  // output has when it is patched onto a control.
  const srcDef = new SynthDef('t_sq', { bus: 0 }, (cc) => { const sq = LFPulse.ar(3000); Out.ar(cc.bus, [sq, sq]); });
  const BUS = 20;
  const f = (v) => ({ type: 'f', value: v });
  const r = renderNRT([
    ...[dev, srcDef, bootDef('poptart_env_ar'), bootDef('poptart_env'), readKr].map((d) => [0, ['/d_recv', d]]),
    // 8: the control-rate envelope with retrigger on, read off control bus 3 at the tail.
    [0, ['/s_new', 'poptart_env', 1004, 0, 0, 'out', 3, 'atk', f(0.05), 'dec', f(0.05), 'sus', f(0.5), 'rel', f(0.1), 'curve', 0, 'retrig', 1]],
    [0, ['/s_new', 't_read', 1005, 1, 0, 'out', 8, 'bus', 3]],
    [0.1, ['/n_set', 1004, 'gate', 1, 't_retrig', 1]],
    [0.5, ['/n_set', 1004, 'gate', 1, 't_retrig', 1]],
    // 0/1: Noise with its level patched to the square. 2/3: the same, with a plain /set after the
    // patch (which must not cut it) and an unpatch at 0.6 s (which must).
    [0, ['/s_new', 't_dev', 1000, 0, 0, 'out', 0]],
    [0, ['/s_new', 't_dev', 1001, 0, 0, 'out', 2]],
    // At the HEAD, so it runs before the devices that read its bus.
    [0, ['/s_new', 't_sq', 1009, 0, 0, 'bus', BUS]],
    [0, ['/u_cmd', 1000, index, '/open', 'Noise']],
    [0, ['/u_cmd', 1001, index, '/open', 'Noise']],
    [0.05, ['/u_cmd', 1000, index, '/set', indexOf('ampenv.attack'), f(0), indexOf('ampenv.sustain'), f(1)]],
    [0.05, ['/u_cmd', 1001, index, '/set', indexOf('ampenv.attack'), f(0), indexOf('ampenv.sustain'), f(1)]],
    [0.06, ['/u_cmd', 1000, index, '/mapa', indexOf('level'), BUS, f(1), f(0)]],
    [0.06, ['/u_cmd', 1001, index, '/mapa', indexOf('level'), BUS, f(1), f(0)]],
    [0.1, ['/u_cmd', 1000, index, '/noteOn', f(60), f(1)]],
    [0.1, ['/u_cmd', 1001, index, '/noteOn', f(60), f(1)]],
    [0.4, ['/u_cmd', 1001, index, '/set', indexOf('level'), f(0)]],
    [0.6, ['/u_cmd', 1001, index, '/mapa', indexOf('level'), -1, f(1), f(0)]],
    // 4/5 and 6/7: the audio-rate envelope, gated at 0.1 s and retriggered at 0.5 s while its gate
    // is still open - with retrigger on, and with it off.
    [0, ['/s_new', 'poptart_env_ar', 1002, 1, 0, 'out', 4, 'atk', f(0.05), 'dec', f(0.05), 'sus', f(0.5), 'rel', f(0.1), 'curve', 0, 'retrig', 1]],
    [0, ['/s_new', 'poptart_env_ar', 1003, 1, 0, 'out', 6, 'atk', f(0.05), 'dec', f(0.05), 'sus', f(0.5), 'rel', f(0.1), 'curve', 0, 'retrig', 0]],
    [0.1, ['/n_set', 1002, 'gate', 1, 't_retrig', 1]],
    [0.1, ['/n_set', 1003, 'gate', 1, 't_retrig', 1]],
    [0.5, ['/n_set', 1002, 'gate', 1, 't_retrig', 1]],
    [0.5, ['/n_set', 1003, 'gate', 1, 't_retrig', 1]],
  ], { duration: 1, outChannels: 10 });
  if (!r.data) { t.skip(r.why); return; }
  const at = (second) => Math.floor(second * SR);
  const sample = (ch, i) => r.at(ch, i);
  const gates = (ch, from, to) => {
    let n = 0;
    for (let i = at(from) + 1; i < at(to); i++) if (sample(ch, i - 1) === 0 && sample(ch, i) !== 0) n++;
    return n / (to - from);
  };
  const rms = (ch, from, to) => {
    let e = 0;
    for (let i = at(from); i < at(to); i++) e += sample(ch, i) ** 2;
    return Math.sqrt(e / (at(to) - at(from)));
  };
  // A level read once a block could open at most 750 times a second.
  const rate = gates(0, 0.15, 0.95);
  assert.ok(rate > 2800 && rate < 3200, `the patched level should gate the noise 3000 times a second, measured ${rate.toFixed(0)}`);
  const held = gates(2, 0.42, 0.58);
  assert.ok(held > 2800, `a /set cut the patch (gating ${held.toFixed(0)} a second after it)`);
  assert.ok(rms(2, 0.15, 0.35) > 0.05, 'the second device did not sound while patched');
  assert.strictEqual(rms(2, 0.62, 0.95), 0, 'after the unpatch the level should be back at the 0 it was set to');
  let worstStep = 0;
  for (let i = at(0.1); i < at(0.15); i++) worstStep = Math.max(worstStep, Math.abs(sample(4, i + 1) - sample(4, i)));
  assert.ok(worstStep < 0.002, `the attack moved ${worstStep.toFixed(4)} in one sample - a block step, not a ramp`);
  assert.ok(Math.abs(sample(4, at(0.125)) - 0.5) < 0.03, `25 ms into a 50 ms attack: ${sample(4, at(0.125))}`);
  assert.ok(Math.abs(sample(4, at(0.45)) - 0.5) < 1e-3, `at sustain before the retrigger: ${sample(4, at(0.45))}`);
  assert.ok(sample(4, at(0.53)) > 0.7, `the retrigger did not restart the attack: ${sample(4, at(0.53))}`);
  assert.ok(Math.abs(sample(6, at(0.53)) - 0.5) < 1e-3, `without retrigger the envelope should hold at sustain: ${sample(6, at(0.53))}`);
  assert.ok(Math.abs(sample(8, at(0.45)) - 0.5) < 1e-3, `the control-rate envelope's sustain: ${sample(8, at(0.45))}`);
  assert.ok(sample(8, at(0.53)) > 0.7, `the control-rate retrigger did not restart the attack: ${sample(8, at(0.53))}`);
  // Both sides of the pair carry it - a patch is read as the mean of the two.
  assert.strictEqual(sample(5, at(0.3)), sample(4, at(0.3)));
});
