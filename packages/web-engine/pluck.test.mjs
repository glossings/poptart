// The Pluck synth: that it is a string - in tune, decaying as Decay says, its top dying sooner
// with Damping, its partials pushed sharp by Stretch, its pluck point cancelling the harmonics
// that have a node there - and that every setting stays stable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLUCK, PluckSynth } from './src/devices/pluck.mjs';
import { fft } from './src/dsp/fft.mjs';

const SR = 48000;
const B = 128;

/** Plays notes ([frame, note, velocity], velocity 0 a release) at the defaults with `over` changed. */
function play(over, notes, seconds) {
  const synth = new PluckSynth(SR);
  const values = {};
  for (const p of PLUCK.params) values[p.id] = p.id in over ? over[p.id] : p.default;
  const frames = Math.round(SR * seconds);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let at = 0; at < frames; at += B) {
    synth.setParams(values);
    synth.setBend(0);
    for (const [frame, note, velocity] of notes) {
      if (frame < at || frame >= at + B) continue;
      if (velocity > 0) synth.queueNoteOn(note, velocity, frame - at);
      else synth.queueNoteOff(note, frame - at);
    }
    const l = new Float32Array(B);
    const r = new Float32Array(B);
    synth.process(l, r, B);
    left.set(l.subarray(0, Math.min(B, frames - at)), at);
    right.set(r.subarray(0, Math.min(B, frames - at)), at);
  }
  return { left, right, synth };
}

const hzOf = (note) => 440 * 2 ** ((note - 69) / 12);
const rms = (x, from = 0, to = x.length) => {
  let e = 0;
  for (let i = Math.round(from); i < Math.round(to); i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, Math.round(to) - Math.round(from)));
};
const db = (v) => 20 * Math.log10(v + 1e-30);

/** The power spectrum of 65536 samples from `from`, Hann-windowed. */
function spectrum(x, from) {
  const n = 65536;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  return { power: (k) => re[k] ** 2 + im[k] ** 2, binHz: SR / n };
}

/** The strongest frequency within a quarter-tone-and-more of `expect`, refined between bins. */
function peakNear(x, from, expect, spread = 1.06) {
  const { power, binHz } = spectrum(x, from);
  let best = 0;
  let k0 = 0;
  for (let k = Math.floor(expect / spread / binHz); k <= Math.ceil(expect * spread / binHz); k++) {
    if (power(k) > best) { best = power(k); k0 = k; }
  }
  const a = Math.log(power(k0 - 1));
  const b = Math.log(power(k0));
  const c = Math.log(power(k0 + 1));
  return { hz: (k0 + (0.5 * (a - c)) / (a - 2 * b + c)) * binHz, power: best };
}

const cents = (a, b) => 1200 * Math.log2(a / b);

test('a note is in tune across the keyboard, at every damping and stretch', () => {
  for (const over of [{}, { damping: 1 }, { stretch: 1 }, { damping: 0.9, stretch: 0.6 }]) {
    for (const note of [28, 48, 69, 84, 100]) {
      const { left } = play({ ...over, detune: 0, decay: 10 }, [[0, note, 1]], 1.6);
      const { hz } = peakNear(left, 4800, hzOf(note));
      assert.ok(Math.abs(cents(hz, hzOf(note))) < 2, `${JSON.stringify(over)} note ${note}: ${cents(hz, hzOf(note)).toFixed(2)} cents out`);
    }
  }
});

test('the bottom of the spectrum falls sixty decibels over Decay', () => {
  for (const decay of [0.5, 3]) {
    const { left } = play({ decay, damping: 0, detune: 0 }, [[0, 48, 1]], decay + 0.3);
    const w = SR / 20;
    const start = SR * 0.05;
    const half = start + (decay / 2) * SR;
    const fell = db(rms(left, start, start + w)) - db(rms(left, half, half + w));
    assert.ok(fell > 25 && fell < 35, `half of a ${decay} s decay fell ${fell.toFixed(1)} dB, not about 30`);
  }
});

test('Release takes over from Decay when the note is let go', () => {
  const held = play({ decay: 8, release: 0.1 }, [[0, 48, 1]], 1.5).left;
  const let_ = play({ decay: 8, release: 0.1 }, [[0, 48, 1], [SR / 2, 48, 0]], 1.5).left;
  assert.ok(db(rms(held, SR, SR * 1.2)) - db(rms(let_, SR, SR * 1.2)) > 40, 'letting go did not shorten the string');
});

test('more Damping dulls the string: its top dies sooner than its bottom', () => {
  const brightness = (damping) => {
    const { left } = play({ damping, detune: 0, decay: 4 }, [[0, 48, 1]], 1.6);
    const { power, binHz } = spectrum(left, SR / 2);
    let low = 0;
    let high = 0;
    for (let k = 1; k < 32768; k++) {
      const f = k * binHz;
      if (f < 600) low += power(k);
      else if (f > 2000 && f < 8000) high += power(k);
    }
    return 10 * Math.log10(high / low);
  };
  assert.ok(brightness(0.1) - brightness(0.8) > 10, `damping 0.1 was only ${(brightness(0.1) - brightness(0.8)).toFixed(1)} dB brighter than 0.8`);
});

test('Stretch pushes the upper partials sharp of the harmonic series', () => {
  // The tenth partial, found by walking up from the fundamental a partial at a time - each one
  // looked for a step past the last, at the spacing the last two had.
  const tenth = (stretch) => {
    const { left } = play({ stretch, detune: 0, damping: 0.1, decay: 6 }, [[0, 45, 1]], 1.6);
    let last = peakNear(left, 4800, hzOf(45), 1.03).hz;
    let step = last;
    for (let k = 2; k <= 10; k++) {
      const next = peakNear(left, 4800, last + step, 1.03).hz;
      step = next - last;
      last = next;
    }
    return last / (hzOf(45) * 10);
  };
  assert.ok(Math.abs(cents(tenth(0), 1)) < 5, `unstretched, the tenth partial was ${cents(tenth(0), 1).toFixed(1)} cents off`);
  assert.ok(cents(tenth(0.8), 1) > 20, `stretched, the tenth partial was only ${cents(tenth(0.8), 1).toFixed(1)} cents sharp`);
});

test('plucking in the middle takes the even harmonics out', () => {
  const ratio = (position) => {
    const { left } = play({ position, detune: 0, damping: 0.1, decay: 6, tone: 20000 }, [[0, 45, 1]], 1.6);
    return db(Math.sqrt(peakNear(left, 2400, hzOf(45) * 2).power)) - db(Math.sqrt(peakNear(left, 2400, hzOf(45) * 3).power));
  };
  assert.ok(ratio(0.13) - ratio(0.5) > 15, `the second harmonic against the third fell only ${(ratio(0.13) - ratio(0.5)).toFixed(1)} dB at the middle`);
});

test('Detune splits the two sides apart, and at zero they are one string', () => {
  const wide = play({ detune: 20 }, [[0, 57, 1]], 1);
  const one = play({ detune: 0 }, [[0, 57, 1]], 1);
  for (let i = 0; i < one.left.length; i++) assert.equal(one.left[i], one.right[i]);
  const l = peakNear(wide.left, 2400, hzOf(57)).hz;
  const r = peakNear(wide.right, 2400, hzOf(57)).hz;
  assert.ok(Math.abs(cents(r, l) - 20) < 2, `the sides were ${cents(r, l).toFixed(1)} cents apart, not 20`);
});

test('velocity sets how hard the string is plucked, and a voice is let go when it falls silent', () => {
  const hard = play({}, [[0, 60, 1]], 0.5).left;
  const soft = play({}, [[0, 60, 0.25]], 0.5).left;
  assert.ok(Math.abs(db(rms(hard)) - db(rms(soft)) - 12) < 1, `a quarter of the velocity was ${(db(rms(hard)) - db(rms(soft))).toFixed(1)} dB down`);
  const { synth } = play({ decay: 0.2, release: 0.05 }, [[0, 60, 1], [B, 60, 0]], 1.5);
  assert.equal(synth.activeVoices, 0);
});

test('every preset, and both ends of every control, stay finite and under clipping', () => {
  const lows = Object.fromEntries(PLUCK.params.map((p) => [p.id, p.min]));
  const highs = Object.fromEntries(PLUCK.params.map((p) => [p.id, p.max]));
  highs.voices = 8;
  const notes = [[0, 24, 1], [0, 60, 1], [0, 127, 1], [SR / 4, 96, 0.8], [SR / 2, 60, 0]];
  for (const [name, over] of [...Object.entries(PLUCK.presets), ['lowest', lows], ['highest', highs]]) {
    const { left, right } = play(over, notes, 2);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${name}: not finite at ${i}`);
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    assert.ok(peak < 2, `${name}: peaked at ${peak.toFixed(2)}`);
  }
});
