'use strict';

// `.preset()` on one of poptart's own devices, captured and restored, then HEARD.
//
// A device's program is its control positions. The engine's Node half captures it from its own
// record of where the controls are (getPluginState -> deviceStateText, the browser's format) and
// restores it by writing those positions as a program that sclang reads into the slot
// (setPluginState -> PoptartDeviceController's readProgram -> /set). Each step has a unit test;
// what only a render can say is that the round trip lands: the same device, restored from the
// captured preset, sounds sample for sample like the one the preset was taken from - and not
// like the device at its defaults.
//
// The Node half runs here as it runs in the engine, with its OSC sends captured. The program it
// writes is read by a real sclang into a real controller, the /set messages that come out are
// what the render plays, and scsynth renders both offline. Skipped where sclang cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { OscEngine, resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { userExtensionsDir, DEVICE_BINARY } = require('./extensions.js');
const { nativeDevice, paramPosition } = require('./native-devices');

const SR = 48000;
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = DEVICE_BINARY; // this platform's build (extensions.js)
const LANG_PORT = 57303;

function sclangConf(dir) {
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  return file;
}

/** The engine's Node half, its sends captured rather than sent. */
function nodeEngine() {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0;
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  e._warnOnce = () => {};
  return { e, sent };
}

/** A Filter set somewhere audible, captured as a preset, and restored onto a fresh engine. */
async function presetProgram() {
  const source = nodeEngine();
  source.e.loadEffect('t', 'Filter', 1);
  source.e.setParam('t', 1, 'mode', 'bandpass');
  source.e.setParam('t', 1, 'cutoff', paramPosition(nativeDevice('Filter'), 'cutoff', 700));
  source.e.setParam('t', 1, 'resonance', 0.65);
  source.e.setParam('t', 1, 'drive', paramPosition(nativeDevice('Filter'), 'drive', 2));
  const preset = await source.e.getPluginState('t', 1);
  const positions = source.e.deviceSlot('t', 1).positions;

  const target = nodeEngine();
  target.e.loadEffect('t', 'Filter', 1);
  target.e.setPluginState('t', 1, preset);
  await target.e._stateIdle();
  const restore = target.sent.find((m) => m.addr === '/poptart/setPluginState');
  assert.ok(restore, 'the restore never wrote a program for sclang');
  return { programFile: restore.args[2], positions };
}

function render(dir, { programFile, positions }) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'preset.wav');
  const q = (s) => JSON.stringify(s);
  const device = nativeDevice('Filter');
  const params = `[${device.params.map((p) => `(id: ${q(p.id)}, name: ${q(p.name)}, default: ${paramPosition(device, p.id, p.default)})`).join(', ')}]`;
  // The source: every control set where the Node half recorded it, as the pattern set it.
  const direct = device.params.map((p, i) => `${i}, ${positions[p.id]}`).join(', ');
  const script = `(
var srv, def, synth, ctl, sets = List[];
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
// The controller's server is this sclang itself, so what it sends arrives here to be kept.
srv = Server(\\pdPresetTest, NetAddr("127.0.0.1", ${LANG_PORT}));
OSCFunc({ |msg| if (msg[3] == '/set') { sets.add(msg.asArray) } }, '/u_cmd');
PoptartDeviceController.openTimeout = 0.2;
def = SynthDef(\\pd_preset_fx, { |out = 0|
    Out.ar(out, PoptartDevice.ar(Saw.ar([110, 165]) * 0.2, 2, 0, nil, \\slot1));
});
synth = Synth.basicNew(\\pd_preset_fx, srv, 1001);
ctl = PoptartDeviceController(synth, \\slot1, def);
ctl.open("Filter", ${params}, nil);
ctl.readProgram(${q(programFile)}, { |self, ok| ("READ<" ++ ok ++ ">").postln });
fork {
    var index = def.metadata[\\poptartDevices][\\slot1][\\index], score, options;
    0.5.wait;
    ("SETS<" ++ sets.size ++ ">").postln;
    score = Score([
        [0.0, ['/d_recv', def.asBytes]],
        [0.0, ['/s_new', 'pd_preset_fx', 1000, 0, 0, 'out', 0]],
        [0.0, ['/s_new', 'pd_preset_fx', 1001, 0, 0, 'out', 2]],
        [0.0, ['/s_new', 'pd_preset_fx', 1002, 0, 0, 'out', 4]],
        [0.0, ['/u_cmd', 1000, index, '/open', 'Filter']],
        [0.0, ['/u_cmd', 1001, index, '/open', 'Filter']],
        [0.0, ['/u_cmd', 1002, index, '/open', 'Filter']],
        [0.05, ['/u_cmd', 1000, index, '/set', ${direct}]],
    ] ++ sets.collect { |m| [0.05, m] } ++ [[0.5, ['/c_set', 0, 0]]]);
    options = ServerOptions.new.numOutputBusChannels_(6);
    options.sampleRate = ${SR};
    options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
    score.recordNRT(${q(path.join(dir, 'preset.osc'))}, ${q(out)}, nil,
        sampleRate: ${SR}, headerFormat: "WAV", sampleFormat: "float",
        options: options, duration: 0.5, action: { "RENDER-DONE".postln; 0.exit });
};
SystemClock.sched(60, { "RENDER-TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return { out, text: execFileSync(sclang, ['-l', sclangConf(dir), '-u', String(LANG_PORT), file], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (err) {
    return { out, text: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a device preset captured and restored sounds like the device it was taken from', async (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-preset-'));
  const program = await presetProgram();
  const { out, text } = render(dir, program);
  fs.rmSync(program.programFile, { force: true });
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(text, /^READ<true>$/m, `sclang could not read the restored program:\n${text}`);
  if (!text.includes('RENDER-DONE') || !fs.existsSync(out)) {
    t.skip(`scsynth could not render here:\n${text.trim().split('\n').slice(-6).join('\n')}`);
    return;
  }
  const wav = readWavRaw(out);
  const ch = wav.channels;
  const from = Math.floor(0.1 * SR);
  const to = Math.floor(0.5 * SR);
  let same = 0;
  let fromDefaults = 0;
  let energy = 0;
  for (let i = from; i < to; i++) {
    for (let c = 0; c < 2; c++) {
      const a = wav.data[i * ch + c];
      same = Math.max(same, Math.abs(a - wav.data[i * ch + 2 + c]));
      fromDefaults = Math.max(fromDefaults, Math.abs(a - wav.data[i * ch + 4 + c]));
      energy += a * a;
    }
  }
  assert.ok(energy > 1e-3, 'the Filter passed nothing');
  assert.ok(same < 1e-6, `the restored preset sounds different from the device it was taken from (by ${same.toExponential(2)})`);
  assert.ok(fromDefaults > 1e-2, 'the preset sounded like the defaults: nothing was captured or nothing restored');
});
