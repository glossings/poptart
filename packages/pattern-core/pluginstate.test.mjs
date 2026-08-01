// Captured plugin state (`synth("Serum 2", { state })`) and how the Scheduler decides whether to
// send it to the engine. The capture itself is auto-pin, which lives in web-app + sc/poptart.scd;
// what's testable here is the rule that keeps a livecoding re-eval from making a plugin re-chew a
// state it already has.

import test from 'node:test';
import assert from 'node:assert/strict';

import { synth } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

// Same stand-in engine as bus.test.mjs: every method records its call, getTime is 0.
function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, callsTo };
}

test('a state in the code is sent once, not on every re-eval', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  const sig = synth('Serum 2', { state: 'H4sIstate1' });

  sch.setPattern(sig);
  sch.setPattern(sig);

  assert.deepEqual(callsTo('setPluginState').map((c) => c.args), [['lead', 0, 'H4sIstate1']]);
});

test('a changed state is sent again', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });

  sch.setPattern(synth('Serum 2', { state: 'H4sIstate1' }));
  sch.setPattern(synth('Serum 2', { state: 'H4sIstate2' }));

  assert.deepEqual(callsTo('setPluginState').map((c) => c.args[2]), ['H4sIstate1', 'H4sIstate2']);
});

test('markStateApplied suppresses the send-back of a just-captured state', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });

  // Auto-pin captured this state *from* the plugin and wrote it into the code; the next eval sees
  // it as a new `{ state }` argument and must not push it back.
  sch.markStateApplied(0, 'Serum 2', 'H4sIcaptured');
  sch.setPattern(synth('Serum 2', { state: 'H4sIcaptured' }));

  assert.deepEqual(callsTo('setPluginState'), []);
});

test('markStateApplied is scoped to the plugin that was captured from', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });

  // Swapping the plugin in the slot invalidates the mark: a fresh Diva has never seen this state,
  // so it still has to be sent.
  sch.markStateApplied(0, 'Serum 2', 'H4sIcaptured');
  sch.setPattern(synth('Diva', { state: 'H4sIcaptured' }));

  assert.deepEqual(callsTo('setPluginState').map((c) => c.args), [['lead', 0, 'H4sIcaptured']]);
});

test('markStateApplied ignores an unknown plugin rather than poisoning the cache', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });

  // The server passes whatever it knows occupies the slot; before the first eval that's undefined,
  // and a mark under a null plugin id must not match (or block) a real one later.
  sch.markStateApplied(0, undefined, 'H4sIcaptured');
  sch.setPattern(synth('Serum 2', { state: 'H4sIcaptured' }));

  assert.deepEqual(callsTo('setPluginState').map((c) => c.args), [['lead', 0, 'H4sIcaptured']]);
});
