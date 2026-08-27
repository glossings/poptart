'use strict';

// wireAudio/unwireAudio (sc/poptart.scd) - one source track feeding SEVERAL sinks at once.
//
// A track synth has exactly one send (\scSend), and the routing used to point it straight at
// whichever sink was wired last. That made every cross-track route exclusive, silently: the
// ordinary parallel-processing shape
//
//   verb: audio("kick").fx("ValhallaRoom").fx("Kickstart 2").audio("kick")
//
// asks the kick for two things - feed this chain's input, and key slot 2's sidechain - and the
// second route moved the send off the first, so the reverb chain went quiet (reported 2026-08-27).
// The source now offers its output on a refcounted per-source FEED bus and each route reads its
// own copy off it.
//
// What this guards: (1) the closures compile; (2) two sinks on one source coexist, reading the
// same feed bus, with the source's send pointed there exactly once; (3) dropping one route leaves
// the other playing; (4) dropping the last one parks the send and frees the bus, so a source that
// stops being read doesn't keep writing into a bus nobody owns.
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

// Lift `name = { ... };` from its assignment to the closing `};` at column 0 - every closure in
// poptart.scd is written at the top level, so nothing inside one is indented that far.
function extract(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

function runSclang() {
  const script = `(
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var server = srv;
var maxSlots = 8;
var tracks = IdentityDictionary.new;
var sidechainByTarget = IdentityDictionary.new;
var sidechainBySource = IdentityDictionary.new;
var sourceFeeds = IdentityDictionary.new;
var namedBuses = IdentityDictionary.new;
var silentBus = Bus.audio(srv, 2), trashBus = Bus.audio(srv, 2);
var acquireSourceFeed, releaseSourceFeed, wireAudio, unwireAudio, scKey;
var awaitTrack, acquireBus, releaseBus;
// Real (never-created) nodes for the track's synth and group: .set/.moveAfter just put an OSC
// message on the wire to a server that isn't there, which is exactly the no-op this test wants.
// The messages themselves aren't sniffed - scsynth commands go out as numeric ids, so there is
// nothing an OSCFunc could match - so what the send is pointed at is read off sourceFeeds
// instead, which is where acquireSourceFeed/releaseSourceFeed decide it. The TRACK stays an
// Event: wireAudio tells a track source from a bus by isKindOf(Event).
var mkTrack = { |key|
    (synth: Synth.basicNew(\\poptart_track, srv), group: Group.basicNew(srv), inBus: Bus.audio(srv, 2));
};

acquireBus = { |name| Bus.audio(srv, 2) };
releaseBus = { |name| };
awaitTrack = { |key, timeoutSec = 5| tracks[key] };

${extract('scKey')}
${extract('acquireSourceFeed')}
${extract('releaseSourceFeed')}
${extract('wireAudio')}
${extract('unwireAudio')}

("COMPILES<" ++ [acquireSourceFeed, releaseSourceFeed, wireAudio, unwireAudio].every { |f| f.isKindOf(Function) } ++ ">").postln;

tracks[\\kick] = mkTrack.(\\kick);
tracks[\\verb] = mkTrack.(\\verb);

// audio("kick").fx(...).fx(...).audio("kick") - the head input, then slot 2's sidechain.
wireAudio.(\\verb, 0, "kick", 1);
wireAudio.(\\verb, 2, "kick", 0.5);

SystemClock.sched(0.4, {
    var head = sidechainByTarget[scKey.(\\verb, 0)], side = sidechainByTarget[scKey.(\\verb, 2)];
    var feed = sourceFeeds[\\kick];
    ("BOTH<" ++ (head.notNil and: { side.notNil }) ++ ">").postln;
    ("SOURCES<" ++ [head, side].collect { |e| e !? { |x| x[\\source] } }.asString ++ ">").postln;
    ("FEEDERS<" ++ [head, side].every { |e| e.notNil and: { e[\\feeder].notNil } } ++ ">").postln;
    // One feed bus for the source, held by both routes - the send was pointed there once, when
    // the first route created the entry, and nothing has moved it since.
    ("FEEDBUS<" ++ (feed !? { |f| f[\\bus].index }).asString ++ ">").postln;
    ("READS<" ++ [head, side].collect { |e| e !? { |x| x[\\bus].index } }.asString ++ ">").postln;
    ("REFS<" ++ (feed !? { |f| f[\\refs] }).asString ++ ">").postln;
    ("ROUTES<" ++ sidechainBySource[\\kick].size ++ ">").postln;

    // Dropping the sidechain must leave the head input playing.
    unwireAudio.(\\verb, 2);
    ("AFTER1_HEAD<" ++ sidechainByTarget[scKey.(\\verb, 0)].notNil ++ ">").postln;
    ("AFTER1_ROUTES<" ++ sidechainBySource[\\kick].size ++ ">").postln;
    ("AFTER1_FEED<" ++ (sourceFeeds[\\kick] !? { |f| f[\\refs] }).asString ++ ">").postln;

    // ...and dropping the last one parks the send back on the trash bus and frees the feed.
    unwireAudio.(\\verb, 0);
    ("AFTER2_FEED<" ++ sourceFeeds[\\kick].isNil ++ ">").postln;
    ("AFTER2_ROUTES<" ++ sidechainBySource[\\kick].isNil ++ ">").postln;
    0.exit;
    nil;
});
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-scfanout-')), 'harness.scd');
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

test('one source track feeds several sinks at once', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  // sclang's array printing varies by nesting, so every reading is compared without its spaces.
  const said = (tag) => out.match(new RegExp(`${tag}<([^>]*)>`))?.[1]?.replace(/ /g, '');

  assert.equal(said('COMPILES'), 'true', `the routing closures did not compile:\n${out}`);

  // The regression: wiring the sidechain used to retire the head input.
  assert.equal(said('BOTH'), 'true', `both routes must survive - one source, two sinks:\n${out}`);
  assert.equal(said('SOURCES'), '[kick,kick]');
  assert.equal(said('FEEDERS'), 'true', 'each route reads its own copy off the feed bus');

  // One feed bus, held twice - and each route reads it into a sink bus of its own, so the two
  // don't share (and can't steal) a destination.
  assert.match(said('FEEDBUS'), /^\d+$/);
  assert.equal(said('REFS'), '2');
  const reads = said('READS').replace(/[[\]]/g, '').split(',');
  assert.equal(new Set(reads).size, 2, `each sink needs its own bus, got ${said('READS')}`);
  assert.ok(!reads.includes(said('FEEDBUS')), 'a sink must read a copy, not the feed bus itself');
  assert.equal(said('ROUTES'), '2');

  // Dropping one route leaves the other alone.
  assert.equal(said('AFTER1_HEAD'), 'true');
  assert.equal(said('AFTER1_ROUTES'), '1');
  assert.equal(said('AFTER1_FEED'), '1', 'the feed stays up while a route still reads it');

  // Dropping the last one gives the bus back and parks the send.
  assert.equal(said('AFTER2_FEED'), 'true');
  assert.equal(said('AFTER2_ROUTES'), 'true');
});
