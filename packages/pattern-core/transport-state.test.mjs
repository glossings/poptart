// Transport#onStateChange and #shiftCycles - the hooks the host's clock sharing hangs off (MIDI
// clock's start/stop/locate, the Link follower's phase trims - see web-app's server.js). What is
// asserted: each transition announces itself exactly once with the right kind, tempo changes
// never announce (they have their own hook), and a shift moves position without touching tempo
// or running state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Transport } from './src/scheduler.mjs';

function clock(t0 = 100) {
  let t = t0;
  const tr = new Transport(() => t, { cps: 0.5, paused: true });
  const kinds = [];
  tr.onStateChange = (k) => kinds.push(k);
  return { tr, kinds, advance: (dt) => { t += dt; }, now: () => t };
}

test('start/stop announce once each, and only on a real transition', () => {
  const { tr, kinds } = clock();
  tr.stop(); // already paused: nothing to say
  assert.deepEqual(kinds, []);
  tr.start();
  tr.start(); // no-op while running
  tr.stop();
  tr.stop();
  assert.deepEqual(kinds, ['start', 'stop']);
  tr.dispose();
});

test('startAt is a start from paused and a rebase while running', () => {
  const { tr, kinds, now } = clock();
  tr.startAt(now(), 0.25);
  assert.equal(tr.cycleAt(now()), 0.25);
  tr.startAt(now(), 3);
  assert.deepEqual(kinds, ['start', 'rebase']);
  tr.startAt(NaN, 1); // junk is ignored, silently
  assert.deepEqual(kinds, ['start', 'rebase']);
  tr.dispose();
});

test('tempo changes never announce a state change', () => {
  const { tr, kinds } = clock();
  tr.start();
  tr.setBpm(140);
  tr.setCps(1);
  tr.rampBpm(100, 0);
  assert.deepEqual(kinds, ['start']);
  tr.dispose();
});

test('shiftCycles moves a running clock by exactly delta, keeps tempo, says nothing', () => {
  const { tr, kinds, advance, now } = clock();
  tr.start();
  advance(2); // 1 cycle at 0.5 cps
  assert.equal(tr.cycleAt(now()), 1);
  tr.shiftCycles(0.3);
  assert.ok(Math.abs(tr.cycleAt(now()) - 1.3) < 1e-12);
  assert.equal(tr.cps, 0.5);
  advance(2);
  assert.ok(Math.abs(tr.cycleAt(now()) - 2.3) < 1e-12); // still advancing at the same rate
  tr.shiftCycles(-0.3);
  assert.ok(Math.abs(tr.cycleAt(now()) - 2) < 1e-12);
  assert.deepEqual(kinds, ['start']);
  tr.dispose();
});

test('shiftCycles is a no-op on a paused clock and on junk', () => {
  const { tr, now } = clock();
  tr.shiftCycles(0.4);
  assert.equal(tr.cycleAt(now()), 0);
  tr.start();
  tr.shiftCycles(NaN);
  tr.shiftCycles(0);
  assert.equal(tr.cycleAt(now()), 0);
  tr.dispose();
});
