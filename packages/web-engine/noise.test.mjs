// The Noise synth: ten colors of noise per voice.
//
// What has to hold: the five spectral colors have the slopes their names promise and play at
// the same loudness, so changing color is a change of tone and not of level; the clocked colors
// follow the note they are played at; Width really is the difference between one stream and
// two; and no color at any setting produces a number nobody can play.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { NOISE, NOISE_COLORS, NoiseSynth } from './src/devices/noise.mjs';

const SR = 48000;
const BLOCK = 128;

/** Renders one held note, with the envelope opened straight to full. */
function render(params, { note = 60, frames = SR / 2, offAt = null } = {}) {
  const synth = new NoiseSynth(SR);
  const values = { ...defaultValues(NOISE), 'ampenv.attack': 0, 'ampenv.decay': 0, 'ampenv.sustain': 1, level: 1, ...params };
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let at = 0; at < frames; at += BLOCK) {
    synth.setParams(values);
    synth.setBend(0);
    if (at === 0) synth.queueNoteOn(note, 1, 0);
    if (offAt !== null && at <= offAt && offAt < at + BLOCK) synth.queueNoteOff(note, offAt - at);
    synth.process(L.subarray(at, at + BLOCK), R.subarray(at, at + BLOCK), BLOCK);
  }
  return { L, R, synth };
}

const rms = (x, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return Math.sqrt(e / (to - from));
};

/** Average power in decibels over a band, from windowed DFT bins - slow, exact, plenty for a test. */
function bandDb(x, lo, hi) {
  const N = 2048;
  let e = 0;
  let n = 0;
  for (let start = 0; start + N <= x.length; start += N) {
    for (let f = lo; f <= hi; f *= 1.1) {
      const k = Math.round((f * N) / SR);
      let re = 0;
      let im = 0;
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
        re += x[start + i] * w * Math.cos((2 * Math.PI * k * i) / N);
        im -= x[start + i] * w * Math.sin((2 * Math.PI * k * i) / N);
      }
      e += re * re + im * im;
      n++;
    }
  }
  return 10 * Math.log10(e / n);
}

test('the spectral colors slope the way their names say, a decade at a time', () => {
  // dB per decade: pink falls 3 dB an octave, brown 6, blue rises 3, violet 6.
  const expected = { white: 0, pink: -10, brown: -20, blue: 10, violet: 20 };
  for (const [name, slope] of Object.entries(expected)) {
    const { L } = render({ color: NOISE_COLORS.indexOf(name) });
    const measured = bandDb(L, 1800, 2200) - bandDb(L, 180, 220);
    assert.ok(Math.abs(measured - slope) < 2, `${name}: ${measured.toFixed(1)} dB a decade, expected ${slope}`);
  }
});

test('the spectral colors play at the loudness white does', () => {
  const white = rms(render({ color: 0 }).L, 4800);
  for (const name of ['pink', 'brown', 'blue', 'violet']) {
    const level = rms(render({ color: NOISE_COLORS.indexOf(name) }).L, 4800);
    const db = 20 * Math.log10(level / white);
    assert.ok(Math.abs(db) < 2.5, `${name} is ${db.toFixed(1)} dB from white`);
  }
});

/** How many times a held output changes value in a span: one per step of a clocked color. */
function changes(x, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i] !== x[i - 1]) n++;
  return n;
}

test('the clocked colors run at the note they are played at, and Pitch moves them', () => {
  // Stepped with no glide holds each level for a whole clock period. The DC blocker leans every
  // held step slightly, so this counts jumps bigger than the lean.
  const steps = (params, note) => {
    const { L } = render({ color: NOISE_COLORS.indexOf('stepped'), character: 0, width: 0, ...params }, { note, frames: SR });
    let n = 0;
    for (let i = 4801; i < SR; i++) if (Math.abs(L[i] - L[i - 1]) > 0.01) n++;
    return n / ((SR - 4801) / SR);
  };
  const at60 = steps({}, 60);
  assert.ok(Math.abs(at60 - 261.6) < 15, `note 60 should step about 262 times a second, measured ${at60.toFixed(0)}`);
  const octave = steps({}, 72);
  assert.ok(Math.abs(octave / at60 - 2) < 0.1, `an octave up should step twice as often, ratio ${(octave / at60).toFixed(2)}`);
  const pitched = steps({ pitch: 12 }, 60);
  assert.ok(Math.abs(pitched / at60 - 2) < 0.1, `Pitch +12 should double the rate, ratio ${(pitched / at60).toFixed(2)}`);
});

test('the digital color repeats a short sequence above the middle of Character, and not below it', () => {
  // The short sequence is 93 steps long, so at a known clock its period is exact.
  const note = 69; // 440 Hz: 93 steps = 0.211 s
  const period = Math.round((93 / 440) * SR);
  const repeats = (character) => {
    const { L } = render({ color: NOISE_COLORS.indexOf('digital'), character, width: 0, tone: 20000 }, { note, frames: SR });
    // Compare one period with the next, sign for sign: the DC blocker moves levels, not signs.
    let same = 0;
    const from = 6000;
    for (let i = from; i < from + period; i++) if (Math.sign(L[i]) === Math.sign(L[i + period])) same++;
    return same / period;
  };
  assert.ok(repeats(0.8) > 0.97, `the short sequence should repeat every 93 steps (${repeats(0.8).toFixed(3)})`);
  assert.ok(repeats(0.2) < 0.8, `the long sequence should not (${repeats(0.2).toFixed(3)})`);
});

test('Width at zero is the same noise on both sides, and at one two unrelated ones', () => {
  const mono = render({ color: 0, width: 0 });
  for (let i = 0; i < mono.L.length; i++) assert.equal(mono.L[i], mono.R[i]);
  const wide = render({ color: 0, width: 1 });
  let c = 0;
  for (let i = 0; i < wide.L.length; i++) c += wide.L[i] * wide.R[i];
  const corr = c / (rms(wide.L) * rms(wide.R) * wide.L.length);
  assert.ok(Math.abs(corr) < 0.05, `the two sides should be uncorrelated, correlation ${corr.toFixed(3)}`);
});

test('velvet and crackle get denser as Character rises', () => {
  for (const name of ['velvet', 'crackle']) {
    const count = (character) => {
      const { L } = render({ color: NOISE_COLORS.indexOf(name), character, width: 0 }, { frames: SR });
      let n = 0;
      for (let i = 1; i < L.length; i++) if (Math.abs(L[i]) > 0.02 && Math.abs(L[i - 1]) <= 0.02) n++;
      return n;
    };
    assert.ok(count(0.7) > count(0.2) * 3, `${name} should have many more events at 0.7 than at 0.2`);
  }
});

test('a released note dies away and frees its voice', () => {
  const { L, synth } = render({ color: 1, 'ampenv.release': 0.05 }, { frames: SR / 2, offAt: 4800 });
  assert.ok(rms(L, 0, 4800) > 0.1, 'the note should sound while it is held');
  assert.ok(rms(L, 4800 + SR * 0.1, SR / 2) < 1e-6, 'and be silent once its release has run');
  assert.equal(synth.activeVoices, 0);
});

test('no color plays anything that is not a number, at either end of every control', () => {
  for (let color = 0; color < NOISE_COLORS.length; color++) {
    for (const edge of [0, 1]) {
      const params = { color };
      for (const p of NOISE.params) if (!p.options && p.id !== 'voices') params[p.id] = edge ? p.max : p.min;
      params['ampenv.sustain'] = 1;
      params.level = 1;
      const { L, R } = render(params, { frames: 9600, note: edge ? 127 : 0 });
      for (let i = 0; i < L.length; i++) {
        assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${NOISE_COLORS[color]} at the ${edge ? 'top' : 'bottom'}: sample ${i}`);
        assert.ok(Math.abs(L[i]) < 8, `${NOISE_COLORS[color]} at the ${edge ? 'top' : 'bottom'} ran away: ${L[i]}`);
      }
    }
  }
});
