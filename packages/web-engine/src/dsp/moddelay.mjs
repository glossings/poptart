// A modulated delay line - the core a chorus and a flanger share.
//
// One delay line per channel read at a length that an LFO moves, with the read interpolated
// so the movement is a smooth pitch wobble rather than a series of steps, and feedback from the
// read back into the write for the flanger's resonance. The chorus and the flanger differ in
// their ranges and in nothing else, which is why this is one class and they are two thin
// descriptors around it.

import { DelayLine } from './reverb.mjs';

const MOD_TWO_PI = Math.PI * 2;

/** A sine or triangle LFO in 0..1, with a phase that can be offset per channel. */
export function lfoValue(phase, shape) {
  const p = phase - Math.floor(phase);
  if (shape === 1) return p < 0.5 ? p * 2 : 2 - p * 2;
  return 0.5 + 0.5 * Math.sin(MOD_TWO_PI * p);
}

export class ModDelay {
  constructor(sampleRate, maxSec) {
    this.sampleRate = sampleRate;
    this.max = Math.ceil(sampleRate * maxSec) + 4;
    this.lines = [new DelayLine(this.max), new DelayLine(this.max)];
    this.phase = 0;
    this.smoothed = [0, 0];
  }

  reset() {
    for (const l of this.lines) l.reset();
    this.smoothed = [0, 0];
  }

  /**
   * One sample for both channels.
   *
   * `baseSec` and `depthSec` place the sweep, `rateHz` moves it, `spread` (0..1) is how far the
   * right channel's LFO sits behind the left's, `feedback` is signed, and `voices` adds
   * further reads at offset phases for a thicker chorus. Writes the wet samples to `out`.
   */
  next(inL, inR, out, { baseSec, depthSec, rateHz, spread, feedback, shape = 0, voices = 1 }) {
    const sr = this.sampleRate;
    this.phase += rateHz / sr;
    if (this.phase >= 1) this.phase -= 1;
    const base = baseSec * sr;
    const depth = depthSec * sr;
    const cap = this.max - 2;
    let wetL = 0;
    let wetR = 0;
    for (let v = 0; v < voices; v++) {
      const offset = v / voices;
      const lenL = Math.min(cap, Math.max(1, base + depth * lfoValue(this.phase + offset, shape)));
      const lenR = Math.min(cap, Math.max(1, base + depth * lfoValue(this.phase + offset + spread * 0.5, shape)));
      wetL += this.lines[0].readLinear(lenL);
      wetR += this.lines[1].readLinear(lenR);
    }
    wetL /= voices;
    wetR /= voices;
    // The feedback comes from the first read, soft-limited so a flanger at full resonance rings
    // rather than runs away.
    const fbL = Math.tanh(wetL * feedback);
    const fbR = Math.tanh(wetR * feedback);
    this.lines[0].write(inL + fbL);
    this.lines[1].write(inR + fbR);
    out[0] = wetL;
    out[1] = wetR;
  }
}
