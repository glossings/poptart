// Scheduler#holdChannel: the mixer holding a channel-strip control at the value under a finger
// while it is dragged, so riding a fader sounds instead of waiting for the release to write code
// and evaluate. The engine side (the track SynthDef's own .lag() on these controls) and the lease
// that expires an abandoned drag (web-app/server.js) are covered by a manual checklist; here we
// pin what the scheduler actually emits.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, synth, lfo, env } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

// Same stand-in engine the other scheduler tests use: every method records its call, getTime is 0.
function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, calls, callsTo };
}

/** The values one poll sent for a channel control (pseudo-slot -1), in order. */
function channelSends(callsTo, name) {
  return callsTo('setParam').filter((c) => c.args[1] === -1 && c.args[2] === name).map((c) => c.args[3]);
}

test('a held control polls at the held value instead of the pattern\'s', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(0.5));

  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [0.5], 'the code\'s trim before the grab');

  assert.equal(sch.holdChannel('gain', 0.8), null, 'taking the hold is allowed');
  sch._pollGenericParams(0);
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [0.5, 0.8, 0.8], 'every tick carries the finger\'s value');
});

test('a control the pattern does not carry can still be held (and is put back on release)', () => {
  const { engine, calls, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2')); // no .pan() anywhere in the block
  calls.length = 0; // setPattern snaps every control the pattern dropped back to its default first

  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'pan'), [], 'nothing polls a control the pattern never set');

  sch.holdChannel('pan', -0.6);
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'pan'), [-0.6], 'grabbing the knob sounds anyway');

  // Releasing has to push the default by hand: the poll only walks what the pattern carries, so
  // otherwise the track would stay pinned where the finger left it.
  sch.holdChannel('pan', null);
  assert.deepEqual(channelSends(callsTo, 'pan'), [-0.6, 0], 'released back to the channel default');
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'pan'), [-0.6, 0], 'and the poll leaves it alone from there');
});

test('releasing a control the pattern does carry just hands it back to the poll', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(0.5));

  sch.holdChannel('gain', 0.8);
  sch.holdChannel('gain', null);
  assert.deepEqual(channelSends(callsTo, 'gain'), [], 'no by-hand push - the pattern has a value of its own');
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [0.5], 'the next tick is the code again');
});

test('releasing a hold that was never taken does nothing', () => {
  const { engine, calls, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2'));
  calls.length = 0; // as above: setPattern's own default resets are not what this is about
  sch.holdChannel('pan', null);
  assert.deepEqual(callsTo('setParam'), [], 'no stray default pushed at a control nobody touched');
});

// The one that matters for correctness rather than feel: a Tier-2 modulator drives its control from
// a bus MAPPED onto the track synth, and a scalar set would unmap it and kill the modulation until
// the next eval. The mixer falls back to writing code for these.
for (const [what, sig] of [['lfo', lfo()], ['env', env()]]) {
  test(`a control driven natively by ${what}() refuses the hold`, () => {
    const { engine, callsTo } = mockEngine();
    const sch = new Scheduler(engine, { trackId: 'pad' });
    sch.setPattern(note('c2*4').synth('Serum 2').gain(sig));

    const why = sch.holdChannel('gain', 0.8);
    assert.match(why ?? '', /native modulator/, 'refused, with a reason the editor can show');
    sch._pollGenericParams(0);
    assert.deepEqual(channelSends(callsTo, 'gain'), [], 'and nothing is sent at the mapped control');
  });
}

test('a hold that predates the modulator is inert rather than destructive', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(0.5));
  sch.holdChannel('gain', 0.8);
  // Re-eval turns the plain trim into a native modulator under the still-held control.
  sch.setPattern(note('c2*4').synth('Serum 2').gain(lfo()));

  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [], 'the stale hold does not push a scalar at the bus map');
});

test('holdChannel rejects a name that is not a channel control', () => {
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2'));
  assert.match(sch.holdChannel('cutoff', 0.5) ?? '', /not a channel control/);
});

test('a channel hold leaves plugin params alone', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').param('cutoff', 0.25).gain(0.5));

  sch.holdChannel('gain', 0.8);
  sch._pollGenericParams(0);
  const cutoff = callsTo('setParam').filter((c) => c.args[2] === 'cutoff');
  assert.equal(cutoff.length, 1, 'the param still polls');
  assert.equal(cutoff[0].args[3], 0.25, 'at its own sampled value, not the hold');
});

test('holds hold across a re-eval, so the release that triggered it does not snap back', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(0.5));
  sch.holdChannel('gain', 0.8);
  sch.setPattern(note('c2*4').synth('Serum 2').gain(0.8)); // the write the release just made

  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [0.8]);
});

test('stopping the track drops its holds', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(0.5));
  sch.holdChannel('gain', 0.8);
  sch.stop();

  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [0.5], 'back on the pattern, not the dropped hold');
});

test('every mixer control is a channel control the hold accepts', () => {
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(synth('Serum 2'));
  for (const name of ['gain', 'pan', 'width', 'bassmono']) {
    assert.equal(sch.holdChannel(name, 1), null, `${name} is holdable`);
  }
});
