// Tempo migration (the performance mixer, phase 5): Transport#rampBpm glides cps to a target as
// a stream of small setCps rebases, so cycle position is continuous the whole way - the property
// every scheduler, LFO anchor and highlight snapshot relies on. Wall-clock timers drive the ramp,
// so the timing assertions here are deliberately loose (see the perf-test flakes note in
// TODO/testing lore); what is asserted tightly is the *math*: monotonic cps toward the target,
// no cycle-position jump at any step, and mutual cancellation with setBpm/tempo signals.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Transport } from './src/scheduler.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

test('rampBpm with 0 seconds is an instant setBpm', () => {
  const tr = new Transport(now, { cps: 0.5 });
  tr.rampBpm(240, 0);
  assert.equal(tr.cps, 1);
  assert.equal(tr._rampTimer, null); // nothing left ticking
  tr.dispose();
});

test('rampBpm glides monotonically to the target with continuous cycle position', async () => {
  const tr = new Transport(now, { cps: 0.5 }); // 120 bpm
  tr.rampBpm(240, 0.25);
  const cpsSamples = [];
  let lastSec = now();
  let lastCycle = tr.cycleAt(lastSec);
  for (let i = 0; i < 12; i++) {
    await sleep(50);
    const sec = now();
    const cycle = tr.cycleAt(sec);
    // Continuity: between samples the clock can have advanced at most at the fastest cps seen
    // (plus generous slack for timer jitter), and it never runs backwards.
    const dt = sec - lastSec;
    assert.ok(cycle >= lastCycle, `cycle position ran backwards (${lastCycle} -> ${cycle})`);
    assert.ok(cycle - lastCycle <= dt * 1.0 * 1.5 + 0.01, `cycle jumped: +${cycle - lastCycle} in ${dt}s`);
    cpsSamples.push(tr.cps);
    lastSec = sec;
    lastCycle = cycle;
  }
  for (let i = 1; i < cpsSamples.length; i++) {
    assert.ok(cpsSamples[i] >= cpsSamples[i - 1], 'cps must rise monotonically toward the target');
  }
  assert.equal(tr.cps, 1, 'the final step lands exactly on the target');
  assert.equal(tr._rampTimer, null, 'the ramp timer stops at the target');
  tr.dispose();
});

test('setBpm cancels a running ramp', async () => {
  const tr = new Transport(now, { cps: 0.5 });
  tr.rampBpm(240, 5); // long ramp, would still be running
  tr.setBpm(100);
  assert.equal(tr._rampTimer, null);
  await sleep(120); // outlive a few would-be ramp steps
  assert.equal(tr.cps, 100 / 240);
  tr.dispose();
});

test('a ramp cancels a tempo signal (and its poll timer)', async () => {
  const tr = new Transport(now, { cps: 0.5 });
  tr.setBpm({ sample: () => 180 }); // signal tempo: polled and applied
  assert.equal(tr.cps, 180 / 240);
  tr.rampBpm(120, 0);
  assert.equal(tr._tempoTimer, null, 'the signal poll must stop');
  await sleep(80); // outlive a poll interval: the signal must not reassert 180
  assert.equal(tr.cps, 0.5);
  tr.dispose();
});

// Grid handover (DJ mode's song decks): startAt un-freezes the clock with the caller's phase, so
// a song deck can make the shared cycle grid its own bar grid and everything that quantizes to a
// cycle afterwards lands on that record's downbeats.
test('startAt un-freezes with the caller\'s position, and cycles run from there', () => {
  const tr = new Transport(now, { cps: 0.5, paused: true }); // 120 bpm, 2s cycles
  assert.equal(tr.paused, true);
  const at = now() + 0.15;
  tr.startAt(at, 0.25); // a start a quarter of the way into a bar
  assert.equal(tr.paused, false);
  assert.ok(Math.abs(tr.cycleAt(at) - 0.25) < 1e-9);
  assert.ok(Math.abs(tr.cycleAt(at + 2) - 1.25) < 1e-9, 'one cycle later is one cycle on');
  // The next boundary a joining deck quantizes to is exactly 0.75 cycles (1.5s) after the start.
  assert.ok(Math.abs(tr.secAt(Math.ceil(tr.cycleAt(at))) - (at + 1.5)) < 1e-9);
  tr.dispose();
});

test('startAt ignores junk rather than corrupting a running clock', () => {
  const tr = new Transport(now, { cps: 0.5 });
  const base = tr.cycleAt(now());
  tr.startAt(NaN, 0);
  assert.ok(Math.abs(tr.cycleAt(now()) - base) < 0.05, 'still where it was');
  tr.dispose();
});
