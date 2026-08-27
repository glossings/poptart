'use strict';

// rampTo / dropRamp / dropSlotRamps (sc/poptart.scd) - the bus behind every polled control.
//
// A polled control (anything Node re-sends every poll: a mini string, a product of two
// modulators, a constant) no longer lands as a bare `set` on the plugin: its first value makes a
// control bus with a poptart_ramp synth writing it, mapped onto the parameter exactly as a native
// modulator's bus is, and later values move the ramp's target. What this guards: (1) the closures
// compile; (2) the first value creates the entry and maps the bus, on a plugin parameter and on a
// channel control alike; (3) a plugin swap that moves the parameter's index re-maps the SAME bus
// (the mapping follows, the bus never changes hands); (4) dropSlotRamps takes exactly one slot's
// ramps, and defers their frees like any dropped modulator, since the values already sent to them
// are timestamped ahead. Like the other *-sclang tests the source under test is lifted out of the
// shipped poptart.scd; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function extract(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

function runSclang() {
  // No server is booted: Bus.control allocates client-side (its index goes nil when freed), and a
  // Synth made against an unreachable server is a node id and a message nobody receives. The
  // plugin controller and track synth are stand-ins that record what was mapped where.
  const script = `(
var server = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new;
var modFreeDelay = 0.05;
var freeModulatorLater, rampTo, dropRamp, dropSlotRamps;
var maps = List.new;
var ctlFor = { |slot| (map: { |self, index, bus| maps.add("slot" ++ slot ++ ":" ++ index ++ "->" ++ bus.index) }) };
var track = (
    group: Group.basicNew(server, 100), // a real node object (nothing is sent), so Synth.new finds its server
    synth: (map: { |self, name, bus| maps.add("chan:" ++ name ++ "->" ++ bus.index) }),
    controllers: [ctlFor.(0), ctlFor.(1), ctlFor.(2)],
    ramps: IdentityDictionary.new
);
var busOf = { |k| track[\\ramps][k][\\bus].index };
var mixBus, mixSynth;
tracks[\\t] = track;
${extract('freeModulatorLater')}
${extract('rampTo')}
${extract('dropRamp')}
${extract('dropSlotRamps')}
("COMPILES<" ++ [rampTo, dropRamp, dropSlotRamps].every({ |f| f.isKindOf(Function) }) ++ ">").postln;

// First value on a plugin parameter: an entry, its bus mapped onto index 7.
rampTo.(track, \\slot1_Mix, 1, "Mix", 7, 0.5);
("CREATED<" ++ track[\\ramps][\\slot1_Mix].notNil ++ "," ++ maps.last ++ ">").postln;
mixBus = busOf.(\\slot1_Mix); mixSynth = track[\\ramps][\\slot1_Mix][\\synth];
// A second value moves the target on the same entry - no new bus, no new map.
rampTo.(track, \\slot1_Mix, 1, "Mix", 7, 0.8);
("MOVED<" ++ (busOf.(\\slot1_Mix) == mixBus) ++ "," ++ (track[\\ramps][\\slot1_Mix][\\synth] === mixSynth) ++ "," ++ maps.size ++ ">").postln;
// The plugin was swapped and Mix is now index 3: the SAME bus is re-mapped there.
rampTo.(track, \\slot1_Mix, 1, "Mix", 3, 0.8);
("FOLLOWED<" ++ (busOf.(\\slot1_Mix) == mixBus) ++ "," ++ maps.last ++ ">").postln;
// A channel control maps onto the track synth by name.
rampTo.(track, 'slot-1_gain', -1, "gain", nil, 1);
("CHANNEL<" ++ maps.last ++ ">").postln;
// Two slots' worth of ramps; dropping slot 2 leaves slot 1 and the channel alone.
rampTo.(track, \\slot2_Drive, 2, "Drive", 1, 0.2);
rampTo.(track, \\slot2_Tone, 2, "Tone", 2, 0.2);
dropSlotRamps.(\\t, track, 2);
("DROPPED<" ++ track[\\ramps].keys.asArray.collect(_.asString).sort.join(",") ++ ">").postln;
// ...and dropRamp on the channel control, for the native-takeover case.
dropRamp.(\\t, track, 'slot-1_gain');
("REMAINING<" ++ track[\\ramps].keys.asArray.collect(_.asString).sort.join(",") ++ ">").postln;
// Nothing is freed until the deferral elapses.
("HELD<" ++ (busOf.(\\slot1_Mix).notNil) ++ ">").postln;
SystemClock.sched(modFreeDelay + 0.1, {
    ("LIVE-BUS<" ++ busOf.(\\slot1_Mix).notNil ++ ">").postln;
    0.exit;
    nil;
});
)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ramp-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  // Run through a wrapper that arms an exit BEFORE loading the harness. A syntax error in the
  // harness aborts its whole block - the 0.exit inside it included - and sclang then idles at its
  // prompt with the error report stuck in a stdout buffer nothing flushes until the runner's
  // timeout kills it. Armed outside, the exit fires regardless and the report comes out with it.
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(8, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  try {
    return execFileSync(resolveSclangPath(), [runner], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a polled control rides one ramp bus, and the bus follows the parameter', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true>$/m, `the ramp closures did not compile:\n${out}`);
  assert.match(out, /^CREATED<true,slot1:7->\d+>$/m, `the first value must create the ramp and map its bus:\n${out}`);
  assert.match(out, /^MOVED<true,true,1>$/m, `a later value must only move the target:\n${out}`);
  assert.match(out, /^FOLLOWED<true,slot1:3->\d+>$/m, `a moved index must re-map the same bus:\n${out}`);
  assert.match(out, /^CHANNEL<chan:gain->\d+>$/m, `a channel control maps onto the track synth by name:\n${out}`);
  assert.match(out, /^DROPPED<slot-1_gain,slot1_Mix>$/m, `dropSlotRamps must take exactly that slot's ramps:\n${out}`);
  assert.match(out, /^REMAINING<slot1_Mix>$/m, `dropRamp must take the one ramp:\n${out}`);
  assert.match(out, /^HELD<true>$/m, 'a dropped ramp must not be freed synchronously');
  assert.match(out, /^LIVE-BUS<true>$/m, 'a ramp still in use must keep its bus');
});
