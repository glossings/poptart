'use strict';

// In DJ mode a track's setbpm() is the deck's native tempo, not a move on the room's - except for
// the first track of the set (nothing else sounding), which sets the room's tempo from its code,
// and the deck the room follows changing its number, which is a livecoded tempo change. Restating
// the same number never moves the room: that is what an update with the tempo untouched is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grab(signature) {
  const at = SRC.indexOf(signature);
  assert.ok(at > 0, `${signature} not found in server.js - this test needs updating`);
  let depth = 0;
  // From the body's brace: a destructured parameter's `{ ... } = {}` comes first.
  for (let i = SRC.indexOf(') {', at) + 2; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${signature}`);
}

function rig({ leader = 'a', synced = true, mult = 1 } = {}) {
  const st = { bpm: { a: 140, b: 128 }, ramps: [], leader, synced, mult };
  const deps = {
    deckNativeBpm: (deck) => st.bpm[deck],
    djDeclaredBpm: { a: undefined, b: undefined },
    mixState: { dj: true, tempoOverride: null },
    transport: { rampBpm: (bpm) => st.ramps.push(Math.round(bpm * 100) / 100) },
    deckLiveSynced: () => st.synced,
    deckLeader: () => st.leader,
    deckTempoMult: () => st.mult,
    declaredBpm: null,
    mixNotify: () => {},
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const djCodeTempo = new Function(...names, `${grab('function djCodeTempo(')}\nreturn djCodeTempo;`)(...names.map((n) => deps[n]));
  return { djCodeTempo, st, deps };
}

test('the first track of a DJ set sets the room to its code\'s tempo, scaled by its fader', () => {
  const r = rig({ mult: 1.05 });
  r.djCodeTempo('a', { alone: true });
  assert.deepEqual(r.st.ramps, [147]);
});

test('a track with no setbpm sets the room to the 120 it plays at', () => {
  const r = rig();
  r.st.bpm.a = 120; // what deckNativeBpm reads for a buffer that says nothing
  r.djCodeTempo('a', { alone: true });
  assert.deepEqual(r.st.ramps, [120]);
});

test('the leader changing its number moves the room; restating it does not', () => {
  const r = rig();
  r.djCodeTempo('a', {}); // the first eval in DJ mode with the room already playing: learned, not applied
  assert.deepEqual(r.st.ramps, []);
  r.djCodeTempo('a', {}); // an update with the tempo untouched
  assert.deepEqual(r.st.ramps, []);
  r.st.bpm.a = 150;
  r.djCodeTempo('a', {});
  assert.deepEqual(r.st.ramps, [150]);
  r.djCodeTempo('a', {});
  assert.deepEqual(r.st.ramps, [150], 'and the new number restated is not another move');
});

test('a deck the room is not following changes nothing by changing its number', () => {
  const r = rig({ leader: 'a' });
  r.djCodeTempo('b', {});
  r.st.bpm.b = 132;
  r.djCodeTempo('b', {});
  assert.deepEqual(r.st.ramps, []);
});

test('a song newly loaded onto the leader starts from its number; it is not a change', () => {
  const r = rig();
  r.djCodeTempo('a', {});
  r.st.bpm.a = 174;
  r.djCodeTempo('a', { fresh: true });
  assert.deepEqual(r.st.ramps, []);
});

test('a deck with sync off, or a signal tempo, leaves the room alone', () => {
  const off = rig({ synced: false });
  off.djCodeTempo('a', { alone: true });
  assert.deepEqual(off.st.ramps, []);
  const sig = rig();
  sig.st.bpm.a = null; // a signal-driven setbpm has no single number
  sig.djCodeTempo('a', { alone: true });
  assert.deepEqual(sig.st.ramps, []);
});

test('outside DJ mode this is not what decides the tempo', () => {
  const r = rig();
  r.deps.mixState.dj = false;
  const again = new Function(...Object.keys(r.deps), `${grab('function djCodeTempo(')}\nreturn djCodeTempo;`)(...Object.values(r.deps));
  again('a', { alone: true });
  assert.deepEqual(r.st.ramps, []);
});

test('a fader hold moves with the new tempo, so the next fader touch scales from it', () => {
  const r = rig();
  r.deps.mixState.tempoOverride = 141;
  r.djCodeTempo('a', {});
  r.st.bpm.a = 150;
  r.djCodeTempo('a', {});
  assert.equal(r.deps.mixState.tempoOverride, 150);
});

test('the eval asks it before the deck schedules, and DJ mode learns each deck afresh', () => {
  assert.match(SRC, /djCodeTempo\(deck, \{ fresh: body\.fresh === true, alone: !deckAudible\('a'\) && !deckAudible\('b'\) \}\);\n\s+if \(body\.start !== false && !deckRunning\(deck\)\) clockFollowSong/);
  assert.match(SRC, /mixState\.dj = !!body\.on;\n\s+djDeclaredBpm\.a = djDeclaredBpm\.b = undefined;/);
});
