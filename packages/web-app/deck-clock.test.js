'use strict';

// The platter, SYNC and tempo fader of a deck playing CODE (server.js's deckClocks section): each
// deck's schedulers read a clock of their own, so a nudge, a jog and sync-off move that deck and
// leave the room alone - and the plugins on a deck whose clock has left the room's are told that
// deck's tempo and place, not the room's. Run against the real pattern-core clocks on a simulated
// time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const songSync = require('./song-sync');

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

async function rig({ dj = true } = {}) {
  const { Transport, DeckClock } = await import('../pattern-core/src/scheduler.mjs');
  let now = 100;
  const transport = new Transport(() => now, { cps: 120 / 240, paused: true });
  const deckClocks = { a: new DeckClock(transport), b: new DeckClock(transport) };
  const running = { a: false, b: false };
  const relocated = { a: 0, b: 0 };
  const sent = [];
  const mixState = { dj, deckTempo: { a: { frac: 0, range: 6 }, b: { frac: 0, range: 6 } }, deckJog: { a: { beats: 1 }, b: { beats: 1 } } };
  const sch = (d) => ({ relocate: (delta) => { relocated[d] += delta; } });
  const make = new Function('engine', 'transport', 'deckClocks', 'songDecks', 'songSync', 'mixState',
    'schedulers', 'fxSchedulers', 'deckRunning', 'trackIds', 'mixNotify', 'clockFollowSong', `
    const VST_TRANSPORT_LOOKAHEAD_SEC = 0.15;
    const engineError = null;
    const deckOfKey = (key) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : 'a');
    const deckTempoMult = (deck) => 1 + (mixState.deckTempo[deck].frac * mixState.deckTempo[deck].range) / 100;
    const deckLive = { a: { sync: true, nudge: 0, bend: 0 }, b: { sync: true, nudge: 0, bend: 0 } };
    const deckLiveSynced = (deck) => !mixState.dj || deckLive[deck].sync;
    ${grabFn('deckClockApply')}
    ${grabFn('deckLiveRelease')}
    ${grabFn('deckSchedulers')}
    ${grabFn('liveNudge')}
    ${grabFn('liveSetSync')}
    ${grabFn('syncEngineClock')}
    return { deckClockApply, deckLiveRelease, liveNudge, liveSetSync, syncEngineClock, deckLive };
  `);
  const api = make(
    { getTime: () => now, setTempo: (bpm, beats, at, playing, event, scope) => sent.push({ bpm, beats, scope }) },
    transport, deckClocks, { a: null, b: null }, songSync, mixState,
    new Map([['kick', sch('a')], ['b:kick', sch('b')]]), { a: null, b: sch('b') },
    (d) => running[d], new Map([['kick', '#1'], ['b:kick', '#2'], ['b:#fx', '#3']]), () => {}, () => {},
  );
  return { ...api, transport, deckClocks, running, relocated, sent, mixState, set: (t) => { now = t; }, now: () => now };
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

test('a held nudge runs the deck 4% fast, the release keeps what it gained, and the room never moves', async () => {
  const r = await rig();
  r.transport.start(100);
  r.running.b = true;
  r.liveNudge('b', { hold: 1 });
  near(r.deckClocks.b.cps, 0.5 * (1 + songSync.NUDGE_PCT), 'held');
  r.set(102);
  const out = r.liveNudge('b', { hold: 0 });
  assert.equal(out.nudge, 0);
  assert.equal(r.deckClocks.b.cps, 0.5);
  near(out.offset, 2 * 0.5 * songSync.NUDGE_PCT, 'gained');
  assert.equal(r.transport.cps, 0.5);
  assert.equal(r.deckClocks.a.deviates, false, 'the other deck is where it was');
});

test('a jog steps a playing deck one beat and carries its schedulers - tracks and FX unit - with it', async () => {
  const r = await rig();
  r.transport.start(100);
  r.liveNudge('b', { jog: 1 }); // not playing: a platter with nothing on it
  assert.equal(r.deckClocks.b.offset, 0);
  r.running.b = true;
  r.set(101);
  r.liveNudge('b', { jog: 1 });
  r.liveNudge('b', { jog: -1 });
  r.liveNudge('b', { jog: -1 });
  near(r.deckClocks.b.offset, -0.25, 'one beat back');
  assert.equal(r.relocated.b, -0.25 * 2, 'two schedulers, each carried the net step');
  assert.equal(r.relocated.a, 0);
});

test('a jog steps by the deck\'s jog size: sixteen beats is four bars of its clock', async () => {
  const r = await rig();
  r.transport.start();
  r.running.b = true;
  r.mixState.deckJog.b.beats = 16;
  r.liveNudge('b', { jog: 1 });
  near(r.deckClocks.b.offset, 4, 'sixteen beats forward');
  r.mixState.deckJog.b.beats = 4;
  r.liveNudge('b', { jog: -1 });
  near(r.deckClocks.b.offset, 3, 'one bar back');
  assert.equal(r.deckClocks.a.offset, 0, 'deck A has its own size, and was not asked');
});

test('sync off: the deck runs at its setbpm times its fader; back on, it rides the room again', async () => {
  const r = await rig();
  r.transport.start(100);
  r.deckClocks.a.setFreeBpm(140);
  r.mixState.deckTempo.a.frac = 0.5; // +3% on a 6% throw
  r.liveSetSync('a', false);
  near(r.deckClocks.a.cps * 240, 140 * 1.03, 'own tempo');
  r.mixState.deckTempo.a.frac = -0.5;
  r.deckClockApply('a'); // what the fader's move does
  near(r.deckClocks.a.cps * 240, 140 * 0.97, 'fader');
  assert.equal(r.transport.cps * 240, 120);
  r.liveSetSync('a', true);
  assert.equal(r.deckClocks.a.cps * 240, 120);
});

test('outside dj mode the one deck rides the room whatever its button was left at', async () => {
  const r = await rig({ dj: false });
  r.deckLive.a.sync = false;
  r.deckClocks.a.setFreeBpm(90);
  r.deckClockApply('a');
  assert.equal(r.deckClocks.a.cps * 240, 120);
});

test('a stop lets go of a held nudge', async () => {
  const r = await rig();
  r.transport.start(100);
  r.liveNudge('a', { hold: -1 });
  r.deckLiveRelease('a');
  assert.equal(r.deckLive.a.nudge, 0);
  assert.equal(r.deckClocks.a.cps, 0.5);
});

test('plugins hear their own deck\'s clock: one message while both decks ride the room, a scoped pair once one leaves', async () => {
  const r = await rig();
  r.transport.start(100);
  r.running.b = true;
  r.set(101);
  r.syncEngineClock();
  assert.deepEqual(r.sent.map((m) => m.scope), [null], 'the one message it always was');
  r.sent.length = 0;
  r.liveNudge('b', { jog: 1 });
  r.syncEngineClock();
  assert.deepEqual(r.sent.map((m) => m.scope), [{ except: ['#2', '#3'] }, { only: ['#2', '#3'] }]);
  near(r.sent[1].beats - r.sent[0].beats, 1, 'deck B\'s plugins are one beat on');
  assert.equal(r.sent[1].bpm, 120);
});
