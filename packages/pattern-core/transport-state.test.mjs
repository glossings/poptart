// Transport#onStateChange - the hook the host's clock outputs hang off (MIDI clock's
// start/stop/locate - see web-app's server.js). What is asserted: each transition announces
// itself exactly once with the right kind, and tempo changes never announce (they have their
// own hook).

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
