// osc() - an incoming OSC message as a signal (src/osc.mjs store + the builder in signal.mjs),
// and the scheduler's native binding for it. Mirrors midicc(): same IR shape (ccIR, with an
// address in place of a device/cc/channel), same bounds rewrites, its own modulator KIND so a
// control moving between the two sources clears the old engine binding. The sclang side
// (setParamOSC opening the input port and mapping a bus) is covered by a manual checklist.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, osc, midicc, mini } from './src/signal.mjs';
import { feedOsc, latestOsc, oscInUse, normalizeOscAddress } from './src/osc.mjs';
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

test('the store keeps the latest numeric arguments per address, slash implied', () => {
  assert.equal(normalizeOscAddress('1/fader3'), '/1/fader3');
  assert.equal(normalizeOscAddress(' /xy '), '/xy');
  assert.equal(latestOsc('/never'), null, 'nothing yet is a rest, not a guess');

  feedOsc('/xy', [0.25, 'label', 0.75]);
  assert.equal(latestOsc('xy'), 0.25, 'the first argument by default, address matched with the slash implied');
  assert.equal(latestOsc('/xy', 1), 0.75, 'non-numeric arguments are dropped, so the index counts values');
  assert.equal(latestOsc('/xy', 5), null, 'a shorter message than the index asks for is a rest');

  feedOsc('/xy', 0.5);
  assert.equal(latestOsc('/xy'), 0.5, 'a bare value counts as a one-argument message');
});

test('osc() samples the store, rests until the address arrives, and registers itself as in use', () => {
  const sig = osc('/1/fader1');
  assert.deepEqual(sig.ccIR, { osc: '/1/fader1', index: 0, min: 0, max: 1 });
  assert.equal(sig.sample(0, 0.5, 0), null, 'rests before the first message');
  feedOsc('/1/fader1', [0.5]);
  assert.equal(sig.sample(0, 0.5, 0), 0.5);
  assert.equal(oscInUse(), true);

  feedOsc('/pad', [0.1, 0.9]);
  assert.equal(osc('pad', 1).sample(0, 0.5, 0), 0.9, 'index picks the argument, slash implied');
});

test('osc() refuses what it cannot bind', () => {
  assert.throws(() => osc(''), /OSC address/);
  assert.throws(() => osc(12), /OSC address/);
  assert.throws(() => osc('/f', -1), /which of the message/);
  assert.throws(() => osc('/f', 1.5), /which of the message/);
});

test('.range() and linear math rewrite the bounds symbolically and keep the binding native', () => {
  feedOsc('/f', [0.5]);
  const r = osc('/f').range(200, 400);
  assert.deepEqual(r.ccIR, { osc: '/f', index: 0, min: 200, max: 400 });
  assert.equal(r.sample(0, 0.5, 0), 300);

  const m = osc('/f').mul(2).add(1);
  assert.deepEqual(m.ccIR, { osc: '/f', index: 0, min: 1, max: 3 });
  assert.equal(m.sample(0, 0.5, 0), 2);

  // A signal-valued bound rides along like midicc's do (see patterned-args.test.mjs).
  const s = osc('/f').range(mini('80 100', 0), 2000);
  assert.deepEqual(s.ccIR.min.stepsForCycle(0).map((x) => x.value), [80, 100]);
  assert.equal(s.ccIR.max, 2000);
});

test('the scheduler programs an osc() control natively and never polls it', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').param('Cutoff', osc('/1/fader3').range(0.2, 0.8)));

  const sends = callsTo('setParamOSC');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].args, ['bass', 0, 'Cutoff', { osc: '/1/fader3', index: 0, min: 0.2, max: 0.8 }]);
  assert.equal(callsTo('setParamCC').length, 0, 'an OSC binding is not a MIDI one');

  sch._pollGenericParams(0);
  assert.equal(callsTo('setParam').filter((c) => c.args[2] === 'Cutoff').length, 0, 'runs engine-side, so the poll skips it');
  assert.match(sch.holdChannel('gain', 0.5) ?? '', /^$/, 'an unbound channel control can still be held');
});

test('moving a control between osc() and midicc() clears the old binding; dropping it clears too', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').param('Cutoff', osc('/f')));
  assert.equal(callsTo('setParamOSC').length, 1);

  sch.setPattern(note('c2*4').synth('Serum 2').param('Cutoff', midicc('Twister')(12)));
  assert.equal(callsTo('clearParamOSC').length, 1, 'the OSC entry goes before the MIDI one arrives');
  assert.deepEqual(callsTo('clearParamOSC')[0].args, ['bass', 0, 'Cutoff']);
  assert.equal(callsTo('setParamCC').length, 1);

  sch.setPattern(note('c2*4').synth('Serum 2').param('Cutoff', osc('/f')));
  assert.equal(callsTo('clearParamCC').length, 1, 'and back the other way');
  assert.equal(callsTo('setParamOSC').length, 2);

  sch.setPattern(note('c2*4').synth('Serum 2'));
  assert.equal(callsTo('clearParamOSC').length, 2, 'a control the new pattern no longer carries is torn down');
});

test('a channel control bound to osc() refuses a mixer hold, naming the source', () => {
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(osc('/gain')));
  assert.match(sch.holdChannel('gain', 0.5), /native modulator .*osc/);
});
