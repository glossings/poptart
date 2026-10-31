// The scheduler tells the engine when its track starts and stops playing, for the devices that
// follow it (a looper plays out its pass on a stop and comes back in on the bar).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine(now = 0) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

test('a start says the track plays from the moment its first cycle does, and a stop says it stopped now', () => {
  const { engine, argsTo } = mockEngine(10);
  const sched = new Scheduler(engine, { trackId: 'loop', cps: 0.5 });
  sched.setPattern(n('0'));
  sched.start(7);
  sched.stop();
  // A second stop says nothing more.
  sched.stop();
  assert.deepEqual(argsTo('setTrackRunning'), [['loop', true, sched.transport.secAt(7)], ['loop', false, null]]);
});

test('a control drawn in the code is never held as a steady setting', async () => {
  const { _input, beginWidgets, takeWidgets, audio } = await import('./src/index.mjs');
  const { engine, argsTo } = mockEngine(0);
  beginWidgets('a');
  const sig = audio('in').fx('Looper').param('Record', _input([10, -1], 'toggle', 1));
  takeWidgets();
  const sched = new Scheduler(engine, { trackId: 'loop', cps: 0.5 });
  sched.setPattern(sig);
  sched.start(0);
  sched._tick();
  sched.stop();
  assert.deepEqual(argsTo('holdParam').map((a) => a[3]), [{ steady: false }]);
});
