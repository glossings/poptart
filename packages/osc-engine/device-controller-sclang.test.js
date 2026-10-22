'use strict';

// PoptartDeviceController (native/devices/PoptartDevice.sc) - the handle sc/poptart.scd drives a
// native device through.
//
// It has a VSTPluginController's method names on purpose, because that is what lets setParam, the
// ramps, the LFOs, the envelopes, MIDI and OSC control and the note paths treat poptart's own
// devices and plugins as one kind of thing. So what is checked here is the surface those paths
// use: that a control resolves by id AND by display name, that a set and a map leave as the right
// unit command, that MIDI velocity arrives as the 0..1 a device reads, that a program round-trips
// (which is what `synth("Plaits", { state })` rides on), and that an open which is never answered
// answers itself - a track whose notes are held for a load that never lands would be silent for
// the rest of the set.
//
// Run in a real sclang with no server: the messages are sent to sclang's own OSC port and read
// back there. Skipped, not failed, where sclang cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { userExtensionsDir } = require('./extensions.js');

const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const CLASS_FILE = path.join(NATIVE_DIR, 'PoptartDevice.sc');
/** This file's own UDP port: the harnesses run in parallel and sclang only tries ten up from 57120. */
const PORT = 57295;

// This checkout's class file and not the installed copy - compiling two of a class is a hard
// error in sclang. Same reason as native-device-sclang.test.js, which excludes the same path.
function sclangConf(dir) {
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'poptart', 'PoptartDevice.sc')}\n`);
  return file;
}

function run(dir) {
  const sclang = resolveSclangPath();
  const program = path.join(dir, 'program.json');
  const script = `(
var srv, def, synth, ctl, other, params, defIndex;
// Every unit command the controller sends, as it goes past. The server is a stand-in whose
// address is this sclang's own port, so the messages are real OSC that arrives here.
OSCFunc({ |msg| ("SENT<" ++ msg.asArray.join(" ") ++ ">").postln }, '/u_cmd');
PoptartDeviceController.openTimeout = 0.5;
srv = Server(\\pdControllerTest, NetAddr("127.0.0.1", ${PORT}));
def = SynthDef(\\pd_ctl, { Out.ar(0, PoptartDevice.ar([], 2, 0, nil, \\nslot0)) });
defIndex = def.metadata[\\poptartDevices][\\nslot0][\\index];
("DEFINDEX<" ++ defIndex ++ ">").postln;

synth = Synth.basicNew(\\pd_ctl, srv, 1000);
ctl = PoptartDeviceController(synth, \\nslot0, def);
("CTLINDEX<" ++ ctl.synthIndex ++ ">").postln;

params = [(id: "engine", name: "Engine", default: 0.125), (id: "lpgcolor", name: "LPG Color", default: 0.5)];
ctl.open("Plaits", params, { |self, ok| ("OPENED<" ++ ok ++ ">").postln });
// A control nobody has set is at its default, which is where the UGen opened it - not at 0.
ctl.get(1, { |v| ("FRESH<" ++ v ++ ">").postln });

// A control resolves by either spelling, in any case - the rule the browser follows too.
("BYID<" ++ ctl.info.findParamIndex("lpgcolor") ++ ">").postln;
("BYNAME<" ++ ctl.info.findParamIndex("LPG Color") ++ ">").postln;
("BYCASE<" ++ ctl.info.findParamIndex("lpg color") ++ ">").postln;
("BYNONE<" ++ (ctl.info.findParamIndex("nope") ? "nil") ++ ">").postln;
("COUNT<" ++ ctl.info.numParameters ++ ">").postln;
("PARAMNAME<" ++ ctl.info.parameters[1].name ++ ">").postln;

ctl.set(0, 0.25, 1, 0.75);
ctl.map(1, 42);
ctl.unmap(1);
ctl.midi.noteOn(0, 60, 127);
ctl.midi.noteOn(0, 48, 64);
ctl.midi.noteOff(0, 60, 0);
ctl.midi.allNotesOff(0);
ctl.get(1, { |v| ("GOT<" ++ v ++ ">").postln });

// What hush and the stop path ask a slot before they send it an all-notes-off: a native device
// is not a VST 3, so it has to answer this without throwing (see hushTrack in poptart.scd).
("SDK<" ++ (ctl.info.sdkVersion.asString.find("VST 3").isNil) ++ ">").postln;

// The program is the positions, which is the whole of a ported device's state.
ctl.writeProgram(${JSON.stringify(program)}, { |self, ok| ("WROTE<" ++ ok ++ ">").postln });
other = PoptartDeviceController(Synth.basicNew(\\pd_ctl, srv, 1001), \\nslot0, def);
other.open("Plaits", params, { |self, ok| ("OTHEROPENED<" ++ ok ++ ">").postln });
other.readProgram(${JSON.stringify(program)}, { |self, ok| ("READ<" ++ ok ++ ">").postln });
other.get(1, { |v| ("RESTORED<" ++ v ++ ">").postln });

// The answer the server never sends: the open answers itself, once, and says no.
SystemClock.sched(1.5, { "DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let text;
  try {
    text = execFileSync(sclang, ['-l', sclangConf(dir), '-u', String(PORT), file], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return text;
}

test('the device controller resolves controls, sends unit commands and round-trips a program', (t) => {
  assert.ok(fs.existsSync(CLASS_FILE), 'the UGen class file is missing from native/devices');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-devctl-'));
  const text = run(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(text.includes('DONE'), `the harness did not finish:\n${text.trim().split('\n').slice(-8).join('\n')}`);
  const mark = (name) => {
    const m = text.match(new RegExp(`^${name}<(.*)>$`, 'm'));
    assert.ok(m, `no ${name} in the harness output:\n${text.trim().split('\n').slice(-10).join('\n')}`);
    return m[1];
  };

  // The controller found its UGen by the id the track def gave it - which is how a unit command
  // reaches one slot of a def that has twenty-one.
  assert.strictEqual(mark('CTLINDEX'), mark('DEFINDEX'));

  assert.strictEqual(mark('BYID'), '1');
  assert.strictEqual(mark('BYNAME'), '1');
  assert.strictEqual(mark('BYCASE'), '1');
  assert.strictEqual(mark('BYNONE'), 'nil');
  assert.strictEqual(mark('COUNT'), '2');
  assert.strictEqual(mark('PARAMNAME'), 'LPG Color');
  assert.strictEqual(mark('FRESH'), '0.5');

  // The unit commands, as they went out. The node id and the UGen index address one slot.
  const sent = [...text.matchAll(/^SENT<(.*)>$/gm)].map((m) => m[1]);
  const index = mark('DEFINDEX');
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /open Plaits`), `no open in ${JSON.stringify(sent)}`);
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /set 0 0.25 1 0.75`), `no set in ${JSON.stringify(sent)}`);
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /map 1 42`), `no map in ${JSON.stringify(sent)}`);
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /unmap 1`), `no unmap in ${JSON.stringify(sent)}`);
  // MIDI's 0..127 velocity arrives as the 0..1 a device reads, and the channel is dropped: a
  // device is one instrument, not sixteen.
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /noteOn 60.0 1.0`), `no full-velocity note in ${JSON.stringify(sent)}`);
  assert.ok(sent.some((m) => m.startsWith(`/u_cmd 1000 ${index} /noteOn 48.0 0.50`)), `no half-velocity note in ${JSON.stringify(sent)}`);
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /noteOff 60.0`), `no note off in ${JSON.stringify(sent)}`);
  assert.ok(sent.includes(`/u_cmd 1000 ${index} /allNotesOff`), `no all-notes-off in ${JSON.stringify(sent)}`);

  // A set is answered from the controller, which is the authority: nothing else writes these.
  assert.strictEqual(mark('GOT'), '0.75');

  // hush asks what plugin API the slot speaks before sending an all-notes-off. A native device
  // answers, and answers in a way that gets the message sent.
  assert.strictEqual(mark('SDK'), 'true');

  // The program round trip, by name, into a different controller.
  assert.strictEqual(mark('WROTE'), 'true');
  assert.strictEqual(mark('READ'), 'true');
  assert.strictEqual(mark('RESTORED'), '0.75');

  // An open nothing ever answers answers itself, and says no.
  assert.strictEqual(mark('OPENED'), 'false');
  assert.strictEqual(mark('OTHEROPENED'), 'false');
});
