// The Voice effect: a pitch shifter for one voice at a time, quick enough to play through.
//
// Shift is spectral - it hears a whole 120 ms window before it can say anything - which is what
// lets it move a chord or a full mix cleanly. A single voice needs much less: find its pitch
// period, cut it into grains one period apart, and lay those grains down closer together (higher)
// or further apart (lower). Each grain keeps the shape of the voice's resonances, so the formants
// stay put on their own; playing a grain back faster or slower is what moves them. This is
// pitch-synchronous overlap-add, and it needs to hear only a couple of periods: 50 ms here, which
// is low enough for the scheduler to play the track's notes early by (latencySec).
//
// It is for one pitched line - a vocal, a lead, a bass. A chord has no single period to find, and
// comes out rough; that is Shift's job.
//
// How it runs, per sample:
//   - the input goes into a ring, and a mono copy averaged four samples at a time into a smaller
//     one, which the pitch tracker reads every HOP samples (YIN: the input against delayed copies
//     of itself, normalized, first dip under the threshold)
//   - analysis marks step through the input one period apart; each grain is cut at the mark
//     nearest to where its output lands minus the delay, so neighboring grains are always whole
//     periods apart in the input and add up in phase
//   - a grain is two periods long, Hann-windowed, and written ahead into an output ring; output
//     marks are a period apart divided by the pitch ratio
//   - the level is held by sqrt(formant / pitch ratio): shifted up, there are more pulses a second,
//     each as loud as before; down, fewer. Unshifted it is exactly 1, and the grains add back up to
//     the input itself
//
// Translated line for line in osc-engine/native/devices/own/voice.cc, and held to it by
// native-device-parity.test.mjs: change one, change both.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';

/** How late the output is, in seconds, and so what the scheduler plays notes early by. */
export const VOICE_LATENCY_SEC = 0.05;

export const VOICE = defineDevice({
  id: 'Voice',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-voice',
  description: 'A pitch shifter for a single voice or line, with its own formant control - quick enough to play through.',
  channels: { in: 2, out: 2 },
  latencySec: VOICE_LATENCY_SEC,
  // Both a-rate, so a signal can be patched onto them - `.param("Pitch", lfo(...))` is a vibrato.
  // The processor reads them once a block, as Shift does.
  params: [
    { id: 'pitch', name: 'Pitch', min: -24, max: 24, default: 0, unit: 'st',
      description: 'Transposition in semitones. Whole numbers are the musical intervals; in between is a detune.' },
    { id: 'formant', name: 'Formant', min: -12, max: 12, default: 0, unit: 'st',
      description: 'Moves the resonances without moving the pitch: up for a smaller throat, down for a bigger one.' },
  ],
});

/** Samples averaged into one for the pitch tracker. */
const DECIMATE = 4;
/** How often the pitch is measured, in samples. */
const HOP = 256;
/** A normalized dip under this is a pitch. */
const YIN_THRESHOLD = 0.15;
/** With no dip under the threshold, the best one still counts as pitched under this. */
const YIN_VOICED = 0.35;
/** The highest pitch tracked, in hertz. */
const MAX_PITCH_HZ = 1000;

export class VoiceProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // The delay, and the longest period it leaves room for: a grain is cut up to half a period
    // past its mark, reads a period either side of that, and is placed up to two periods ahead.
    this.delay = Math.floor(VOICE_LATENCY_SEC * sampleRate + 0.5);
    this.maxPeriod = Math.floor(this.delay / 4);
    this.minPeriod = Math.ceil(sampleRate / MAX_PITCH_HZ);
    this.unvoiced = Math.floor(this.maxPeriod / 2);
    this.reach = 2 * this.maxPeriod;
    let size = 1024;
    while (size < 4 * this.delay + 4 * this.maxPeriod + 1024) size *= 2;
    this.mask = size - 1;
    this.input = [new Float64Array(size), new Float64Array(size)];
    this.acc = [new Float64Array(size), new Float64Array(size)];
    this.dsMask = size / DECIMATE - 1;
    this.ds = new Float64Array(size / DECIMATE);
    this.lags = Math.floor(this.maxPeriod / DECIMATE);
    this.cm = new Float64Array(this.lags + 1);
    this.reset();
  }

  reset() {
    for (const b of this.input) b.fill(0);
    for (const b of this.acc) b.fill(0);
    this.ds.fill(0);
    this.n = 0;
    this.m = 0;
    this.dsSum = 0;
    this.period = this.unvoiced;
    this.nextMark = 0;
    this.anaMark = 0;
    this.anaStarted = false;
  }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const ratio = Math.pow(2, at(params.pitch, 0) / 12);
    const formant = Math.pow(2, at(params.formant, 0) / 12);
    const g = Math.sqrt(formant / ratio);
    const mask = this.mask;
    for (let i = 0; i < count; i++) {
      this.write(inL ? inL[i] : 0, inR ? inR[i] : 0);
      while (this.nextMark <= this.n + this.reach) {
        this.grain(this.nextMark, formant);
        this.nextMark += this.period / ratio;
      }
      const k = this.n & mask;
      outL[i] = this.acc[0][k] * g;
      if (outR !== outL) outR[i] = this.acc[1][k] * g;
      this.acc[0][k] = 0;
      this.acc[1][k] = 0;
      this.n += 1;
    }
    if (count > 0 && !Number.isFinite(outL[count - 1])) this.reset();
  }

  /** One input frame into the ring, and the pitch tracker's copy. */
  write(l, r) {
    const k = this.n & this.mask;
    this.input[0][k] = l;
    this.input[1][k] = r;
    this.dsSum += (l + r) * 0.5;
    if (this.n % DECIMATE === DECIMATE - 1) {
      this.ds[this.m & this.dsMask] = this.dsSum / DECIMATE;
      this.m += 1;
      this.dsSum = 0;
    }
    if (this.n % HOP === HOP - 1) this.detect();
  }

  /** The pitch period of the latest input, in samples, or the unpitched grain where there is none. */
  detect() {
    const L = this.lags;
    const W = L;
    const base = this.m - 2 * L;
    const ds = this.ds;
    const dm = this.dsMask;
    let energy = 0;
    for (let j = 0; j < 2 * L; j++) {
      const v = ds[(base + j) & dm];
      energy += v * v;
    }
    if (energy < 1e-8 * 2 * L) {
      this.period = this.unvoiced;
      return;
    }
    const cm = this.cm;
    cm[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= L; tau++) {
      let d = 0;
      for (let j = 0; j < W; j++) {
        const diff = ds[(base + j) & dm] - ds[(base + j + tau) & dm];
        d += diff * diff;
      }
      running += d;
      cm[tau] = running > 0 ? (d * tau) / running : 1;
    }
    const lo = Math.max(2, Math.floor(this.minPeriod / DECIMATE));
    let tau = -1;
    for (let t = lo; t <= L; t++) {
      if (cm[t] < YIN_THRESHOLD) {
        while (t + 1 <= L && cm[t + 1] < cm[t]) t += 1;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = lo;
      for (let t = lo + 1; t <= L; t++) if (cm[t] < cm[best]) best = t;
      if (!(cm[best] < YIN_VOICED)) {
        this.period = this.unvoiced;
        return;
      }
      tau = best;
    }
    // Between lags: the bottom of the parabola through the dip and its neighbors.
    let exact = tau;
    if (tau > 1 && tau < L) {
      const a = cm[tau - 1];
      const b = cm[tau];
      const c = cm[tau + 1];
      const den = a - 2 * b + c;
      if (den > 0) exact = tau + Math.max(-1, Math.min(1, (0.5 * (a - c)) / den));
    }
    this.period = Math.max(this.minPeriod, Math.min(this.maxPeriod, exact * DECIMATE));
  }

  /**
   * The pitch pulse nearest `x0`: the highest point of the input within a quarter period of it.
   * A grain has to be CENTERED on a pulse - one cut between two carries both at half weight, and
   * laid down further apart it still says the old pitch. The sum of the channels, not its size,
   * so every mark lands on the same side of the waveform.
   */
  peak(x0, P) {
    const half = Math.floor(P / 4);
    const c = Math.floor(x0 + 0.5);
    const mask = this.mask;
    const in0 = this.input[0];
    const in1 = this.input[1];
    let best = c - half;
    let bestV = -Infinity;
    for (let i = c - half; i <= c + half; i++) {
      const k = i & mask;
      const v = in0[k] + in1[k];
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    return best;
  }

  /** One grain, for the output mark `s`, laid into the output ring. */
  grain(s, formant) {
    const P = this.period;
    const target = s - this.delay;
    if (!this.anaStarted) {
      this.anaMark = this.peak(target, P);
      this.anaStarted = true;
    }
    // The marks step a period at a time, each one settled onto its pulse; the grain takes
    // whichever of the two either side of where it belongs is nearer.
    let next = this.peak(this.anaMark + P, P);
    while (next <= target) {
      this.anaMark = next;
      next = this.peak(this.anaMark + P, P);
    }
    const a = target - this.anaMark <= next - target ? this.anaMark : next;
    const h = P / formant;
    const mask = this.mask;
    const in0 = this.input[0];
    const in1 = this.input[1];
    const acc0 = this.acc[0];
    const acc1 = this.acc[1];
    const from = Math.max(Math.ceil(s - h), this.n);
    const to = Math.floor(s + h);
    for (let k = from; k <= to; k++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (k - s)) / h);
      const x = a + (k - s) * formant;
      const i0 = Math.floor(x);
      const frac = x - i0;
      const j0 = i0 & mask;
      const j1 = (i0 + 1) & mask;
      const o = k & mask;
      acc0[o] += w * (in0[j0] + (in0[j1] - in0[j0]) * frac);
      acc1[o] += w * (in1[j0] + (in1[j1] - in1[j0]) * frac);
    }
  }
}
