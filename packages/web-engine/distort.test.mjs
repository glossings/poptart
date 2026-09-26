// The Distort effect. The test that earns its keep is the oversampling one: a waveshaper makes
// harmonics above the audible range by design, and whether they fold back down or get filtered
// off is the difference between distortion that sounds like an instrument and distortion that
// sounds broken.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, findParam } from './src/descriptor.mjs';
import { DISTORT, DistortProcessor } from './src/devices/distort.mjs';
import { ASYMMETRIC, IS_CURVE, SHAPER_INDEX, SHAPER_MODES, TAKES_CHARACTER, autoGainFor, harmonicsOf as curveHarmonics, shape } from './src/dsp/shapers.mjs';

/** The curves Distort shipped with in 0.2.0, in their order: their indexes are in saved songs. */
const SHIPPED = ['soft', 'hard', 'fold', 'sine', 'asym', 'tube', 'diode', 'westcoast', 'cheby'];
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
    if (mode === SHAPER_INDEX.stairs) continue;     // hard stairs at 0.5: a quiet sample is on the zero tread
    if (mode === SHAPER_INDEX.bitflip) continue;    // the mask moves every level, quiet ones too
    if (mode === SHAPER_INDEX.chaos) continue;      // a chaotic map moves everything
    const y = shape(0.05, mode, 1, 0, 0.5);
    assert.ok(Math.abs(y - 0.05) < 0.03, `${name} moved a quiet sample from 0.05 to ${y.toFixed(4)}`);
  }
});

test('a curve with no bias is odd, so it puts no offset on what it is given', () => {
  for (const [mode, name] of SHAPER_MODES.entries()) {
    if (mode === SHAPER_INDEX.cheby) continue;   // a Chebyshev harmonic is even or odd by number
    if (mode === SHAPER_INDEX.wrap) continue;    // at the edge itself, plus and minus one are one point
    if (ASYMMETRIC[mode]) continue;              // these two are asymmetric on purpose
    for (const drive of [1, 4, 20]) {
      for (const x of [0.13, 0.4, 0.77, 1]) {
        const up = shape(x, mode, drive, 0, 0.5);
        const down = shape(-x, mode, drive, 0, 0.5);
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
          const y = shape(x, mode, drive, bias, 0.5);
          // cheby is taken less its value at silence, so an even harmonic spans 0..2; the DC
          // blocker recenters it, as it always did.
          const bound = mode === SHAPER_INDEX.cheby ? 2.001 : 1.001;
          assert.ok(Number.isFinite(y) && Math.abs(y) <= bound, `${name} at drive ${drive} bias ${bias} on ${x} gave ${y}`);
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
        const g = autoGainFor(mode, drive, bias, 0.5);
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
  // Character 0.6 is the third (see shapers.mjs: the second at 0.5, the eighth at 1).
  const out = run({ mode: SHAPER_INDEX.cheby, character: 0.6, drive: 0, mix: 1, autogain: 0, oversample: 2, tone: 20000 }, input);
  const { amp } = harmonicsOf(out);
  assert.ok(amp[303] > amp[101] * 4, 'the third harmonic should dominate');
  assert.ok(amp[303] > amp[202] * 4, 'and it should be the third, not the second');
});

test('the cheby mode at an even harmonic puts no offset on silence, or on a signal', () => {
  // T_n(0) is minus one for even n, so without a blocker the mode's DEFAULT setting - the
  // second harmonic - would park its output at half scale on nothing at all.
  for (const [harmonic, character] of [[2, 0.45], [4, 0.7]]) {
    const silence = run({ mode: SHAPER_INDEX.cheby, character, drive: 0, mix: 1, autogain: 0, tone: 20000 }, new Float64Array(N));
    let mean = 0;
    for (let i = 4096; i < N; i++) mean += silence[i];
    mean /= N - 4096;
    assert.ok(Math.abs(mean) < 1e-3, `harmonic ${harmonic} on silence settled at ${mean.toFixed(4)}`);

    const out = run({ mode: SHAPER_INDEX.cheby, character, drive: 0, mix: 1, autogain: 0, tone: 20000 }, sine(101, 1));
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

test('the device reports how loud its input is, on the curve\'s own axis', () => {
  const fx = new DistortProcessor(SR, 128);
  const out = new Float32Array(128);
  const input = new Float32Array(128).map((_, i) => 0.6 * Math.sin(i * 0.3));
  fx.process([input], [out], 128, { ...defaultValues(DISTORT), drive: 24 });
  assert.ok(Math.abs(fx.report().meters.level - 0.6) < 0.01, 'the peak before the drive');
  fx.process([new Float32Array(128)], [out], 128, defaultValues(DISTORT));
  assert.equal(fx.report().meters.level, 0, 'and silence is zero');
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

// ---------------------------------------------------------------------------------------------
// Version 2: the rebuilt diode, the new curves, drawn curves - and version 1 left as it was.
// ---------------------------------------------------------------------------------------------

/** A run through a given processor class and descriptor. */
function runWith(Processor, descriptor, params, input, count = N, block = 128, setup = null) {
  const fx = new Processor(SR, block);
  setup?.(fx);
  const out = new Float32Array(count);
  const full = { ...defaultValues(descriptor), ...params };
  for (let at = 0; at < count; at += block) {
    const n = Math.min(block, count - at);
    fx.process([input.subarray(at, at + n)], [out.subarray(at, at + n)], n, full);
  }
  return out;
}

test('at the default character, the curves 0.2.0 shipped are the curves it shipped', () => {
  // Written out here rather than kept as a frozen copy in the source: these are the 0.2.0
  // formulas, with v the driven, biased sample. The diode was rebuilt on purpose and is not here.
  const fold = (x) => { let p = (x + 1) * 0.25; p -= Math.floor(p); return 1 - Math.abs(p * 4 - 2); };
  const shipped = {
    soft: (v) => Math.tanh(v),
    hard: (v) => Math.max(-1, Math.min(1, v)),
    fold: (v) => fold(v),
    sine: (v) => Math.sin(v * Math.PI * 0.5),
    asym: (v) => (v >= 0 ? Math.tanh(v) : Math.tanh(v * 0.6) * 0.8),
    tube: (v) => (v >= 0 ? 1 - Math.exp(-v) : -1 + Math.exp(v * 0.7)),
    // Its default, the 2nd - plus the constant that 0.2.0's DC blocker was already taking off,
    // now taken off in the curve so that stepping between harmonics does not pop.
    cheby: (v) => Math.cos(2 * Math.acos(Math.max(-1, Math.min(1, v)))) + 1,
  };
  for (const [name, f] of Object.entries(shipped)) {
    for (const drive of [0.5, 2, 9]) {
      for (const bias of [0, 0.3]) {
        for (let k = 0; k <= 40; k++) {
          const x = -1 + k / 20;
          const got = shape(x, SHAPER_INDEX[name], drive, bias, 0.5);
          assert.ok(Math.abs(got - f(x * drive + bias)) < 1e-12, `${name} at drive ${drive} bias ${bias} on ${x}: ${got}`);
        }
      }
    }
  }
  // westcoast's second fold takes half the bias, as it always did.
  for (let k = 0; k <= 40; k++) {
    const x = -1 + k / 20;
    const want = fold(fold((x * 2 + 0.3) * 1.5) * 1.5 + 0.15);
    assert.ok(Math.abs(shape(x, SHAPER_INDEX.westcoast, 2, 0.3, 0.5) - want) < 1e-12);
  }
});

test('the curves 0.2.0 shipped keep their indexes, and the new ones come after', () => {
  SHIPPED.forEach((name, i) => assert.equal(SHAPER_MODES[i], name));
  for (const name of ['rectify', 'stairs', 'harmonics', 'wrap', 'bitflip', 'chaos']) {
    assert.ok(SHAPER_INDEX[name] >= SHIPPED.length, `${name} is appended`);
  }
});

test('the diode does not draw as soft: a harder knee and a second harmonic', () => {
  // The 0.2.0 diode bent so gently it sat within 0.05 of soft, level-matched; this one is well clear.
  const gap = Math.max(...Array.from({ length: 41 }, (_, i) => {
    const x = -1 + i / 20;
    const d = shape(x, SHAPER_INDEX.diode, 2, 0, 0.5) * autoGainFor(SHAPER_INDEX.diode, 2, 0, 0.5);
    const soft = shape(x, SHAPER_INDEX.soft, 2, 0, 0.5) * autoGainFor(SHAPER_INDEX.soft, 2, 0, 0.5);
    return Math.abs(d - soft);
  }));
  assert.ok(gap > 0.15, `the diode sits ${gap.toFixed(3)} from soft at most`);
  const [h2] = curveHarmonics(SHAPER_INDEX.diode, 2, 0, 0.5);
  assert.ok(h2 > -40, `second harmonic at ${h2.toFixed(1)} dB`);
});

test('rectify at full character is a full-wave rectifier: a sine goes up an octave', () => {
  const [h2, h3, , h5, , h7] = curveHarmonics(SHAPER_INDEX.rectify, 1, 0, 1); // character 1: full-wave
  assert.ok(h2 > -12, `a strong second harmonic, ${h2.toFixed(0)} dB against the input`);
  for (const odd of [h3, h5, h7]) assert.ok(odd < -100, 'and no odd ones at all');
});

test('stairs: smooth sine stairs at 0, hard stairs at 0.5, diagonal at 1 with nothing flat', () => {
  const at = (x, c) => shape(x, SHAPER_INDEX.stairs, 1, 0, c);
  const xs = Array.from({ length: 2001 }, (_, i) => -1 + i / 1000);
  // Hard: nine levels, -1 to 1 in quarters, and a quiet signal on the zero tread.
  assert.equal(new Set(xs.map((x) => at(x, 0.5))).size, 9);
  assert.equal(at(0.05, 0.5), 0);
  // Smooth: no jump anywhere - the largest step between neighbors is about the slope's.
  const jump = (c) => Math.max(...xs.slice(1).map((x, i) => Math.abs(at(x, c) - at(xs[i], c))));
  assert.ok(jump(0) < 0.003, `sine stairs jump ${jump(0).toFixed(4)}`);
  assert.ok(jump(0.5) > 0.2 && jump(1) > 0.1, 'hard and diagonal stairs do jump, at each edge');
  // Diagonal: nothing is flat, so a quiet signal passes (at half level), and no dead zone.
  assert.ok(Math.abs(at(0.05, 1) - 0.025) < 1e-12);
  assert.ok(xs.slice(1).every((x, i) => at(x, 1) !== at(xs[i], 1)), 'every stair slopes');
});

test('wrap: the character is how hard the tear is, not a second drive', () => {
  const at = (x, c, drive = 1) => shape(x, SHAPER_INDEX.wrap, drive, 0, c);
  // Below the tear, untouched at any character - the drive decides how often it wraps.
  for (const c of [0, 0.5, 1]) for (const x of [-0.4, 0.1, 0.45]) assert.ok(Math.abs(at(x, c) - x) < 1e-12);
  // Past the edge it comes back from the other side: a sheer drop at 1...
  assert.ok(at(1.02, 1) < -0.9, `hard: ${at(1.02, 1)}`);
  // ...a slope at 0, where it is a fold at half scale: past 0.5 it turns straight back down.
  assert.ok(Math.abs(at(0.6, 0) - 0.4) < 1e-12);
  // And at the same drive the characters really are different curves, not louder or quieter ones.
  const diff = Array.from({ length: 101 }, (_, i) => -1 + i / 50).map((x) => Math.abs(at(x, 0, 3) - at(x, 1, 3)));
  assert.ok(Math.max(...diff) > 0.5);
  // Continuous at the soft end - a slope, not a tear.
  const xs = Array.from({ length: 4001 }, (_, i) => -2 + i / 1000);
  assert.ok(Math.max(...xs.slice(1).map((x, i) => Math.abs(at(x, 0) - at(xs[i], 0)))) < 0.005);
});

test('the harmonic blend brings one more overtone in per six decibels', () => {
  const count = (drive) => curveHarmonics(SHAPER_INDEX.harmonics, drive, 0, 0.5).filter((db) => db > -80).length;
  assert.equal(count(1), 0);
  assert.ok(count(2) >= 1);
  assert.ok(count(8) > count(2));
  assert.ok(count(256) >= 6);
});

test('a drawn curve is played through, and read from -1 to 1 both ways', () => {
  // "0,1 1,0" drawn: an inverter.
  const table = new Float32Array(256).map((_, i) => 1 - i / 255);
  const drawnMode = SHAPER_MODES.length;
  assert.ok(Math.abs(shape(0.5, drawnMode, 1, 0, 0.5, table) + 0.5) < 0.01);
  const input = sine(101, 0.5);
  const out = runWith(DistortProcessor, DISTORT, { mode: drawnMode, drive: 0, autogain: 0, tone: 20000 }, input, N, 128,
    (fx) => assert.ok(fx.loadShape('mode', drawnMode, table)));
  // The oversampler delays the output a few samples; find it, then compare.
  const residual = (lag) => rms(Float64Array.from({ length: 1024 }, (_, i) => out[N / 2 + i + lag] + input[N / 2 + i]));
  const best = Math.min(...Array.from({ length: 32 }, (_, lag) => residual(lag)));
  assert.ok(best < 0.02, `what came out is the input upside down, to ${best.toFixed(4)}`);
  assert.equal(new DistortProcessor(SR, 128).loadShape('window', drawnMode, table), false, 'only the mode takes one');
});

test('the mode control takes a drawn curve past the ones it ships with', () => {
  const mode = findParam(DISTORT, 'mode');
  assert.equal(mode.takes, 'shape');
  assert.ok(mode.capacity > SHAPER_MODES.length);
});

test('a change of curve is as smooth as the signal around it, at every oversampling, however late a drawn table arrives', () => {
  // A held tone through one curve, then another: the largest step between neighboring samples
  // across the switch may be no bigger than the steady signal's own either side. Built from what
  // was heard - a crack on every curve pick - and the three things that made it: a cut-over, the
  // auto gain applied after the oversampler's delay, and a drawn slot played before its table.
  const SRATE = 48000;
  const block = 128;
  const drawn = SHAPER_MODES.length;
  const table = new Float32Array(256).map((_, i) => { const x = i / 255; return x < 0.25 ? 0.457 - 0.752 * x : x < 0.5 ? 0.269 + 0.924 * (x - 0.25) : x < 0.75 ? 0.5 + 0.924 * (x - 0.5) : 0.731 + 0.6 * (x - 0.75); });
  const tone = new Float64Array(block * 200).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 130.8 * i) / SRATE));
  const pairs = [
    [SHAPER_INDEX.cheby, drawn, 0], [SHAPER_INDEX.cheby, drawn, 3], [SHAPER_INDEX.soft, drawn, 0],
    [drawn, SHAPER_INDEX.soft, 0], [SHAPER_INDEX.cheby, SHAPER_INDEX.soft, 0], [SHAPER_INDEX.soft, SHAPER_INDEX.fold, 0],
  ];
  for (const oversample of [0, 1, 2]) {
    for (const [from, to, late] of pairs) {
      const fx = new DistortProcessor(SRATE, block);
      if (from === drawn || to !== drawn) fx.loadShape('mode', drawn, table);
      const out = new Float32Array(tone.length);
      for (let b = 0; b < 200; b++) {
        if (to === drawn && b === 100 + late) fx.loadShape('mode', drawn, table);
        fx.process([tone.subarray(b * block, (b + 1) * block)], [out.subarray(b * block, (b + 1) * block)], block,
          { ...defaultValues(DISTORT), oversample, autogain: 1, mode: b < 100 ? from : to });
      }
      const step = (a, z) => { let m = 0; for (let i = a + 1; i < z; i++) m = Math.max(m, Math.abs(out[i] - out[i - 1])); return m; };
      const S = 100 * block;
      const steady = Math.max(step(S - 4800, S), step(S + 4800, out.length));
      const at = step(S, S + 2400);
      assert.ok(at <= steady * 1.5, `${SHAPER_MODES[from] ?? 'drawn'} to ${SHAPER_MODES[to] ?? 'drawn'} at ${oversample} (table ${late} late): steps ${at.toFixed(3)} against ${steady.toFixed(3)}`);
    }
  }
});

/** A sine through Distort for a while; the second half of what comes out. */
function tail(params, { hz = 220, amplitude = 0.4, blocks = 120, block = 128 } = {}) {
  const count = blocks * block;
  const input = new Float32Array(count).map((_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / SR));
  const fx = new DistortProcessor(SR, block);
  const out = new Float32Array(count);
  for (let b = 0; b < blocks; b++) {
    fx.process([input.subarray(b * block, (b + 1) * block)], [out.subarray(b * block, (b + 1) * block)], block, { ...defaultValues(DISTORT), ...params });
  }
  return { out: out.subarray(count / 2), input: input.subarray(count / 2) };
}
const levelDb = ({ out, input }) => 20 * Math.log10(rms(out) / rms(input));

test('harmonics is as loud as what goes in at every drive, not 12 dB under it', () => {
  // It was: its even terms put an offset on the curve that the level correction counted as
  // loudness and the DC blocker then removed.
  for (const drive of [0, 12, 24, 40]) {
    const db = levelDb(tail({ mode: SHAPER_INDEX.harmonics, drive }));
    assert.ok(Math.abs(db) < 4, `harmonics at ${drive} dB of drive came out ${db.toFixed(1)} dB from the input`);
  }
});

test('with the auto gain on, every curve comes out within 6 dB of what goes in', () => {
  for (const [mode, name] of SHAPER_MODES.entries()) {
    for (const drive of [0, 12, 24]) {
      const db = levelDb(tail({ mode, drive }));
      assert.ok(Math.abs(db) < 6, `${name} at ${drive} dB of drive came out ${db.toFixed(1)} dB from the input`);
    }
  }
});

test('Character replaces the old Harmonic knob, and shows only on the curves it changes', async () => {
  const { buildPanel } = await import('./src/panel.mjs');
  assert.equal(findParam(DISTORT, 'harmonic'), null);
  assert.ok(findParam(DISTORT, 'character'));
  const shown = (mode) => buildPanel(DISTORT, { ...defaultValues(DISTORT), mode }).sections
    .flatMap((s) => s.widgets).some((w) => w.id === 'character');
  for (const name of TAKES_CHARACTER) assert.ok(shown(SHAPER_INDEX[name]), `${name} shows Character`);
  for (const name of ['hard', 'fold', 'sine']) assert.equal(shown(SHAPER_INDEX[name]), false, `${name} hides it`);
  assert.equal(shown(SHAPER_MODES.length), false, 'and so does a drawn curve');
});

test('Character is read per sample, so a signal on it moves the curve inside a block', () => {
  const block = 128;
  const fx = new DistortProcessor(SR, block);
  const input = new Float32Array(block).fill(0.3);
  const ramp = new Float32Array(block).map((_, i) => i / (block - 1));
  const out = new Float32Array(block);
  // Stairs on a constant: a coarser staircase as the character climbs moves the one level.
  for (let k = 0; k < 20; k++) fx.process([input], [out], block, { ...defaultValues(DISTORT), mode: SHAPER_INDEX.stairs, oversample: 0, autogain: 0, character: ramp });
  assert.ok(new Set(Array.from(out.slice(8), (v) => v.toFixed(3))).size > 2, 'the level steps as the character moves');
});

test('at 0.5, each curve that had a fixed setting is that setting', () => {
  for (const x of [-0.9, -0.3, 0.2, 0.7]) {
    assert.ok(Math.abs(shape(x, SHAPER_INDEX.soft, 2, 0, 0.5) - Math.tanh(2 * x)) < 1e-12, 'soft is tanh');
    const v = 2 * x;
    const asym = v >= 0 ? Math.tanh(v) : Math.tanh(v * 0.6) * 0.8;
    assert.ok(Math.abs(shape(x, SHAPER_INDEX.asym, 2, 0, 0.5) - asym) < 1e-12, 'asym is what it was');
  }
});

test('more character is more asymmetry: asym grows a second harmonic', () => {
  const [h2none] = curveHarmonics(SHAPER_INDEX.asym, 2, 0, 0);
  const [h2full] = curveHarmonics(SHAPER_INDEX.asym, 2, 0, 1);
  assert.ok(h2none < -100, 'symmetric at 0: no even harmonic');
  assert.ok(h2full > -20, `lopsided at 1: ${h2full.toFixed(0)} dB of second harmonic`);
});

test('bitflip at 0 is plain 8-bit; above it rearranges levels, but never out of their octave', () => {
  for (const x of [-0.8, -0.2, 0.1, 0.6]) {
    const eight = Math.sign(x) * Math.round(Math.abs(x) * 127) / 127;
    assert.ok(Math.abs(shape(x, SHAPER_INDEX.bitflip, 1, 0, 0) - eight) < 1e-12);
  }
  assert.ok(Math.abs(shape(0.6, SHAPER_INDEX.bitflip, 1, 0, 0.3) - shape(0.6, SHAPER_INDEX.bitflip, 1, 0, 0)) > 0.05);
  for (let k = 0; k <= 200; k++) {
    const x = -1 + k / 100;
    const y = shape(x, SHAPER_INDEX.bitflip, 1, 0, 0.73);
    const plain = Math.abs(shape(x, SHAPER_INDEX.bitflip, 1, 0, 0));
    assert.ok(plain === 0 ? y === 0 : Math.abs(y) >= plain / 2 && Math.abs(y) < plain * 2, `${x} left its octave: ${plain} became ${y}`);
  }
  assert.equal(shape(0, SHAPER_INDEX.bitflip, 1, 0, 1), 0, 'silence is silence at any character');
});

test('no two curves sound alike at their defaults', () => {
  // A decaying chord through each curve; for every pair, how much of one cancels against the other
  // at the level that cancels most. A copy cancels completely; distinct curves leave most of it.
  const block = 128;
  const blocks = 80;
  const count = block * blocks;
  const x = new Float32Array(count).map((_, i) => Math.exp(-(i % 6000) / 2500) * 0.3
    * (Math.sin((2 * Math.PI * 110 * i) / SR) + Math.sin((2 * Math.PI * 164.8 * i) / SR) + 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR)));
  const outs = SHAPER_MODES.map((_, mode) => {
    const fx = new DistortProcessor(SR, block);
    const out = new Float32Array(count);
    for (let b = 0; b < blocks; b++) fx.process([x.subarray(b * block, (b + 1) * block)], [out.subarray(b * block, (b + 1) * block)], block, { ...defaultValues(DISTORT), mode, drive: 12 });
    return out.subarray(block * 10);
  });
  const residual = (a, b) => {
    let ab = 0; let aa = 0; let bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return 10 * Math.log10(Math.max(1e-12, (bb - (ab * ab) / aa) / bb));
  };
  const shipped = new Set(SHIPPED);
  for (let i = 0; i < outs.length; i++) {
    for (let j = i + 1; j < outs.length; j++) {
      if (shipped.has(SHAPER_MODES[i]) && shipped.has(SHAPER_MODES[j])) continue; // 0.2.0's own pairs are what they are
      const r = Math.max(residual(outs[i], outs[j]), residual(outs[j], outs[i]));
      // -20: version 1's soft and hard, which nobody would mistake for each other, are -19.
      assert.ok(r > -20, `${SHAPER_MODES[i]} and ${SHAPER_MODES[j]} are ${r.toFixed(1)} dB apart - near copies`);
    }
  }
});

test('turning Character on cheby does not pop, even on silence', () => {
  // cheby's value at silence is -1, 0 or +1 by harmonic; left in the curve, stepping across
  // harmonics jumped the output by that much and the DC blocker passed the jump straight through.
  const block = 128;
  for (const amplitude of [0, 0.01]) {
    const fx = new DistortProcessor(SR, block);
    let worst = 0;
    let prev = 0;
    for (let b = 0; b < 300; b++) {
      const x = new Float32Array(block).map((_, i) => amplitude * Math.sin((2 * Math.PI * 220 * (b * block + i)) / SR));
      const out = new Float32Array(block);
      fx.process([x], [out], block, { ...defaultValues(DISTORT), mode: SHAPER_INDEX.cheby, character: Math.min(1, b / 250) });
      for (let i = 0; i < block; i++) { if (b > 20) worst = Math.max(worst, Math.abs(out[i] - prev)); prev = out[i]; }
    }
    assert.ok(worst < 0.01, `at ${amplitude}, a step of ${worst.toFixed(4)} while the knob turned`);
  }
});
