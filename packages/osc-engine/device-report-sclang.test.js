'use strict';

// A device's live state, asked of the UGen itself: where each control is as the DEVICE last read
// it, and what it says it is doing (PoptartDevice.cpp's /report, answered by SendNodeReply and
// read by PoptartDeviceController's report).
//
// This is what lets a device window draw a knob under a modulator where the modulator has GOT TO:
// a control bus mapped onto the UGen is read by nobody else, so the controller's own record (what
// was sent) cannot say. The test maps a bus onto a control and asks; it also asks a granulator
// that is playing for its grains, and Distort for its meters.
//
// SendNodeReply needs a running server - an offline render sends its replies nowhere - so this
// boots one, output only and as small as will boot, on ports of its own. Skipped where sclang or
// scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { writeWav } = require('./wav.js');
const { userExtensionsDir } = require('./extensions.js');
const { nativeDevice, paramPosition, deviceParam } = require('./native-devices');

const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = path.join(NATIVE_DIR, 'bin', 'PoptartDevices.scx');
const LANG_PORT = '57302';
const SCSYNTH_PORT = 57122;

const index = (id, param) => nativeDevice(id).params.findIndex((p) => p.id === param);

/** A device's controls as the controller is opened with them: id, name and resting position. */
function paramsLiteral(id) {
  const device = nativeDevice(id);
  return `[${device.params.map((p) => `(id: ${JSON.stringify(p.id)}, name: ${JSON.stringify(p.name)}, default: ${paramPosition(device, p.id, p.default)})`).join(', ')}]`;
}

function sclangConf(dir) {
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  return file;
}

function run(dir) {
  const sound = path.join(dir, 'sound.wav');
  const frames = 48000;
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.5;
  writeWav(sound, { sampleRate: 48000, channels: 1, data });
  const q = (s) => JSON.stringify(s);
  const grainSlot = deviceParam(nativeDevice('Granular'), 'sample').options.length;
  const script = `(
var server = Server(\\poptartReportTest, NetAddr("127.0.0.1", ${SCSYNTH_PORT}));
var said = { |tag, values| (tag ++ "<" ++ (values ? []).collect({ |v| v.round(0.0001) }).join(",") ++ ">").postln };
server.options.numInputBusChannels = 0;
server.options.numOutputBusChannels = 2;
server.options.outputStreamsEnabled = "0"; // tests never play through the speakers
server.options.memSize = 8192;
server.options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
PoptartDeviceController.openTimeout = 5;
server.waitForBoot {
    var fxDef, synthDef, filter, grains, distort, empty, fxSynth, grainSynth, distSynth, emptySynth, bus, buf, opened = 0;
    fxDef = SynthDef(\\pd_report_fx, { |out = 0|
        Out.ar(out, PoptartDevice.ar(SinOsc.ar(330) * 0.2 ! 2, 2, 0, nil, \\fx) * 0);
    }).add;
    synthDef = SynthDef(\\pd_report_synth, { |out = 0|
        Out.ar(out, PoptartDevice.ar([], 2, 0, nil, \\inst) * 0);
    }).add;
    buf = Buffer.read(server, ${q(sound)});
    server.sync;
    fxSynth = Synth(\\pd_report_fx, [], server);
    distSynth = Synth(\\pd_report_fx, [], server);
    grainSynth = Synth(\\pd_report_synth, [], server);
    emptySynth = Synth(\\pd_report_synth, [], server);
    server.sync;
    filter = PoptartDeviceController(fxSynth, \\fx, fxDef);
    distort = PoptartDeviceController(distSynth, \\fx, fxDef);
    grains = PoptartDeviceController(grainSynth, \\inst, synthDef);
    empty = PoptartDeviceController(emptySynth, \\inst, synthDef);
    filter.open("Filter", ${paramsLiteral('Filter')}, { |c, ok| ("OPENED<Filter," ++ ok ++ ">").postln; opened = opened + 1 });
    distort.open("Distort", ${paramsLiteral('Distort')}, { |c, ok| ("OPENED<Distort," ++ ok ++ ">").postln; opened = opened + 1 });
    grains.open("Granular", ${paramsLiteral('Granular')}, { |c, ok| ("OPENED<Granular," ++ ok ++ ">").postln; opened = opened + 1 });
    0.5.wait;

    // One control set outright, one with a control bus mapped onto it - which only the UGen can
    // say the value of.
    filter.set(${index('Filter', 'cutoff')}, 0.3);
    bus = Bus.control(server, 1);
    bus.set(0.77);
    server.sync;
    filter.map(${index('Filter', 'resonance')}, bus);
    0.2.wait;
    filter.report({ |positions, report|
        said.("FILTER", [positions[${index('Filter', 'cutoff')}], positions[${index('Filter', 'resonance')}], positions.size, report.size]);
    });
    // The bus moves; the next answer follows it.
    bus.set(0.12);
    0.2.wait;
    filter.report({ |positions, report| said.("FILTERMOVED", [positions[${index('Filter', 'resonance')}]]) });

    grains.loadSample(${index('Granular', 'sample')}, ${grainSlot}, buf);
    grains.set(${index('Granular', 'sample')}, ${paramPosition(nativeDevice('Granular'), 'sample', grainSlot)});
    0.2.wait;
    grains.midi.noteOn(0, 60, 127);
    0.4.wait;
    grains.report({ |positions, report| said.("GRAINS", report) });
    distort.report({ |positions, report| said.("DISTORT", report) });
    empty.report({ |positions, report| said.("EMPTY", [positions.size]) });
    0.5.wait;
    "PHASE<end>".postln;
    server.quit;
    0.4.wait;
    0.exit;
};
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(75, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    return execFileSync(resolveSclangPath(), ['-l', sclangConf(dir), '-u', LANG_PORT, runner], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const tagged = (out, tag) => {
  const m = out.match(new RegExp(`^${tag}<([^>]*)>$`, 'm'));
  return m ? (m[1] ? m[1].split(',').map(Number) : []) : null;
};

test('a device says where its controls really are, and what it is doing', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-report-'));
  const out = run(dir);
  if (!/PHASE<end>/.test(out)) {
    t.skip(`no real-time server here: ${out.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
    return;
  }
  for (const id of ['Filter', 'Distort', 'Granular']) assert.match(out, new RegExp(`OPENED<${id},true>`), `${id} did not open:\n${out}`);

  const filter = tagged(out, 'FILTER');
  assert.ok(filter, `the Filter never answered:\n${out}`);
  const [cutoff, resonance, count, reportSize] = filter;
  assert.ok(Math.abs(cutoff - 0.3) < 1e-4, `a control set outright reads ${cutoff}, not 0.3`);
  assert.ok(Math.abs(resonance - 0.77) < 1e-4, `a control under a bus reads ${resonance}, not where the bus is (0.77)`);
  assert.strictEqual(count, nativeDevice('Filter').params.length, 'one position per control');
  assert.strictEqual(reportSize, 0, 'the Filter reports nothing of its own');
  const moved = tagged(out, 'FILTERMOVED');
  assert.ok(moved && Math.abs(moved[0] - 0.12) < 1e-4, `the answer did not follow the bus: ${moved}`);

  const grains = tagged(out, 'GRAINS');
  assert.ok(grains && grains.length >= 4 && grains.length % 4 === 0, `the granulator reported no grains: ${grains}`);
  for (let i = 0; i < grains.length; i += 4) {
    const [from, life, pan] = grains.slice(i, i + 4);
    assert.ok(from >= 0 && from <= 1 && life >= 0 && life <= 1 && pan >= -1 && pan <= 1, `grain ${i / 4} is out of range: ${grains.slice(i, i + 4)}`);
  }
  const distort = tagged(out, 'DISTORT');
  assert.ok(distort && distort.length === 2, `Distort's meters did not come back: ${distort}`);
  assert.ok(distort[1] > 0.1, `Distort reported no input level: ${distort}`);
  assert.deepStrictEqual(tagged(out, 'EMPTY'), [0], 'an empty slot answers with no controls');
});
