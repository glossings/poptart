'use strict';

// What an effect slot plays when one of poptart's own devices is in it: the device, and nothing
// else.
//
// Every effect slot of a track carries two UGens, a VSTPlugin and a PoptartDevice, because the
// track's SynthDef is built before anything says which kind will go in it. An empty PoptartDevice
// is silent, but an empty VSTPlugin PASSES ITS INPUT THROUGH - so a slot that summed the two played
// the dry signal under every native effect. Under a pitch shifter's ~120ms of latency that is an
// echo, which is how it was heard; under a filter it is just a filter at half strength. The slot
// therefore picks one half with its `native` control, set by the load that filled it.
//
// The lines under test are LIFTED OUT OF sc/poptart.scd by pattern, not copied here, so this
// renders the shipped source. Rendered offline (Score.recordNRT): no server boot, no audio device.

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
const PORT = 57297;
const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = DEVICE_BINARY; // this platform's build (extensions.js)
const VSTPLUGIN_DIR = path.join(userExtensionsDir(), 'VSTPlugin', 'plugins');

/** An effect's own node, its two halves and the choice between them, as poptart.scd has it. */
function fxDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^buildFxDef = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find buildFxDef in sc/poptart.scd');
  return m[0];
}

function sclangConf(dir) {
  const file = path.join(dir, 'sclang_conf.yaml');
  const installed = path.join(userExtensionsDir(), 'PoptartDevice.sc');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${installed}\n`);
  return file;
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'slot.wav');
  const q = (s) => JSON.stringify(s);
  const script = `(
var slot, alone, tone, slotIndex, aloneIndex, score, options, buildFxDef, chanIn;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
("HAS-CLASS<" ++ (\\PoptartDevice.asClass.notNil) ++ ">").postln;
// An effect of a track, fed a tone on a bus, with an empty sidechain.
${fs.readFileSync(SCD, 'utf8').match(/^chanIn = \{[\s\S]*?^\};$/m)[0]}
${fxDef()}
slot = buildFxDef.();
tone = SynthDef(\\pt_tone, { |out| Out.ar(out, SinOsc.ar(220, 0, 0.5) ! 2) });
// The same device with no slot around it: what the slot should sound like.
alone = SynthDef(\\pt_slot_alone, { |out = 0|
    var sig = SinOsc.ar(220, 0, 0.5) ! 2;
    Out.ar(out, PoptartDevice.ar([sig[0], sig[1]], 2, 0, [DC.ar(0), DC.ar(0)], \\nslot1));
});
slotIndex = slot.metadata[\\poptartDevices][\\nslot][\\index];
aloneIndex = alone.metadata[\\poptartDevices][\\nslot1][\\index];
score = Score([
    [0.0, ['/d_recv', slot.asBytes]],
    [0.0, ['/d_recv', alone.asBytes]],
    [0.0, ['/d_recv', tone.asBytes]],
    [0.0, ['/s_new', 'pt_tone', 999, 0, 0, 'out', 100]],
    // 0/1: a device in the slot. 2/3: the device alone. 4/5: the slot on its plugin half, empty.
    [0.0, ['/s_new', 'poptart_fx', 1000, 1, 0, 'in', 100, 'out', 0, 'scBus', 1000000, 'active', 1, 'native', 1]],
    [0.0, ['/s_new', 'pt_slot_alone', 1001, 1, 0, 'out', 2]],
    [0.0, ['/s_new', 'poptart_fx', 1002, 1, 0, 'in', 100, 'out', 4, 'scBus', 1000000, 'active', 1, 'native', 0]],
    [0.0, ['/u_cmd', 1000, slotIndex, '/open', 'Filter']],
    [0.0, ['/u_cmd', 1001, aloneIndex, '/open', 'Filter']],
    [0.6, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(6).numAudioBusChannels_(1024);
options.sampleRate = ${SR};
// SuperCollider's own UGens, the committed device binary, and the installed VSTPlugin - the half
// of the slot whose behavior when empty is the point.
options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}, ${q(VSTPLUGIN_DIR)}];
score.recordNRT(
    ${q(path.join(dir, 'slot.osc'))}, ${q(out)}, nil,
    sampleRate: ${SR}, headerFormat: "WAV", sampleFormat: "float",
    options: options, duration: 0.6,
    action: { "RENDER-DONE".postln; 0.exit });
SystemClock.sched(90, { "RENDER-TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let text;
  try {
    text = execFileSync(sclang, ['-l', sclangConf(dir), '-u', String(PORT), file], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('an effect slot with a native device in it plays the device and not the dry signal', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  if (!fs.existsSync(VSTPLUGIN_DIR)) {
    t.skip(`no VSTPlugin installed at ${VSTPLUGIN_DIR} - osc-engine's setup installs it`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-slot-kind-'));
  const { text, out } = render(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(text, /^HAS-CLASS<true>$/m, `sclang did not compile PoptartDevice.sc:\n${text}`);
  if (!text.includes('RENDER-DONE') || !fs.existsSync(out)) {
    t.skip(`scsynth could not render here:\n${text.trim().split('\n').slice(-6).join('\n')}`);
    return;
  }
  const wav = readWavRaw(out);
  assert.ok(wav && wav.channels === 6, `unreadable render: ${JSON.stringify(wav && wav.channels)}`);
  const from = Math.floor(0.1 * SR);
  const to = Math.floor(0.5 * SR);
  const sample = (ch, i) => wav.data[i * wav.channels + ch];
  let deviceRms = 0;
  let worst = 0;
  let passRms = 0;
  for (let i = from; i < to; i++) {
    deviceRms += sample(2, i) ** 2;
    passRms += sample(4, i) ** 2;
    worst = Math.max(worst, Math.abs(sample(0, i) - sample(2, i)), Math.abs(sample(1, i) - sample(3, i)));
  }
  deviceRms = Math.sqrt(deviceRms / (to - from));
  passRms = Math.sqrt(passRms / (to - from));

  // Why the slot has to choose: an empty VSTPlugin is not silent, it is the input. If this ever
  // stops being true the choice is still right, but the comment in poptart.scd is not.
  assert.ok(passRms > 0.3, `an empty VSTPlugin no longer passes its input (rms ${passRms.toFixed(3)})`);
  // The device sounds...
  assert.ok(deviceRms > 0.05, `the Filter alone made no sound (rms ${deviceRms.toFixed(3)})`);
  // ...and the slot is exactly the device: a slot that summed the halves would be the device plus
  // the 0.5-amplitude tone.
  assert.ok(worst < 1e-5, `the slot is not the device alone - off by up to ${worst.toFixed(4)} (the dry signal leaking through)`);
});
