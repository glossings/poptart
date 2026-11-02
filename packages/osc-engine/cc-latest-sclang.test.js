'use strict';

// /poptart/setParamCC and /poptart/setParamOSC (sc/poptart.scd) - where a binding made afresh
// starts.
//
// A stop, a mute or a rebuilt track tears a track's bindings down, and the next evaluation makes
// them again. A knob does not say where it is until it moves, so a new binding used to start at
// the floor of its range: every such evaluation dropped the parameter to the bottom until the knob
// was touched. sclang sees every incoming controller (it forwards them to Node), so it keeps each
// one's latest position for the session, and a new binding starts there. The floor is only for a
// knob that has not moved since MIDI came on.
//
// The handlers under test are LIFTED OUT OF the shipped poptart.scd and run in a real sclang, with
// the track, its target and the device lookup stubbed; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57304'; // its own, like every sclang harness

function lift(re, what) {
  const m = fs.readFileSync(SCD, 'utf8').match(re);
  assert.ok(m, `could not find ${what} in sc/poptart.scd`);
  return m[0];
}

function runSclang() {
  const setParamCC = lift(/^OSCdef\(\\poptartSetParamCC, \{[\s\S]*?^\}, '\/poptart\/setParamCC'\);$/m, 'the setParamCC handler');
  const setParamOSC = lift(/^OSCdef\(\\poptartSetParamOSC, \{[\s\S]*?^\}, '\/poptart\/setParamOSC'\);$/m, 'the setParamOSC handler');
  const sawCC = lift(/^midiSawCC = \{[\s\S]*?^\};$/m, 'midiSawCC');
  const latestCC = lift(/^midiLatestCC = \{.*\};$/m, 'midiLatestCC');
  // Buses print what they are set to (a Server whose address prints, as in hush-sclang.test.js);
  // the target's map, the device lookup and the track are Events. No server is booted.
  const script = `(
var server = Server(\\poptartProbe, NetAddr("127.0.0.1", 57998));
var tracks = IdentityDictionary.new;
var midiCCSeen = Dictionary.new, midiSawCC, midiLatestCC;
var oscSeen = Dictionary.new, oscInPort = 57997;
var midiEnable = {}, oscEnable = {}, dropRamp = { |key, track, k| };
var midiWarnMissing = { |context, device| ("MISSING<" ++ device ++ ">").postln };
var src = (device: "Encoder Box", name: "Port 1", uid: 4242);
var midiSourceFor = { |pattern| if ("encoder box port 1".contains(pattern.asString.toLower)) { src } };
var awaitTrack = { |key| tracks[key] };
var awaitTarget = { |track, slot, paramName, who| (kind: \\control, index: 3, map: { |bus| }) };
var bindCC, bindOSC, busOf;
server.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57998,
    sendMsg: { |self ...msg| if (msg[0].asString == "/c_set") { ("SET<" ++ msg[1] ++ ">" ++ msg[2].round(0.0001)).postln } },
    sendBundle: { |self, time ...msgs| msgs.do { |m| self.sendMsg(*m) } });
${sawCC}
${latestCC}
${setParamCC}
${setParamOSC}
("COMPILES<" ++ midiSawCC.isKindOf(Function) ++ "," ++ midiLatestCC.isKindOf(Function) ++ ">").postln;
bindCC = { |key, param, cc, channel, lo, hi|
    OSCdef(\\poptartSetParamCC).func.value(['/poptart/setParamCC', key, 0, param, "Encoder Box", cc, channel, lo, hi]);
};
bindOSC = { |key, param, address, index, lo, hi|
    OSCdef(\\poptartSetParamOSC).func.value(['/poptart/setParamOSC', key, 0, param, address, index, lo, hi]);
};
// What a binding's bus was last set to, by the entry the handler filed.
busOf = { |key, kind, param| tracks[key][kind][("slot0_" ++ param).asSymbol] };
tracks[\\t] = (ccs: IdentityDictionary.new, oscs: IdentityDictionary.new, controllers: [nil]);
fork {
    // cc 12 turned to a quarter on channel 1, then to three quarters on channel 2.
    midiSawCC.("Encoder Box Port 1", 12, 1, 0.25);
    midiSawCC.("Encoder Box Port 1", 12, 2, 0.75);
    bindCC.(\\t, "Cutoff", 12, 1, 200, 600);   // channel 1: a quarter of the way
    0.05.wait;
    ("LAST<cutoff>" ++ busOf.(\\t, \\ccs, "Cutoff")[\\last]).postln;
    bindCC.(\\t, "Res", 12, 0, 0, 1);          // all channels: the last on any (channel 2's)
    0.05.wait;
    ("LAST<res>" ++ busOf.(\\t, \\ccs, "Res")[\\last]).postln;
    bindCC.(\\t, "Drive", 13, 0, 0.1, 0.9);    // never moved: the floor
    0.05.wait;
    ("LAST<drive>" ++ busOf.(\\t, \\ccs, "Drive")[\\last]).postln;
    // Torn down (a stop) and made again: the entry is new, the position is not lost.
    MIDIdef.all[busOf.(\\t, \\ccs, "Cutoff")[\\defKey]] !? { |d| d.free };
    tracks[\\t][\\ccs].removeAt(\\slot0_Cutoff);
    midiSawCC.("Encoder Box Port 1", 12, 1, 0.5);
    bindCC.(\\t, "Cutoff", 12, 1, 200, 600);
    0.05.wait;
    ("LAST<rebuilt>" ++ busOf.(\\t, \\ccs, "Cutoff")[\\last]).postln;
    // OSC: the address's latest arguments, by index, raw as the binding reads them.
    oscSeen["/1/fader"] = [0.4, 0.8];
    bindOSC.(\\t, "Mix", '/1/fader', 1, 0, 2);
    bindOSC.(\\t, "Gain", '/never', 0, 0.5, 1);
    0.05.wait;
    ("LAST<mix>" ++ busOf.(\\t, \\oscs, "Mix")[\\last]).postln;
    ("LAST<gain>" ++ busOf.(\\t, \\oscs, "Gain")[\\last]).postln;
    "DONE".postln;
    0.exit;
};
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-cclatest-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a binding made afresh starts where its knob was last seen, the floor only for one never moved', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true,true>$/m, `the lifted closures did not compile:\n${out}`);
  assert.match(out, /^DONE$/m, `the harness did not run to its end:\n${out}`);
  // The channel's own latest, scaled into lo..hi on the bus.
  assert.match(out, /^LAST<cutoff>0\.25$/m, `a channel binding did not start from its channel's position:\n${out}`);
  assert.match(out, /^SET<\d+>300(\.0)?$/m, `the bus did not start at 200 + 0.25 * 400:\n${out}`);
  // All channels: the last on any.
  assert.match(out, /^LAST<res>0\.75$/m, `an all-channels binding did not start from the last on any channel:\n${out}`);
  // Never moved: the floor of its range.
  assert.match(out, /^LAST<drive>0$/m, `an unmoved knob must start at the floor:\n${out}`);
  assert.match(out, /^SET<\d+>0\.1$/m, `the unmoved knob's bus did not start at its floor:\n${out}`);
  // Torn down and rebound: where the knob is now.
  assert.match(out, /^LAST<rebuilt>0\.5$/m, `a rebuilt binding fell back to the floor:\n${out}`);
  assert.match(out, /^SET<\d+>400(\.0)?$/m, `the rebuilt bus did not start at 200 + 0.5 * 400:\n${out}`);
  // OSC the same way.
  assert.match(out, /^LAST<mix>0\.8$/m, `an osc binding did not start from the address's latest argument:\n${out}`);
  assert.match(out, /^LAST<gain>0$/m, `an address never sent must start at the floor:\n${out}`);
  assert.doesNotMatch(out, /ERROR/, `sclang reported an error:\n${out}`);
});
