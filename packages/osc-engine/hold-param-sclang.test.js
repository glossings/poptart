'use strict';

// \poptartHoldParam / \poptartReleaseParam (sc/poptart.scd) - a polled parameter taken by the
// pattern and handed back.
//
// A `.param()` that stops speaking for a parameter - the off side of a .when() that alone sets
// it, a call deleted in an eval - should leave the plugin as if the call had never been. Node
// sends a hold before the first value, and sclang reads what the parameter is and keeps it; the
// release drops the poll's ramp, unmaps the parameter and sets it back. What this guards: (1) the
// handlers compile; (2) a hold reads the parameter through the controller's asynchronous get and
// files the answer; (3) a second hold does not ask again or overwrite the first reading; (4) a
// release drops the ramp, unmaps and sets back exactly the reading, and forgets it; (5) a release
// with nothing held (the answer never came) unmaps and sets nothing. The source under test is
// lifted out of the shipped poptart.scd, with the controller's `set` renamed so an Event stand-in
// can record it (Event:set is a primitive a mock cannot override). Skipped where sclang can't run.

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
var modFreeDelay = 0.05;
var freeModulatorLater, rampTo, dropRamp, bundleNow, resolveParamIndex;
var log = List.new;
var pendingGet = nil;
var info = (parameters: [(name: "Mix"), (name: "Drive")], findParamIndex: { |self, name| self[\\parameters].detectIndex { |p| p[\\name] == name.asString } });
var ctl = (
    info: info,
    map: { |self, index, bus| log.add("map:" ++ index) },
    unmap: { |self, index| log.add("unmap:" ++ index) },
    setParam: { |self, index, value| log.add("set:" ++ index ++ "=" ++ value) },
    // The server answers a get later: the action is kept and fired by the harness.
    get: { |self, index, action| log.add("get:" ++ index); pendingGet = action }
);
var track = (
    group: Group.basicNew(server, 100),
    controllers: [nil, ctl],
    ramps: IdentityDictionary.new,
    resting: IdentityDictionary.new
);
var hold = { |name| OSCdef(\\poptartHoldParam).func.value(['/poptart/holdParam', 't', 1, name]) };
var release = { |name| OSCdef(\\poptartReleaseParam).func.value(['/poptart/releaseParam', 't', 1, name, 0]) };
tracks[\\t] = track;
${extractClosure('freeModulatorLater')}
${extractClosure('rampTo')}
${extractClosure('dropRamp')}
${extractClosure('bundleNow')}
${extractClosure('resolveParamIndex')}
${extractOscdef('poptartHoldParam', '/poptart/holdParam').replace(/ctl\.set\(/g, 'ctl.setParam(')}
${extractOscdef('poptartReleaseParam', '/poptart/releaseParam').replace(/ctl\.set\(/g, 'ctl.setParam(')}
("COMPILES<" ++ (OSCdef(\\poptartHoldParam).notNil and: { OSCdef(\\poptartReleaseParam).notNil }) ++ ">").postln;

// A hold asks the plugin, and marks the slot as asked while the answer is on its way.
hold.("Mix");
("ASKED<" ++ log.last ++ "," ++ track[\\resting][\\slot1_Mix] ++ ">").postln;
// The first value lands meanwhile (a ramp, as any polled control); then the answer arrives.
rampTo.(track, \\slot1_Mix, 1, "Mix", 0, 0.9);
pendingGet.value(0.42);
("FILED<" ++ track[\\resting][\\slot1_Mix] ++ ">").postln;
// A second hold - a fresh Scheduler - neither asks again nor overwrites the reading.
log.clear; hold.("Mix");
("AGAIN<" ++ log.size ++ "," ++ track[\\resting][\\slot1_Mix] ++ ">").postln;
// The release: the ramp goes, the parameter is unmapped and set back, and nothing is remembered.
log.clear; release.("Mix");
("RELEASED<" ++ log.join(" ") ++ "," ++ track[\\ramps][\\slot1_Mix].isNil ++ "," ++ track[\\resting][\\slot1_Mix].isNil ++ ">").postln;
// A release with no reading to go back to (the get never answered) unmaps and sets nothing.
hold.("Drive"); rampTo.(track, \\slot1_Drive, 1, "Drive", 1, 0.5);
log.clear; release.("Drive");
("UNANSWERED<" ++ log.join(" ") ++ ">").postln;
// A parameter the plugin has not got is left alone on both sides.
log.clear; hold.("Nope"); release.("Nope");
("UNKNOWN<" ++ log.size ++ ">").postln;
0.exit;
)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-hold-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  // A wrapper arms the exit BEFORE loading the harness, so a syntax error in it (which aborts the
  // block, 0.exit included) still ends the run with the report flushed.
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(8, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    // Its own UDP port: the sclang harnesses run in parallel and only ten ports up from the
    // default are tried before sclang gives up on networking.
    return execFileSync(resolveSclangPath(), ['-u', '57296', runner], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a held parameter is read once, and a release puts back what was read', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true>$/m, `the handlers did not compile:\n${out}`);
  assert.match(out, /^ASKED<get:0,pending>$/m, `a hold must ask the plugin and mark the slot:\n${out}`);
  assert.match(out, /^FILED<0\.42>$/m, `the answer must be filed under the slot:\n${out}`);
  assert.match(out, /^AGAIN<0,0\.42>$/m, `a second hold must neither ask nor overwrite:\n${out}`);
  assert.match(out, /^RELEASED<unmap:0 set:0=0\.42,true,true>$/m, `a release must unmap, set back the reading, drop the ramp and forget:\n${out}`);
  assert.match(out, /^UNANSWERED<unmap:1>$/m, `with no reading, a release unmaps and sets nothing:\n${out}`);
  assert.match(out, /^UNKNOWN<0>$/m, `an unknown parameter is left alone:\n${out}`);
});
