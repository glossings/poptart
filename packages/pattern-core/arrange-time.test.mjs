// Scheduler#setSongClock: with an arrangement, a track's pattern is read at the SONG position rather
// than the transport cycle. Before this, only the painter's gate followed the song clock - a track
// started from the marker at bar 2 was gated as bar 2 but played its pattern's bar 0, and a loop
// region re-gated its bars without replaying them. Here we pin what the scheduler emits.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, _auto, auto } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { ArrangeClock } from './src/arrange.mjs';

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
  const clock = new ArrangeClock({ len: 4 });
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
  const clock = new ArrangeClock({ len: 4, regions: [{ name: 'A', start: 0, end: 2 }] });
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), clock);
  sch._scheduleNoteEdges(0, 6, 0);
  assert.deepEqual(notes().map(([, n]) => n), [60, 62, 60, 62, 60, 62]);
});

test('the song wrapping at its end starts the patterns over too', () => {
  const clock = new ArrangeClock({ len: 3 });
  const { sch, notes } = schedulerFor(note('<60 62 64 65>').synth('X'), clock);
  sch._scheduleNoteEdges(0, 4, 0);
  assert.deepEqual(notes().map(([, n]) => n), [60, 62, 64, 60]);
});

test('a marker inside a bar plays from inside the bar, on time', () => {
  const clock = new ArrangeClock({ len: 4 });
  clock.seek(0, 0.5);
  const { sch, notes } = schedulerFor(note('60 62').synth('X'), clock);
  sch._scheduleNoteEdges(0, 1, 0);
  assert.deepEqual(round(notes()), [[0, 62], [0.5, 60]], 'the second half first, then the next bar\'s downbeat');
});

test('a window split across ticks plays each note once', () => {
  const clock = new ArrangeClock({ len: 4, regions: [{ name: 'A', start: 0.5, end: 1.5 }] });
  const whole = schedulerFor(note('60 62 64 65').synth('X'), clock);
  whole.sch._scheduleNoteEdges(0, 4, 0);
  const twin = new ArrangeClock({ len: 4, regions: [{ name: 'A', start: 0.5, end: 1.5 }] });
  const ticked = schedulerFor(note('60 62 64 65').synth('X'), twin);
  for (let c = 0; c < 4; c += 0.13) ticked.sch._scheduleNoteEdges(c, Math.min(4, c + 0.13), 0);
  assert.deepEqual(round(ticked.notes()), round(whole.notes()));
});

test('a polled control reads the song position too', () => {
  _auto('rise', '0,0 16,1');
  const clock = new ArrangeClock({ len: 32 });
  clock.seek(0, 8);
  const { sch, callsTo } = schedulerFor(note('60').synth('X').pan(auto('rise')), clock);
  sch._pollGenericParams(0);
  const sent = callsTo('setParam').filter((c) => c.args[2] === 'pan').map((c) => c.args[3]);
  // Applied a lookahead ahead (0.15s = 0.15 cycles at cps 1), from bar 8.
  assert.ok(Math.abs(sent.at(-1) - (8.15 / 16)) < 1e-6, `pan read at bar 8, got ${sent.at(-1)}`);
});
