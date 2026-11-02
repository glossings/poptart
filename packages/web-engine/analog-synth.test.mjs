import test from 'node:test';
import assert from 'node:assert/strict';

import { ANALOG, ANALOG_DRIFT_CENTS, ANALOG_FILTER_TYPES, ANALOG_SHAPES, AnalogSynth } from './src/devices/analog.mjs';
import { STAGE } from './src/dsp/adsr.mjs';
import { fft } from './src/dsp/fft.mjs';
import { midiToHz } from './src/dsp/voice.mjs';
import { buildFigures } from './src/figures.mjs';

const SR = 48000;
const BLOCK = 128;

const defaults = () => Object.fromEntries(ANALOG.params.map((p) => [p.id, p.default]));
const typeOf = (name) => ANALOG_FILTER_TYPES.indexOf(name);
const shapeOf = (name) => ANALOG_SHAPES.indexOf(name);

/** A synth with `settings` over the defaults, playing `notes` from the first sample. */
function playing(settings = {}, notes = [48], velocity = 1) {
  const synth = new AnalogSynth(SR);
  const values = { ...defaults(), ...settings };
  synth.setParams(values);
  synth.setBend(0);
  for (const note of notes) synth.queueNoteOn(note, velocity, 0);
  return { synth, values };
}

/** `blocks` blocks of the left channel; `each(b)` may queue notes or change controls before block b. */
function render(synth, values, blocks, each = null) {
  const out = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    each?.(b, values);
    synth.setParams(values);
    l.fill(0);
    r.fill(0);
    synth.process(l, r, BLOCK);
    out.set(l, b * BLOCK);
  }
  return out;
}

const rms = (x, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (to - from));
};

/** Where a voice's filter is tuned, in Hz, after its clamps. */
const tunedHz = (voice) => voice.filter.tuned;

/** A filter wide open and still: what the oscillators make, heard as they are. */
const OPEN = { 'filter.type': typeOf('statevar'), cutoff: 20000, resonance: 0, keytrack: 0, envamount: 0, drift: 0 };

test('every note takes a voice of its own, and past Voices the oldest is taken', () => {
  const { synth, values } = playing({}, [48, 52, 55]);
  render(synth, values, 4);
  assert.equal(synth.activeVoices, 3);
  const notes = synth.voices.filter((v) => v.active).map((v) => v.note).sort();
  assert.deepEqual(notes, [48, 52, 55]);

  const two = playing({ voices: 2 }, [48, 52, 55]);
  render(two.synth, two.values, 4);
  assert.equal(two.synth.activeVoices, 2);
  assert.deepEqual(two.synth.voices.filter((v) => v.active).map((v) => v.note).sort(), [52, 55]);
});

test('with one voice a note played over a held one slides there without starting the envelopes again', () => {
  const settings = { voices: 1, glide: 0.05, 'ampenv.attack': 0.01, 'ampenv.decay': 0.02, 'fenv.attack': 0.01, 'fenv.decay': 0.02 };
  const { synth, values } = playing(settings, [48]);
  render(synth, values, 40);
  const v = synth.voices[0];
  assert.equal(v.ampEnv.stage, STAGE.SUSTAIN);
  assert.equal(v.filterEnv.stage, STAGE.SUSTAIN);

  // Legato: 55 while 48 is held. One voice, both envelopes where they were, the pitch on its way.
  render(synth, values, 2, (b) => { if (b === 0) synth.queueNoteOn(55, 1, 0); });
  assert.equal(synth.activeVoices, 1);
  assert.equal(v.ampEnv.stage, STAGE.SUSTAIN, 'the amp envelope started again');
  assert.equal(v.filterEnv.stage, STAGE.SUSTAIN, 'the filter envelope started again');
  assert.ok(v.pitch > 48.5 && v.pitch < 54.5, `the pitch jumped to ${v.pitch} rather than sliding`);
  render(synth, values, 200);
  assert.ok(Math.abs(v.pitch - 55) < 1e-3, 'the slide arrives');

  // Letting go of 55 while 48 is still held slides back to 48, again without a restart.
  render(synth, values, 1, (b) => { if (b === 0) synth.queueNoteOff(55, 0); });
  assert.equal(v.ampEnv.stage, STAGE.SUSTAIN);
  assert.equal(v.note, 48);
  assert.ok(v.pitch > 48.5, 'back to the held note by a slide');
  render(synth, values, 200);
  assert.ok(Math.abs(v.pitch - 48) < 1e-3);

  // Letting go of the last held note releases; a note on its own starts both envelopes, unslid.
  render(synth, values, 2, (b) => { if (b === 0) synth.queueNoteOff(48, 0); });
  assert.equal(v.ampEnv.stage, STAGE.RELEASE);
  render(synth, values, 1, (b) => { if (b === 0) synth.queueNoteOn(60, 1, 0); });
  assert.equal(v.ampEnv.stage, STAGE.ATTACK);
  assert.equal(v.filterEnv.stage, STAGE.ATTACK);
  assert.equal(v.pitch, 60);
});

test('with one voice and no glide, a legato note jumps straight there, still without a restart', () => {
  const { synth, values } = playing({ voices: 1, 'ampenv.decay': 0.01 }, [48]);
  render(synth, values, 20);
  render(synth, values, 1, (b) => { if (b === 0) synth.queueNoteOn(50, 1, 0); });
  const v = synth.voices[0];
  assert.equal(v.pitch, 50);
  assert.equal(v.ampEnv.stage, STAGE.SUSTAIN);
});

test('with more voices, Glide slides a voice from what it last played', () => {
  const { synth, values } = playing({ voices: 2, glide: 0.1 }, [48, 52]);
  render(synth, values, 10);
  // A third note takes the oldest voice, which slides from 48.
  render(synth, values, 1, (b) => { if (b === 0) synth.queueNoteOn(60, 1, 0); });
  const v = synth.voices.find((x) => x.note === 60);
  assert.ok(v.pitch > 48 && v.pitch < 59, `the stolen voice did not slide (${v.pitch})`);
});

test('Key Track moves the cutoff with the note, from middle C', () => {
  const type = typeOf('statevar');
  for (const [track, note, ratio] of [[1, 72, 2], [1, 48, 0.5], [0.5, 72, Math.SQRT2], [0, 84, 1], [1, 60, 1]]) {
    const { synth, values } = playing({ 'filter.type': type, cutoff: 500, keytrack: track, envamount: 0 }, [note]);
    render(synth, values, 2);
    const hz = tunedHz(synth.voices[0]);
    assert.ok(Math.abs(hz / 500 - ratio) < 1e-6, `Key Track ${track} on note ${note}: ${hz.toFixed(2)} Hz`);
  }
});

test('Env Amount moves the cutoff by semitones, either way, and a harder note further when Velocity says', () => {
  const type = typeOf('statevar');
  const held = { 'filter.type': type, cutoff: 400, keytrack: 0, 'fenv.attack': 0, 'fenv.sustain': 1 };
  const at = (settings, velocity) => {
    const { synth, values } = playing({ ...held, ...settings }, [60], velocity);
    render(synth, values, 4);
    return tunedHz(synth.voices[0]);
  };
  assert.ok(Math.abs(at({ envamount: 24, velocity: 0 }, 1) / 1600 - 1) < 1e-6);
  assert.ok(Math.abs(at({ envamount: -12, velocity: 0 }, 1) / 200 - 1) < 1e-6);
  // Velocity at zero: how hard the note was played does not reach the filter.
  assert.ok(Math.abs(at({ envamount: 24, velocity: 0 }, 0.25) / 1600 - 1) < 1e-6);
  // At one, a note at half velocity gets half the sweep, and a full one all of it.
  assert.ok(Math.abs(at({ envamount: 24, velocity: 1 }, 0.5) / 800 - 1) < 1e-6);
  assert.ok(Math.abs(at({ envamount: 24, velocity: 1 }, 1) / 1600 - 1) < 1e-6);
  assert.ok(at({ envamount: 24, velocity: 0.5 }, 0.9) > at({ envamount: 24, velocity: 0.5 }, 0.3), 'a harder note opens it further');
});

test('velocity scales the level', () => {
  const loud = playing(OPEN, [48], 1);
  const soft = playing(OPEN, [48], 0.5);
  const a = rms(render(loud.synth, loud.values, 40), 2000);
  const b = rms(render(soft.synth, soft.values, 40), 2000);
  assert.ok(Math.abs(b / a - 0.5) < 0.01, `half the velocity came out at ${(b / a).toFixed(3)} of the level`);
});

/** A frame's spectrum in decibels against its loudest bin, windowed with a four-term Blackman-Harris. */
function spectrum(x, n = 16384) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const start = x.length - n;
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const w = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    re[i] = x[start + i] * w;
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  let top = 0;
  for (let k = 0; k < n / 2; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
    if (mag[k] > top) top = mag[k];
  }
  return { n, db: Array.from(mag, (m) => 20 * Math.log10(m / top + 1e-15)) };
}

/** The loudest component that is not a harmonic of `f0`, below 18 kHz, against the loudest. */
function worstFold(x, f0) {
  const { n, db } = spectrum(x);
  let worst = -Infinity;
  for (let k = 1; k < (18000 * n) / SR; k++) {
    const hz = (k * SR) / n;
    const h = hz / f0;
    if (Math.abs(h - Math.round(h)) * f0 < 40) continue;
    worst = Math.max(worst, db[k]);
  }
  return worst;
}

test('a high note does not fold back, on every shape and synced', () => {
  const cases = [
    { 'osc1.shape': shapeOf('saw'), mix: 0 },
    { 'osc1.shape': shapeOf('square'), 'osc1.width': 0.3, mix: 0 },
    { 'osc1.shape': shapeOf('triangle'), mix: 0 },
    { 'osc2.shape': shapeOf('saw'), mix: 1, sync: 1, 'osc2.semi': 7, 'osc2.detune': 30 },
    // The sub is an octave down, so its harmonics are the half-steps of the note's.
    { mix: 0, sub: 1, octave: 0.5 },
    // Through the ladder circuit, open, undriven.
    { 'osc1.shape': shapeOf('saw'), mix: 0, 'filter.type': typeOf('ladder') },
    { 'osc1.shape': shapeOf('square'), mix: 0, 'filter.type': typeOf('ladder') },
  ];
  for (const { octave = 1, ...settings } of cases) {
    for (const note of [96, 103]) {
      const { synth, values } = playing({ ...OPEN, ...settings }, [note]);
      const x = render(synth, values, 160);
      const fold = worstFold(x, midiToHz(note) * octave);
      assert.ok(fold < -60, `${JSON.stringify(settings)} on note ${note}: a folded component at ${fold.toFixed(1)} dB`);
    }
  }
});

test('every filter type stays finite and bounded at the top of Resonance and Drive, swept', () => {
  for (let type = 0; type < ANALOG_FILTER_TYPES.length; type++) {
    for (const drive of [1, 8]) {
      const { synth, values } = playing({ 'filter.type': type, resonance: 1, drive, noise: 0.5, sub: 1, cutoff: 80, envamount: 96 }, [36, 43, 48]);
      const x = render(synth, values, 400, (b, v) => { v.cutoff = 40 * Math.pow(2, (b % 100) / 12); });
      let peak = 0;
      for (const s of x) {
        assert.ok(Number.isFinite(s), `${ANALOG_FILTER_TYPES[type]} put out ${s}`);
        peak = Math.max(peak, Math.abs(s));
      }
      assert.ok(peak < 10, `${ANALOG_FILTER_TYPES[type]} at drive ${drive} peaked at ${peak.toFixed(2)}`);
      assert.ok(peak > 0.01, `${ANALOG_FILTER_TYPES[type]} at drive ${drive} was silent`);
    }
  }
});

test('the ladder rings at its cutoff at the top of Resonance, and keeps ringing bounded', () => {
  const { synth, values } = playing({ 'filter.type': typeOf('ladder'), resonance: 1, cutoff: 1000, keytrack: 0, envamount: 0 }, [36]);
  const x = render(synth, values, 400);
  const { n, db } = spectrum(x);
  // The loudest part above the note's own low harmonics.
  let best = Math.round((300 * n) / SR);
  for (let k = best; k < (5000 * n) / SR; k++) if (db[k] > db[best]) best = k;
  const hz = (best * SR) / n;
  assert.ok(hz > 700 && hz < 1100, `the loudest part is at ${hz.toFixed(0)} Hz`);
  assert.ok(rms(x, x.length - 8192) < 2);
});

test('the drift is the same every time and stays within its cents', () => {
  const a = playing({ ...OPEN, drift: 1 }, [48, 55]);
  const b = playing({ ...OPEN, drift: 1 }, [48, 55]);
  assert.deepEqual(render(a.synth, a.values, 400), render(b.synth, b.values, 400));
  const v = a.synth.voices[0];
  for (let i = 0; i < 2000; i++) {
    render(a.synth, a.values, 1);
    assert.ok(Math.abs(v.drift1) <= 1 && Math.abs(v.drift2) <= 1);
  }
  assert.equal(ANALOG_DRIFT_CENTS, 12);
  // At zero, the oscillators sit exactly on the note.
  const still = playing(OPEN, [57]);
  const x = render(still.synth, still.values, 200);
  const { n, db } = spectrum(x);
  let best = 1;
  for (let k = 1; k < n / 2; k++) if (db[k] > db[best]) best = k;
  assert.ok(Math.abs((best * SR) / n - 220) < SR / n, 'not on the note');
});

test('the width only shows on a square, and every preset is one word that plays', () => {
  assert.deepEqual(ANALOG.params.find((p) => p.id === 'osc1.width').active, { param: 'osc1.shape', is: 'square' });
  assert.deepEqual(ANALOG.params.find((p) => p.id === 'osc2.width').active, { param: 'osc2.shape', is: 'square' });
  assert.ok(Object.keys(ANALOG.presets).length >= 8);
  for (const [name, preset] of Object.entries(ANALOG.presets)) {
    assert.match(name, /^[a-z]+$/);
    assert.ok('voices' in preset, `${name} names its voices`);
    const { synth, values } = playing(preset, [36, 48]);
    const x = render(synth, values, 200);
    assert.ok(x.every(Number.isFinite), `${name} put out something that is not a number`);
    assert.ok(rms(x) > 1e-3, `${name} is silent`);
  }
  assert.equal(ANALOG.presets.acid.voices, 1);
  assert.ok(ANALOG.presets.acid.resonance >= 0.8 && ANALOG.presets.acid.glide > 0);
});

test('the panel draws the filter\'s response for its type, and both envelopes', () => {
  const values = { ...defaults() };
  const figures = buildFigures(ANALOG, values);
  assert.deepEqual(figures.map((f) => f.kind), ['response', 'adsr', 'adsr']);
  const ladder = figures[0];
  assert.equal(ladder.modeName, 'ladder');
  // Every type is drawn as the Filter device's circuit of the same name, from its own equations.
  for (const name of ANALOG_FILTER_TYPES) {
    assert.equal(buildFigures(ANALOG, { ...values, 'filter.type': typeOf(name) })[0].modeName, name);
  }
  // Morph moves the multimodes' picture: a highpass loses its bottom end.
  const at = (morph) => buildFigures(ANALOG, { ...values, 'filter.type': typeOf('statevar'), morph })[0].points[0].db;
  assert.ok(at(1) < at(0) - 30, 'the morphed response did not move');
  assert.equal(figures[1].params?.attack ?? 'fenv.attack', 'fenv.attack');
  assert.equal(figures[1].sustain, values['fenv.sustain']);
  assert.equal(figures[2].sustain, values['ampenv.sustain']);
});

test('eight voices stay affordable', () => {
  const { synth, values } = playing({ voices: 8 }, [36, 43, 48, 52, 55, 60, 64, 67]);
  const seconds = 1;
  const blocks = Math.round((seconds * SR) / BLOCK);
  render(synth, values, 50);
  const t0 = performance.now();
  render(synth, values, blocks);
  const ms = performance.now() - t0;
  // Generous: a fraction of a second for a second of eight voices on any machine CI runs.
  assert.ok(ms < 1000 * seconds * 0.5, `eight voices took ${ms.toFixed(0)} ms for ${seconds} s`);
});
