'use strict';

// A track whose build never finishes can be built again, and the evaluation sweep that used to
// lose builds no longer touches the clock (sc/poptart.scd).
//
// The bug this pins (2026-09-22, one track in a song silent for a whole session while an identical
// copy under a different name played): createTrack reserves its key with \pending and writes the
// real track only at the end of an async build. That build can end without committing - it throws,
// or its routine is never run because sclang's clock queue refused it - and \pending was then
// permanent: createTrack guards on isNil and no-oped on every evaluation after, destroyTrack's body
// sits inside a `track !? {}` and skipped it too, and every note aimed at the key was dropped without
// a sound. Engine track ids outlive the label they came from (server.js's trackIds), so renaming the
// block was the only way out, and the ghost id stayed.
//
// Two halves. awaitTrack now hands a reservation it has waited out to reclaimStuckTrack, which clears
// it so the key can be built again; a generation counter keeps that safe when the build was merely
// slow (it wakes to a stale claim and frees what it made). And the thing that refused the build in
// the first place: the scheduler clears every fx slot past its chain's end on every evaluation -
// twenty messages a track - and unloadEffect forked a routine for each, ~500 at once for a full
// song, against a clock queue that holds ~680 (measured 2026-09-22: 1500 forks, 683 started, the
// rest never ran). It now decides synchronously, and forks only for a slot with something in it.
//
// Like the other sclang harnesses: the pieces are lifted out of the shipped file and run against a
// stand-in `tracks` dictionary, so no server is booted. Skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57298'; // its own, like every sclang harness: only ten are tried from 57120 up

function lift(re, what) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(re);
  assert.ok(m, `could not find ${what} in sc/poptart.scd`);
  return m[0];
}

// Taken from the shipped source, so these tests fail if any of it is rewritten to stop doing what
// they check.
const liftRecovery = () => [
  lift(/^awaitTrack = \{ \|key, timeoutSec = 5\|[\s\S]*?^\};$/m, 'awaitTrack'),
  lift(/^reclaimStuckTrack = \{ \|key\|[\s\S]*?^\};$/m, 'reclaimStuckTrack'),
].join('\n');
const liftSlotLive = () => lift(/^slotLive = \{ \|track, slot\|.*$/m, 'slotLive');
const liftUnloadEffect = () =>
  lift(/^OSCdef\(\\poptartUnloadEffect, \{ \|msg\|[\s\S]*?^\}, '\/poptart\/unloadEffect'\);$/m, 'the unloadEffect handler');

function sclangOrSkip(t) {
  try {
    const sclang = resolveSclangPath();
    if (fs.existsSync(sclang)) return sclang;
  } catch { /* fall through */ }
  t.skip('sclang not available');
  return null;
}

// Runs a script, returns its RESULT lines as a name -> boolean map plus the raw output.
function run(sclang, dir, name, script) {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, script);
  const out = execFileSync(sclang, ['-u', LANG_PORT, scriptPath], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const results = new Map();
  for (const line of out.split('\n')) {
    const m = /^RESULT (\w+) (true|false)$/.exec(line.trim());
    if (m) results.set(m[1], m[2] === 'true');
  }
  return { results, out };
}

function expectAll(results, out, names) {
  for (const name of names) {
    assert.strictEqual(results.get(name), true, `${name} (sclang output: ${out})`);
  }
}

test('a track build that never commits is given up on, and the key can be built again', (t) => {
  const sclang = sclangOrSkip(t);
  if (!sclang) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-birth-'));
  try {
    const { results, out } = run(sclang, dir, 'birth.scd', `
var tracks = IdentityDictionary.new;
var trackGen = IdentityDictionary.new;
var awaitTrack, reclaimStuckTrack;
${liftRecovery()}
fork {
    var got, firstGen, secondGen;

    // A build in flight: createTrack's reservation, holding generation 1.
    firstGen = (trackGen[\\a] ? 0) + 1;
    trackGen[\\a] = firstGen;
    tracks[\\a] = \\pending;

    // Something asks for the track. The build never committed, so the wait runs out...
    got = awaitTrack.(\\a, 0.2);
    ("RESULT stuck_returns_nil " ++ got.isNil).postln;
    // ...and the reservation is gone, which is the whole point: the isNil guard in createTrack
    // passes again on the next evaluation.
    ("RESULT stuck_cleared " ++ tracks[\\a].isNil).postln;

    // The rebuild takes a fresh generation.
    secondGen = (trackGen[\\a] ? 0) + 1;
    trackGen[\\a] = secondGen;
    tracks[\\a] = \\pending;
    // The abandoned build finally wakes: its claim is stale, so it must NOT commit.
    ("RESULT stale_build_refused " ++ (trackGen[\\a] != firstGen)).postln;
    // The rebuild's own claim still stands, so it commits.
    ("RESULT rebuild_commits " ++ (trackGen[\\a] == secondGen)).postln;

    // A track that is actually there comes back untouched - no reclaim, no generation bump.
    tracks[\\b] = (synth: 1);
    trackGen[\\b] = 5;
    got = awaitTrack.(\\b, 0.2);
    ("RESULT live_returned " ++ got.notNil).postln;
    ("RESULT live_gen_untouched " ++ (trackGen[\\b] == 5)).postln;

    // A key nothing ever reserved is left alone: engineTrack passes an unknown label through
    // verbatim (see server.js), and those must not mint bookkeeping here.
    got = awaitTrack.(\\c, 0.2);
    ("RESULT unknown_nil " ++ got.isNil).postln;
    ("RESULT unknown_untouched " ++ (tracks[\\c].isNil and: { trackGen[\\c].isNil })).postln;

    0.exit;
};
`);
    expectAll(results, out, [
      'stuck_returns_nil',
      'stuck_cleared',
      'stale_build_refused',
      'rebuild_commits',
      'live_returned',
      'live_gen_untouched',
      'unknown_nil',
      'unknown_untouched',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing an empty fx slot takes no routine, so a whole song\'s sweep cannot fill the clock queue', (t) => {
  const sclang = sclangOrSkip(t);
  if (!sclang) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-sweep-'));
  try {
    // More sweeps than the clock queue has room for (see the header). The old handler forked once
    // per message and the queue printed "scheduler queue is full." for every one it refused; the
    // new one must get through all of them without touching the clock at all.
    const SWEEPS = 1500;
    // The track synth is a real Synth on a Server whose address swallows what it is handed (an
    // Event can't stand in for a node: Event has a set of its own - see hush-sclang.test.js).
    const { results, out } = run(sclang, dir, 'sweep.scd', `
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new;
var maxSlots = 21;
var closed = 0, ramped = 0, bypassed = 0;
var dropSlotRamps = { ramped = ramped + 1 };
var slotLive;
var live = (
    loaded: Array.newClear(maxSlots), wanted: Array.newClear(maxSlots),
    controllers: Array.newClear(maxSlots), editWatch: Array.newClear(maxSlots),
    synth: Synth.basicNew(\\x, srv, 1)
);
var unload = { |key, slot| OSCdef(\\poptartUnloadEffect).func.value(['/poptart/unloadEffect', key, slot]) };
srv.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57999,
    sendMsg: { |self ...msg| bypassed = bypassed + 1 });
${liftSlotLive()}
${liftUnloadEffect()}
tracks[\\live] = live;
tracks[\\born] = \\pending;

// The sweep: every slot past a chain's end, on a live track and on one still being built.
${SWEEPS}.do { |i| unload.(\\live, 1 + (i % (maxSlots - 1))) };
${SWEEPS}.do { |i| unload.(\\born, 1 + (i % (maxSlots - 1))) };
("RESULT pending_untouched " ++ (tracks[\\born] == \\pending)).postln;

// A slot with a plugin in it still gets the real teardown, which does run as a routine.
live[\\loaded][3] = "Pro-Q 3";
live[\\controllers][3] = (close: { |self| closed = closed + 1 });
unload.(\\live, 3);

// slotLive: a plugin still opening (wanted, not loaded) is not one to send MIDI to; an open one is.
live[\\wanted][5] = "Serum 2";
("RESULT wanted_not_live " ++ slotLive.(live, 5).not).postln;
live[\\loaded][5] = "Serum 2";
("RESULT loaded_live " ++ slotLive.(live, 5)).postln;

AppClock.sched(0.5, {
    ("RESULT teardown_ran " ++ (closed == 1 and: { ramped == 1 } and: { bypassed == 1 } and: { live[\\loaded][3].isNil })).postln;
    0.exit; nil
});
`);
    expectAll(results, out, ['pending_untouched', 'teardown_ran', 'wanted_not_live', 'loaded_live']);
    assert.ok(!/scheduler queue is full/.test(out), `the sweep filled the clock queue (sclang output: ${out})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
