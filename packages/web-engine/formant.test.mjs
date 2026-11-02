// The Formant synth: a spectral peak set apart from the pitch, in two modes.
//
// What has to hold: the peak stays where the formant puts it while the note moves (and moves with
// the note when told to track it); a formant below the pitch drops the note to an undertone in
// both modes rather than cutting anything short; a sharp, driven impulse on a high note does not
// fold back; a note starts without a thump; and nothing at any setting produces a number nobody
// can play.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { FORMANT, FormantSynth } from './src/devices/formant.mjs';
import { midiToHz } from './src/dsp/voice.mjs';

const SR = 48000;
const BLOCK = 128;

/** Renders one held note, with the envelope opened straight to full. */
function render(params, { note = 48, frames = SR / 2 } = {}) {
  const synth = new FormantSynth(SR);
  const values = { ...defaultValues(FORMANT), 'ampenv.attack': 0, 'ampenv.decay': 0, 'ampenv.sustain': 1, level: 1, ...params };
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let at = 0; at < frames; at += BLOCK) {
    synth.setParams(values);
    synth.setBend(0);
    if (at === 0) synth.queueNoteOn(note, 1, 0);
    synth.process(L.subarray(at, at + BLOCK), R.subarray(at, at + BLOCK), BLOCK);
  }
  return L;
}

/** The level of one frequency over the last 8192 samples, in dB, through a Blackman window. */
function levelAt(x, hz) {
  const N = 8192;
  const start = x.length - N;
  let re = 0;
  let im = 0;
  for (let i = 0; i < N; i++) {
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N);
    re += x[start + i] * w * Math.cos((2 * Math.PI * hz * i) / SR);
    im -= x[start + i] * w * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return 20 * Math.log10((Math.hypot(re, im) * 2) / (N * 0.42) + 1e-12);
}

/** The harmonic of `f0` the output is loudest at, from `from` Hz up. */
function loudestHarmonic(x, f0, from = 0) {
  let best = -Infinity;
  let at = 0;
  for (let h = Math.max(1, Math.ceil(from / f0)); h * f0 < 16000; h++) {
    const db = levelAt(x, h * f0);
    if (db > best) { best = db; at = h * f0; }
  }
  return at;
}

// Above the low end: a train of pulses that are all positive is a lump at the pitch as well, which
// is the fundamental VOSIM is known for.
test('VOSIM puts the peak at the formant whatever the note', () => {
  for (const note of [36, 43, 48]) {
    const f0 = midiToHz(note);
    const peak = loudestHarmonic(render({ formant: 1200 }, { note }), f0, 500);
    assert.ok(Math.abs(peak - 1200) <= f0, `note ${note}: the peak is at ${peak.toFixed(0)} Hz`);
  }
});

test('with track at one, the peak moves with the note and is the knob at middle C', () => {
  for (const note of [48, 60, 72]) {
    const f0 = midiToHz(note);
    const peak = loudestHarmonic(render({ formant: 1200, track: 1, count: 8 }, { note }), f0);
    const want = 1200 * (f0 / midiToHz(60));
    assert.ok(Math.abs(peak - want) <= f0, `note ${note}: the peak is at ${peak.toFixed(0)} Hz, not near ${want.toFixed(0)}`);
  }
});

test('in both modes, a formant below the pitch drops the note to an undertone', () => {
  const f0 = midiToHz(72);
  for (const mode of [0, 1]) {
    const x = render({ mode, formant: f0 * 0.6 }, { note: 72 });
    const under = Math.max(levelAt(x, f0 / 2), levelAt(x, f0 / 3));
    assert.ok(under > -30, `mode ${mode}: nothing below the pitch (${under.toFixed(1)} dB)`);
  }
  // And above it, nothing under the pitch at all.
  for (const mode of [0, 1]) {
    const x = render({ mode, formant: f0 * 3 }, { note: 72 });
    assert.ok(levelAt(x, f0 / 2) < -80, `mode ${mode}: an undertone with the formant above the pitch`);
  }
});

test('a VOSIM train is as many pulses as fit: a high note plays fewer, and stays at its pitch', () => {
  const f0 = midiToHz(84);
  const x = render({ count: 16, formant: 3000 }, { note: 84 });
  assert.ok(levelAt(x, f0) > -30, 'the fundamental is missing');
  assert.ok(levelAt(x, f0 / 2) < -80, 'a train that did not fit dropped the pitch');
});

test('a sharp, fully driven impulse on a high note does not fold back', () => {
  for (const note of [96, 108]) {
    const f0 = midiToHz(note);
    const x = render({ mode: 1, shape: 0, air: 1, formant: 6000 }, { note });
    const top = levelAt(x, f0);
    let worst = -Infinity;
    for (let hz = 100; hz < 18000; hz += 37) {
      const h = hz / f0;
      if (Math.abs(h - Math.round(h)) * f0 < 60) continue;
      worst = Math.max(worst, levelAt(x, hz));
    }
    assert.ok(worst - top < -45, `note ${note}: a folded component ${(worst - top).toFixed(1)} dB under the fundamental`);
  }
});

test('a note starts without a thump: no offset left in its first moments', () => {
  for (const params of [{ mode: 0 }, { mode: 0, count: 8, decay: 1, formant: 300 }, { mode: 1, formant: 3000 }, { mode: 1, air: 1, formant: 400 }]) {
    const x = render(params, { frames: 4800 });
    let sum = 0;
    for (let i = 0; i < 2400; i++) sum += x[i];
    assert.ok(Math.abs(sum / 2400) < 0.02, `${JSON.stringify(params)}: an offset of ${(sum / 2400).toFixed(3)} at the start`);
  }
});

test('the mode-only controls show only on their mode', () => {
  const on = (id) => FORMANT.params.find((p) => p.id === id).active;
  assert.deepEqual(on('count'), { param: 'mode', is: 'vosim' });
  assert.deepEqual(on('decay'), { param: 'mode', is: 'vosim' });
  assert.deepEqual(on('shape'), { param: 'mode', is: 'square' });
  assert.deepEqual(on('air'), { param: 'mode', is: 'square' });
  assert.equal(on('formant'), null);
});

test('nothing it renders is out of range or not a number, at either end of every control', () => {
  for (const edge of [false, true]) {
    for (const mode of [0, 1]) {
      const params = { mode };
      for (const p of FORMANT.params) if (!p.options && p.id !== 'voices' && p.id !== 'glide') params[p.id] = edge ? p.max : p.min;
      params['ampenv.attack'] = 0;
      params['ampenv.sustain'] = 1;
      params.level = 1;
      for (const note of [0, 60, 127]) {
        const x = render(params, { note, frames: 4800 });
        for (const v of x) assert.ok(Number.isFinite(v) && Math.abs(v) < 4, `mode ${mode}, note ${note}: ${v}`);
      }
    }
  }
});
