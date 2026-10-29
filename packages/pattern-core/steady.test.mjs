// steadyValue: a control value the code SETS, told apart from one a pattern keeps putting back.
// What the scheduler hands the engine with a hold, so a device window stays editable on a setting
// and names a pattern.

import test from 'node:test';
import assert from 'node:assert/strict';

import { steadyValue, mini, lfo, n, Scheduler } from './src/index.mjs';

test('a number, a name, and a one-step mini string are steady', () => {
  assert.equal(steadyValue(0.4), 0.4);
  assert.equal(steadyValue('asym'), 'asym');
  assert.equal(steadyValue(mini('asym')), 'asym');
  assert.equal(steadyValue(mini('0.4')), 0.4);
});

test('anything that changes, or might, is not', () => {
  assert.equal(steadyValue(mini('<asym tanh>')), undefined, 'an alternation');
  assert.equal(steadyValue(mini('asym tanh')), undefined, 'two steps');
  assert.equal(steadyValue(mini('asym ~')), undefined, 'a rest in the cycle');
  assert.equal(steadyValue(lfo('sine', { rate: 1 })), undefined, 'a modulator');
  assert.equal(steadyValue(mini('<asym asym asym asym asym asym asym tanh>')), undefined, 'a long alternation');
  assert.equal(steadyValue(NaN), undefined);
  assert.equal(steadyValue(null), undefined);
});

test('the scheduler tells the engine which kind of hold it is', () => {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) });
  const sched = new Scheduler(engine, { trackId: 'bass', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').fx('Distort').param('Mode', 'asym').param('Drive', '<0.2 0.8>'));
  sched.start();
  sched._tick();
  sched.stop();
  const holds = Object.fromEntries(calls.filter((c) => c.method === 'holdParam').map((c) => [c.args[2], c.args[3]]));
  assert.deepEqual(holds, { Mode: { steady: true }, Drive: { steady: false } });
});
