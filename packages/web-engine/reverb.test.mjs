// The algorithmic reverb's level.
//
// A reverb at full mix that is barely audible is a reverb that reads as broken, and that is what
// this one was: the wet path sat twenty-two decibels under a sustained input at a two-second
// decay. Level is not something a tail test notices - a tail that is there but tiny still decays
// correctly - so the level is held here on its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Reverb as ReverbDsp } from './src/dsp/reverb.mjs';

/** Steady-state wet RMS over dry RMS, on noise, once the tail has built up. */
function wetOverDry(decay) {
  const SR = 48000;
  const B = 128;
  const rv = new ReverbDsp(SR);
  rv.set({ decay, size: 1, damping: 6000, preDelay: 0, lowCut: 120, modulation: 0 });
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 4294967296) * 2 - 1; };
  const inL = new Float32Array(B); const inR = new Float32Array(B);
  const oL = new Float32Array(B); const oR = new Float32Array(B);
  let dryE = 0; let wetE = 0;
  for (let b = 0; b < (SR * 3) / B; b++) {
    for (let i = 0; i < B; i++) { inL[i] = rnd() * 0.3; inR[i] = rnd() * 0.3; }
    rv.process(inL, inR, oL, oR, B);
    if (b * B > SR * 1.5) for (let i = 0; i < B; i++) { dryE += inL[i] ** 2; wetE += oL[i] ** 2; }
  }
  return 20 * Math.log10(Math.sqrt(wetE / dryE));
}

test('at full mix a two-second tail sits a few decibels under the dry signal, not twenty', () => {
  const db = wetOverDry(2);
  assert.ok(db > -9 && db < -3, `a two-second tail measured ${db.toFixed(1)} dB against the input`);
});

test('a longer tail is louder in steady state, and a very long one stays under unity', () => {
  const short = wetOverDry(0.5);
  const long = wetOverDry(6);
  assert.ok(long > short, `six seconds (${long.toFixed(1)} dB) should sit above half a second (${short.toFixed(1)} dB)`);
  assert.ok(wetOverDry(20) < 0, 'twenty seconds of tail must not run over the input level');
});
