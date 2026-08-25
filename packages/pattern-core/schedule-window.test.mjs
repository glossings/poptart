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
