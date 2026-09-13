'use strict';

// hushTrack (sc/poptart.scd) - what playing a stopped track again does to the voices it is
// still sounding.
//
// A stop lets everything ring out: every event already sent carries its own gate-off and plays to
// it, so a fitted break runs to the end of its bar. The restart must not play over that, so the
// host hushes the track first. hushTrack releases the sample voices (one gate-off on their
// group), sends the plugins all-notes-off, closes the env modulators' gate, zeroes the held count
// and drops notes waiting on a program load - now, and again `again` seconds on, for a caller
// hushing while events sent a lookahead early are still in flight.
//
// What this guards: (1) the closure compiles; (2) the immediate release reaches every kind of
// voice and clears the bookkeeping; (3) the repeat runs on a track still standing; (4) it does
// NOT run against a track destroyed or rebuilt under the same key inside the window - the new
// track's first notes are its own; (5) a key with no track is a no-op, not an error.
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

// Lift `hushTrack = { ... };` from its assignment to the closing `};` at column 0.
function extractHushTrack() {
  const m = fs.readFileSync(SCD, 'utf8').match(/^hushTrack = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the hushTrack closure in sc/poptart.scd');
  return m[0];
}

function runSclang() {
  // The nodes are real Group/Synth objects (an Event can't stand in for a node: Event has a set
  // of its own) on a Server whose address is a stand-in that prints every message it is handed,
  // so each /n_set shows up with its node id. The plugin controller is an Event whose midi proxy
  // prints. bundleNow just runs its function. No server is booted.
  const script = `(
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new, noteQueues = IdentityDictionary.new, maxSlots = 2;
var slotKey = { |key, slot| (key ++ "_" ++ slot).asSymbol };
var bundleNow = { |latency, func| func.value };
var hushTrack;
var mk = { |name, id| (
    voices: Group.basicNew(srv, id),
    controllers: [(midi: (allNotesOff: { |self, ch| ("ANO<" ++ name ++ ">" ++ ch).postln })), nil],
    envs: IdentityDictionary.new,
    held: 3
) };
srv.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57999,
    sendMsg: { |self ...msg| ("NSET<" ++ msg[1] ++ ">" ++ msg[2] ++ "," ++ msg[3]).postln });
${extractHushTrack()}
("COMPILES<" ++ hushTrack.isKindOf(Function) ++ ">").postln;

tracks[\\living] = mk.(\\living, 100);
tracks[\\rebuilt] = mk.(\\old, 200);
tracks[\\gone] = mk.(\\gone, 300);
tracks[\\living][\\envs][\\e] = (synth: Synth.basicNew(\\x, srv, 150));
noteQueues[\\living_0] = [1];
noteQueues[\\living_1] = [1];

hushTrack.(\\living, 0.3);
hushTrack.(\\rebuilt, 0.3);
hushTrack.(\\gone, 0.3);
hushTrack.(\\missing, 0.3);
("HELD<" ++ tracks[\\living][\\held] ++ ">").postln;
("QUEUES<" ++ noteQueues[\\living_0].isNil ++ "," ++ noteQueues[\\living_1].isNil ++ ">").postln;

// Inside the window one track is destroyed and another rebuilt under its key.
tracks[\\gone] = nil;
tracks[\\rebuilt] = mk.(\\new, 400);

SystemClock.sched(0.6, { "DONE".postln; 0.exit; nil });
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-hush-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    // Its own UDP port: the *-sclang harnesses run in parallel, and sclang gives up after ten
    // tries up from 57120 - carrying on without networking, which breaks a test that listens.
    return execFileSync(resolveSclangPath(), ['-u', '57190', file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const count = (out, re) => (out.match(re) ?? []).length;

test('a hush releases every voice now, and again on request - on the same track only', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true>$/m, `the hushTrack closure did not compile:\n${out}`);
  assert.match(out, /^DONE$/m, `the harness did not run to its end:\n${out}`);
  // The immediate release: sample voices, the plugin, the env modulator, the bookkeeping.
  assert.match(out, /^ANO<living>0$/m, `the instrument did not get all-notes-off:\n${out}`);
  assert.match(out, /^NSET<150>gate,0(\.0)?$/m, `the env modulator's gate was not closed:\n${out}`);
  assert.match(out, /^HELD<0>$/m, `the held-note count was not zeroed:\n${out}`);
  assert.match(out, /^QUEUES<true,true>$/m, `notes waiting on a program load were not dropped:\n${out}`);
  // The repeat: twice on the track still standing, once each where the key was destroyed or
  // rebuilt in the meantime - and never against the rebuilt track's replacement.
  assert.equal(count(out, /^NSET<100>gate,0(\.0)?$/gm), 2, `the living track's voices must be released twice:\n${out}`);
  assert.equal(count(out, /^NSET<300>gate,0(\.0)?$/gm), 1, `a destroyed track's repeat must not run:\n${out}`);
  assert.equal(count(out, /^NSET<200>gate,0(\.0)?$/gm), 1, `the replaced track's repeat must not run:\n${out}`);
  assert.equal(count(out, /^NSET<400>/gm), 0, `the rebuilt track must not be hushed by its predecessor's stop:\n${out}`);
  assert.doesNotMatch(out, /ERROR/, `sclang reported an error:\n${out}`);
});
