'use strict';

// clearMidiRoute (sc/poptart.scd) - what tearing a live midi()/midikeys() route down sends the
// track's instrument.
//
// A key held across a mute/stop must not drone, so the teardown releases what the route still has
// sounding: each note by name, at the pitch its note-on actually played and on the channel it
// came in on. CC 123 (all notes off) follows on all sixteen channels for a VST2 plugin only - a
// VST3 plugin takes a controller only where it maps one to a parameter, and VSTPlugin answers an
// unmapped one with a warning per channel, which used to be sixteen log lines on every teardown.
//
// What this guards: (1) the closure compiles; (2) a VST3 instrument gets its held notes released
// and no CC at all; (3) a VST2 instrument gets both; (4) the bookkeeping (route, held count, env
// gates) is cleared either way; (5) a track with no route, and a key with no track, are no-ops.
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
const LANG_PORT = '57296'; // its own, like every sclang harness: only ten are tried from 57120 up

// Lift `clearMidiRoute = { ... };` from its assignment to the closing `};` at column 0.
function extractClearMidiRoute() {
  const m = fs.readFileSync(SCD, 'utf8').match(/^clearMidiRoute = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the clearMidiRoute closure in sc/poptart.scd');
  return m[0];
}
// The teardown only releases through a slot whose plugin is open (slotLive) - a one-liner, lifted
// on its own.
function extractSlotLive() {
  const m = fs.readFileSync(SCD, 'utf8').match(/^slotLive = \{ \|track, slot\|.*$/m);
  assert.ok(m, 'could not find slotLive in sc/poptart.scd');
  return m[0];
}

function runSclang() {
  // The env modulator's synth is a real Synth on a Server whose address prints what it is handed
  // (an Event can't stand in for a node - see hush-sclang.test.js); the plugin controller is an
  // Event whose midi proxy prints. No server is booted.
  const script = `(
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var tracks = IdentityDictionary.new;
var clearMidiRoute, slotLive;
var mk = { |name, sdk, envId| (
    midiRoute: (keys: [], sounding: IdentityDictionary[(0 * 128) + 60 -> 62, (3 * 128) + 64 -> 64]),
    loaded: ["plugin"], // slot 0 has its plugin open (see slotLive) - the one the teardown releases through
    controllers: [(
        info: (sdkVersion: sdk),
        midi: (
            noteOff: { |self, ch, note, vel| ("OFF<" ++ name ++ ">" ++ ch ++ "," ++ note).postln },
            control: { |self, ch, num, val| ("CC<" ++ name ++ ">" ++ ch ++ "," ++ num).postln }
        )
    )],
    envs: IdentityDictionary[\\e -> (synth: Synth.basicNew(\\x, srv, envId))],
    held: 2
) };
srv.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57999,
    sendMsg: { |self ...msg| ("NSET<" ++ msg[1] ++ ">" ++ msg[2] ++ "," ++ msg[3]).postln });
${extractClearMidiRoute()}
${extractSlotLive()}
("COMPILES<" ++ clearMidiRoute.isKindOf(Function) ++ ">").postln;

tracks[\\three] = mk.(\\three, "VST 3.7.8", 150);
tracks[\\two] = mk.(\\two, "VST 2.4", 250);
tracks[\\unrouted] = mk.(\\unrouted, "VST 2.4", 350);
tracks[\\unrouted][\\midiRoute] = nil;

[\\three, \\two, \\unrouted, \\missing].do { |k| clearMidiRoute.(k) };
[\\three, \\two].do { |k|
    ("STATE<" ++ k ++ ">" ++ tracks[k][\\midiRoute].isNil ++ "," ++ tracks[k][\\held]).postln;
};
("UNTOUCHED<" ++ tracks[\\unrouted][\\held] ++ ">").postln;
"DONE".postln;
0.exit;
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-midiroute-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const count = (out, re) => (out.match(re) ?? []).length;

test('a route teardown releases its held notes by name, and sends CC 123 to a VST2 plugin only', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^COMPILES<true>$/m, `the clearMidiRoute closure did not compile:\n${out}`);
  assert.match(out, /^DONE$/m, `the harness did not run to its end:\n${out}`);
  // Each held note is released at the pitch its note-on played, on the channel it came in on.
  for (const name of ['three', 'two']) {
    assert.match(out, new RegExp(`^OFF<${name}>0,62$`, 'm'), `${name}: the remapped note was not released as played:\n${out}`);
    assert.match(out, new RegExp(`^OFF<${name}>3,64$`, 'm'), `${name}: the channel-4 note was not released:\n${out}`);
    assert.equal(count(out, new RegExp(`^OFF<${name}>`, 'gm')), 2, `${name}: exactly the held notes are released:\n${out}`);
    assert.match(out, new RegExp(`^STATE<${name}>true,0$`, 'm'), `${name}: the route or the held count was left standing:\n${out}`);
  }
  // The all-notes-off net is a VST2 message: sixteen channels there, none at all for VST3.
  assert.equal(count(out, /^CC<three>/gm), 0, `a VST3 plugin must not be sent CC 123:\n${out}`);
  assert.equal(count(out, /^CC<two>\d+,123$/gm), 16, `a VST2 plugin gets CC 123 on every channel:\n${out}`);
  // The env modulators' gates close as they do when the last note ends.
  assert.match(out, /^NSET<150>gate,0(\.0)?$/m, `the VST3 track's env gate was not closed:\n${out}`);
  assert.match(out, /^NSET<250>gate,0(\.0)?$/m, `the VST2 track's env gate was not closed:\n${out}`);
  // No route, no teardown.
  assert.equal(count(out, /<unrouted>/g), 0, `a track with no route must be left alone:\n${out}`);
  assert.equal(count(out, /^NSET<350>/gm), 0, `a track with no route must keep its env gate:\n${out}`);
  assert.match(out, /^UNTOUCHED<2>$/m, `a track with no route must keep its held count:\n${out}`);
  assert.doesNotMatch(out, /ERROR/, `sclang reported an error:\n${out}`);
});
