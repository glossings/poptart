// Voice: a pitch shifter for one line at a time. Driven with a voice-shaped signal - a pulse train,
// a fundamental with its harmonics falling away - because that is what it is for: a pure sine has
// no pulse to cut grains at, and no shifter of this kind moves one cleanly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { VOICE, VOICE_LATENCY_SEC, VoiceProcessor } from './src/devices/voice.mjs';

const SR = 48000;

function pulses(freq, seconds, amp = 0.12) {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let h = 1; h <= 20; h++) v += Math.cos((2 * Math.PI * h * freq * i) / SR) / h;
    out[i] = amp * v;
  }
  return out;
}

/** A vowel: the same pulse train, its harmonics shaped by one resonance - the thing a formant is. */
function vowel(freq, seconds, peakHz, amp = 0.1) {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let h = 1; h * freq < 8000; h++) v += Math.cos((2 * Math.PI * h * freq * i) / SR) / (1 + ((h * freq - peakHz) / 250) ** 2);
    out[i] = amp * v;
  }
  return out;
}

function run(input, pitch, formant) {
  const fx = new VoiceProcessor(SR);
  const out = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += 128) {
    const n = Math.min(128, input.length - at);
    const x = input.subarray(at, at + n);
    const o = [new Float32Array(n), new Float32Array(n)];
    fx.process([x, x], o, n, { pitch: [pitch], formant: [formant] });
    out.set(o[0], at);
  }
  return out;
}

/** The period of a stretch of signal, in samples: the first strong dip of the normalized difference. */
function periodOf(sig, from) {
  const W = 2048;
  let run = 0;
  const cm = [1];
  for (let tau = 1; tau <= 1000; tau++) {
    let d = 0;
    for (let j = from; j < from + W; j++) d += (sig[j] - sig[j + tau]) ** 2;
    run += d;
    cm[tau] = (d * tau) / run;
  }
  for (let t = 40; t <= 1000; t++) {
    if (cm[t] < 0.2) {
      while (cm[t + 1] < cm[t]) t += 1;
      return t;
    }
  }
  return NaN;
}

const rms = (sig, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += sig[i] * sig[i];
  return Math.sqrt(s / (to - from));
};

test('the descriptor says how late it is, and it is late enough to compensate', () => {
  assert.equal(VOICE.latencySec, VOICE_LATENCY_SEC);
  // Under the scheduler's 100 ms early-send budget, with room to spare.
  assert.ok(VOICE.latencySec <= 0.06);
});

test('it moves the pitch by the interval asked for, across the range', () => {
  const input = pulses(220, 1);
  for (const pitch of [-24, -12, -5, 0, 7, 12, 24]) {
    const out = run(input, pitch, 0);
    const hz = SR / periodOf(out, 24000);
    const want = 220 * 2 ** (pitch / 12);
    // Within a percent: the period is measured to a whole sample, which at 880 Hz is that much.
    assert.ok(Math.abs(hz / want - 1) < 0.01, `pitch ${pitch}: ${hz.toFixed(1)} Hz, want ${want.toFixed(1)}`);
  }
});

test('at no shift it gives back close to what it was given, late by its delay', () => {
  const input = pulses(220, 1);
  const out = run(input, 0, 0);
  // The marks sit on the pulses, so the delay is the declared one to within half a period.
  const D = Math.round(VOICE_LATENCY_SEC * SR);
  let best = Infinity;
  for (let lag = D - 120; lag <= D + 120; lag++) {
    let err = 0;
    for (let i = 20000; i < 30000; i++) err += (out[i] - input[i - lag]) ** 2;
    best = Math.min(best, Math.sqrt(err / 10000));
  }
  // Not exact: the marks sit on whole samples and the period is fractional, so neighboring grains
  // are a fraction of a sample out with each other - a residual some 25 dB down.
  assert.ok(best < 0.1 * rms(input, 20000, 30000), `the unshifted output is not the input (error ${best})`);
});

test('the level holds within a few dB whichever way it shifts', () => {
  const input = pulses(220, 1);
  const level = rms(input, 24000, 48000);
  for (const [pitch, formant] of [[12, 0], [-12, 0], [7, 0], [0, 6], [0, -6]]) {
    const db = 20 * Math.log10(rms(run(input, pitch, formant), 24000, 48000) / level);
    assert.ok(Math.abs(db) < 4, `pitch ${pitch} formant ${formant}: ${db.toFixed(1)} dB`);
  }
});

test('the formant moves the brightness and leaves the pitch alone', () => {
  const input = vowel(220, 1, 1000);
  // How bright: the average step between samples against the average level, which rises with
  // where the energy sits in the spectrum.
  const brightness = (sig) => {
    let step = 0;
    let level = 0;
    for (let i = 24001; i < 48000; i++) {
      step += Math.abs(sig[i] - sig[i - 1]);
      level += Math.abs(sig[i]);
    }
    return step / level;
  };
  const down = run(input, 0, -12);
  const flat = run(input, 0, 0);
  const up = run(input, 0, 12);
  for (const [name, sig] of [['down', down], ['up', up]]) {
    const hz = SR / periodOf(sig, 24000);
    assert.ok(Math.abs(hz / 220 - 1) < 0.01, `formant ${name} moved the pitch to ${hz.toFixed(1)} Hz`);
  }
  const [b0, b1, b2] = [down, flat, up].map(brightness);
  assert.ok(b2 > b1 * 1.3 && b1 > b0 * 1.3, `brightness did not follow the formant: ${b0.toFixed(3)} / ${b1.toFixed(3)} / ${b2.toFixed(3)}`);
});

test('silence in is silence out, and a bad sample does not stick', () => {
  const quiet = run(new Float32Array(SR / 2), 7, 3);
  assert.equal(rms(quiet, 0, quiet.length), 0);
  const bad = pulses(220, 0.5);
  bad[1000] = NaN;
  const out = run(bad, 0, 0);
  assert.ok(out.slice(-4800).every(Number.isFinite), 'the device stayed broken after a NaN');
});
