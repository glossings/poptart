'use strict';

// The PoptartDevice UGen (native/devices/) - poptart's own synths and effects running in
// scsynth, which is the desktop half of the devices the browser build plays as compiled modules.
//
// Rendered offline through a real scsynth, because the only question worth asking about a UGen
// is what comes out of it: that an instrument slot is silent until a note and sounds after one,
// that a control actually reaches the DSP (two engines of Plaits do not sound alike), that an
// effect slot hears its input (a reverb rings after its input stops), and that a slot with no
// device in it is SILENT rather than noise - an empty slot is the state every track is born in.
//
// Skipped, not failed, where sclang or scsynth cannot run (a machine with no SuperCollider) or
// where the committed .scx was built for another platform - same as keylock-sclang.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { userExtensionsDir } = require('./extensions.js');

const SR = 48000;
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = path.join(NATIVE_DIR, 'bin', 'PoptartDevices.scx');
const CLASS_FILE = path.join(NATIVE_DIR, 'PoptartDevice.sc');

/** Plaits' engine control is its first, 0..23 in whole steps; this is where one engine sits. */
const enginePosition = (engine) => engine / 23;

/**
 * A class library that has this checkout's PoptartDevice and not the installed copy.
 *
 * The engine installs the class file into the user's Extensions folder (extensions.js), so a
 * machine that has run poptart already has one - and compiling two copies of a class is a
 * hard error in sclang. Excluding the installed one by path is what makes this test read the
 * repository on every machine, whether or not the engine has ever run here.
 */
function sclangConf(dir) {
  const installed = path.join(userExtensionsDir(), 'PoptartDevice.sc');
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${installed}\n`);
  return file;
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'devices.wav');
  const q = (s) => JSON.stringify(s);
  const script = `(
var defs, index, score, options;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
("HAS-CLASS<" ++ (\\PoptartDevice.asClass.notNil) ++ ">").postln;
defs = ();
// An instrument slot: no input, the track's bend wired in as a control, notes by unit command.
defs[\\synth] = SynthDef(\\pd_t_synth, { |out = 0|
    Out.ar(out, PoptartDevice.ar([], 2, 0, nil, \\slot0));
});
// An effect slot, fed noise that stops well before the render does, so what is left at the end
// is the device's own tail and nothing else.
defs[\\fx] = SynthDef(\\pd_t_fx, { |out = 0|
    var src = PinkNoise.ar(0.3 ! 2) * EnvGen.kr(Env([1, 1, 0, 0], [0.3, 0.005, 1]));
    Out.ar(out, PoptartDevice.ar(src, 2, 0, nil, \\slot1));
});
index = ();
index[\\synth] = defs[\\synth].metadata[\\poptartDevices][\\slot0][\\index];
index[\\fx] = defs[\\fx].metadata[\\poptartDevices][\\slot1][\\index];
("INDEX<" ++ index[\\synth] ++ "," ++ index[\\fx] ++ ">").postln;
score = Score([
    [0.0, ['/d_recv', defs[\\synth].asBytes]],
    [0.0, ['/d_recv', defs[\\fx].asBytes]],
    // 0/1 Plaits at its default engine; 2/3 the same def with nothing opened into it;
    // 4/5 Plaits on another engine; 6/7 Galactic over the noise burst.
    [0.0, ['/s_new', 'pd_t_synth', 1000, 0, 0, 'out', 0]],
    [0.0, ['/s_new', 'pd_t_synth', 1001, 0, 0, 'out', 2]],
    [0.0, ['/s_new', 'pd_t_synth', 1002, 0, 0, 'out', 4]],
    [0.0, ['/s_new', 'pd_t_fx', 1003, 0, 0, 'out', 6]],
    [0.0, ['/u_cmd', 1000, index[\\synth], '/open', 'Plaits']],
    [0.0, ['/u_cmd', 1002, index[\\synth], '/open', 'Plaits']],
    [0.0, ['/u_cmd', 1003, index[\\fx], '/open', 'Galactic']],
    // Engine 14 is the chord model: a sustaining one, like the default, so the two can be
    // compared over the same window - the drum models at 21..23 are one-shots that are over
    // before it opens.
    [0.1, ['/u_cmd', 1002, index[\\synth], '/set', 0, ${enginePosition(14)}]],
    [0.2, ['/u_cmd', 1000, index[\\synth], '/noteOn', 60.0, 1.0]],
    [0.2, ['/u_cmd', 1002, index[\\synth], '/noteOn', 60.0, 1.0]],
    [1.0, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(8);
options.sampleRate = ${SR};
// The committed binary in this checkout, next to SuperCollider's own UGens - not whatever is
// installed in the Extensions folder, which may be older than the build under test.
options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
score.recordNRT(
    ${q(path.join(dir, 'devices.osc'))}, ${q(out)}, nil,
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
    text = execFileSync(sclang, ['-l', sclangConf(dir), '-u', '57294', file], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('the native devices sound, take their controls and stay silent when empty', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  assert.ok(fs.existsSync(CLASS_FILE), 'the UGen class file is missing from native/devices');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-devices-'));
  const { text, out } = render(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(text, /^HAS-CLASS<true>$/m, `sclang did not compile PoptartDevice.sc:\n${text}`);
  if (!text.includes('RENDER-DONE') || !fs.existsSync(out)) {
    t.skip(`scsynth could not render the devices here:\n${text.trim().split('\n').slice(-6).join('\n')}`);
    return;
  }

  const wav = readWavRaw(out);
  assert.ok(wav && wav.channels === 8, `unreadable render: ${JSON.stringify(wav && wav.channels)}`);
  const at = (second) => Math.floor(second * SR);
  const rms = (channel, from, to) => {
    let sum = 0;
    for (let i = at(from); i < at(to); i++) {
      const v = wav.data[i * wav.channels + channel];
      sum += v * v;
    }
    return Math.sqrt(sum / (at(to) - at(from)));
  };
  const peak = (channel, from, to) => {
    let m = 0;
    for (let i = at(from); i < at(to); i++) m = Math.max(m, Math.abs(wav.data[i * wav.channels + channel]));
    return m;
  };

  // An instrument slot: quiet until the note, sounding after it.
  const before = rms(0, 0, 0.19);
  const after = rms(0, 0.25, 0.6);
  assert.ok(before < 1e-3, `Plaits was not quiet before its note (rms ${before.toExponential(2)})`);
  assert.ok(after > 5e-3, `Plaits did not sound after its note (rms ${after.toExponential(2)})`);

  // A slot with no device: silent, and exactly silent.
  assert.strictEqual(peak(2, 0, 1.0), 0, 'a PoptartDevice with nothing opened into it was not silent');

  // A control that reached the DSP: another engine, another sound. Compared as a difference
  // rather than a level, since two engines can be equally loud.
  const other = rms(4, 0.25, 0.6);
  assert.ok(other > 5e-3, `Plaits on engine 14 did not sound (rms ${other.toExponential(2)})`);
  let diff = 0;
  for (let i = at(0.25); i < at(0.6); i++) {
    diff += (wav.data[i * wav.channels] - wav.data[i * wav.channels + 4]) ** 2;
  }
  const difference = Math.sqrt(diff / (at(0.6) - at(0.25)));
  assert.ok(difference > after * 0.5,
    `setting Plaits' engine changed nothing: the two renders differ by only ${difference.toExponential(2)}`);

  // An effect slot heard its input: the noise stops at 0.3 s and the reverb is still ringing.
  const tail = rms(6, 0.6, 0.95);
  assert.ok(tail > 1e-4, `Galactic produced no tail after its input stopped (rms ${tail.toExponential(2)})`);
});
