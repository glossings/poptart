'use strict';

// Param expressions through a real scsynth: the SynthDef installExpr builds from a tree
// (exprSynthDef in sc/poptart.scd, lifted, not copied), rendered offline. What has to hold:
//
//   - two audio sources sum onto one of poptart's own devices' controls, read every sample;
//   - audio multiplied by a moving control signal is a VCA - silent where the signal is 0;
//   - an envelope times an LFO is computed at the sample rate, sample for sample the product of
//     the two (the attack is a ramp, not a block staircase);
//   - a constant is a control: a new number lands on the SAME node, and a plugin-bound
//     expression is clipped to 0..1;
//   - a log-curve map turns real units into a 0..1 position.
//
// Skipped, not failed, where sclang or scsynth cannot run - as audio-patch-sclang.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { userExtensionsDir } = require('./extensions.js');
const { nativeDevice } = require('./native-devices');

const SR = 48000;
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = path.join(NATIVE_DIR, 'bin', 'PoptartDevices.scx');
const SCD = path.join(__dirname, 'sc', 'poptart.scd');

const NOISE = nativeDevice('Noise');
const indexOf = (id) => NOISE.params.findIndex((p) => p.id === id);

function lift(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `${name} is not in poptart.scd any more`);
  return m[0];
}

/** An envelope def, as poptart.scd defines it, without its `.add`. */
function envDef(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = new RegExp(`SynthDef\\(\\\\${name}, \\{[\\s\\S]*?\\n {4}\\}\\)\\.add;`).exec(src);
  assert.ok(m, `${name} is not in poptart.scd any more`);
  return m[0].replace(/\.add;$/, '');
}

// The trees, as the scheduler sends them (JSON), parsed by sclang the way the handler does.
const c = (v) => ({ k: 'const', v });
const inp = (i, rate, source) => ({ k: 'in', i, rate, ...(source ? { source } : {}) });
const op = (o, ...a) => ({ k: 'op', op: o, a });
const TREES = {
  // 0.5 * square + 0.25 * one: two sources summed (0.75 / 0.25).
  sum: op('add', op('mul', inp(0, 'ar', 'sq'), c(0.5)), op('mul', inp(1, 'ar', 'one'), c(0.25))),
  // A sine times a 4 Hz gate: a VCA.
  vca: op('mul', inp(0, 'ar', 'sine'), inp(1, 'kr')),
  // An audio-rate envelope times a control-rate LFO.
  env: op('mul', inp(0, 'ar'), inp(1, 'kr')),
  // A constant plus an input nothing drives (reads 0), bound for a plugin: clipped to 0..1.
  constant: op('add', c(0.2), inp(0, 'kr')),
  // 1000 Hz on a 20..20000 Hz log control is position log(50)/log(1000).
  map: { k: 'map', min: 20, max: 20000, curve: 'log', a: [c(1000)] },
};

function sclangConf(dir) {
  const installed = path.join(userExtensionsDir(), 'PoptartDevice.sc');
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${installed}\n`);
  return file;
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'expr.wav');
  const q = (s) => JSON.stringify(s);
  const tree = (name) => `${q(JSON.stringify(TREES[name]))}.parseJSON`;
  const script = `(
var exprSynthDef, defs, synthDef, index, score, options, env, src, readAr, readKr, lfoKr;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
${lift('exprSynthDef')}
defs = [
    exprSynthDef.(\\pe_sum, ${tree('sum')}, \\device),
    exprSynthDef.(\\pe_vca, ${tree('vca')}, \\device),
    exprSynthDef.(\\pe_env, ${tree('env')}, \\device),
    exprSynthDef.(\\pe_const, ${tree('constant')}, \\plugin),
    exprSynthDef.(\\pe_map, ${tree('map')}, \\plugin),
];
synthDef = SynthDef(\\pe_dev, { |out = 0| Out.ar(out, PoptartDevice.ar([], 2, 0, nil, \\slot0)) });
index = synthDef.metadata[\\poptartDevices][\\slot0][\\index];
env = ${envDef('poptart_env_ar')};
// Sources, written to both sides of a stereo bus as a track's output is.
src = SynthDef(\\pe_src, { |bus, kind = 0|
    var sig = Select.ar(kind, [LFPulse.ar(3000), DC.ar(1), SinOsc.ar(441)]);
    Out.ar(bus, [sig, sig]);
});
lfoKr = SynthDef(\\pe_lfokr, { |bus, kind = 0|
    Out.kr(bus, Select.kr(kind, [LFPulse.kr(4), SinOsc.kr(3) * 0.5 + 0.5]));
});
readAr = SynthDef(\\pe_readar, { |out, bus| Out.ar(out, In.ar(bus, 1)) });
readKr = SynthDef(\\pe_readkr, { |out, bus| Out.ar(out, K2A.ar(In.kr(bus))) });
score = Score([
    [0.0, ['/d_recv', synthDef.asBytes]],
    [0.0, ['/d_recv', env.asBytes]],
    [0.0, ['/d_recv', src.asBytes]],
    [0.0, ['/d_recv', lfoKr.asBytes]],
    [0.0, ['/d_recv', readAr.asBytes]],
    [0.0, ['/d_recv', readKr.asBytes]],
] ++ defs.collect { |d| [0.0, ['/d_recv', d.asBytes]] } ++ [
    // Everything at the tail, in order: sources, then the expressions, then what reads them.
    [0.0, ['/s_new', 'pe_src', 2000, 1, 0, 'bus', 20, 'kind', 0]],
    [0.0, ['/s_new', 'pe_src', 2001, 1, 0, 'bus', 22, 'kind', 1]],
    [0.0, ['/s_new', 'pe_src', 2002, 1, 0, 'bus', 24, 'kind', 2]],
    [0.0, ['/s_new', 'pe_lfokr', 2003, 1, 0, 'bus', 5, 'kind', 0]],
    [0.0, ['/s_new', 'pe_lfokr', 2004, 1, 0, 'bus', 6, 'kind', 1]],
    [0.0, ['/s_new', 'poptart_env_ar', 2005, 1, 0, 'out', 26, 'atk', 0.05, 'dec', 0.05, 'sus', 0.5, 'rel', 0.1, 'curve', 0]],
    [0.1, ['/n_set', 2005, 'gate', 1]],
    // sum -> audio bus 30, onto the Noise device's level and onto output 0.
    [0.0, ['/s_new', 'pe_sum', 3000, 1, 0, 'out', 30, 'c0', 0.5, 'c1', 0.25, 'a0', 20, 'a1', 22]],
    [0.0, ['/s_new', 'pe_vca', 3001, 1, 0, 'out', 32, 'a0', 24, 'k1', 5]],
    [0.0, ['/s_new', 'pe_env', 3002, 1, 0, 'out', 34, 'a0', 26, 'k1', 6]],
    [0.0, ['/s_new', 'pe_const', 3003, 1, 0, 'out', 7, 'c0', 0.2]],
    [0.0, ['/s_new', 'pe_map', 3004, 1, 0, 'out', 8, 'c0', 20, 'c1', 20000, 'c2', 1000]],
    [0.5, ['/n_set', 3003, 'c0', 0.7]],
    [0.75, ['/n_set', 3003, 'c0', 1.5]],
    [0.0, ['/s_new', 'pe_readar', 4000, 1, 0, 'out', 0, 'bus', 30]],
    [0.0, ['/s_new', 'pe_readar', 4001, 1, 0, 'out', 4, 'bus', 32]],
    [0.0, ['/s_new', 'pe_readar', 4002, 1, 0, 'out', 5, 'bus', 24]],
    [0.0, ['/s_new', 'pe_readar', 4003, 1, 0, 'out', 6, 'bus', 34]],
    [0.0, ['/s_new', 'pe_readar', 4004, 1, 0, 'out', 7, 'bus', 26]],
    [0.0, ['/s_new', 'pe_readkr', 4005, 1, 0, 'out', 8, 'bus', 6]],
    [0.0, ['/s_new', 'pe_readkr', 4006, 1, 0, 'out', 9, 'bus', 7]],
    [0.0, ['/s_new', 'pe_readkr', 4007, 1, 0, 'out', 10, 'bus', 8]],
    [0.0, ['/s_new', 'pe_readkr', 4008, 1, 0, 'out', 11, 'bus', 5]],
    // The device on outputs 2/3, its level driven by the summed expression.
    [0.0, ['/s_new', 'pe_dev', 5000, 1, 0, 'out', 2]],
    [0.0, ['/u_cmd', 5000, index, '/open', 'Noise']],
    [0.05, ['/u_cmd', 5000, index, '/set', ${indexOf('ampenv.attack')}, 0.0, ${indexOf('ampenv.sustain')}, 1.0]],
    [0.06, ['/u_cmd', 5000, index, '/mapa', ${indexOf('level')}, 30, 1.0, 0.0]],
    [0.1, ['/u_cmd', 5000, index, '/noteOn', 60.0, 1.0]],
    [1.0, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(12).numInputBusChannels_(0);
options.sampleRate = ${SR};
options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
score.recordNRT(
    ${q(path.join(dir, 'expr.osc'))}, ${q(out)}, nil,
    sampleRate: ${SR}, headerFormat: "WAV", sampleFormat: "float",
    options: options, duration: 1.0,
    action: { "RENDER-DONE".postln; 0.exit });
SystemClock.sched(90, { "RENDER-TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let text;
  try {
    text = execFileSync(sclang, ['-l', sclangConf(dir), '-u', '57301', file], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('a param expression sums sources, gates audio, multiplies modulators per sample, and updates its constants in place', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-expr-'));
  const { text, out } = render(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(text.includes('RENDER-DONE') && fs.existsSync(out), `the render failed:\n${text.trim().split('\n').slice(-12).join('\n')}`);
  const wav = readWavRaw(out);
  assert.ok(wav && wav.channels === 12, `unreadable render: ${JSON.stringify(wav && wav.channels)}`);
  const at = (second) => Math.floor(second * SR);
  const s = (ch, i) => wav.data[i * wav.channels + ch];
  const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} is not ${b}`);

  // Two sources summed: only ever 0.75 (square up) or 0.25 (square down), switching 6000 times a second.
  const values = new Set();
  let edges = 0;
  for (let i = at(0.2); i < at(0.4); i++) {
    values.add(Math.round(s(0, i) * 1000) / 1000);
    if (s(0, i) !== s(0, i - 1)) edges++;
  }
  assert.deepStrictEqual([...values].sort(), [0.25, 0.75], `the sum took values ${[...values]}`);
  assert.ok(edges / 0.2 > 5500 && edges / 0.2 < 6500, `the sum switched ${edges / 0.2} times a second`);

  // ...and the device's level follows it per sample: louder where the sum is 0.75, never silent.
  let hi = 0, lo = 0, nHi = 0, nLo = 0;
  for (let i = at(0.2); i < at(0.9); i++) {
    const e = s(2, i) ** 2;
    if (s(0, i) > 0.5) { hi += e; nHi++; } else { lo += e; nLo++; }
  }
  const ratio = Math.sqrt(hi / nHi) / Math.sqrt(lo / nLo);
  assert.ok(lo > 0, 'the device went silent where the sum was 0.25');
  assert.ok(ratio > 1.8, `the device should be louder on the 0.75 samples (ratio ${ratio.toFixed(2)})`);

  // The VCA: the sine times the 4 Hz gate at every sample (a control signal read at audio rate
  // ramps across its block at an edge), so the sine itself where open and silence where shut.
  let vca = 0, shut = 0, openPeak = 0;
  for (let i = at(0.05); i < at(0.95); i++) {
    vca = Math.max(vca, Math.abs(s(4, i) - s(5, i) * s(11, i)));
    if (s(11, i) === 0) shut = Math.max(shut, Math.abs(s(4, i)));
    if (s(11, i) === 1) openPeak = Math.max(openPeak, Math.abs(s(4, i)));
  }
  assert.ok(vca < 1e-6, `the output should be the sine times the gate (off by ${vca})`);
  assert.ok(shut < 1e-9, `with the gate shut the output should be silent (peak ${shut})`);
  assert.ok(openPeak > 0.99, `with the gate open the sine should pass whole (peak ${openPeak})`);

  // env * lfo: the product of the two, sample for sample, with an attack that ramps per sample.
  let worst = 0, worstStep = 0;
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
