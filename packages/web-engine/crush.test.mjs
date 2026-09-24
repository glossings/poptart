// The Crush effect: bit depth and sample rate, thrown away on purpose.
//
// These two used to be modes of Distort and were moved out because they are not curves: they
// exist to alias, and everything Distort does to keep a curve clean works against them. What
// has to hold is that each one does what it says at the setting it was given, that the hold
// rate is steady ACROSS blocks (a phase that restarted every hundred and twenty-eight samples
// would put a hundred-and-a-bit hertz tone under everything), and that neither produces a
// number nobody can play.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { CRUSH, CrushProcessor } from './src/devices/crush.mjs';

const SR = 48000;
const N = 4096;

const sine = (hz, amp = 1) =>
  Float32Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SR) * amp);

function run(params, input, count = N, block = 128) {
  const fx = new CrushProcessor(SR);
  const out = new Float32Array(count);
  const full = { ...defaultValues(CRUSH), ...params };
  for (let at = 0; at < count; at += block) {
    const n = Math.min(block, count - at);
    fx.process([input.subarray(at, at + n)], [out.subarray(at, at + n)], n, full);
  }
  return out;
}

test('the bit depth is how many levels are left, and few of them at two bits', () => {
  const out = run({ bits: 2, rate: 24000, mix: 1, tone: 20000 }, sine(101, 0.9));
  const levels = new Set([...out.subarray(1024, 4096)].map((v) => v.toFixed(3)));
  assert.ok(levels.size <= 12, `two bits should leave few distinct levels, found ${levels.size}`);

  // And sixteen bits is transparent enough that the levels are the signal's own.
  const clean = run({ bits: 16, rate: 24000, mix: 1, tone: 20000 }, sine(101, 0.9));
  assert.ok(new Set([...clean.subarray(1024, 4096)].map((v) => v.toFixed(3))).size > 100);
});

test('the rate is held steady across blocks, not restarted at every one', () => {
  const out = run({ bits: 16, rate: 3000, mix: 1, tone: 20000 }, sine(101, 0.6));
  // At 3 kHz into 48 kHz each value is held for about sixteen samples.
  let steps = 0;
  for (let i = 1200; i < 4096; i++) if (out[i] !== out[i - 1]) steps++;
  const held = 2896 / Math.max(1, steps);
  assert.ok(held > 8 && held < 32, `expected about sixteen samples per step, measured ${held.toFixed(1)}`);
});

test('the held steps stay flat - there is no DC blocker turning them into slopes', () => {
  const out = run({ bits: 16, rate: 2000, mix: 1, tone: 20000 }, sine(101, 0.6));
  // Inside one hold the value does not drift at all, which is the character the device is for.
  let flat = 0;
  for (let i = 2001; i < 2020; i++) if (out[i] === out[i - 1]) flat++;
  assert.ok(flat >= 15, `expected a flat step, ${flat} of 19 samples held`);
});

test('jitter smears the hold rate rather than leaving it on one number', () => {
  const steady = run({ bits: 16, rate: 3000, jitter: 0, mix: 1, tone: 20000 }, sine(101, 0.6));
  const wobbled = run({ bits: 16, rate: 3000, jitter: 1, mix: 1, tone: 20000 }, sine(101, 0.6));
  const spans = (out) => {
    const lengths = [];
    let run_ = 1;
    for (let i = 1500; i < 4000; i++) {
      if (out[i] === out[i - 1]) run_++;
      else { lengths.push(run_); run_ = 1; }
    }
    return lengths;
  };
  const spread = (xs) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  };
  assert.ok(spread(spans(wobbled)) > spread(spans(steady)), 'a jittered hold has uneven steps');
});

test('a dry mix passes the signal through, and nothing it renders is out of range', () => {
  const input = sine(101, 0.8);
  const dry = run({ bits: 1, rate: 200, mix: 0, output: 0, tone: 20000 }, input);
  for (let i = 0; i < N; i++) assert.ok(Math.abs(dry[i] - input[i]) < 1e-6, `sample ${i} was not the input`);

  for (const bits of [1, 4, 16]) {
    for (const rate of [100, 3000, 24000]) {
      const out = run({ bits, rate, jitter: 1, mix: 1, output: 12 }, sine(101, 1));
      for (let i = 0; i < N; i++) {
        assert.ok(Number.isFinite(out[i]) && Math.abs(out[i]) < 16, `${bits} bits at ${rate} Hz, sample ${i} was ${out[i]}`);
      }
    }
  }
});

test('the top of the rate range holds nothing, at every sample rate', () => {
  // A hold at 24 kHz is not the top of anything: at 48 kHz it holds every other sample, at 44.1
  // kHz it holds some samples and not others, and at 96 kHz four at a time. The top of the
  // range, which is also the default, takes every sample as it comes - only the bits apply.
  for (const rate of [44100, 48000, 96000]) {
    const fx = new CrushProcessor(rate);
    const params = defaultValues(CRUSH);
    const levels = Math.pow(2, params.bits - 1);
    const input = Float32Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * 1234 * i) / rate) * 0.8);
    const out = new Float32Array(N);
    for (let at = 0; at < N; at += 128) {
      fx.process([input.subarray(at, at + 128)], [out.subarray(at, at + 128)], 128, params);
    }
    for (let i = 0; i < N; i++) {
      const expected = Math.fround(Math.round(input[i] * levels) / levels);
      assert.equal(out[i], expected, `at ${rate} Hz, sample ${i} was held rather than taken`);
    }
  }
});
