'use strict';

// A synth(...) naming something that cannot be an instrument empties the instrument slot, so the
// track plays what the code says - nothing - rather than the instrument the last evaluation
// loaded. OscEngine sends '/poptart/unloadInstrument' (see native-devices.test.js); these are the
// two engines that answer it, Node's (engine/loads.js) and sclang's (sc/poptart.scd), against a
// stand-in track, with no server booted. The sclang half is skipped (not failed) where sclang
// can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fakeEngine } = require('./test-support/fake-engine');
const { resolveSclangPath } = require('./index.js');

test('unloadInstrument closes what the instrument slot holds and says the slot is empty', () => {
  const { E } = fakeEngine();
  let closed = 0;
  let ramped = 0;
  const told = [];
  E.dropSlotRamps = () => { ramped += 1; };
  E.tellSlot = (track, slot) => told.push([track.key, slot, track.controllers.has(slot), track.loaded.has(slot)]);
  const track = {
    key: 't', loaded: new Map([[0, 'Granular']]), wanted: new Map(), editWatch: new Map(),
    controllers: new Map([[0, { close: () => { closed += 1; } }]]),
  };
  E.tracks.set('t', track);
  E.dispatch('/poptart/unloadInstrument', ['t']);
  assert.deepEqual([closed, ramped, track.controllers.has(0), track.loaded.has(0)], [1, 1, false, false]);
  assert.deepEqual(told, [['t', 0, false, false]]);
  // Again, on the next evaluation: nothing left to close.
  E.dispatch('/poptart/unloadInstrument', ['t']);
  assert.equal(closed, 1);
  // An open still in flight no longer commits.
  track.wanted.set(0, 'A Plugin');
  E.dispatch('/poptart/unloadInstrument', ['t']);
  assert.equal(track.wanted.has(0), false);
  // A track still being built has loaded nothing, and is left alone.
  E.tracks.set('born', 'pending');
  E.dispatch('/poptart/unloadInstrument', ['born']);
  assert.equal(E.tracks.get('born'), 'pending');
});

test('sclang empties the instrument slot the same way', (t) => {
  let sclang = null;
  try { sclang = resolveSclangPath(); } catch { /* none */ }
  if (!sclang || !fs.existsSync(sclang)) { t.skip('sclang not available'); return; }
  const src = fs.readFileSync(path.join(__dirname, 'sc', 'poptart.scd'), 'utf8');
  const handler = src.match(/^OSCdef\(\\poptartUnloadInstrument, \{ \|msg\|[\s\S]*?^\}, '\/poptart\/unloadInstrument'\);$/m);
  assert.ok(handler, 'could not find the unloadInstrument handler in sc/poptart.scd');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-unload-instrument-'));
  try {
    const script = path.join(dir, 'unload.scd');
    fs.writeFileSync(script, `
var tracks = IdentityDictionary.new;
var closed = 0, ramped = 0, told = 0;
var dropSlotRamps = { ramped = ramped + 1 };
var tellSlot = { told = told + 1 };
var track = (
    loaded: IdentityDictionary[0 -> "Granular"], wanted: IdentityDictionary.new,
    controllers: IdentityDictionary[0 -> (close: { |self| closed = closed + 1 })],
    editWatch: IdentityDictionary.new
);
var unload = { |key| OSCdef(\\poptartUnloadInstrument).func.value(['/poptart/unloadInstrument', key]) };
${handler[0]}
tracks[\\t] = track;
tracks[\\born] = \\pending;
unload.(\\t);
("RESULT closed " ++ (closed == 1 and: { ramped == 1 } and: { told == 1 })).postln;
("RESULT emptied " ++ (track[\\controllers][0].isNil and: { track[\\loaded][0].isNil })).postln;
unload.(\\t);
("RESULT once " ++ (closed == 1)).postln;
track[\\wanted][0] = "A Plugin";
unload.(\\t);
("RESULT in_flight " ++ track[\\wanted][0].isNil).postln;
unload.(\\born);
("RESULT pending " ++ (tracks[\\born] == \\pending)).postln;
0.exit;
`);
    const out = execFileSync(sclang, ['-u', '57318', script], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const name of ['closed', 'emptied', 'once', 'in_flight', 'pending']) {
      assert.match(out, new RegExp(`^RESULT ${name} true$`, 'm'), `${name} (sclang output: ${out})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
