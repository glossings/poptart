'use strict';

// hostClockSync / clockNextTick (sc/poptart.scd) - the transport mirror MIDI clock out ticks
// from. What this guards: (1) the closures compile; (2) a sync sets the mirror's tempo and pulls
// its beat position back by tempo * latency (Node's beats are at now + latency, a TempoClock's
// are now); (3) a paused transport re-tunes the tempo but never moves the position (Node is
// frozen at 0 and the tick train must not stutter back there every 4s); (4) start/rebase arm a
// locate and restart the ticker, stop sends the stop, a plain sync does neither; (5) the tick
// index math: the next tick is the first one whose
// sounding moment is after now + lead, and a routine waking exactly at its own send moment gets
// the tick after the one it just sent. Like the other *-sclang tests the source under test is
// lifted out of the shipped poptart.scd; skipped (not failed) where sclang can't run.

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
  const script = `(
var hostClock = TempoClock(2).permanent_(true);
var hostClockSync, clockNextTick, clockOut, clockRunning = false, clockLocate = false, clockTickerStart;
var restarts = 0, b0, b1;
clockTickerStart = { restarts = restarts + 1 };
// The MIDIOut stand-in: something whose stop is observable. An Event stub can't intercept it -
// Object answers stop itself (with nothing) before Event's key lookup gets a look-in.
clockOut = Task { loop { 1.wait } }.play(SystemClock);
${extract('hostClockSync')}
${extract('clockNextTick')}
("COMPILES<" ++ [hostClockSync, clockNextTick].every({ |f| f.isKindOf(Function) }) ++ ">").postln;

// A running sync: 120 bpm, beat 8 due in 0.15 s -> the mirror sits at 8 - 0.3 now.
hostClockSync.(120, 8, 0.15, true, \\sync);
("SYNC<" ++ (hostClock.tempo * 60).round.asInteger ++ "," ++ ((hostClock.beats - 7.7).abs < 1e-6) ++ "," ++ restarts ++ "," ++ clockOut.isPlaying ++ "," ++ clockRunning ++ ">").postln;

// Paused: the tempo follows, the position does not.
b0 = hostClock.beats;
hostClockSync.(90, 0, 0.15, false, \\sync);
("PAUSED<" ++ (hostClock.tempo * 60).round.asInteger ++ "," ++ ((hostClock.beats - b0).abs < 1e-6) ++ "," ++ clockRunning ++ ">").postln;

// Events: start and rebase arm a locate and restart the ticker; stop sends the stop.
hostClockSync.(90, 0, 0.15, true, \\start);
b1 = clockLocate;
clockLocate = false;
hostClockSync.(90, 4, 0.15, true, \\rebase);
("EVENTS<" ++ b1 ++ "," ++ clockLocate ++ "," ++ restarts ++ "," ++ clockOut.isPlaying ++ ">").postln;
hostClockSync.(90, 4, 0.15, false, \\stop);
("STOP<" ++ restarts ++ "," ++ clockOut.isPlaying.not ++ "," ++ clockRunning ++ ">").postln;

// Tick math (24 per beat).
("TICKS<" ++ [
    clockNextTick.(0, 0),            // at the top with no lead: tick 1 is next (tick 0 is now)
    clockNextTick.(0.5, 0.02),       // beat 0.5, lead 0.02 -> (0.52 * 24 = 12.48) -> 13
    clockNextTick.((2 / 24) - 0.1, 0.1), // woke at its own send moment for tick 2: next is 3
    clockNextTick.(-0.3, 0.1)        // before the top: negative indices are fine (pre-start ticks)
].join(",") ++ ">").postln;
0.exit;
)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-midiclock-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  const runner = path.join(dir, 'run.scd');
  fs.writeFileSync(runner, `(
SystemClock.sched(8, { "FAILSAFE-EXIT".postln; 0.exit; nil });
thisProcess.interpreter.executeFile(${JSON.stringify(file)});
)
`);
  // Its own UDP port: the *-sclang tests run in parallel, and sclang only tries ten ports from
  // its default before giving up on networking - one more harness in the default range was
  // enough to make whichever instance lost the race fail its OSC-dependent assertions.
  try {
    return execFileSync(resolveSclangPath(), ['-u', '57180', runner], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the host clock mirror follows Node\'s tempo, position and events', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true>$/m, `the clock closures did not compile:\n${out}`);
  assert.match(out, /^SYNC<120,true,0,true,true>$/m, `a running sync must set tempo and pull the position back by the lead:\n${out}`);
  assert.match(out, /^PAUSED<90,true,false>$/m, `a paused sync must re-tune but never move the position:\n${out}`);
  assert.match(out, /^EVENTS<true,true,2,true>$/m, `start and rebase must arm a locate and restart the ticker:\n${out}`);
  assert.match(out, /^STOP<2,true,false>$/m, `stop must send the stop and nothing else:\n${out}`);
  assert.match(out, /^TICKS<1,13,3,-4>$/m, `the next-tick math is off:\n${out}`);
});
