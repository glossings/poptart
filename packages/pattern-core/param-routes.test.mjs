// Audio patched straight onto a parameter: `.param("Osc 1 Phase", audio("mod"))`.
//
// A parameter set from a pattern is POLLED - sampled every 30 ms and ramped between polls - which
// is the right answer for a filter sweep and the wrong one for phase modulation, where the
// modulator has to run at the sample rate to be a modulator at all. So an audio handle in value
// position is not a value: it is a connection, and the engine wires it.
//
// The audio summing lives engine-side; what is pinned here is the builder's behavior and the
// engine calls the scheduler emits for it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Signal, audio, lfo, mini, setPatternWarn, sine, synth } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine({ canRoute = true } = {}) {
  const calls = [];
  const base = { getTime: () => 0 };
  const engine = new Proxy(base, {
    get: (t, p) => {
      if (p in t) return t[p];
      // An engine that cannot patch audio into a parameter simply does not have the method, which
      // is what the scheduler feature-detects on.
      if (!canRoute && (p === 'connectParam' || p === 'disconnectParam')) return undefined;
      return (...args) => { calls.push({ method: p, args }); };
    },
    has: (t, p) => (!canRoute && (p === 'connectParam' || p === 'disconnectParam') ? false : true),
  });
  return { engine, calls, callsTo: (m) => calls.filter((c) => c.method === m) };
}

const capture = () => {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  return { lines, restore: () => setPatternWarn(null) };
};

test('an audio handle in value position files a connection, not a polled value', () => {
  const sig = synth('Wavetable').param('Osc 1 Phase', audio('mod'));
  assert.deepEqual(Object.values(sig.paramRoutes), [
    { slot: 0, name: 'Osc 1 Phase', source: 'mod', gain: 1, offset: 0 },
  ]);
  assert.deepEqual(sig.paramSignals, {}, 'it must not also be filed as something to sample');
});

test('a plain value still files as a polled signal', () => {
  const sig = synth('Wavetable').param('Filter Cutoff', 2000);
  assert.deepEqual(sig.paramRoutes, {});
  assert.equal(Object.values(sig.paramSignals).length, 1);
});

test('.mul() and .add() on a handle ride along as a gain and an offset', () => {
  const sig = synth('Wavetable').param('Filter Cutoff', audio('env').mul(2000).add(400));
  assert.deepEqual(Object.values(sig.paramRoutes), [
    { slot: 0, name: 'Filter Cutoff', source: 'env', gain: 2000, offset: 400 },
  ]);
});

test('the order of the arithmetic is respected, the way it would be on a number', () => {
  // (x + 1) * 100 is not x * 100 + 1.
  const after = synth('Wavetable').param('P', audio('m').add(1).mul(100));
  assert.deepEqual(Object.values(after.paramRoutes)[0], { slot: 0, name: 'P', source: 'm', gain: 100, offset: 100 });
  const before = synth('Wavetable').param('P', audio('m').mul(100).add(1));
  assert.deepEqual(Object.values(before.paramRoutes)[0], { slot: 0, name: 'P', source: 'm', gain: 100, offset: 1 });
});

test('subtraction and division work too, and dividing by nothing is refused', () => {
  const sig = synth('Wavetable').param('P', audio('m').sub(0.5).div(2));
  assert.deepEqual(Object.values(sig.paramRoutes)[0], { slot: 0, name: 'P', source: 'm', gain: 0.5, offset: -0.25 });
  assert.throws(() => audio('m').div(0), /div\(0\)/);
});

test('a patterned operand on a connection is refused, and says why', () => {
  assert.throws(() => audio('m').mul('1 2'), /connection, so only a constant gain/);
  assert.throws(() => audio('m').mul(1, 2), /it is a connection, not a pattern/);
  // The paths that do not go through the arithmetic dispatcher have to refuse it too, or they
  // return a handle that quietly ignored the operation.
  assert.throws(() => audio('m').round(), /Only a constant gain/);
  assert.throws(() => audio('m').clamp(0, 1), /Only a constant gain/);
  assert.throws(() => audio('m').gte(1), /Only a constant gain/);
});

test('a handle that has become a track is an ordinary pattern again', () => {
  // audio("drums").fx(...) is a TRACK reading a live input, not a handle on one, so nothing here
  // should change how it behaves.
  const track = audio('drums').fx('Distort');
  assert.equal(track._isBareAudioHandle(), false);
  assert.equal(audio('drums')._isBareAudioHandle(), true);
});

test('a connection aims at the plugin last in the chain, like every other .param()', () => {
  const sig = synth('Wavetable').fx('Distort').param('Drive', audio('mod'));
  assert.deepEqual(Object.values(sig.paramRoutes)[0].slot, 1);
});

test('setting a parameter twice keeps the last one, whichever kind each was', () => {
  const routed = synth('W').param('P', 0.5).param('P', audio('m'));
  assert.deepEqual(routed.paramSignals, {}, 'the connection should replace the value');
  assert.equal(Object.values(routed.paramRoutes).length, 1);

  const valued = synth('W').param('P', audio('m')).param('P', 0.5);
  assert.deepEqual(valued.paramRoutes, {}, 'the value should replace the connection');
  assert.equal(Object.values(valued.paramSignals).length, 1);
});

test('the scheduler wires a connection once and does not re-wire an unchanged one', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't1' });
  sch.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod').mul(0.5)));
  assert.deepEqual(callsTo('connectParam').map((c) => c.args), [['t1', 0, 'Osc 1 Phase', 'mod', 0.5, 0]]);

  sch.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod').mul(0.5)));
  assert.equal(callsTo('connectParam').length, 1, 're-wiring cuts the signal, so an unchanged route is left alone');
});

test('a changed gain is re-wired, because it is a different connection', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't1' });
  sch.setPattern(synth('W').param('P', audio('mod')));
  sch.setPattern(synth('W').param('P', audio('mod').mul(2)));
  assert.equal(callsTo('connectParam').length, 2);
  assert.deepEqual(callsTo('connectParam')[1].args, ['t1', 0, 'P', 'mod', 2, 0]);
});

test('a connection the new pattern dropped is torn down, since the engine track outlives us', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't1' });
  sch.setPattern(synth('W').param('P', audio('mod')));
  sch.setPattern(synth('W'));
  assert.deepEqual(callsTo('disconnectParam').map((c) => c.args), [['t1', 0, 'P']]);
});

test('a parameter whose name has a colon in it is torn down by its real name', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't1' });
  sch.setPattern(synth('W').param('Filter: Cutoff', audio('mod')));
  sch.setPattern(synth('W'));
  assert.deepEqual(callsTo('disconnectParam')[0].args, ['t1', 0, 'Filter: Cutoff']);
});

test('an engine that cannot do this warns once and keeps playing', () => {
  const { engine, callsTo } = mockEngine({ canRoute: false });
  const { lines, restore } = capture();
  try {
    const sch = new Scheduler(engine, { trackId: 't1', label: 'lead' });
    sch.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));
    sch.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));
    const warnings = lines.filter((l) => l.includes('cannot patch audio into a parameter'));
    assert.equal(warnings.length, 1, 'the warning belongs once per track, not once per evaluation');
    assert.ok(warnings[0].includes('"Osc 1 Phase"'), 'it should name the parameter');
    assert.ok(warnings[0].includes('lead'), 'and the track');
    // The rest of the track still reached the engine.
    assert.equal(callsTo('loadInstrument').length, 2);
  } finally {
    restore();
  }
});

test('an engine that cannot do this is not warned at about a pattern with no connections', () => {
  const { engine } = mockEngine({ canRoute: false });
  const { lines, restore } = capture();
  try {
    new Scheduler(engine, { trackId: 't1' }).setPattern(synth('Wavetable').param('Cutoff', 2000));
    assert.equal(lines.filter((l) => l.includes('cannot patch audio')).length, 0);
  } finally {
    restore();
  }
});

// A fresh Scheduler on an engine track that outlived the last one: a re-evaluation, or a label
// removed and re-added. The route was wired by a Scheduler that no longer exists, so "what I
// sent" is empty and the only way to know what is still patched is to ask the engine.
test('a route the last pattern wired and this one dropped is torn down by a fresh scheduler', () => {
  const { engine, callsTo } = mockEngine();
  const held = new Map([['0:Osc 1 Phase', 'mod|1|0']]);
  engine.paramRoutes = () => held;

  const sch = new Scheduler(engine, { trackId: 't1', label: 'lead' });
  sch.setPattern(synth('Wavetable'));   // the same track, without the connection this time

  const dropped = callsTo('disconnectParam');
  assert.equal(dropped.length, 1, 'the route the engine still held must be disconnected');
  assert.deepEqual(dropped[0].args, ['t1', 0, 'Osc 1 Phase']);
});

test('a route that did not change survives a fresh scheduler without being re-wired', () => {
  const { engine, callsTo } = mockEngine();
  engine.paramRoutes = () => new Map([['0:Osc 1 Phase', 'mod|1|0']]);

  const sch = new Scheduler(engine, { trackId: 't1', label: 'lead' });
  sch.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));

  assert.equal(callsTo('disconnectParam').length, 0, 'nothing was dropped');
  // Re-wiring cuts the signal for a moment, and a parameter fed at audio rate is part of the
  // sound: an unchanged route is left alone exactly as it is within one Scheduler's lifetime.
  assert.equal(callsTo('connectParam').length, 0, 'and nothing was re-made');
});

test('an engine with no answer about its routes is not a scheduler that throws', () => {
  // Every engine is duck-typed and a mock answers anything; a capability the scheduler can do
  // without must never take the pattern down with it.
  const { engine, callsTo } = mockEngine();
  engine.paramRoutes = () => 7;
  const sch = new Scheduler(engine, { trackId: 't1' });
  sch.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));
  assert.equal(callsTo('connectParam').length, 1, 'the pattern still wired its own route');
});

// What may ride on a connection. `.mul()` and `.add()` on an audio handle become a gain node and
// a constant, which are set once and then run in the graph - so the operand has to be a number
// that never changes. A CONTINUOUS signal is the dangerous case: sine() and lfo() have no step
// grid, so a test for steps alone lets them through to be read once at cycle zero and wired as a
// fixed gain. It makes a sound, it is the wrong sound, and nothing says so.
test('a moving operand on a connection is refused rather than frozen at cycle zero', () => {
  for (const [what, operand] of [
    ['a sine', sine()],
    ['an lfo', lfo(2)],
    ['a pattern', mini('0.2 0.8')],
  ]) {
    assert.throws(
      () => synth('Wavetable').param('Osc 1 Phase', audio('mod').mul(operand)),
      /needs a plain number|takes one number/,
      `${what} must be refused`,
    );
  }
});

test('a constant still rides on a connection, however it is spelled', () => {
  const plain = synth('Wavetable').param('Osc 1 Phase', audio('mod').mul(0.5));
  assert.equal(Object.values(plain.paramRoutes)[0].gain, 0.5);

  // Arithmetic that folds to a constant is still a constant: it is the same number at every
  // moment, which is the whole of what a connection needs from it.
  const folded = synth('Wavetable').param('Osc 1 Phase', audio('mod').mul(Signal(0.25).mul(2)));
  assert.equal(Object.values(folded.paramRoutes)[0].gain, 0.5);
});
