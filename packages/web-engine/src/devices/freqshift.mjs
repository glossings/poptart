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

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';

export const DIRECTIONS = Object.freeze(['up', 'down', 'split']);

export const FREQSHIFT = defineDevice({
  id: 'FreqShift',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-freqshift',
  description: 'A frequency shifter: moves every partial by the same number of hertz, which makes a pitched sound inharmonic.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'freq', name: 'Freq', min: 0.1, max: 5000, default: 50, unit: 'Hz', curve: 'exp',
      description: 'How far every partial moves. A few hertz is a slow phasing wobble; tens to hundreds turn a pitched sound metallic.' },
    { id: 'direction', name: 'Direction', default: 0, options: [...DIRECTIONS], rate: 'k',
      description: 'Up adds the frequency and down subtracts it; split moves the left channel up and the right down.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 0.95, default: 0,
      description: 'Sends the shifted signal round again, so each repeat moves further: a rising or falling spiral.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1,
      description: 'The shifted signal against the dry one. In between, the two beat against each other.' },
  ],
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
    const direction = Math.round(at(params.direction, 0));
    // +1 keeps the upper sideband, -1 the lower; split sends the two channels opposite ways.
    const signL = direction === 1 ? -1 : 1;
    const signR = direction === 0 ? 1 : -1;
    const sr = this.sampleRate;
    for (let i = 0; i < count; i++) {
      this.phase += at(params.freq, i) / sr;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
      const w = 2 * Math.PI * this.phase;
      const c = Math.cos(w);
      const s = Math.sin(w);
      const feedback = at(params.feedback, i);
      const mix = at(params.mix, i);
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const wetL = this.shift(0, l, c, s * signL, feedback);
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
