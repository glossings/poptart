'use strict';

// freeModulatorLater (sc/poptart.scd) - the deferred teardown a dropped Tier-2 modulator gets.
//
// Note events are sent a lookahead ahead of time and gate these synths from inside a TIMESTAMPED
// bundle (poptartNoteOn: `set(\gate, 1)` for env(), `set(\t_trig, 1)` for the note-gated lfo()
// modes). Freeing the node the instant the pattern drops the modulator therefore pulls it out from
// under every note already in flight, and scsynth answers with "FAILURE IN SERVER /n_set Node not
// found" once per note in the window - which is what dropping a `mode: 'envelope'` LFO off a
// playing track looked like from the console (reported 2026-08-26).
//
// What this guards: (1) the closure compiles at all; (2) the free really is deferred, not just
// reordered; (3) the delay clears the scheduler's note lookahead with margin; (4) a track that
// died inside the window doesn't get a stale /n_free (its group already took the node) but still
// gets its bus back - the bus is a client-side allocation destroyTrack can no longer see, and
// leaking one per dropped modulator would be the quieter bug this fix could have introduced.
//
// Like the other *-sclang tests, the source under test is lifted out of the shipped poptart.scd
// and run in a real sclang; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

// The scheduler's note lookahead (pattern-core/src/scheduler.mjs DEFAULT_LOOKAHEAD_SEC) - the
// window of already-sent, not-yet-executed gate messages the delay has to outlast.
const LOOKAHEAD_SEC = 0.15;

function scdSource() {
  return fs.readFileSync(SCD, 'utf8');
}

// Lift `freeModulatorLater = { ... };` from its assignment to the closing `};` at column 0.
function extractFreeModulatorLater() {
  const m = scdSource().match(/^freeModulatorLater = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the freeModulatorLater closure in sc/poptart.scd');
  return m[0];
}

// And the delay it schedules against, off its declaration.
function extractDelay() {
  const m = scdSource().match(/^var modFreeDelay = ([0-9.]+)/m);
  assert.ok(m, 'could not find the modFreeDelay declaration in sc/poptart.scd');
  return Number(m[1]);
}

function runSclang(delay) {
  // Stand-ins for the modulator's synth and bus. `free` can't be mocked with an Event - Object
  // already understands it, so doesNotUnderstand never fires - so both slots hold a real control
  // Bus, whose index goes nil when it is freed. That makes the closure's actual decision visible
  // (which of the two `.free` calls it makes under each track state), which is the thing worth
  // pinning; no server is booted, since allocating and returning a control bus is client-side.
  const script = `(
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new;
var modFreeDelay = ${delay};
var freeModulatorLater;
var groupA = (id: 100), groupB = (id: 200);
var entry = { (synth: Bus.control(srv, 1), bus: Bus.control(srv, 1)) };
var report = { |name, e| ("FREED<" ++ name ++ ">" ++ e[\\synth].index.isNil ++ "," ++ e[\\bus].index.isNil).postln };
var living, orphaned, rebuilt;
${extractFreeModulatorLater()}
("COMPILES<" ++ freeModulatorLater.isKindOf(Function) ++ ">").postln;

living = entry.(); orphaned = entry.(); rebuilt = entry.();
tracks[\\living] = (group: groupA);
tracks[\\orphaned] = (group: groupA);
tracks[\\rebuilt] = (group: groupA);

freeModulatorLater.(\\living, groupA, living[\\synth], living[\\bus]);
freeModulatorLater.(\\orphaned, groupA, orphaned[\\synth], orphaned[\\bus]);
freeModulatorLater.(\\rebuilt, groupA, rebuilt[\\synth], rebuilt[\\bus]);
// Nothing may have gone yet: the notes already in flight still need these nodes.
report.("immediate-living", living);

// Inside the window one track is destroyed outright, and another is torn down and rebuilt under
// the same key - in both cases the group free has already reaped the node.
tracks[\\orphaned] = nil;
tracks[\\rebuilt] = (group: groupB);

SystemClock.sched(modFreeDelay + 0.2, {
    report.("living", living);
    report.("orphaned", orphaned);
    report.("rebuilt", rebuilt);
    0.exit;
    nil;
});
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-modfree-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('a dropped modulator outlives the notes already in flight', (t) => {
  const delay = extractDelay();
  assert.ok(delay > LOOKAHEAD_SEC,
    `modFreeDelay (${delay}s) must outlast the scheduler's ${LOOKAHEAD_SEC}s note lookahead, or a gate `
    + 'message already sent will land on a freed node');

  const out = runSclang(delay);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true>$/m, `the freeModulatorLater closure did not compile:\n${out}`);
  assert.match(out, /^FREED<immediate-living>false,false$/m,
    `nothing may be freed synchronously - that is the whole point of the deferral:\n${out}`);
  // A track still standing gives up both the node and its bus.
  assert.match(out, /^FREED<living>true,true$/m, `the deferred teardown did not run:\n${out}`);
  // A track destroyed or rebuilt inside the window keeps its node free UNSENT - the group already
  // took it, and a stale /n_free is the same console noise in reverse - but must still hand back
  // the bus, which destroyTrack can no longer see to free itself.
  assert.match(out, /^FREED<orphaned>false,true$/m,
    `a destroyed track's modulator must not be double-freed, and must not leak its bus:\n${out}`);
  assert.match(out, /^FREED<rebuilt>false,true$/m,
    `a track rebuilt under the same key must not have the old modulator freed against it:\n${out}`);
});
