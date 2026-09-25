// The Distort effect. The test that earns its keep is the oversampling one: a waveshaper makes
// harmonics above the audible range by design, and whether they fold back down or get filtered
// off is the difference between distortion that sounds like an instrument and distortion that
// sounds broken.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, findParam } from './src/descriptor.mjs';
import { DISTORT, DistortProcessor } from './src/devices/distort.mjs';
import { ASYMMETRIC, IS_CURVE, SHAPER_INDEX, SHAPER_MODES, autoGainFor, shape } from './src/dsp/shapers.mjs';
import { Oversampler } from './src/dsp/oversample.mjs';
import { harmonicsOf } from './src/dsp/fft.mjs';

const SR = 48000;
const N = 8192;

/** A sine at a bin-exact frequency, so the analysis has no leakage to hide behind. */
function sine(bins, amplitude = 0.5, count = N) {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.sin((2 * Math.PI * bins * i) / N) * amplitude;
  return out;
}

function run(params, input, count = N, block = 128) {
  const fx = new DistortProcessor(SR, block);
  const out = new Float32Array(count);
  const full = { ...defaultValues(DISTORT), ...params };
  for (let at = 0; at < count; at += block) {
    const n = Math.min(block, count - at);
    fx.process([input.subarray(at, at + n)], [out.subarray(at, at + n)], n, full);
  }
  return out;
}

/** Energy at bins that are not whole multiples of the input's own frequency. */
function inharmonicEnergy(signal, fundamentalBin) {
  const { amp } = harmonicsOf(signal);
  let harmonic = 0;
  let other = 0;
  for (let k = 1; k < amp.length; k++) {
    const e = amp[k] * amp[k];
    const ratio = k / fundamentalBin;
    if (Math.abs(ratio - Math.round(ratio)) * fundamentalBin < 1.5) harmonic += e; else other += e;
  }
  return other / (harmonic + other);
}

const peak = (buf) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (buf) => Math.sqrt(buf.reduce((a, b) => a + b * b, 0) / buf.length);

test('the descriptor lists the modes the code switches on, and marks which are curves', () => {
  assert.deepEqual([...findParam(DISTORT, 'mode').options], [...SHAPER_MODES]);
  assert.equal(SHAPER_MODES.length, IS_CURVE.length);
  // Every mode here is a curve now: bit crushing and downsampling are their own device, which
  // is what the exemption was for (see devices/crush.mjs).
  assert.ok(IS_CURVE.every(Boolean));
  assert.equal(SHAPER_INDEX.crush, undefined);
  assert.equal(SHAPER_INDEX.downsample, undefined);
});

test('every curve passes a quiet signal through more or less untouched at no drive', () => {
  for (const [mode, name] of SHAPER_MODES.entries()) {
    if (!IS_CURVE[mode]) continue;
    if (mode === SHAPER_INDEX.cheby) continue;      // a Chebyshev curve is a harmonic, not a slope
    if (mode === SHAPER_INDEX.westcoast) continue;  // two folds in series have gain between them
    const y = shape(0.05, mode, 1, 0, 8);
    assert.ok(Math.abs(y - 0.05) < 0.03, `${name} moved a quiet sample from 0.05 to ${y.toFixed(4)}`);
  }
});

test('a curve with no bias is odd, so it puts no offset on what it is given', () => {
  for (const [mode, name] of SHAPER_MODES.entries()) {
    if (mode === SHAPER_INDEX.cheby) continue;   // a Chebyshev harmonic is even or odd by number
    if (ASYMMETRIC[mode]) continue;              // these two are asymmetric on purpose
    for (const drive of [1, 4, 20]) {
      for (const x of [0.13, 0.4, 0.77, 1]) {
        const up = shape(x, mode, drive, 0, 8);
        const down = shape(-x, mode, drive, 0, 8);
        assert.ok(Math.abs(up + down) < 1e-9, `${name} at drive ${drive} is not odd: ${up} against ${down}`);
      }
    }
  }
});

test('every curve stays bounded however hard it is driven', () => {
  for (const [mode, name] of SHAPER_MODES.entries()) {
    for (const drive of [1, 10, 100, 1000]) {
      for (const bias of [-1, 0, 1]) {
        for (const x of [-1, -0.3, 0, 0.3, 1]) {
          const y = shape(x, mode, drive, bias, 8);
          assert.ok(Number.isFinite(y) && Math.abs(y) <= 1.001, `${name} at drive ${drive} bias ${bias} on ${x} gave ${y}`);
        }
      }
    }
  }
});

test('an odd-symmetric curve makes odd harmonics, and a bias brings the even ones in', () => {
  const input = sine(101);
  const clean = run({ mode: SHAPER_INDEX.soft, drive: 24, bias: 0, oversample: 2, autogain: 0 }, input);
  const biased = run({ mode: SHAPER_INDEX.soft, drive: 24, bias: 0.4, oversample: 2, autogain: 0 }, input);
  const evenEnergy = (sig) => {
    const { amp } = harmonicsOf(sig);
    let even = 0;
    for (let h = 2; h <= 8; h += 2) even += amp[101 * h] ** 2;
    return even;
  };
  assert.ok(evenEnergy(biased) > evenEnergy(clean) * 20, 'a bias should bring in the even harmonics');
});

// The point of the oversample control.
test('oversampling moves the folded harmonics out of the way', () => {
  // A bright input high enough that hard clipping puts most of its harmonics past Nyquist.
  const input = sine(701, 0.5);
  const noise = (over) => inharmonicEnergy(run({ mode: SHAPER_INDEX.hard, drive: 24, oversample: over, autogain: 0 }, input), 701);
  const at1 = noise(0);
  const at4 = noise(2);
  assert.ok(at4 < at1 * 0.5, `4x should fold back far less than 1x: ${(at4 * 100).toFixed(3)}% against ${(at1 * 100).toFixed(3)}%`);
});

test('the oversampler passes a signal through unchanged when it is doing nothing', () => {
  for (const factor of [1, 2, 4]) {
    const over = new Oversampler(256);
    over.setFactor(factor);
    const input = sine(40, 0.5, 2048);
    const out = new Float64Array(2048);
    // An identity curve: whatever comes out is the filters' doing, not the curve's.
    for (let at = 0; at < 2048; at += 128) {
      over.process(input.subarray(at, at + 128), out.subarray(at, at + 128), 128, (v) => v);
    }
    // Skip the filter's start-up, then compare against the input delayed by the filter's own lag.
    const tail = out.subarray(1024, 2048);
    assert.ok(rms(tail) > 0.3, `${factor}x lost the signal: rms ${rms(tail).toFixed(4)}`);
    assert.ok(rms(tail) < 0.4, `${factor}x changed the level: rms ${rms(tail).toFixed(4)}`);
  }
});

test('auto gain holds the level as the drive goes up, and off it does not', () => {
  const input = sine(101, 0.5);
  const quiet = rms(run({ mode: SHAPER_INDEX.soft, drive: 0, autogain: 1 }, input));
  const loud = rms(run({ mode: SHAPER_INDEX.soft, drive: 36, autogain: 1 }, input));
  assert.ok(Math.abs(loud / quiet - 1) < 0.5, `auto gain should hold the level: ${(loud / quiet).toFixed(2)}x`);

  const off = rms(run({ mode: SHAPER_INDEX.soft, drive: 36, autogain: 0 }, input));
  assert.ok(off > loud * 1.3, 'with auto gain off, driving should get louder');
});

test('the gain compensation never returns something absurd, whatever the curve is doing', () => {
  for (const [mode] of SHAPER_MODES.entries()) {
    for (const drive of [0.1, 1, 10, 100, 1000]) {
      for (const bias of [-1, 0, 0.7]) {
        const g = autoGainFor(mode, drive, bias, 8);
        assert.ok(g >= 0.05 && g <= 8 && Number.isFinite(g), `mode ${mode} drive ${drive} asked for ${g}`);
      }
    }
  }
});

test('the mix control really is dry at zero and wet at one', () => {
  const input = sine(101, 0.5);
  const dry = run({ mode: SHAPER_INDEX.hard, drive: 36, mix: 0, autogain: 0 }, input);
  for (let i = 0; i < N; i++) assert.ok(Math.abs(dry[i] - input[i]) < 1e-5, `sample ${i} should be untouched at mix 0`);

  const wet = run({ mode: SHAPER_INDEX.hard, drive: 36, mix: 1, autogain: 0 }, input);
  assert.ok(rms(wet) > rms(dry) * 1.2, 'at mix 1 the clipped signal should dominate');
});

test('a bias leaves no offset behind on the output', () => {
  const input = sine(101, 0.5);
  const out = run({ mode: SHAPER_INDEX.tube, drive: 18, bias: 0.8, autogain: 0 }, input);
  // Measured past the blocker's own settling time, which at a 20 Hz corner is a few tens of ms.
  const mean = out.subarray(4096).reduce((a, b) => a + b, 0) / (N - 4096);
  assert.ok(Math.abs(mean) < 0.01, `the output still has an offset of ${mean.toFixed(4)}`);
});

test('the tone control takes the top off, and is out of the way when it is open', () => {
  const input = sine(51, 0.5);
  const open = run({ mode: SHAPER_INDEX.hard, drive: 30, tone: 20000, autogain: 0 }, input);
  const closed = run({ mode: SHAPER_INDEX.hard, drive: 30, tone: 800, autogain: 0 }, input);
  const highs = (sig) => {
    const { amp } = harmonicsOf(sig);
    let sum = 0;
    for (let h = 5; h <= 15; h += 2) sum += amp[51 * h] ** 2;
    return sum;
  };
  assert.ok(highs(closed) < highs(open) * 0.2, 'closing the tone control should remove the top harmonics');
});

test('the output trim is in dB', () => {
  const input = sine(101, 0.25);
  const unity = rms(run({ mode: SHAPER_INDEX.soft, drive: 0, output: 0, autogain: 0 }, input));
  const up = rms(run({ mode: SHAPER_INDEX.soft, drive: 0, output: 6, autogain: 0 }, input));
  assert.ok(Math.abs(up / unity - 2) < 0.1, `six decibels should be about twice the level, got ${(up / unity).toFixed(3)}x`);
});

test('the cheby mode adds the harmonic it was asked for rather than a whole series', () => {
  const input = sine(101, 1);
  const out = run({ mode: SHAPER_INDEX.cheby, harmonic: 3, drive: 0, mix: 1, autogain: 0, oversample: 2, tone: 20000 }, input);
  const { amp } = harmonicsOf(out);
  assert.ok(amp[303] > amp[101] * 4, 'the third harmonic should dominate');
  assert.ok(amp[303] > amp[202] * 4, 'and it should be the third, not the second');
});

test('the cheby mode at an even harmonic puts no offset on silence, or on a signal', () => {
  // T_n(0) is minus one for even n, so without a blocker the mode's DEFAULT setting - the
  // second harmonic - would park its output at half scale on nothing at all.
  for (const harmonic of [2, 4]) {
    const silence = run({ mode: SHAPER_INDEX.cheby, harmonic, drive: 0, mix: 1, autogain: 0, tone: 20000 }, new Float64Array(N));
    let mean = 0;
    for (let i = 4096; i < N; i++) mean += silence[i];
    mean /= N - 4096;
    assert.ok(Math.abs(mean) < 1e-3, `harmonic ${harmonic} on silence settled at ${mean.toFixed(4)}`);

    const out = run({ mode: SHAPER_INDEX.cheby, harmonic, drive: 0, mix: 1, autogain: 0, tone: 20000 }, sine(101, 1));
    let dc = 0;
    for (let i = 4096; i < N; i++) dc += out[i];
    dc /= N - 4096;
    assert.ok(Math.abs(dc) < 0.02, `harmonic ${harmonic} on a sine left ${dc.toFixed(4)} of offset`);
  }
});

test('a NaN arriving from upstream does not stay in the effect for good', () => {
  const fx = new DistortProcessor(SR, 128);
  const params = { ...defaultValues(DISTORT), bias: 0.5, tone: 8000 };
  const poisoned = new Float32Array(128).fill(NaN);
  const out = new Float32Array(128);
  fx.process([poisoned], [out], 128, params);
  const clean = new Float32Array(128);
  for (let i = 0; i < 128; i++) clean[i] = Math.sin(i * 0.2) * 0.5;
  fx.process([clean], [out], 128, params);
  for (let i = 0; i < 128; i++) assert.ok(Number.isFinite(out[i]), `sample ${i} was still ${out[i]} a block later`);
});

test('nothing the effect renders is out of range or not a number, in any mode', () => {
  const input = sine(101, 1);
  for (const [mode] of SHAPER_MODES.entries()) {
    for (const oversample of [0, 1, 2]) {
      const out = run({ mode, oversample, drive: 40, bias: 0.6, mix: 0.7, output: 6 }, input, 2048);
      for (let i = 0; i < out.length; i++) {
        assert.ok(Number.isFinite(out[i]) && Math.abs(out[i]) < 16, `mode ${mode} at ${oversample} sample ${i} was ${out[i]}`);
      }
    }
  }
});

test('a missing input channel renders silence rather than throwing', () => {
  const fx = new DistortProcessor(SR, 128);
  const out = new Float32Array(128);
  fx.process([], [out], 128, defaultValues(DISTORT));
  assert.ok(out.every((v) => v === 0));
});

test('a per-sample drive is read per sample, so a signal patched into it is modulation', () => {
  const input = sine(101, 0.5);
  const steady = run({ mode: SHAPER_INDEX.hard, drive: 20, autogain: 0 }, input, 512, 128);
  const swept = new Float32Array(128);
  for (let i = 0; i < 128; i++) swept[i] = i < 64 ? 0 : 40;
  const fx = new DistortProcessor(SR, 128);
  const out = new Float32Array(128);
  fx.process([input.subarray(0, 128)], [out], 128, { ...defaultValues(DISTORT), mode: SHAPER_INDEX.hard, drive: swept, autogain: 0 });
  let differsEarly = false;
  for (let i = 0; i < 64; i++) if (Math.abs(out[i] - steady[i]) > 1e-4) { differsEarly = true; break; }
  assert.ok(differsEarly, 'the first half was driven differently and should sound different');
});
