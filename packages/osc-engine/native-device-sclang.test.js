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
const { userExtensionsDir, DEVICE_BINARY } = require('./extensions.js');

const SR = 48000;
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = DEVICE_BINARY; // this platform's build (extensions.js)
const CLASS_FILE = path.join(NATIVE_DIR, 'PoptartDevice.sc');

/** Plaits' engine control is its first, 0..23 in whole steps; this is where one engine sits. */
const enginePosition = (engine) => engine / 23;

/** Which control is which on poptart's own Filter, from the catalog it is built with. */
const FILTER_CUTOFF = require('./native-devices')
  .nativeDevice('Filter').params.findIndex((p) => p.id === 'cutoff');

/**
 * The FM synth's output level, which is its LAST control - number 147 of 148.
 *
 * It is in this test because of where it sits: the UGen holds a fixed table of control
 * positions, and a device whose controls run past the end of it would have the rest of them
 * silently ignored. The FM synth is the device that found that limit (its matrix alone is
 * sixty-four cells), so turning its level down through an index that high is the proof that a
 * control at the far end of a long list actually arrives.
 */
const FM_LEVEL = require('./native-devices')
  .nativeDevice('FM').params.findIndex((p) => p.id === 'level');

/**
 * Which control the granulator plays a file on, and where a loaded one lands.
 *
 * The slot is the first entry past the options the descriptor ships with - the same rule the
 * engine and the browser both follow - and the test loads a file into it the way the engine does:
 * a buffer the server read, handed to the device by number (see the sample path in
 * PoptartDevice.cpp). THIS IS THE ONLY TEST THAT PLAYS THAT PATH END TO END; everything above it
 * is a device making a sound out of its own controls.
 */
const GRAIN_SAMPLE = require('./native-devices')
  .nativeDevice('Granular').params.findIndex((p) => p.id === 'sample');
const GRAIN_SLOT = require('./native-devices')
  .deviceParam(require('./native-devices').nativeDevice('Granular'), 'sample').options.length;
const GRAIN_SAMPLE_POSITION = require('./native-devices')
  .paramPosition(require('./native-devices').nativeDevice('Granular'), 'sample', GRAIN_SLOT);

/** A second of a tone, as a file for the granulator to read. */
function writeSample(dir) {
  const { writeWav } = require('./wav.js');
  const frames = SR;
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
    data[i * 2] = v;
    data[i * 2 + 1] = v;
  }
  const file = path.join(dir, 'grain-source.wav');
  writeWav(file, { sampleRate: SR, channels: 2, data });
  return file;
}

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
  const sampleFile = writeSample(dir);
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
// A second effect slot, fed a steady tone well above the corner being tested: a filter is
// judged by what it does to that rather than by its tail, and a tone either survives the
// filter or it does not. (Noise would not do: most of pink noise's energy is under 20 Hz
// anyway, so a lowpass there barely changes its level and the test would measure nothing.)
defs[\\fx2] = SynthDef(\\pd_t_fx2, { |out = 0|
    Out.ar(out, PoptartDevice.ar(SinOsc.ar(4000) * 0.3 ! 2, 2, 0, nil, \\slot1));
});
index = ();
index[\\synth] = defs[\\synth].metadata[\\poptartDevices][\\slot0][\\index];
index[\\fx] = defs[\\fx].metadata[\\poptartDevices][\\slot1][\\index];
index[\\fx2] = defs[\\fx2].metadata[\\poptartDevices][\\slot1][\\index];
("INDEX<" ++ index[\\synth] ++ "," ++ index[\\fx] ++ ">").postln;
score = Score([
    [0.0, ['/d_recv', defs[\\synth].asBytes]],
    [0.0, ['/d_recv', defs[\\fx].asBytes]],
    [0.0, ['/d_recv', defs[\\fx2].asBytes]],
    // 0/1 Plaits at its default engine; 2/3 the same def with nothing opened into it;
    // 4/5 Plaits on another engine; 6/7 Galactic over the noise burst.
    [0.0, ['/s_new', 'pd_t_synth', 1000, 0, 0, 'out', 0]],
    [0.0, ['/s_new', 'pd_t_synth', 1001, 0, 0, 'out', 2]],
    [0.0, ['/s_new', 'pd_t_synth', 1002, 0, 0, 'out', 4]],
    [0.0, ['/s_new', 'pd_t_fx', 1003, 0, 0, 'out', 6]],
    // 8/9 the Wavetable synth, which is poptart's own rather than a ported module; 10/11 and
    // 12/13 its Filter over an unending noise, open and shut - the same device twice with one
    // control between them.
    [0.0, ['/s_new', 'pd_t_synth', 1004, 0, 0, 'out', 8]],
    [0.0, ['/s_new', 'pd_t_fx2', 1005, 0, 0, 'out', 10]],
    [0.0, ['/s_new', 'pd_t_fx2', 1006, 0, 0, 'out', 12]],
    // 14/15 the FM synth as it comes; 16/17 the same thing with its last control turned down.
    [0.0, ['/s_new', 'pd_t_synth', 1007, 0, 0, 'out', 14]],
    [0.0, ['/s_new', 'pd_t_synth', 1008, 0, 0, 'out', 16]],
    [0.0, ['/u_cmd', 1000, index[\\synth], '/open', 'Plaits']],
    [0.0, ['/u_cmd', 1002, index[\\synth], '/open', 'Plaits']],
    [0.0, ['/u_cmd', 1003, index[\\fx], '/open', 'Galactic']],
    // Engine 14 is the chord model: a sustaining one, like the default, so the two can be
    // compared over the same window - the drum models at 21..23 are one-shots that are over
    // before it opens.
    [0.1, ['/u_cmd', 1002, index[\\synth], '/set', 0, ${enginePosition(14)}]],
    [0.0, ['/u_cmd', 1004, index[\\synth], '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1005, index[\\fx2], '/open', 'Filter']],
    [0.0, ['/u_cmd', 1006, index[\\fx2], '/open', 'Filter']],
    // Wide open against shut: the top of that exponential sweep is 20 kHz and the bottom 20 Hz.
    [0.1, ['/u_cmd', 1005, index[\\fx2], '/set', ${FILTER_CUTOFF}, 1.0]],
    [0.1, ['/u_cmd', 1006, index[\\fx2], '/set', ${FILTER_CUTOFF}, 0.0]],
    [0.2, ['/u_cmd', 1000, index[\\synth], '/noteOn', 60.0, 1.0]],
    [0.2, ['/u_cmd', 1002, index[\\synth], '/noteOn', 60.0, 1.0]],
    [0.2, ['/u_cmd', 1004, index[\\synth], '/noteOn', 60.0, 1.0]],
    [0.0, ['/u_cmd', 1007, index[\\synth], '/open', 'FM']],
    [0.0, ['/u_cmd', 1008, index[\\synth], '/open', 'FM']],
    [0.1, ['/u_cmd', 1008, index[\\synth], '/set', ${FM_LEVEL}, 0.0]],
    [0.2, ['/u_cmd', 1007, index[\\synth], '/noteOn', 60.0, 1.0]],
    [0.2, ['/u_cmd', 1008, index[\\synth], '/noteOn', 60.0, 1.0]],
    // 18/19 the granulator, with a file read into a buffer and handed to it: the sample path,
    // end to end through a real server. 20/21 the same noise burst through the convolution
    // reverb, which is the one device whose DSP is nobody's JavaScript (see own/convolver.cc).
    [0.0, ['/s_new', 'pd_t_synth', 1009, 0, 0, 'out', 18]],
    [0.0, ['/s_new', 'pd_t_fx', 1010, 0, 0, 'out', 20]],
    [0.0, ['/b_allocRead', 0, ${q(sampleFile)}, 0, 0]],
    [0.0, ['/u_cmd', 1009, index[\\synth], '/open', 'Granular']],
    [0.0, ['/u_cmd', 1010, index[\\fx], '/open', 'Convolver']],
    [0.1, ['/u_cmd', 1009, index[\\synth], '/sample', ${GRAIN_SAMPLE}, ${GRAIN_SLOT}, 0]],
    [0.15, ['/u_cmd', 1009, index[\\synth], '/set', ${GRAIN_SAMPLE}, ${GRAIN_SAMPLE_POSITION}]],
    [0.2, ['/u_cmd', 1009, index[\\synth], '/noteOn', 60.0, 1.0]],
    [1.0, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(22);
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
  assert.ok(wav && wav.channels === 22, `unreadable render: ${JSON.stringify(wav && wav.channels)}`);
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

  // poptart's OWN devices out of the same extension: the ones whose DSP is written twice (see
  // own/pd-own.h and the parity test beside this one). Here the question is only whether the
  // server can play them at all - what the waveform is, is the parity test's business.
  const wtBefore = rms(8, 0, 0.19);
  const wtAfter = rms(8, 0.25, 0.6);
  assert.ok(wtBefore < 1e-3, `the Wavetable synth was not quiet before its note (rms ${wtBefore.toExponential(2)})`);
  assert.ok(wtAfter > 5e-3, `the Wavetable synth did not sound after its note (rms ${wtAfter.toExponential(2)})`);

  // One effect, one control: wide open it passes the tone, shut it takes nearly all of it away.
  const open = rms(10, 0.2, 0.9);
  const shut = rms(12, 0.2, 0.9);
  assert.ok(open > 5e-3, `the Filter passed nothing with its cutoff at the top (rms ${open.toExponential(2)})`);
  assert.ok(shut < open * 0.05,
    `the Filter's cutoff did nothing: open ${open.toExponential(2)}, shut ${shut.toExponential(2)}`);

  // The far end of a long control list: the FM synth's level is its 148th control, and a
  // control that never arrives is a device that goes on sounding when it was turned down.
  const fm = rms(14, 0.25, 0.6);
  const fmDown = rms(16, 0.25, 0.6);
  assert.ok(fm > 5e-3, `the FM synth did not sound after its note (rms ${fm.toExponential(2)})`);
  assert.ok(fmDown < fm * 0.02,
    `the FM synth's level (control ${FM_LEVEL}) did not reach it: ${fm.toExponential(2)} against `
    + `${fmDown.toExponential(2)} with it at zero`);

  // THE SAMPLE PATH, end to end: a file read into one of the server's buffers, copied out of it
  // on the non-realtime thread and handed to the device, which then plays a note as a cloud of
  // grains from it. A granulator with no file is silent, so a sound here is the whole chain -
  // the unit command, the asynchronous stages, the mono sum and the device holding the pointer.
  const grainBefore = rms(18, 0, 0.19);
  const grainAfter = rms(18, 0.3, 0.9);
  assert.ok(grainBefore < 1e-3, `the granulator was not quiet before its note (rms ${grainBefore.toExponential(2)})`);
  assert.ok(grainAfter > 1e-3,
    `the granulator played nothing from the sample it was handed (rms ${grainAfter.toExponential(2)}) - `
    + 'the buffer never reached the device, or the control was not pointed at the slot it landed in');

  // The convolution reverb over the same noise burst: the input stops at 0.3 s and a space is
  // still sounding after it. A convolver whose response never got laid out is silent, and one
  // whose partitions are misaligned is noise - this says it is neither.
  const spaceTail = rms(20, 0.6, 0.95);
  const spaceWhile = rms(20, 0.1, 0.29);
  assert.ok(spaceWhile > 5e-3, `the Convolver passed nothing (rms ${spaceWhile.toExponential(2)})`);
  assert.ok(spaceTail > 1e-4, `the Convolver left no tail after its input stopped (rms ${spaceTail.toExponential(2)})`);
});
