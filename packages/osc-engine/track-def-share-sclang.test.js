'use strict';

// The track SynthDef is built ONCE per engine (sc/poptart.scd, sharedTrackDef): every track runs
// the same graph, and building it is ~25 ms of single-threaded sclang that the other deck's notes
// queue behind. Tracks created together - a whole song's worth, in one evaluation - must build
// it exactly once, and those that ask while the first is still sending it must wait for it
// rather than create a synth from a def the server doesn't have yet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function extractSharedTrackDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^sharedTrackDef = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find sharedTrackDef in sc/poptart.scd');
  return m[0];
}

test('a song\'s tracks created together build the shared track def once, and all wait for it', (t) => {
  const script = `(
var sharedTrackDef, trackDef, trackDefState, builds = 0, adds = 0, got = List.new, server;
var buildTrackDef = { |key| builds = builds + 1; (name: ("poptart_track_" ++ key).asSymbol) };
var countAdd = { adds = adds + 1 };
server = (sync: { 0.05.wait });
// An Event mock can't stand in for SynthDef:add (Event has its own add), so the one send is
// counted through a stand-in instead.
${extractSharedTrackDef().replace('trackDef.add;', 'countAdd.();')}
5.do { |i| fork { got.add(sharedTrackDef.().name) } };
fork {
  0.5.wait;
  fork { got.add(sharedTrackDef.().name) }; // a track created long after: no rebuild
  0.1.wait;
  ("BUILDS<" ++ builds ++ ">").postln;
  ("ADDS<" ++ adds ++ ">").postln;
  ("GOT<" ++ got.size ++ "," ++ got.asSet.size ++ "," ++ got[0] ++ ">").postln;
  0.exit;
};
fork { 10.wait; "FAILSAFE-EXIT".postln; 0.exit };
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-trackdef-')), 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(resolveSclangPath(), ['-u', '57296', file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    t.skip(`sclang could not run here: ${err.message.split('\n')[0]}`);
    return;
  }
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip('sclang did not start here');
    return;
  }
  assert.match(out, /^BUILDS<1>$/m, `built more than once:\n${out}`);
  assert.match(out, /^ADDS<1>$/m, 'sent to the server more than once');
  assert.match(out, /^GOT<6,1,poptart_track_shared>$/m, 'every track got the one def');
});
