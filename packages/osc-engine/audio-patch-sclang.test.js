'use strict';

// Audio onto a native device's control, through a real scsynth: what `.param("Level",
// audio("lfo"))` and an env() on one of poptart's own devices come to on the desktop.
//
// The parity test beside this one holds the DSP to the browser's with a harness; this renders
// the UGen itself, because the parts that matter here are the UGen's own: that /mapa reads an
// audio bus EVERY SAMPLE (a 3 kHz square on a level gates the sound three thousand times a
// second, which no once-a-block read can do), that a plain /set landing after the patch does
// not cut it, that /mapa with a bus of -1 does, and that poptart_env_ar - lifted from
// poptart.scd, not copied - ramps per sample and restarts its attack on a retrigger only when
// told to.
//
// Skipped, not failed, where sclang or scsynth cannot run - as native-device-sclang.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { userExtensionsDir, DEVICE_BINARY } = require('./extensions.js');
const { nativeDevice } = require('./native-devices');

const SR = 48000;
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = DEVICE_BINARY; // this platform's build (extensions.js)
const SCD = path.join(__dirname, 'sc', 'poptart.scd');

const NOISE = nativeDevice('Noise');
const indexOf = (id) => NOISE.params.findIndex((p) => p.id === id);

/** An envelope def, as poptart.scd defines it, without its `.add`. */
function envDef(name = 'poptart_env_ar') {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = new RegExp(`SynthDef\\(\\\\${name}, \\{[\\s\\S]*?\\n {4}\\}\\)\\.add;`).exec(src);
  assert.ok(m, `${name} is not in poptart.scd any more`);
  return m[0].replace(/\.add;$/, '');
}

function sclangConf(dir) {
  const installed = path.join(userExtensionsDir(), 'PoptartDevice.sc');
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${installed}\n`);
  return file;
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'patch.wav');
  const q = (s) => JSON.stringify(s);
  const BUS = 20; // a private audio bus, past the 10 outputs and no inputs
  const script = `(
var synthDef, srcDef, env, envKr, readKr, index, score, options;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
synthDef = SynthDef(\\pa_t_synth, { |out = 0| Out.ar(out, PoptartDevice.ar([], 2, 0, nil, \\slot0)) });
// The source: a 3 kHz square from 0 to 1 on both sides of a stereo bus, which is the shape a
// track's output has when it is patched onto a control.
srcDef = SynthDef(\\pa_t_src, { |bus| var sq = LFPulse.ar(3000); Out.ar(bus, [sq, sq]) });
env = ${envDef()};
envKr = ${envDef('poptart_env')};
// The control-rate one writes a control bus; this puts that on an output to be read.
readKr = SynthDef(\\pa_t_readkr, { |out, bus| Out.ar(out, K2A.ar(In.kr(bus))) });
index = synthDef.metadata[\\poptartDevices][\\slot0][\\index];
score = Score([
    [0.0, ['/d_recv', synthDef.asBytes]],
    [0.0, ['/d_recv', srcDef.asBytes]],
    [0.0, ['/d_recv', env.asBytes]],
    [0.0, ['/d_recv', envKr.asBytes]],
    [0.0, ['/d_recv', readKr.asBytes]],
    // 8: the control-rate envelope with retrigger on, read off control bus 3 at the tail.
    [0.0, ['/s_new', 'poptart_env', 1004, 0, 0, 'out', 3, 'atk', 0.05, 'dec', 0.05, 'sus', 0.5, 'rel', 0.1, 'curve', 0, 'retrig', 1]],
    [0.0, ['/s_new', 'pa_t_readkr', 1005, 1, 0, 'out', 8, 'bus', 3]],
    [0.1, ['/n_set', 1004, 'gate', 1, 't_retrig', 1]],
    [0.5, ['/n_set', 1004, 'gate', 1, 't_retrig', 1]],
    // 0/1: Noise with its level patched to the square. 2/3: the same, with a plain /set after
    // the patch (which must not cut it) and an unpatch at 0.6 s (which must).
    [0.0, ['/s_new', 'pa_t_synth', 1000, 0, 0, 'out', 0]],
    [0.0, ['/s_new', 'pa_t_synth', 1001, 0, 0, 'out', 2]],
    // At the HEAD, so it runs before the devices that read its bus.
    [0.0, ['/s_new', 'pa_t_src', 1009, 0, 0, 'bus', ${BUS}]],
    [0.0, ['/u_cmd', 1000, index, '/open', 'Noise']],
    [0.0, ['/u_cmd', 1001, index, '/open', 'Noise']],
    [0.05, ['/u_cmd', 1000, index, '/set', ${indexOf('ampenv.attack')}, 0.0, ${indexOf('ampenv.sustain')}, 1.0]],
    [0.05, ['/u_cmd', 1001, index, '/set', ${indexOf('ampenv.attack')}, 0.0, ${indexOf('ampenv.sustain')}, 1.0]],
    [0.06, ['/u_cmd', 1000, index, '/mapa', ${indexOf('level')}, ${BUS}, 1.0, 0.0]],
    [0.06, ['/u_cmd', 1001, index, '/mapa', ${indexOf('level')}, ${BUS}, 1.0, 0.0]],
    [0.1, ['/u_cmd', 1000, index, '/noteOn', 60.0, 1.0]],
    [0.1, ['/u_cmd', 1001, index, '/noteOn', 60.0, 1.0]],
    [0.4, ['/u_cmd', 1001, index, '/set', ${indexOf('level')}, 0.0]],
    [0.6, ['/u_cmd', 1001, index, '/mapa', ${indexOf('level')}, -1, 1.0, 0.0]],
    // 4/5 and 6/7: the audio-rate envelope, gated at 0.1 s and sent a retrigger at 0.5 s while
    // its gate is still open - with retrigger on, and with it off.
    [0.0, ['/s_new', 'poptart_env_ar', 1002, 1, 0, 'out', 4, 'atk', 0.05, 'dec', 0.05, 'sus', 0.5, 'rel', 0.1, 'curve', 0, 'retrig', 1]],
    [0.0, ['/s_new', 'poptart_env_ar', 1003, 1, 0, 'out', 6, 'atk', 0.05, 'dec', 0.05, 'sus', 0.5, 'rel', 0.1, 'curve', 0, 'retrig', 0]],
    [0.1, ['/n_set', 1002, 'gate', 1, 't_retrig', 1]],
    [0.1, ['/n_set', 1003, 'gate', 1, 't_retrig', 1]],
    [0.5, ['/n_set', 1002, 'gate', 1, 't_retrig', 1]],
    [0.5, ['/n_set', 1003, 'gate', 1, 't_retrig', 1]],
    [1.0, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(10).numInputBusChannels_(0);
options.sampleRate = ${SR};
options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
score.recordNRT(
    ${q(path.join(dir, 'patch.osc'))}, ${q(out)}, nil,
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
    text = execFileSync(sclang, ['-l', sclangConf(dir), '-u', '57299', file], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('audio patched onto a native control is read every sample, and an audio-rate env() ramps and retriggers', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-patch-'));
  const { text, out } = render(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  if (!text.includes('RENDER-DONE') || !fs.existsSync(out)) {
    t.skip(`scsynth could not render here:\n${text.trim().split('\n').slice(-6).join('\n')}`);
    return;
  }
  const wav = readWavRaw(out);
  assert.ok(wav && wav.channels === 10, `unreadable render: ${JSON.stringify(wav && wav.channels)}`);
  const at = (second) => Math.floor(second * SR);
  const sample = (ch, i) => wav.data[i * wav.channels + ch];
  /** Silent-to-sounding edges a second: the rate the level is gated at. */
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

  // A block is 64 samples, so a level read once a block could open at most 750 times a second.
  const rate = gates(0, 0.15, 0.95);
  assert.ok(rate > 2800 && rate < 3200, `the patched level should gate the noise 3000 times a second, measured ${rate.toFixed(0)}`);

  // A /set after the patch leaves it patched; an unpatch takes it off, back to that /set (0).
  const held = gates(2, 0.42, 0.58);
  assert.ok(held > 2800, `a /set cut the patch (gating ${held.toFixed(0)} a second after it)`);
  assert.ok(rms(2, 0.15, 0.35) > 0.05, 'the second device did not sound while patched');
  assert.strictEqual(rms(2, 0.62, 0.95), 0, 'after the unpatch the level should be back at the 0 it was set to');

  // The envelope: a straight ramp per sample (a 50 ms attack climbs about 1/2400 a sample, never
  // a block's worth at once), halfway up 25 ms in, and at sustain before the retrigger.
  let worstStep = 0;
  for (let i = at(0.1); i < at(0.15); i++) worstStep = Math.max(worstStep, Math.abs(sample(4, i + 1) - sample(4, i)));
  assert.ok(worstStep < 0.002, `the attack moved ${worstStep.toFixed(4)} in one sample - that is a block step, not a ramp`);
  assert.ok(Math.abs(sample(4, at(0.125)) - 0.5) < 0.03, `25 ms into a 50 ms attack: ${sample(4, at(0.125))}`);
  assert.ok(Math.abs(sample(4, at(0.45)) - 0.5) < 1e-3, `at sustain before the retrigger: ${sample(4, at(0.45))}`);
  // With retrigger on, the second note climbs again from sustain; with it off it stays put.
  assert.ok(sample(4, at(0.53)) > 0.7, `the retrigger did not restart the attack: ${sample(4, at(0.53))}`);
  assert.ok(Math.abs(sample(6, at(0.53)) - 0.5) < 1e-3, `without retrigger the envelope should hold at sustain: ${sample(6, at(0.53))}`);
  // The control-rate one, which a plugin's parameter reads, retriggers the same way.
  assert.ok(Math.abs(sample(8, at(0.45)) - 0.5) < 1e-3, `the control-rate envelope's sustain: ${sample(8, at(0.45))}`);
  assert.ok(sample(8, at(0.53)) > 0.7, `the control-rate retrigger did not restart the attack: ${sample(8, at(0.53))}`);
  // Both sides of the pair carry it - a patch is read as the mean of the two.
  assert.strictEqual(sample(5, at(0.3)), sample(4, at(0.3)));
});
