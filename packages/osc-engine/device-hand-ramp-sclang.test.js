'use strict';

// A program loaded into one of poptart's own devices after a control was turned in its window
// (dropHandRamps, sc/poptart.scd).
//
// The window's turn goes out through rampTo like any polled value, so the control ends up mapped
// onto a ramp's bus - and a program load puts every mapped control back on its bus (the device
// controller's readProgram). Without dropHandRamps that ramp, still writing the hand's value, won
// over every preset loaded afterwards: the controls a window had touched stayed where the hand
// left them, and the presets all sounded alike. What this guards: (1) a ramp the window left is
// dropped before the load and its control set where the hand left it, so the program moves it
// and nothing maps it back; (2) a ramp the pattern polls (held for it) stays and is mapped back,
// as a driven control is. The closures are lifted out of the shipped poptart.scd and run against
// the real controller class, its unit commands read back off sclang's own port. Skipped where
// sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { userExtensionsDir } = require('./extensions.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
/** This file's own UDP port: the harnesses run in parallel and sclang only tries ten up from 57120. */
const PORT = 57304;

function extractClosure(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

// This checkout's class file and not the installed copy - compiling two of a class is a hard error.
function sclangConf(dir) {
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'poptart', 'PoptartDevice.sc')}\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n`);
  return file;
}

function run(dir) {
  const program = path.join(dir, 'program.json');
  fs.writeFileSync(program, JSON.stringify({ device: 'Hat', params: { tone: 0.2, decay: 0.1 } }));
  const script = `(
var server = Server(\\pdHandRamp, NetAddr("127.0.0.1", ${PORT}));
var tracks = IdentityDictionary.new;
var tellRamp = { }, nodeOwns = { |nodeID, what| }, nodeGoneSaid = IdentitySet.new;
var modFreeDelay = 0.05;
var freeModulatorLater, rampTo, dropRamp, dropHandRamps, bundleNow, resolveParamIndex, leafRampTime;
var exprLeaf, busIndexOf, paramTarget, reassertAudioDrivers, exprFeed, channelDefault, channelTarget, chanAudio, setChanAr;
var def, ctl, track, params;
OSCFunc({ |msg| ("SENT<" ++ msg.asArray.join(" ") ++ ">").postln }, '/u_cmd');
PoptartDeviceController.openTimeout = 0.2;
${extractClosure('freeModulatorLater')}
${extractClosure('rampTo')}
${extractClosure('dropRamp')}
${extractClosure('dropHandRamps')}
${extractClosure('bundleNow')}
${extractClosure('resolveParamIndex')}
${extractClosure('exprLeaf')}
${extractClosure('busIndexOf')}
${extractClosure('paramTarget')}
def = SynthDef(\\pd_hand, { Out.ar(0, PoptartDevice.ar([], 2, 0, nil, \\nslot0)) });
("DEFINDEX<" ++ def.metadata[\\poptartDevices][\\nslot0][\\index] ++ ">").postln;
ctl = PoptartDeviceController(Synth.basicNew(\\pd_hand, server, 1000), \\nslot0, def);
params = [(id: "tone", name: "Tone", default: 0.5), (id: "decay", name: "Decay", default: 0.5)];
ctl.open("Hat", params, { });
track = (
    key: \\t,
    group: Group.basicNew(server, 100),
    controllers: IdentityDictionary[0 -> ctl],
    ramps: IdentityDictionary.new,
    resting: IdentityDictionary.new,
    steady: IdentitySet.new,
    hands: IdentitySet.new
);
tracks[\\t] = track;
// The pattern polls Decay: held first, as the scheduler does, then its ramp.
track[\\resting][\\slot0_decay] = 0.5;
rampTo.(track, \\slot0_decay, 0, paramTarget.(track, 0, "decay"), 0.6);
// The window turns Tone, which reaches the device the same way.
rampTo.(track, \\slot0_tone, 0, paramTarget.(track, 0, "tone"), 0.9);
// A marker in the same stream as the unit commands, so what the load sent can be told apart.
server.sendMsg('/u_cmd', 0, 0, "LOAD");
dropHandRamps.(\\t, track, 0);
ctl.readProgram(${JSON.stringify(program)}, { |self, ok| ("READ<" ++ ok ++ ">").postln });
("RAMPS<" ++ track[\\ramps].keys.asArray.collect(_.asString).sort.join(",") ++ ">").postln;
ctl.get(0, { |v| ("TONE<" ++ v ++ ">").postln });
SystemClock.sched(0.5, { "DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-l', sclangConf(dir), '-u', String(PORT), file], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a program loaded into a device moves a control its window turned, and leaves a polled one on its ramp', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-handramp-'));
  const text = run(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(text.includes('DONE'), `the harness did not finish:\n${text.trim().split('\n').slice(-12).join('\n')}`);
  const mark = (name) => {
    const m = text.match(new RegExp(`^${name}<(.*)>$`, 'm'));
    assert.ok(m, `no ${name} in the harness output:\n${text.trim().split('\n').slice(-12).join('\n')}`);
    return m[1];
  };
  assert.strictEqual(mark('READ'), 'true');
  // The window's ramp is gone; the pattern's stays.
  assert.strictEqual(mark('RAMPS'), 'slot0_decay');
  // The program's value is where Tone is.
  assert.strictEqual(Number(mark('TONE')), 0.2);

  const index = mark('DEFINDEX');
  const sent = [...text.matchAll(/^SENT<(.*)>$/gm)].map((m) => m[1]);
  const at = sent.indexOf('/u_cmd 0 0 LOAD');
  assert.ok(at >= 0, `no load marker in ${JSON.stringify(sent)}`);
  const before = sent.slice(0, at);
  const afterLoad = sent.slice(at + 1);
  const ours = (cmd, control) => (m) => m.startsWith(`/u_cmd 1000 ${index} ${cmd} ${control} `);
  // Before the load both controls were on ramps.
  assert.ok(before.some(ours('/map', 0)), `Tone was never mapped onto its ramp: ${JSON.stringify(before)}`);
  assert.ok(before.some(ours('/map', 1)), `Decay was never mapped onto its ramp: ${JSON.stringify(before)}`);
  // After it: Tone is set where the hand left it, then by the program, and never mapped again.
  const toneSets = afterLoad.filter(ours('/set', 0)).map((m) => Number(m.split(' ')[5]));
  assert.ok(toneSets.length >= 2 && Math.abs(toneSets[0] - 0.9) < 1e-6 && Math.abs(toneSets.at(-1) - 0.2) < 1e-6,
    `Tone was not set where the hand left it and then by the program: ${JSON.stringify(afterLoad)}`);
  assert.ok(!afterLoad.some(ours('/map', 0)), `Tone was mapped back onto the window's ramp: ${JSON.stringify(afterLoad)}`);
  // Decay, which the pattern polls, goes back on its ramp after the program's set.
  const lastSet = afterLoad.findLastIndex(ours('/set', 1));
  const remap = afterLoad.findLastIndex(ours('/map', 1));
  assert.ok(lastSet >= 0 && remap > lastSet, `the polled control was not mapped back after the load: ${JSON.stringify(afterLoad)}`);
});
