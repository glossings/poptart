// The FM synth renders without making garbage.
//
// A voice renders every block for as long as it sounds, on the audio thread, where an allocation
// is a pause the collector takes later at a moment nobody chose. So the steady state - a note
// held, block after block - makes no new arrays and builds no settings objects for its
// envelopes; it writes into what the voice already owns.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, findParam } from './src/descriptor.mjs';
import { FMSYNTH, FmSynth } from './src/devices/fmsynth.mjs';
import { Adsr } from './src/dsp/adsr.mjs';

const SR = 48000;
const BLOCK = 128;

test('a held FM note renders block after block without allocating', () => {
  const synth = new FmSynth(SR);
  synth.setParams(defaultValues(FMSYNTH));
  synth.queueNoteOn(60, 1, 0);
  synth.queueNoteOn(67, 1, 0);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  synth.process(l, r, BLOCK);

  const Original = globalThis.Float64Array;
  const set = Adsr.prototype.set;
  let arrays = 0;
  let objects = 0;
  globalThis.Float64Array = new Proxy(Original, { construct(target, args) { arrays++; return new target(...args); } });
  Adsr.prototype.set = function (...args) { objects++; return set.apply(this, args); };
  try {
    for (let b = 0; b < 20; b++) { l.fill(0); r.fill(0); synth.process(l, r, BLOCK); }
  } finally {
    globalThis.Float64Array = Original;
    Adsr.prototype.set = set;
  }
  assert.equal(arrays, 0, `${arrays} arrays were made while the notes were held`);
  assert.equal(objects, 0, `the envelopes were handed ${objects} settings objects`);
  assert.ok(l.some((v) => v !== 0), 'the notes should be sounding');
});

test('setting the stages as arguments is the same as setting them as an object', () => {
  const a = new Adsr(SR);
  const b = new Adsr(SR);
  a.set({ attack: 0.1, decay: 0.2, sustain: 1.4, release: -1, attackCurve: 2, decayCurve: -3, releaseCurve: 5, scale: 2 });
  b.setStages(0.1, 0.2, 1.4, -1, 2, -3, 5, 2);
  for (const key of ['attack', 'decay', 'sustain', 'release', 'attackCurve', 'decayCurve', 'releaseCurve']) {
    assert.equal(b[key], a[key], key);
  }
});

// ---- the operator's feedback is the matrix's diagonal ----------------------------------------

test('there is no feedback knob beside the diagonal, which is the same thing', () => {
  assert.equal(findParam(FMSYNTH, 'Op 1 Feedback'), null);
  assert.match(findParam(FMSYNTH, 'Mod 3 to 3').description, /feedback/);
});

test('the velocity amount says what it does in its name', () => {
  assert.equal(findParam(FMSYNTH, 'op2.velocity').name, 'Op 2 Vel > Level');
});
