'use strict';

// The desk's LEADER (server.js's deckLeader): exactly one tempo fader moves the room - the deck
// that has been playing longest - and when it stops, by any route (a stop, the end, a cue, a
// song loaded over it), the lead passes to whichever deck is still playing. Livecoded decks
// take part exactly as song decks do; every other deck's fader is inert (drawn grayed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf(') {', at) + 2; // the body's brace - a destructured parameter has one too
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}
function grabArrow(name) {
  const at = SRC.indexOf(`const ${name} = (`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  return SRC.slice(at, SRC.indexOf('\n};', at) + 3);
}
function grabConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm'));
  assert.ok(m, `const ${name} not found in server.js - this test needs updating`);
  return m[0];
}

const DEPS = ['songDecks', 'schedulers', 'deckOfKey', 'FX_KEYS', 'mixState', 'transport', 'songSync',
  'songApplyRate', 'mixNotify', 'othersPlaying'];
// eslint-disable-next-line no-new-func
const make = new Function(...DEPS, `
  let songMasterDeck = null;
  let songMasterOctave = 1;
  ${grabConst('deckPlayingSince')}
  let deckPlayingSeq = 0;
  let deckLeaderNow = null;
  ${grabConst('DECK_TEMPO_RANGES')}
  ${grabArrow('deckTempoMult')}
  ${grabFn('songOctave')}
  ${grabFn('deckAudible')}
  ${grabFn('deckLeader')}
  ${grabFn('deckTempoLocked')}
  ${grabFn('deckTempoApply')}
  return {
    deckLeader, deckTempoLocked, deckTempoApply,
    get master() { return songMasterDeck; },
    set master(d) { songMasterDeck = d; },
  };
`);

/** Two decks, nothing loaded; `live(d, on)` runs or stops a livecoded deck's tracks. */
function rig() {
  const songDecks = { a: null, b: null };
  const schedulers = new Map();
  const transport = {
    cps: 128 / 240,
    ramps: [],
    rampBpm(bpm) { this.ramps.push(bpm); this.cps = bpm / 240; },
  };
  const mixState = {
    tempoOverride: null,
    deckTempo: { a: { frac: 0, range: 6 }, b: { frac: 0, range: 6 } },
  };
  const deckOfKey = (key) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : 'a');
  const othersPlaying = (deck) => [...schedulers.values()].some((s) => s.running)
    || ['a', 'b'].some((d) => d !== deck && songDecks[d]?.playing);
  const api = make(songDecks, schedulers, deckOfKey, { a: '#fx', b: 'b:#fx' }, mixState, transport,
    { RATE_MIN: 0.5, RATE_MAX: 2, syncOctave: () => 1 }, () => {}, () => {}, othersPlaying);
  const live = (deck, on) => {
    schedulers.set(deck === 'a' ? 'kick' : 'b:kick', { running: on });
  };
  const song = (deck, { playing = true, sync = true, bpm = 128 } = {}) => {
    songDecks[deck] = { playing, sync, bpm, syncMult: 'auto', manualRate: 1 };
  };
  return Object.assign(api, { songDecks, schedulers, transport, mixState, live, song }); // not a spread: `master` is a live getter
}

test('the first deck to start leads; the other fader is grayed', () => {
  const r = rig();
  r.live('a', true);
  assert.equal(r.deckLeader(), 'a');
  r.live('b', true);
  assert.equal(r.deckLeader(), 'a', 'starting second does not take the lead');
  assert.equal(r.deckTempoLocked('a'), false);
  assert.equal(r.deckTempoLocked('b'), true, "a livecoded follower's fader would only drag the room");
});

test('the lead passes when the leader stops, and comes back to nobody when nothing plays', () => {
  const r = rig();
  r.live('a', true);
  r.live('b', true);
  r.deckLeader();
  r.live('a', false); // a stop, the arrangement's end, a cue release, a clear before a load
  assert.equal(r.deckLeader(), 'b');
  assert.equal(r.deckTempoLocked('b'), false, 'the new leader is the one slider not grayed');
  r.live('a', true); // a fresh song on deck a starts while b plays
  assert.equal(r.deckLeader(), 'b', 'the eldest keeps it');
  r.live('b', false);
  r.live('a', false);
  assert.equal(r.deckLeader(), null);
  assert.equal(r.deckTempoLocked('a'), false);
});

test("the leader's fader moves the room; a follower's moves nothing", () => {
  const r = rig();
  r.live('a', true);
  r.live('b', true);
  r.deckTempoApply('b', { frac: 0.5 });
  assert.deepEqual(r.transport.ramps, [], 'the follower is inert');
  r.deckTempoApply('a', { frac: 0.5 }); // +3% on a ±6 range
  assert.equal(r.transport.ramps.length, 1);
  assert.ok(Math.abs(r.transport.ramps[0] - 128 * 1.03) < 1e-9, `got ${r.transport.ramps[0]}`);
});

test('an inherited lead scales the room from where it stands - no lurch to the deck\'s own tempo', () => {
  const r = rig();
  r.live('a', true);
  r.live('b', true);
  r.deckLeader();
  r.deckTempoApply('b', { frac: 0.5 }); // moved while following: remembered, room untouched
  r.live('a', false);
  r.deckTempoApply('b', { frac: 0.6 }); // first touch as leader: +3% -> +3.6%
  const bpm = r.transport.ramps.at(-1);
  assert.ok(Math.abs(bpm - (128 / 1.03) * 1.036) < 1e-9, `the room moved by the fader's step only, got ${bpm}`);
});

test('a synced song inheriting the lead from a livecoded deck takes the grid', () => {
  const r = rig();
  r.live('a', true);
  r.song('b'); // joined the playing set, synced - a follower
  assert.equal(r.deckLeader(), 'a');
  assert.equal(r.deckTempoLocked('b'), true);
  r.live('a', false);
  assert.equal(r.deckLeader(), 'b');
  assert.equal(r.master, 'b', 'the song now holds the grid, so its fader drives the clock');
  assert.equal(r.deckTempoLocked('b'), false);
  r.deckTempoApply('b', { frac: 0.5 });
  assert.ok(Math.abs(r.transport.ramps.at(-1) - 128 * 1.03) < 1e-9);
});

test("a deck's FX unit running is not the deck playing", () => {
  const r = rig();
  r.schedulers.set('b:#fx', { running: true });
  r.live('a', true);
  assert.equal(r.deckLeader(), 'a');
  r.live('a', false);
  assert.equal(r.deckLeader(), null, 'an FX return alone does not lead the room');
});
