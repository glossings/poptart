// Scheduler#setSongClock: with an arrangement, a track's pattern is read at the SONG position rather
// than the transport cycle. Before this, only the painter's gate followed the song clock - a track
// started from the marker at bar 2 was gated as bar 2 but played its pattern's bar 0, and a loop
// region re-gated its bars without replaying them. Here we pin what the scheduler emits.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, _auto, auto } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { ArrangeClock, ClipClock, parseArrangement, clipShiftNow } from './src/arrange.mjs';

// Same stand-in engine the other scheduler tests use: every method records its call, getTime is 0.
function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, callsTo };
}

// cps 1, so a transport cycle is a second and the onsets read straight off the timestamps.
function schedulerFor(sig, clock) {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setSongClock(clock);
  sch.setPattern(sig);
  const notes = () => callsTo('noteOn').map((c) => [c.args[3], c.args[1]]);
  return { sch, notes, callsTo };
}

const round = (pairs) => pairs.map(([at, n]) => [Math.round(at * 1e6) / 1e6, n]);

test('started from the marker, a track plays the bar the song is on', () => {
  const clock = new ArrangeClock({ end: 4 });
  clock.seek(0, 2); // play from bar 2, the transport starting at cycle 0
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), clock);
  sch._scheduleNoteEdges(0, 2, 0);
  assert.deepEqual(notes(), [[0, 64], [1, 65]], 'bars 2 and 3, not bars 0 and 1');
});

test('without a clock the song is the transport', () => {
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), null);
  sch._scheduleNoteEdges(0, 2, 0);
  assert.deepEqual(notes(), [[0, 60], [1, 62]]);
});

test('a loop region replays what it played the first time round', () => {
  const clock = new ArrangeClock({ end: 4, regions: [{ name: 'A', start: 0, end: 2 }] });
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), clock);
  sch._scheduleNoteEdges(0, 6, 0);
  assert.deepEqual(notes().map(([, n]) => n), [60, 62, 60, 62, 60, 62]);
});

test('nothing wraps at the song\'s end: the patterns run on until the host stops the deck', () => {
  const clock = new ArrangeClock({ end: 3 });
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), clock);
  sch._scheduleNoteEdges(0, 4, 0);
  assert.deepEqual(notes().map(([, n]) => n), [60, 62, 64, 65]);
  assert.equal(clock.endCycle(), 3, 'which is what the host watches for');
});

test('a marker inside a bar plays from inside the bar, on time', () => {
  const clock = new ArrangeClock({ end: 4 });
  clock.seek(0, 0.5);
  const { sch, notes } = schedulerFor(note('60 62').synth('X'), clock);
  sch._scheduleNoteEdges(0, 1, 0);
  assert.deepEqual(round(notes()), [[0, 62], [0.5, 60]], 'the second half first, then the next bar\'s downbeat');
});

test('a window split across ticks plays each note once', () => {
  const clock = new ArrangeClock({ end: 4, regions: [{ name: 'A', start: 0.5, end: 1.5 }] });
  const whole = schedulerFor(note('60 62 64 65').synth('X'), clock);
  whole.sch._scheduleNoteEdges(0, 4, 0);
  const twin = new ArrangeClock({ end: 4, regions: [{ name: 'A', start: 0.5, end: 1.5 }] });
  const ticked = schedulerFor(note('60 62 64 65').synth('X'), twin);
  for (let c = 0; c < 4; c += 0.13) ticked.sch._scheduleNoteEdges(c, Math.min(4, c + 0.13), 0);
  assert.deepEqual(round(ticked.notes()), round(whole.notes()));
});

test('a polled control reads the song position too', () => {
  _auto('rise', '0,0 16,1');
  const clock = new ArrangeClock({ end: 32 });
  clock.seek(0, 8);
  const { sch, callsTo } = schedulerFor(note('60').synth('X').pan(auto('rise')), clock);
  sch._pollGenericParams(0);
  const sent = callsTo('setParam').filter((c) => c.args[2] === 'pan').map((c) => c.args[3]);
  // Applied a lookahead ahead (0.15s = 0.15 cycles at cps 1), from bar 8.
  assert.ok(Math.abs(sent.at(-1) - (8.15 / 16)) < 1e-6, `pan read at bar 8, got ${sent.at(-1)}`);
});

// --- clip-relative time, through the scheduler: the notes AND everything read at them ---

test('a track on a ClipClock plays its pattern from the start of each clip', () => {
  const clock = new ClipClock(new ArrangeClock({ end: 16 }), parseArrangement('lead,1,2 lead,6,2'));
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), clock);
  sch._scheduleNoteEdges(0, 10, 0);
  assert.deepEqual(round(notes()), [[1, 60], [2, 62], [6, 60], [7, 62]], 'silent between the clips, and each one starts over');
});

const lastSent = (callsTo, name) => callsTo('setParam').filter((c) => c.args[2] === name).map((c) => c.args[3]).at(-1);

test('a polled control is read in clip time too', () => {
  const clock = new ClipClock(new ArrangeClock({ end: 32 }), parseArrangement('lead,8,8'));
  clock.clock.seek(0, 12); // bar 12 of the song is bar 4 of the clip
  const { sch, callsTo } = schedulerFor(note('60').synth('X').pan('<-1 0 1>'), clock);
  sch._pollGenericParams(0);
  assert.equal(lastSent(callsTo, 'pan'), 0, 'bar 4 of the clip is the second step; bar 12 of the song would be the first');
});

// --- ...except an automation lane, which is drawn against the song and stays on it ---

test('an auto() lane polled on a ClipClock track reads the song, not the clip', () => {
  _auto('verb', '0,0 48,0 48,1 64,1 64,0'); // off, then on from bar 48 to bar 64
  const clips = parseArrangement('sub,16,16 sub,48,8 sub,72,16');
  const at = (bar) => {
    const clock = new ClipClock(new ArrangeClock({ end: 128 }), clips);
    clock.clock.seek(0, bar);
    const { sch, callsTo } = schedulerFor(note('60').synth('X').fx('V').param('Mix', auto('verb')), clock);
    sch._pollGenericParams(0);
    return lastSent(callsTo, 'Mix');
  };
  assert.equal(at(20), 0, 'ahead of the rise');
  assert.equal(at(50), 1, 'inside the clip at bar 48, which reads its own pattern from bar 0');
  assert.equal(at(60), 1, 'between clips the lane goes on reading the song');
  assert.equal(at(80), 0, 'and it has fallen again by the next clip');
});

test('an auto() lane under arithmetic still reads the song', () => {
  _auto('climb', '0,0 16,1');
  const clock = new ClipClock(new ArrangeClock({ end: 32 }), parseArrangement('lead,8,8'));
  clock.clock.seek(0, 12);
  const { sch, callsTo } = schedulerFor(note('60').synth('X').pan(auto('climb').mul(0.5)), clock);
  sch._pollGenericParams(0);
  assert.ok(Math.abs(lastSent(callsTo, 'pan') - (12.15 / 16) * 0.5) < 1e-6, `pan read at bar 12 of the song, got ${lastSent(callsTo, 'pan')}`);
});

test('a lane read at a note\'s onset is read where the song is, clip by clip', () => {
  _auto('swell', '0,0 10,1');
  const clock = new ClipClock(new ArrangeClock({ end: 16 }), parseArrangement('lead,2,1 lead,6,1'));
  const { sch, callsTo } = schedulerFor(note('60').synth('X').vel(auto('swell')), clock);
  sch._scheduleNoteEdges(0, 10, 0); // one window over both clips: each step carries its own shift
  const vels = round(callsTo('noteOn').map((c) => [c.args[3], c.args[2]])).map(([at, v]) => [at, Math.round(v * 1e6) / 1e6]);
  assert.deepEqual(vels, [[2, 0.2], [6, 0.6]], 'both clips play bar 0 of the pattern, at the song\'s bars 2 and 6');
});

test('the clip shift is unbound once a read is over', () => {
  _auto('ramp16', '0,0 16,1');
  const clock = new ClipClock(new ArrangeClock({ end: 32 }), parseArrangement('lead,8,8'));
  const { sch } = schedulerFor(note('60').synth('X').vel(auto('ramp16')), clock);
  sch._scheduleNoteEdges(8, 10, 0);
  sch._pollGenericParams(0);
  assert.equal(clipShiftNow(), 0);
  for (const entry of sch._songSteps(sch.pattern.stepsForCycle, 8, 10)) {
    assert.equal(clipShiftNow(), -8, 'bound while the loop body holds the step');
    if (entry) break; // a loop left early
  }
  assert.equal(clipShiftNow(), 0, 'and let go on the way out');
  assert.equal(auto('ramp16').sample(0, 1, 4), 4 / 16, 'so a lane read outside any track is read as asked');
});
