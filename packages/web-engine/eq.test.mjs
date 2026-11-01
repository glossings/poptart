// The EQ's slopes.
//
// A cut or shelf band at 24 to 96 dB per octave is a Butterworth cascade of biquads. The cuts
// have to be maximally flat at a Q of 0.71 (-3 dB at the corner, no bump) and fall at their
// slope; the curve on the panel has to be what the processor plays; and 12 has to be the single
// biquad it always was.

import test from 'node:test';
import assert from 'node:assert/strict';

import { argToValue, defaultValues, findParam } from './src/descriptor.mjs';
import { buildFigures } from './src/figures.mjs';
import { buildPanel } from './src/panel.mjs';
import { EQ, EqProcessor } from './src/devices/eq.mjs';
import {
  BIQUAD_SLOPES, BIQUAD_TYPES, biquadCoefficients, biquadMagnitude, biquadSections, sectionCoefficients,
} from './src/dsp/biquad.mjs';

const SR = 48000;
const T = (name) => BIQUAD_TYPES.indexOf(name);
const S = (db) => BIQUAD_SLOPES.indexOf(String(db));

/** A band's response in dB at `f`, from its sections. */
function bandDb(type, hz, gainDb, q, slope, f) {
  const sections = biquadSections(type, slope);
  let mag = 1;
  for (let k = 0; k < sections; k++) {
    mag *= biquadMagnitude(sectionCoefficients(type, hz, gainDb, q, sections, k, SR, new Float64Array(5)), f, SR);
  }
  return 20 * Math.log10(mag);
}

test('a cut is -3 dB at its corner and falls at its slope, at every slope', () => {
  for (const db of [12, 24, 36, 48, 72, 96]) {
    // The lowpass corner sits low, so the octaves measured are far from Nyquist's warping.
    for (const [type, hz, away] of [['highpass', 2000, 1 / 2], ['lowpass', 150, 2]]) {
      const at = (f) => bandDb(T(type), hz, 0, Math.SQRT1_2, S(db), f);
      assert.ok(Math.abs(at(hz) + 3.01) < 0.05, `${type} ${db}: ${at(hz).toFixed(2)} dB at the corner`);
      // One octave further out from two octaves out: the asymptote.
      const fall = at(hz * away ** 2) - at(hz * away ** 3);
      assert.ok(Math.abs(fall - db) < 1, `${type} ${db}: falls ${fall.toFixed(2)} dB an octave`);
    }
  }
});

test('a 48 dB highpass is maximally flat: no bump above the corner', () => {
  for (let f = 1000; f < 16000; f *= 1.05) {
    const db = bandDb(T('highpass'), 1000, 0, Math.SQRT1_2, S(48), f);
    assert.ok(db <= 1e-9, `${db} dB at ${f.toFixed(0)} Hz`);
  }
  const octaveBelow = bandDb(T('highpass'), 1000, 0, Math.SQRT1_2, S(48), 500);
  assert.ok(Math.abs(octaveBelow + 48.2) < 0.3, `${octaveBelow.toFixed(2)} dB an octave below`);
});

test('the Q is the level at a steep cut\'s corner, as it is at 12', () => {
  for (const q of [0.4, 1, 2, 6]) {
    for (const db of [12, 48, 96]) {
      const got = bandDb(T('lowpass'), 2000, 0, q, S(db), 2000);
      const want = 20 * Math.log10(q);
      assert.ok(Math.abs(got - want) < 0.05, `Q ${q} at ${db}: ${got.toFixed(2)} dB, want ${want.toFixed(2)}`);
    }
  }
});

test('a steep shelf reaches its gain, crosses half of it at the corner, and is steeper', () => {
  for (const db of [12, 24, 48, 96]) {
    const at = (f) => bandDb(T('lowshelf'), 500, 12, Math.SQRT1_2, S(db), f);
    assert.ok(Math.abs(at(20) - 12) < 0.2, `${db}: ${at(20).toFixed(2)} dB far below`);
    assert.ok(Math.abs(at(500) - 6) < 0.05, `${db}: ${at(500).toFixed(2)} dB at the corner`);
    assert.ok(Math.abs(at(16000)) < 0.2, `${db}: ${at(16000).toFixed(2)} dB far above`);
  }
  // Steeper: closer to full gain half an octave below the corner.
  const half = (db) => bandDb(T('lowshelf'), 500, 12, Math.SQRT1_2, S(db), 500 / Math.SQRT2);
  assert.ok(half(48) > half(12) + 2, `${half(12).toFixed(2)} then ${half(48).toFixed(2)}`);
});

test('the slope leaves the peak, band, notch and allpass types alone', () => {
  for (const name of ['peak', 'bandpass', 'notch', 'allpass']) {
    assert.equal(biquadSections(T(name), S(96)), 1, name);
  }
});

test('at 12 a band is the single biquad it always was', () => {
  for (let type = 0; type < BIQUAD_TYPES.length; type++) {
    const a = biquadCoefficients(type, 700, 5, 1.3, SR, new Float64Array(5));
    const b = sectionCoefficients(type, 700, 5, 1.3, biquadSections(type, 0), 0, SR, new Float64Array(5));
    assert.deepEqual([...b], [...a], BIQUAD_TYPES[type]);
  }
});

test('the processor plays what the curve draws at a steep slope', () => {
  const values = {
    ...defaultValues(EQ),
    'band1.type': T('highpass'), 'band1.slope': S(48), 'band1.freq': 1000, 'band1.q': Math.SQRT1_2,
  };
  const figure = buildFigures(EQ, values, { sampleRate: SR }).find((f) => f.kind === 'eq');
  const fx = new EqProcessor(SR);
  const block = 128;
  for (const hz of [700, 1000, 2000]) {
    const drawn = figure.points.reduce((b, p) => (Math.abs(Math.log(p.hz / hz)) < Math.abs(Math.log(b.hz / hz)) ? p : b));
    // Played at the drawn point's own frequency, after the filter has settled.
    fx.reset();
    let sum = 0;
    let n = 0;
    for (let at = 0; at < SR; at += block) {
      const input = new Float32Array(block);
      for (let i = 0; i < block; i++) input[i] = Math.sin((2 * Math.PI * drawn.hz * (at + i)) / SR);
      const out = [new Float32Array(block), new Float32Array(block)];
      fx.process([input, input], out, block, values);
      if (at >= SR / 2) for (const x of out[0]) { sum += x * x; n++; }
    }
    const played = 20 * Math.log10(Math.sqrt(sum / n) * Math.SQRT2);
    assert.ok(Math.abs(played - drawn.db) < 0.1, `${drawn.hz.toFixed(0)} Hz: played ${played.toFixed(2)}, drawn ${drawn.db.toFixed(2)}`);
  }
});

test('each band has a slope control, 12 by default, named by its decibels', () => {
  for (let n = 1; n <= 4; n++) {
    const p = findParam(EQ, `band${n}.slope`);
    assert.ok(p, `band${n}.slope`);
    assert.deepEqual(p.options, ['12', '24', '36', '48', '72', '96']);
    assert.equal(p.default, 0);
    assert.equal(p.group, `Band ${n}`);
    assert.equal(findParam(EQ, `Band ${n} Slope`), p);
    assert.equal(argToValue(p, '48'), 3);
  }
  const panel = buildPanel(EQ);
  const band1 = panel.sections.find((s) => s.title === 'Band 1');
  const slope = band1.widgets.find((w) => w.id === 'band1.slope');
  assert.equal(slope.widget, 'enum');
  assert.equal(slope.text, '12');
});
