// The DJ desk's FX knob as a signal (fxknob / `fx1` in an FX chain's code).
//
// The knob being an honest Signal is the whole reason an FX chain is code rather than a plugin
// name: on a player deck the FX knob is not only a dry/wet, it reaches whatever the effect makes
// it reach - a threshold, a cutoff, a feedback - and it has to do that to several parameters of
// several plugins at once, each in its own units. What is pinned here is that one knob move is
// seen by every parameter bound to it, and that .range()/arithmetic put it in those units.

import test from 'node:test';
import assert from 'node:assert/strict';

import { audio, fxknob, Sig } from './src/signal.mjs';
import { setFxKnob, fxKnobValue, FX_KNOB_COUNT } from './src/fxknobs.mjs';

test('the knob is a plain 0..1 signal, and never rests', () => {
  const fx1 = fxknob(1);
  setFxKnob(1, 0);
  assert.equal(fx1.sample(0, 0.5, 0), 0, 'a knob at the bottom reads 0, not null - it always has a position');
  setFxKnob(1, 0.42);
  assert.equal(fx1.sample(0, 0.5, 0), 0.42);
  // Clamped at the feed, like the macro knobs: the desk can only ever send 0..1.
  setFxKnob(1, 4);
  assert.equal(fxKnobValue(1), 1);
  setFxKnob(1, -2);
  assert.equal(fxKnobValue(1), 0);
  setFxKnob(1, NaN);
  assert.equal(fxKnobValue(1), 0);
});

test('an index outside the bank is refused rather than silently read', () => {
  assert.throws(() => fxknob(0), /knob index must be 1/);
  assert.throws(() => fxknob(FX_KNOB_COUNT + 1), /knob index must be 1/);
  assert.throws(() => setFxKnob(FX_KNOB_COUNT + 1, 0.5), /knob index must be 1/);
});

test('.range() and arithmetic put the knob in a parameter\'s own units', () => {
  const fx1 = fxknob(1);
  setFxKnob(1, 0.5);
  assert.equal(fx1.range(0.2, 0.4).sample(0, 0.5, 0), 0.30000000000000004);
  assert.equal(fx1.range(200, 4000).sample(0, 0.5, 0), 2100);
  assert.equal(fx1.mul(2).sample(0, 0.5, 0), 1);
  setFxKnob(1, 1);
  assert.equal(fx1.range(0.2, 0.4).sample(0, 0.5, 0), 0.4, 'the top of the throw is the top of the range');
});

test('a chain builds the Sig an FX return track needs, with the knob on every binding', () => {
  // Exactly what the desk evaluates: `song` + the chain's code + the appended dry/wet.
  const sig = audio('bus:#fxa')
    .fx('Pro-C 2').param('Threshold', fxknob(1))
    .fx('kHs Comb Filter').param('Cutoff', fxknob(1).range(0.2, 0.4))
    .wet(fxknob(1));
  assert.ok(sig instanceof Sig);
  // A bus block: no instrument and no notes, which is what makes the return track's scheduler a
  // parameter poller and nothing else.
  assert.equal(sig.instrument, null);
  assert.equal(sig.stepsForCycle, null);
  assert.deepEqual(sig.inputSource, { io: 'audio', name: 'bus:#fxa' });
  assert.deepEqual(sig.fxChain, ['Pro-C 2', 'kHs Comb Filter']);
  // The params sit on the slots the chain order gives them (slot 0 is the instrument).
  assert.deepEqual(Object.keys(sig.paramSignals).sort(), ['1:Threshold', '2:Cutoff']);
  // ...and the dry/wet lands on the LAST slot, which is the unit's output.
  assert.deepEqual(Object.keys(sig.channel).filter((k) => k.startsWith('wet')), ['wet2']);

  // One knob, three destinations, each in its own units.
  const read = () => ({
    threshold: sig.paramSignals['1:Threshold'].sig.sample(0, 0.5, 0),
    cutoff: sig.paramSignals['2:Cutoff'].sig.sample(0, 0.5, 0),
    wet: sig.channel.wet2.sample(0, 0.5, 0),
  });
  setFxKnob(1, 0);
  assert.deepEqual(read(), { threshold: 0, cutoff: 0.2, wet: 0 },
    'knob closed: the unit passes the deck through untouched (wet 0)');
  setFxKnob(1, 1);
  assert.deepEqual(read(), { threshold: 1, cutoff: 0.4, wet: 1 });
  setFxKnob(1, 0); // leave the bank as the other tests expect it
});
