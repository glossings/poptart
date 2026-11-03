// Trigger on a device struck by notes (a low-pass gate, a ducker): the scheduler tells the engine
// which slots have it set, because the device cannot tell a Trigger at rest from one nobody set.

import test from 'node:test';
import assert from 'node:assert/strict';

import { audio, s, sine } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine() {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, {
    get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }),
  });
  return { engine, routes: () => calls.filter((c) => c.method === 'triggerRoute').map((c) => c.args) };
}

test('Trigger set on an effect tells the engine; dropped, it says so once', () => {
  const { engine, routes } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(s('bd').fx('LPG').param('Trigger', sine()));
  assert.deepEqual(routes(), [['t', 1, true]]);
  sched.setPattern(s('bd').fx('LPG').param('Decay', 0.2));
  assert.deepEqual(routes(), [['t', 1, true], ['t', 1, false]]);
  sched.setPattern(s('bd').fx('LPG'));
  assert.equal(routes().length, 2, 'nothing more once it is off');
});

test('Trigger by its id, a constant, or audio patched onto it all count', () => {
  for (const value of [1, audio('kick')]) {
    const { engine, routes } = mockEngine();
    new Scheduler(engine, { trackId: 't' }).setPattern(s('bd').fx('Filter').fx('Ducker').param('trigger', value));
    assert.deepEqual(routes(), [['t', 2, true]], `for ${typeof value === 'number' ? value : 'audio'}`);
  }
});
