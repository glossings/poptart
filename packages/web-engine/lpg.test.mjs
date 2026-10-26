// The LPG effect: a level and a lowpass opened together through a slow, uneven response.
//
// What has to hold: open, it is out of the way; closed, it is silent; a routed note strikes it
// open and it closes by itself, slower at the end of the close than at the start, and duller as
// it closes - which is the whole reason to use one instead of an envelope on a level.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { LPG, LPG_MODES, LpgProcessor } from './src/devices/lpg.mjs';

const SR = 48000;
const BLOCK = 128;

const sines = (frames, freqs, amp = 0.4) =>
  Float32Array.from({ length: frames }, (_, i) => freqs.reduce((s, f) => s + Math.sin((2 * Math.PI * f * i) / SR) * amp, 0));

/** Runs the gate over an input, with strikes at the given frames. */
function run(params, input, strikes = []) {
  const fx = new LpgProcessor(SR);
  const full = { ...defaultValues(LPG), ...params };
  const out = new Float32Array(input.length);
  const outR = new Float32Array(input.length);
  // The engine says a route is set before any note on it arrives (setNoteRoute), as it does here.
  if (strikes.length) fx.setNoteRoute(true);
  let next = 0;
  for (let at = 0; at < input.length; at += BLOCK) {
    while (next < strikes.length && strikes[next] < at + BLOCK) {
      fx.noteOn(60, 1, strikes[next] / SR);
      next++;
    }
    const inp = input.subarray(at, at + BLOCK);
    fx.process([inp, inp], [out.subarray(at, at + BLOCK), outR.subarray(at, at + BLOCK)], BLOCK, full, null, at / SR);
  }
  return out;
}

const rms = (x, from, to) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return Math.sqrt(e / (to - from));
};

test('fully open, the gate passes a tone through at its own level', () => {
  const input = sines(SR / 4, [220]);
  const out = run({ level: 1 }, input);
  const ratio = rms(out, 4800, SR / 4) / rms(input, 4800, SR / 4);
  assert.ok(Math.abs(ratio - 1) < 0.02, `expected unity, measured ${ratio.toFixed(3)}`);
});

test('closed, it is silent', () => {
  const out = run({ level: 0 }, sines(SR / 4, [220]));
  assert.ok(rms(out, 0, SR / 4) < 1e-6);
});

test('a routed note strikes it open, and it closes again on its own', () => {
  const input = sines(SR, [220]);
  const out = run({ decay: 0.3 }, input, [2400]);
  assert.ok(rms(out, 0, 2400) < 1e-6, 'before the strike, with notes routed in, it rests closed');
  const peak = rms(out, 2400 + 240, 2400 + 960);
  assert.ok(peak > 0.15, `the strike should open it most of the way (rms ${peak.toFixed(3)})`);
  assert.ok(rms(out, SR - 4800, SR) < peak * 0.05, 'a second later it should have closed');
});

test('a longer decay takes longer to close', () => {
  const input = sines(SR, [220]);
  const short = run({ decay: 0.1 }, input, [0]);
  const long = run({ decay: 1 }, input, [0]);
  assert.ok(rms(long, 9600, 14400) > rms(short, 9600, 14400) * 4);
});

test('the close slows as it goes, as the element darkens', () => {
  // The vca mode alone, on a steady tone, reads the element's own curve off the level. A plain
  // exponential would take as long to fall from a half to a quarter as from full to a half.
  const input = Float32Array.from({ length: SR * 2 }, () => 0.5);
  const fx = new LpgProcessor(SR);
  const full = { ...defaultValues(LPG), mode: LPG_MODES.indexOf('vca'), decay: 1 };
  const level = [];
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  fx.noteOn(60, 1, 0);
  for (let at = 0; at < input.length; at += BLOCK) {
    const inp = input.subarray(at, at + BLOCK);
    fx.process([inp, inp], [outL, outR], BLOCK, full, null, at / SR);
    // The gain is the element squared, so its square root is the element.
    for (let i = 0; i < BLOCK; i++) level.push(Math.sqrt(outL[i] / 0.5));
  }
  const top = Math.max(...level);
  const when = (frac) => level.findIndex((v, i) => i > level.indexOf(top) && v <= top * frac);
  const first = when(0.5) - level.indexOf(top);
  const second = when(0.25) - when(0.5);
  assert.ok(second > first * 1.2, `half to a quarter took ${second} samples, full to half ${first}`);
});

test('as it closes, the top goes before the bottom', () => {
  // A low tone and a high one together: late in the close the high one has gone much further.
  const lowOnly = run({ decay: 0.5 }, sines(SR, [150]), [0]);
  const highOnly = run({ decay: 0.5 }, sines(SR, [6000]), [0]);
  const early = [rms(lowOnly, 480, 1440), rms(highOnly, 480, 1440)];
  const late = [rms(lowOnly, 14400, 19200), rms(highOnly, 14400, 19200)];
  const brightEarly = early[1] / early[0];
  const brightLate = late[1] / late[0];
  assert.ok(brightLate < brightEarly * 0.5, `high/low was ${brightEarly.toFixed(2)} early and ${brightLate.toFixed(2)} late`);
});

test('the vca mode leaves the tone alone, and the lowpass mode leaves the level of a low tone alone', () => {
  const half = { level: 0.5 };
  const high = sines(SR / 4, [6000]);
  const low = sines(SR / 4, [100]);
  const vcaHigh = rms(run({ ...half, mode: 1 }, high), 4800, SR / 4) / rms(high, 4800, SR / 4);
  const vcaLow = rms(run({ ...half, mode: 1 }, low), 4800, SR / 4) / rms(low, 4800, SR / 4);
  assert.ok(Math.abs(vcaHigh - vcaLow) < 0.02, `vca should treat both tones alike (${vcaHigh.toFixed(3)} vs ${vcaLow.toFixed(3)})`);
  const lpLow = rms(run({ ...half, mode: 2 }, low), 4800, SR / 4) / rms(low, 4800, SR / 4);
  assert.ok(Math.abs(lpLow - 1) < 0.05, `lowpass alone should pass a low tone at its level (${lpLow.toFixed(3)})`);
});

test('nothing at the ends of the controls plays a number nobody can play', () => {
  const input = sines(9600, [80, 9000], 0.8);
  for (const edge of [0, 1]) {
    for (let mode = 0; mode < LPG_MODES.length; mode++) {
      const params = { mode };
      for (const p of LPG.params) if (!p.options) params[p.id] = edge ? p.max : p.min;
      const out = run(params, input, [0, 4000, 4001]);
      // +24 dB of output on a resonant peak is loud, not a runaway: it has to stay finite and bounded.
      for (const v of out) assert.ok(Number.isFinite(v) && Math.abs(v) < 400);
    }
  }
});
