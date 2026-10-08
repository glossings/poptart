'use strict';

// The shared clock follows a free-running song (server.js's clockFollowSong): with the room led
// by a song whose sync is OFF - matched by ear, ridden by hand - a livecoded deck brought in beside
// it has to land on that song's tempo and bar, and stay there through every ride of its pitch
// fader, every nudge and every bend, because a livecoded deck has no jog of its own. Run against
// the real pattern-core Transport on a simulated clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const linkSync = require('./link-sync');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf(') {', at) + 2;
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

async function rig({ leader = 'a', sync = false, peers = 0, song = true } = {}) {
  const { Transport, DeckClock } = await import('../pattern-core/src/scheduler.mjs');
  let now = 100;
  const clock = { get: () => now, set: (t) => { now = t; } };
  const transport = new Transport(() => now, { cps: 120 / 240, paused: true });
  const songDecks = {
    a: song ? { playing: true, sync, bpm: 124, rate: 1.02, posSec: 31.37, startSec: 99, anchorSec: 0.215, duration: 400 } : null,
    b: null,
  };
  const running = { a: false, b: false };
  const deckClocks = { a: new DeckClock(transport), b: new DeckClock(transport) };
  const deckLive = { a: { sync: true, nudge: 0, bend: 0 }, b: { sync: true, nudge: 0, bend: 0 } };
  const rebases = [];
  const make = new Function('engine', 'transport', 'songDecks', 'linkSync', 'linkState', 'mixState',
    'deckLeader', 'deckRunning', 'syncEngineClock', 'mixNotify', 'deckClocks', 'deckLive', 'songSync', `
    const songFollow = { deck: null, offset: 0, adoptPending: false };
    let songFollowing = false;
    ${grabFn('songPlayheadSec')}
    ${grabFn('linkPhaseAt')}
    ${grabFn('songFollowDeck')}
    ${grabFn('songFollowReport')}
    ${grabFn('songFollowPhaseAt')}
    ${grabFn('clockFollowSong')}
    ${grabFn('transportStart')}
    return { clockFollowSong, transportStart, songFollowReport, songFollow };
  `);
  const api = make({ getTime: () => now }, transport, songDecks, linkSync,
    { enabled: peers > 0, peers, report: null, offset: 0, adoptPending: false }, { dj: true },
    () => leader, (d) => running[d], (why) => rebases.push(why), () => {}, deckClocks, deckLive, require('./song-sync'));
  /** How far the clock's bar is from the song's, in cycles, at the current time. */
  const phaseError = () => linkSync.phaseDelta(transport.cycleAt(now), api.songFollowReport('a', now).beats);
  return { ...api, transport, songDecks, running, clock, phaseError, rebases, deckClocks, deckLive };
}

test('a stopped clock takes the song\'s tempo and starts on its bar', async () => {
  const r = await rig();
  r.clockFollowSong({ adopt: true }); // what evaluate does before a deck starts
  assert.ok(Math.abs(r.transport.cps * 240 - 124 * 1.02) < 1e-9, `tempo ${r.transport.cps * 240}`);
  r.transportStart(100.15);
  r.clock.set(100.15);
  assert.ok(Math.abs(r.phaseError()) < 1e-9, `off the song's bar by ${r.phaseError()} cycles`);
});

test('a running clock on the wrong bar is moved onto the song\'s before a deck starts', async () => {
  const r = await rig();
  r.transport.start(50); // left running from earlier, at another tempo and phase
  r.clockFollowSong({ adopt: true });
  assert.ok(Math.abs(r.phaseError()) < 1e-9, `off by ${r.phaseError()}`);
  assert.deepEqual(r.rebases, ['rebase'], 'the plugins and MIDI clock are told the clock jumped');
});

test('riding the song\'s pitch fader carries the clock with it, bar for bar', async () => {
  const r = await rig();
  r.clockFollowSong({ adopt: true });
  r.transportStart(100.15);
  r.running.b = true; // the livecoded deck is now playing on the clock
  // Thirty seconds of the hand riding the fader: each step is what songApplyRate does (rebase
  // the song's model at the new rate), and the follower runs on its 50 ms tick.
  for (let i = 1; i <= 600; i++) {
    const t = 100.15 + i * 0.05;
    r.clock.set(t);
    if (i % 40 === 0) {
      const s = r.songDecks.a;
      s.posSec = s.posSec + Math.max(0, t - s.startSec) * s.rate;
      s.startSec = t;
      s.rate = 1.02 + 0.01 * Math.sin(i / 40); // up and down a percent
    }
    r.clockFollowSong();
    assert.ok(Math.abs(r.phaseError()) < 0.002, `at ${t.toFixed(2)}s the clock is ${r.phaseError()} cycles off the song`);
  }
  assert.ok(Math.abs(r.transport.cps * 240 - 124 * r.songDecks.a.rate) < 1e-9);
});

test('a deliberate jump of the song is accepted, not chased, while a deck rides the clock', async () => {
  const r = await rig();
  r.clockFollowSong({ adopt: true });
  r.transportStart(100.15);
  r.running.b = true;
  r.clock.set(101);
  r.clockFollowSong();
  r.songDecks.a.posSec += 60 / 124; // a one-beat jog on the song
  const before = r.transport.cycleAt(101);
  r.clockFollowSong();
  assert.equal(r.transport.cycleAt(101), before, 'the playing livecode deck is not yanked a beat');
  assert.ok(Math.abs(r.songFollow.offset) > 0.2, 'the new relation is kept');
});

test('a synced song is the grid already, and a Link session owns the clock - neither is followed', async () => {
  const synced = await rig({ sync: true });
  synced.clockFollowSong({ adopt: true });
  assert.equal(synced.transport.cps * 240, 120);
  const linked = await rig({ peers: 2 });
  linked.clockFollowSong({ adopt: true });
  assert.equal(linked.transport.cps * 240, 120);
});

test('a livecoded leader is not a song to follow', async () => {
  const r = await rig({ leader: 'b' });
  r.clockFollowSong({ adopt: true });
  assert.equal(r.transport.cps * 240, 120);
});

test('a livecoded leader with its sync off is followed: the room takes its tempo and its bar', async () => {
  const r = await rig({ song: false });
  r.transport.start(100);
  r.running.a = true;
  r.deckClocks.a.setFreeBpm(140);
  r.deckLive.a.sync = false;
  r.deckClocks.a.setSync(false);
  r.clock.set(103);
  r.deckClocks.a.jog(0.25); // the hand moves the leader a beat: nobody else rides the room, so it comes too
  r.clockFollowSong();
  assert.ok(Math.abs(r.transport.cps * 240 - 140) < 1e-9, `tempo ${r.transport.cps * 240}`);
  r.clock.set(109);
  r.clockFollowSong();
  const off = linkSync.phaseDelta(r.transport.cycleAt(109), r.deckClocks.a.cycleAt(109) * 4);
  assert.ok(Math.abs(off) < 1e-9, `the room is ${off} cycles off the leader's bar`);
  // ...and a synced deck beside it rides the room, so it is at the leader's tempo too.
  assert.ok(Math.abs(r.deckClocks.b.cps * 240 - 140) < 1e-9);
});

test('a synced livecoded leader is the room already, and is not followed', async () => {
  const r = await rig({ song: false });
  r.transport.start(100);
  r.running.a = true;
  r.deckClocks.a.setBend(0.04); // a nudge held on a synced deck moves that deck, never the room
  r.clock.set(101);
  r.clockFollowSong();
  assert.equal(r.transport.cps * 240, 120);
});
