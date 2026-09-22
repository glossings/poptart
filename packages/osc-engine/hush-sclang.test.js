'use strict';

// hushTrack (sc/poptart.scd) - what playing a stopped track again does to the voices it is
// still sounding.
//
// A stop lets everything ring out: every event already sent carries its own gate-off and plays to
// it, so a fitted break runs to the end of its bar. The restart must not play over that, so the
// host hushes the track first. hushTrack releases the sample voices (one gate-off on their
// group), releases by name every note a plugin has not finished sounding, closes the env
// modulators' gate, zeroes the held count and drops notes waiting on a program load - now, and
// again `again` seconds on, for a caller hushing while events sent a lookahead early are still in
// flight. All-notes-off goes out behind the named releases for a VST2 plugin only: VST3 has no
// such message, so on its own it released nothing there and logged a warning.
//
// What this guards: (1) the closure compiles; (2) the immediate release reaches every kind of
// voice and clears the bookkeeping; (3) the repeat runs on a track still standing; (4) it does
// NOT run against a track destroyed or rebuilt under the same key inside the window - the new
// track's first notes are its own; (5) a key with no track is a no-op, not an error; (6) a plugin
// note is released exactly when its end is still to come, whatever the plugin's format, and a
// VST3 plugin is never sent all-notes-off.
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

// Lift `<name> = { ... };` from its assignment to the closing `};` at column 0.
function extractClosure(name) {
  const m = fs.readFileSync(SCD, 'utf8').match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}
// slotLive is a one-liner, which the closure regex above (it wants the closing brace on its own
// line) does not match.
function extractSlotLive() {
  const m = fs.readFileSync(SCD, 'utf8').match(/^slotLive = \{ \|track, slot\|.*$/m);
  assert.ok(m, 'could not find slotLive in sc/poptart.scd');
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
var hushTrack, markSounding, slotLive;
// Slot 0 holds one note with no end known yet, one ending in five seconds and one that ended a
// second ago - the first two are what a hush has to release.
var mk = { |name, id, sdk = "VST 2.4"| (
    voices: Group.basicNew(srv, id),
    loaded: ["plugin", nil], // slot 0 has its plugin open (see slotLive) - the one a hush releases
    controllers: [(
        info: (sdkVersion: sdk),
        midi: (
            allNotesOff: { |self, ch| ("ANO<" ++ name ++ ">" ++ ch).postln },
            noteOff: { |self, ch, note| ("OFF<" ++ name ++ ">" ++ ch ++ "," ++ note).postln }
        )
    ), nil],
    envs: IdentityDictionary.new,
    held: 3,
    sounding: [IdentityDictionary[60 -> inf, 64 -> (Main.elapsedTime + 5), 67 -> (Main.elapsedTime - 1)],
        IdentityDictionary.new]
) };
srv.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57999,
    sendMsg: { |self ...msg| ("NSET<" ++ msg[1] ++ ">" ++ msg[2] ++ "," ++ msg[3]).postln });
${extractClosure('hushTrack')}
${extractClosure('markSounding')}
${extractSlotLive()}
("COMPILES<" ++ hushTrack.isKindOf(Function) ++ ">").postln;

tracks[\\living] = mk.(\\living, 100);
tracks[\\rebuilt] = mk.(\\old, 200);
tracks[\\gone] = mk.(\\gone, 300);
tracks[\\three] = mk.(\\three, 500, "VST 3.7.8");
tracks[\\living][\\envs][\\e] = (synth: Synth.basicNew(\\x, srv, 150));
noteQueues[\\living_0] = [1];
noteQueues[\\living_1] = [1];

hushTrack.(\\living, 0.3);
hushTrack.(\\rebuilt, 0.3);
hushTrack.(\\gone, 0.3);
hushTrack.(\\missing, 0.3);
hushTrack.(\\three, 0);

// The bookkeeping a hush reads: a note is on the books until its end has passed.
tracks[\\marked] = mk.(\\marked, 600);
tracks[\\marked][\\sounding] = [IdentityDictionary.new, IdentityDictionary.new];
markSounding.(tracks[\\marked], 0, 72, inf); // its on...
markSounding.(tracks[\\marked], 0, 72, Main.elapsedTime - 0.5); // ...and an off that has landed
markSounding.(tracks[\\marked], 0, 74, inf);
markSounding.(tracks[\\marked], 1, 40, Main.elapsedTime + 5);
("MARKED<" ++ tracks[\\marked][\\sounding][0].keys.asArray.sort ++ "|" ++ tracks[\\marked][\\sounding][1].keys.asArray ++ ">").postln;
("LEFT<" ++ tracks[\\living][\\sounding][0].size ++ ">").postln;
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
  assert.match(out, /^ANO<living>0$/m, `the VST2 instrument did not get all-notes-off:\n${out}`);
  // Plugin notes go by name: the ringing one and the one not yet ended, now and at the repeat -
  // never the one that has already finished.
  assert.equal(count(out, /^OFF<living>0,60$/gm), 2, `the open-ended note must be released, and again at the repeat:\n${out}`);
  assert.equal(count(out, /^OFF<living>0,64$/gm), 2, `the note still to end must be released, and again at the repeat:\n${out}`);
  assert.equal(count(out, /^OFF<\w+>0,67$/gm), 0, `a note that has ended is not released again:\n${out}`);
  assert.match(out, /^LEFT<0>$/m, `a hush leaves nothing on the books:\n${out}`);
  assert.match(out, /^MARKED<\[74\]\|\[40\]>$/m, `a finished note must leave the books, per slot:\n${out}`);
  // VST3: the same named releases, and no all-notes-off at all (there it is only a log warning).
  assert.equal(count(out, /^OFF<three>0,6[04]$/gm), 2, `the VST3 instrument's notes were not released by name:\n${out}`);
  assert.equal(count(out, /^ANO<three>/gm), 0, `a VST3 plugin must not be sent all-notes-off:\n${out}`);
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
