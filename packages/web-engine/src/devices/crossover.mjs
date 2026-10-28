// The Crossover: one Linkwitz-Riley split, the DJ isolator's kind. It is what `.bands()` is built
// from, one per frequency, and it is the ENGINES' device, not the user's: it is in no catalog, no
// chain and no device list, so `.fx("Crossover")` names nothing, and the track (or, on the desktop,
// the engine) makes one for each crossover the wiring has. That is also why a band split costs
// nothing on a track that has none, and adds no delay on one that does.
//
// Three outputs, because a band split needs all three:
//
//   0  the band below the frequency (fourth-order lowpass)
//   1  the rest, above it (fourth-order highpass), which the next crossover splits again
//   2  the KEY through the same pair's all-pass (lowpass plus highpass)
//
// The third is what makes the bands sum back flat. A Linkwitz-Riley pair sums to an all-pass, not
// to a wire, so every band below a crossover has to be turned in phase exactly as that crossover
// turns the bands above it. The bands summed so far come in as the key, and leave in step with
// what is above. pattern-core's route.mjs wires the three; nothing else reads them.
//
// Translated line for line into native/devices/own/crossover.cc for the desktop, and held to it
// by native-device-parity.test.mjs.

import { defineDevice } from '../descriptor.mjs';
import { at, isMoving } from '../dsp/control.mjs';
import { Crossover } from '../dsp/biquad.mjs';

/** The Frequency control's range, in Hz - pattern-core's CROSSOVER_MIN_HZ / CROSSOVER_MAX_HZ. */
export const CROSSOVER_MIN_HZ = 20;
export const CROSSOVER_MAX_HZ = 20000;

export const CROSSOVER = defineDevice({
  id: 'Crossover',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-crossover',
  description: 'The Linkwitz-Riley crossover .bands() splits a signal with.',
  channels: { in: 2, out: 2, key: 2, outputs: 3 },
  params: [
    // Linear, so a frequency written in Hz is one straight line from its position whatever it is
    // - a number, a pattern or a modulator - and a modulator stays native (see route.mjs).
    { id: 'frequency', name: 'Frequency', min: CROSSOVER_MIN_HZ, max: CROSSOVER_MAX_HZ, default: 1000, unit: 'Hz',
      description: 'Where the signal is split.' },
  ],
});

export class CrossoverProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // The input's pair and the key's, one per channel. The key's follow the input's, so the
    // all-pass turns the key exactly as the split turns the input, glide and all.
    this.main = [new Crossover(sampleRate), new Crossover(sampleRate)];
    this.key = [new Crossover(sampleRate), new Crossover(sampleRate)];
    this.parts = new Float64Array(2);
    this.last = -1;
  }

  /**
   * Moves the split to `hz` over `steps` samples. The first setting is taken outright, so a
   * crossover opened at 250 Hz does not sweep down to it from wherever it was built.
   */
  retune(hz, steps) {
    this.main[0].setFrequency(hz, this.last < 0 ? 0 : steps);
    this.main[1].follow(this.main[0]);
    this.key[0].follow(this.main[0]);
    this.key[1].follow(this.main[0]);
    this.last = hz;
  }

  /**
   * `outputs` is the band below; `more` holds the other two outputs, [rest, all-pass], each a pair
   * of channels. A frequency a signal moves is followed sample by sample, as the desktop host
   * plays this device while one is patched; otherwise it glides across the block.
   */
  process(inputs, outputs, count, params, key, time, more) {
    const moving = isMoving(params.frequency);
    if (!moving) {
      const hz = at(params.frequency, 0);
      if (hz !== this.last) this.retune(hz, count);
    }
    const restOut = more?.[0] ?? null;
    const apOut = more?.[1] ?? null;
    const parts = this.parts;
    for (let i = 0; i < count; i++) {
      if (moving) {
        const hz = at(params.frequency, i);
        if (hz !== this.last) this.retune(hz, 1);
      }
      for (let ch = 0; ch < 2; ch++) {
        const x = inputs[ch] ?? inputs[0];
        const k = key?.[ch] ?? key?.[0];
        this.main[ch].split(x ? x[i] : 0, parts);
        const low = outputs[ch];
        if (low) low[i] = parts[0];
        const high = restOut?.[ch];
        if (high) high[i] = parts[1];
        this.key[ch].split(k ? k[i] : 0, parts);
        const turned = apOut?.[ch];
        if (turned) turned[i] = parts[0] + parts[1];
      }
    }
  }
}
