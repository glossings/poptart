// .attack()/.decay()/.sustain()/.release()/.envscale() on a synth set its own amp envelope: they
// become `@amp.<stage>` controls on the instrument, which the engine resolves to whatever control
// the device has for that stage, in the same seconds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, s } from './src/signal.mjs';

test('on a synth the envelope options are its amp envelope, written before or after it', () => {
  assert.deepEqual(Object.keys(n(0).synth('Wavetable').decay(0.3).sustain(0).paramSignals), ['0:@amp.decay', '0:@amp.sustain']);
  const before = n(0).decay(0.3).synth('Wavetable');
  assert.deepEqual(Object.keys(before.paramSignals), ['0:@amp.decay']);
  assert.deepEqual(before.samplerPending, {});
  assert.deepEqual(Object.keys(n(0).synth('W').fx('Delay').adsr(0.01, 0.2, 0, 0.5).paramSignals),
    ['0:@amp.attack', '0:@amp.decay', '0:@amp.sustain', '0:@amp.release'], 'the instrument, past any effects');
  assert.deepEqual(Object.keys(n(0).synth('W').envscale(2).paramSignals), ['0:@amp.scale']);
  assert.equal(n(0).synth('W').decay(0.3).paramSignals['0:@amp.decay'].sig.sample(0, 1, 0), 0.3, 'in seconds, as given');
});

test('on a sampler they stay the sampler\'s', () => {
  const t = s('bd').decay(0.3);
  assert.deepEqual(Object.keys(t.paramSignals), []);
  assert.ok(t.sampler.decay);
});
