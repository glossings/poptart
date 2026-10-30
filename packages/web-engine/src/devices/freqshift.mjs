// The FreqShift effect: every partial moved by the same number of hertz, rather than by the same
// ratio the way a pitch shifter moves them.
//
// Adding a fixed amount to every frequency breaks the harmonic series apart - a few hertz is a
// slow phasing wobble, tens of hertz turn a pitched sound metallic and bell-like, hundreds make
// it clangorous. The signal is split into two copies a quarter-cycle apart at every frequency (a
// Hilbert pair, built from two chains of allpasses) and those are ring-modulated by a sine and a
// cosine; summing the products one way keeps only the upper sideband, the other way only the
// lower. Feedback runs the shifted signal round again, so each pass moves it further: the
// endlessly rising or falling spiral.
//
// One signed Freq knob says both how far and which way, as every hardware and plugin shifter
// does: zero in the middle, up to the right, down to the left, on a curve that is fine near zero
// (a shift of 2 Hz matters as much as one of 2 kHz) and still reaches thousands of hertz at the
// ends. Wide sends the right channel the other way.
//
// Version 2. Version 1 had an unsigned Freq on a log curve, which cannot pass through zero, so
// the sign lived in an up/down/split Direction menu; `migrate` reads those states.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';

export const FREQSHIFT = defineDevice({
  id: 'FreqShift',
  kind: 'fx',
  version: 2,
  license: 'AGPL-3.0-only',
  processor: 'poptart-freqshift',
  description: 'A frequency shifter: moves every partial by the same number of hertz, which makes a pitched sound inharmonic.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'freq', name: 'Freq', min: -5000, max: 5000, default: 50, unit: 'Hz', curve: 'sym', curveExp: 3, decimals: 1,
      description: 'How far every partial moves, and which way: up to the right of center, down to the left. A few hertz is a slow phasing wobble; tens to hundreds turn a pitched sound metallic.' },
    { id: 'wide', name: 'Wide', min: 0, max: 1, default: 0, ui: 'toggle', rate: 'k',
      description: 'Moves the right channel the other way from the left, so the two sides pull apart.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 0.95, default: 0,
      description: 'Sends the shifted signal round again, so each repeat moves further: a rising or falling spiral.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1,
      description: 'The shifted signal against the dry one. In between, the two beat against each other.' },
  ],
  migrate(params, from) {
    if (from < 2) {
      // Direction 0 was up, 1 down, 2 split (left up, right down).
      const direction = Math.round(Number(params.direction) || 0);
      const freq = Number(params.freq);
      delete params.direction;
      if (Number.isFinite(freq)) params.freq = direction === 1 ? -freq : freq;
      params.wide = direction === 2 ? 1 : 0;
    }
    return params;
  },
});

// Two chains of second-order allpasses whose outputs stay 90 degrees apart from about 20 Hz to
// within a few hundred hertz of Nyquist at 44.1 and 48 kHz. Each stage is
// y[n] = a^2 (x[n] + y[n-2]) - x[n-2]; the first chain is read one sample late.
const CHAIN_I = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737].map((a) => a * a);
const CHAIN_Q = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278].map((a) => a * a);

class AllpassChain {
  constructor(coefficients) {
    this.k = coefficients;
    this.x1 = new Float64Array(coefficients.length);
    this.x2 = new Float64Array(coefficients.length);
    this.y1 = new Float64Array(coefficients.length);
    this.y2 = new Float64Array(coefficients.length);
  }

  reset() { this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0); }

  next(x) {
    let v = x;
    for (let s = 0; s < this.k.length; s++) {
      const y = this.k[s] * (v + this.y2[s]) - this.x2[s];
      this.x2[s] = this.x1[s]; this.x1[s] = v;
      this.y2[s] = this.y1[s]; this.y1[s] = y;
      v = y;
    }
    return v;
  }
}

/** One channel's Hilbert pair: a sample in, its in-phase and quadrature copies out. */
export class Hilbert {
  constructor() {
    this.i = new AllpassChain(CHAIN_I);
    this.q = new AllpassChain(CHAIN_Q);
    this.iLate = 0;
  }

  reset() { this.i.reset(); this.q.reset(); this.iLate = 0; }

  /** Returns [inPhase, quadrature] for `x`, written into `out`. */
  next(x, out) {
    out[0] = this.iLate;
    out[1] = this.q.next(x);
    this.iLate = this.i.next(x);
    return out;
  }
}

export class FreqShiftProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.pairs = [new Hilbert(), new Hilbert()];
    this.fb = [0, 0];
    this.phase = 0;
    this.iq = [0, 0];
  }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    // The sign of the frequency is the direction: the oscillator runs backwards for a shift
    // down, which keeps the lower sideband. Wide runs the right channel's the other way.
    const signR = at(params.wide, 0) >= 0.5 ? -1 : 1;
    const sr = this.sampleRate;
    for (let i = 0; i < count; i++) {
      this.phase += at(params.freq, i) / sr;
      this.phase -= Math.floor(this.phase);
      const w = 2 * Math.PI * this.phase;
      const c = Math.cos(w);
      const s = Math.sin(w);
      const feedback = at(params.feedback, i);
      const mix = at(params.mix, i);
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const wetL = this.shift(0, l, c, s, feedback);
      const wetR = this.shift(1, r, c, s * signR, feedback);
      outL[i] = l + (wetL - l) * mix;
      if (outR !== outL) outR[i] = r + (wetR - r) * mix;
    }
    if (!Number.isFinite(outL[count - 1])) {
      for (const p of this.pairs) p.reset();
      this.fb[0] = this.fb[1] = 0;
    }
  }

  /** One channel, one sample: the single sideband of `x` (plus the fed-back shift) at the oscillator. */
  shift(ch, x, c, s, feedback) {
    const [re, im] = this.pairs[ch].next(x + this.fb[ch] * feedback, this.iq);
    const y = re * c + im * s;
    this.fb[ch] = Math.tanh(y);
    return y;
  }
}
