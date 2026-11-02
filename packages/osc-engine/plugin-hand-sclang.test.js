'use strict';

// takeHand and \poptartReleaseHands (sc/poptart.scd) - a plugin parameter the code sets, moved in
// the plugin's own window.
//
// The poll drives a `.param()` through a ramp mapped onto the parameter, so a move in the plugin's
// window was put straight back. A parameter the code SETS (Node's hold says steady) is let go when
// the hand moves it: its ramp dropped, the parameter unmapped, and the poll shut out of it until
// Node hands it back - on the next evaluation, of code the editor has rewritten to the new value.
// A pattern keeps its mapping. What this guards: (1) the source compiles, the whole file included;
// (2) a hand on a setting unmaps it and drops its ramp; (3) the poll then leaves it alone; (4) a
// hand on a pattern takes nothing; (5) handing one back, by name or the whole track, lets the poll
// map a fresh ramp at the code's value; (6) a hold that turns into a pattern, or a release, is no
// longer the hand's to take. Lifted out of the shipped poptart.scd. Skipped where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function extractClosure(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

function extractOscdef(name, address) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^OSCdef\\(\\\\${name}, \\{[\\s\\S]*?^\\}, '${address}'\\);$`, 'm'));
  assert.ok(m, `could not find the ${name} OSCdef in sc/poptart.scd`);
  return m[0];
}

function runSclang() {
  const script = `(
var server = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new;
var tellRamp = { }, tellSlot = { }, tellMods = { }, tellTap = { }, shapesHandled = IdentityDictionary.new, nodeAddr = (sendMsg: { });
var nodeGoneSaid = IdentitySet.new, nodeOwns = { |nodeID, what| };
var modFreeDelay = 0.05;
var freeModulatorLater, rampTo, dropRamp, takeHand, bundleNow, resolveParamIndex, leafRampTime;
var exprLeaf, busIndexOf, paramTarget, reassertAudioDrivers, exprFeed, channelDefault;
var channelTarget = { |track, name| [track[\\synth], name.asSymbol] };
var chanAudio = { |name| false }, setChanAr = { |track, name, index| };
var log = List.new;
var info = (parameters: [(name: "Mix"), (name: "Drive")], findParamIndex: { |self, name| self[\\parameters].detectIndex { |p| p[\\name] == name.asString } });
var ctl = (
    info: info,
    map: { |self, index, bus| log.add("map:" ++ index) },
    unmap: { |self, index| log.add("unmap:" ++ index) },
    setParam: { |self, index, value| log.add("set:" ++ index ++ "=" ++ value) },
    get: { |self, index, action| }
);
var track = (
    group: Group.basicNew(server, 100),
    controllers: [nil, ctl],
    ramps: IdentityDictionary.new,
    resting: IdentityDictionary.new,
    steady: IdentitySet.new,
    hands: IdentitySet.new
);
var hold = { |name, steady| OSCdef(\\poptartHoldParam).func.value(['/poptart/holdParam', 't', 1, name, steady]) };
var release = { |name| OSCdef(\\poptartReleaseParam).func.value(['/poptart/releaseParam', 't', 1, name, 0]) };
var handsBack = { |...args| OSCdef(\\poptartReleaseHands).func.value(['/poptart/releaseHands', 't'] ++ args) };
var poll = { |name, value| rampTo.(track, ("slot1_" ++ name).asSymbol, 1, paramTarget.(track, 1, name), value) };
var taken;
tracks[\\t] = track;
${extractClosure('freeModulatorLater')}
${extractClosure('rampTo')}
${extractClosure('dropRamp')}
${extractClosure('takeHand')}
${extractClosure('bundleNow')}
${extractClosure('resolveParamIndex')}
${extractClosure('exprLeaf')}
${extractClosure('busIndexOf')}
${extractClosure('paramTarget')}
${extractOscdef('poptartHoldParam', '/poptart/holdParam').replace(/ctl\.set\(/g, 'ctl.setParam(')}
${extractOscdef('poptartReleaseParam', '/poptart/releaseParam').replace(/ctl\.set\(/g, 'ctl.setParam(')}
${extractOscdef('poptartReleaseHands', '/poptart/releaseHands')}
("FILE<" ++ thisProcess.interpreter.compileFile(${JSON.stringify(SCD)}).notNil ++ ">").postln;

// Mix is set by the code, Drive by a pattern; both are polled through ramps.
hold.("Mix", 1); hold.("Drive", 0);
poll.("Mix", 0.4); poll.("Drive", 0.5);
log.clear;
// A hand on Mix in the plugin's window.
taken = takeHand.(\\t, track, 1, 0);
("TAKEN<" ++ taken.asArray ++ "," ++ log.join(" ") ++ "," ++ track[\\ramps][\\slot1_Mix].isNil ++ ">").postln;
log.clear; poll.("Mix", 0.4);
("POLL<" ++ log.size ++ "," ++ track[\\ramps][\\slot1_Mix].isNil ++ ">").postln;
// A hand on the pattern's Drive.
log.clear; taken = takeHand.(\\t, track, 1, 1);
("PATTERN<" ++ taken.size ++ "," ++ log.size ++ "," ++ track[\\ramps][\\slot1_Drive].notNil ++ ">").postln;
// Handed back by name: the poll maps a fresh ramp at the code's value.
handsBack.(1, "Mix");
log.clear; poll.("Mix", 0.9);
("BACK<" ++ log.join(" ") ++ "," ++ track[\\ramps][\\slot1_Mix][\\target] ++ ">").postln;
// Taken again, then the whole track handed back (an evaluation).
takeHand.(\\t, track, 1, 0); handsBack.();
("TRACK<" ++ track[\\hands].size ++ ">").postln;
// Mix turns into a pattern: no longer the hand's.
hold.("Mix", 0);
log.clear; taken = takeHand.(\\t, track, 1, 0);
("NOWPATTERN<" ++ taken.size ++ "," ++ log.size ++ ">").postln;
// A release forgets that it was a setting.
hold.("Mix", 1); release.("Mix");
("RELEASED<" ++ track[\\steady].includes(\\slot1_Mix) ++ ">").postln;
0.exit;
)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-hands-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(8, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    // Its own UDP port: the sclang harnesses run in parallel (see hold-param-sclang.test.js).
    return execFileSync(resolveSclangPath(), ['-u', '57304', runner], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a hand in a plugin window takes a parameter the code sets, until it is handed back', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^FILE<true>$/m, `sc/poptart.scd did not compile:\n${out}`);
  assert.match(out, /^TAKEN<\[slot1_Mix\],unmap:0,true>$/m, `a hand on a setting must unmap it and drop its ramp:\n${out}`);
  assert.match(out, /^POLL<0,true>$/m, `the poll must leave a taken parameter alone:\n${out}`);
  assert.match(out, /^PATTERN<0,0,true>$/m, `a hand on a pattern takes nothing:\n${out}`);
  assert.match(out, /^BACK<map:0,0\.9>$/m, `handed back, the poll maps a fresh ramp at the code's value:\n${out}`);
  assert.match(out, /^TRACK<0>$/m, `an evaluation hands back every one on the track:\n${out}`);
  assert.match(out, /^NOWPATTERN<0,0>$/m, `a setting that became a pattern is no longer the hand's:\n${out}`);
  assert.match(out, /^RELEASED<false>$/m, `a release forgets the setting:\n${out}`);
});
