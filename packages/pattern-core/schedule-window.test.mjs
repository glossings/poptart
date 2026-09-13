// The schedule window's opening edge (Scheduler#start's fromCycle). Play-from-stop un-freezes
// the transport a few ms before the schedulers start, so a window opened at "wherever the clock
// is by now" begins just PAST cycle 0 - and everything at exactly the boundary was quietly
// dropped: the downbeat, and a `.preset()`'s first application, which left synths on their init
// program for the whole first cycle (found 2026-08-24). The host passes the position it read
// before starting the clock; this pins that the boundary events then play.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Scheduler, Transport } from './src/scheduler.mjs';
import { mini } from './src/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockEngine(sent) {
  return {
    getTime: () => Date.now() / 1000,
    createTrack() {}, loadInstrument() {}, loadEffect() {}, unloadEffect() {},
    noteOn(tid, note) { sent.push(note); },
    noteOff() {}, setParam() {},
  };
}

test('the cycle-0 downbeat plays when the scheduler starts moments after the clock', async () => {
  const sent = [];
  const engine = mockEngine(sent);
  const transport = new Transport(engine.getTime, { cps: 0.5, paused: true });
  transport.stop();
  const scheduleFrom = transport.cycleAt(engine.getTime()); // read while frozen: exactly 0
  transport.start();
  await sleep(5); // the eval loop's own few ms of work between clock start and scheduler start
  const sig = mini('60 62 64 65');
  sig.instrument = 'X';
  sig.fxChain = [];
  sig.channel = {};
  const sch = new Scheduler(engine, { transport, trackId: 't' });
  sch.setPattern(sig);
  sch.start(scheduleFrom);
  await sleep(300);
  sch.stop();
  transport.dispose();
  assert.ok(sent.includes(60), `the downbeat must play (got: ${JSON.stringify(sent)})`);
});

// Play-from-stop starts the clock a lookahead AHEAD of the moment it starts it (see the host's
// transportStart), and the schedulers start with it - so they tick before the clock has reached
// cycle 0. Two things pinned: nothing from before the start position is sent (a cyclic pattern
// answers for cycle -1 as readily as for any other), and the downbeat reaches the engine
// timestamped at the start moment rather than fired late.
test('a clock started ahead of now: nothing plays before its start, and the downbeat is on time', async () => {
  const sent = [];
  const engine = { ...mockEngine([]), noteOn(tid, note, vel, at) { sent.push({ note, at }); } };
  const transport = new Transport(engine.getTime, { cps: 0.5, paused: true });
  transport.stop();
  const sig = mini('60*16');
  sig.instrument = 'X';
  sig.fxChain = [];
  sig.channel = {};
  const sch = new Scheduler(engine, { transport, trackId: 't' });
  sch.setPattern(sig);
  const startSec = engine.getTime() + 1;
  transport.start(startSec);
  sch.start(0);
  await sleep(300); // the clock is still short of cycle 0 by far more than the lookahead
  assert.deepEqual(sent, [], 'nothing from before the start position may play');
  await sleep(1000);
  sch.stop();
  transport.dispose();
  assert.ok(sent.length > 0, 'the pattern plays once the clock reaches its start');
  assert.ok(Math.abs(sent[0].at - startSec) < 1e-6, `the downbeat is timestamped at the start (${sent[0].at} vs ${startSec})`);
  for (const e of sent) assert.ok(e.at >= startSec, 'no event before the start position');
});
