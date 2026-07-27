// Output-to-bus sends (Sig#bus / #dry / #bsend) and how the Scheduler forwards them to the engine.
// The audio summing itself lives in SuperCollider (sc/poptart.scd) and is covered by a manual
// checklist; here we pin the pure builder behaviour and the engine calls the scheduler emits.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, synth, s } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

// A stand-in engine: every method is a spy that records its call; getTime is 0 so the Transport a
// Scheduler builds has a clock. `typeof engine.method === 'function'` holds for everything, which
// is what the scheduler feature-detects on.
function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, calls, callsTo };
}

test('.bus() appends a send; defaults amount to 1', () => {
  const sig = synth('Serum 2').bus('drums');
  assert.deepEqual(sig.busSends, [{ name: 'drums', amount: 1 }]);
});

test('.bus() takes a send amount and stacks multiple buses', () => {
  const sig = synth('Serum 2').bus('reverb', 0.3).bus('delay', 0.5);
  assert.deepEqual(sig.busSends, [
    { name: 'reverb', amount: 0.3 },
    { name: 'delay', amount: 0.5 },
  ]);
});

test('.bus() trims the name and validates its arguments', () => {
  assert.deepEqual(synth('Serum 2').bus('  drums  ').busSends, [{ name: 'drums', amount: 1 }]);
  assert.throws(() => synth('Serum 2').bus(''), /bus name/);
  assert.throws(() => synth('Serum 2').bus(42), /bus name/);
  assert.throws(() => synth('Serum 2').bus('drums', 'loud'), /amount must be a number/);
  assert.throws(() => synth('Serum 2').bus('drums', NaN), /amount must be a number/);
});

test('.dry() sets a dry-level channel control, independent of bus sends', () => {
  const sig = synth('Serum 2').bus('drums').dry(0.25);
  assert.ok('dry' in sig.channel, 'dry rides the channel strip');
  assert.deepEqual(sig.busSends, [{ name: 'drums', amount: 1 }], 'dry leaves sends untouched');
});

test('.bsend() is .bus().dry(0)', () => {
  const sig = synth('Serum 2').bsend('reverb', 0.4);
  assert.deepEqual(sig.busSends, [{ name: 'reverb', amount: 0.4 }]);
  const plain = synth('Serum 2').bus('reverb', 0.4).dry(0);
  // Same shape as spelling it out by hand.
  assert.deepEqual(sig.busSends, plain.busSends);
  assert.deepEqual(Object.keys(sig.channel), Object.keys(plain.channel));
});

test('bus sends survive later chaining (threaded through _clone)', () => {
  const sig = synth('Serum 2').bus('drums', 0.7).gain(0.5).pan(-1);
  assert.deepEqual(sig.busSends, [{ name: 'drums', amount: 0.7 }]);
});

test('scheduler forwards .bus() sends to the engine', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2').bus('drums', 0.8).bus('room'));

  const sent = callsTo('setBusSends');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, ['kick', [{ name: 'drums', amount: 0.8 }, { name: 'room', amount: 1 }]]);
});

test('scheduler tears down sends when a re-eval drops .bus()', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2').bus('drums'));
  sch.setPattern(note('c2*4').synth('Serum 2')); // .bus() gone this eval

  assert.equal(callsTo('clearBusSends').length, 1);
  assert.deepEqual(callsTo('clearBusSends')[0].args, ['kick']);
});

test('scheduler does not clear sends when there were none to begin with', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2'));
  assert.equal(callsTo('clearBusSends').length, 0);
});

test('stop() releases a track\'s bus sends', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2').bus('drums'));
  sch.stop();
  assert.equal(callsTo('clearBusSends').length, 1);
});
