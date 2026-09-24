// The Vocoder effect: the spectrum of one signal imposed on another.
//
// The modulator is split into bands, each band's level is followed, and the carrier is split
// into the same bands and each one scaled by the modulator's level in it. The effect sits on the
// carrier's track - a synth, a pad - and `.audio("voice")` patches the modulator in; with no
// modulator patched it turns the arrangement round and treats the track as the modulator over a
// carrier of its own, so a voice track alone still speaks.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { BIQUAD_TYPES, Biquad } from '../dsp/biquad.mjs';
import { Detector } from './compressor.mjs';

const MAX_BANDS = 32;
const BANDPASS = BIQUAD_TYPES.indexOf('bandpass');

export const VOCODER = defineDevice({
  id: 'Vocoder',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-vocoder',
  description: 'A channel vocoder: the sidechained signal\'s spectrum, band by band, shapes this track. With nothing sidechained the track is the modulator and the carrier is the built-in one.',
  channels: { in: 2, out: 2 },
  sidechain: true,
  params: [
    { id: 'bands', name: 'Bands', min: 8, max: MAX_BANDS, default: 16, step: 4, rate: 'k', ui: 'number' },
    { id: 'low', name: 'Low', min: 40, max: 1000, default: 100, unit: 'Hz', curve: 'exp',
      description: 'The lowest band.' },
    { id: 'high', name: 'High', min: 2000, max: 16000, default: 8000, unit: 'Hz', curve: 'exp',
      description: 'The highest band.' },
    { id: 'attack', name: 'Attack', min: 1, max: 200, default: 8, unit: 'ms', curve: 'exp' },
    { id: 'release', name: 'Release', min: 5, max: 1000, default: 60, unit: 'ms', curve: 'exp' },
    { id: 'carrier', name: 'Carrier', default: 0, options: ['track', 'saw', 'noise'], rate: 'k',
      description: 'Track uses this track as the carrier and the sidechain as the modulator. Saw and noise are built-in carriers, and then this track is the modulator.' },
    { id: 'note', name: 'Carrier Note', min: 24, max: 84, default: 48, step: 1, ui: 'number',
      description: 'The built-in saw\'s pitch.' },
    { id: 'emphasis', name: 'Emphasis', min: 0, max: 1, default: 0.5,
      description: 'Lifts the high bands, which is where the consonants live.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 },
  ],
});

export class VocoderProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.modBands = Array.from({ length: MAX_BANDS }, () => new Biquad());
    this.carBands = Array.from({ length: MAX_BANDS }, () => new Biquad());
    this.detectors = Array.from({ length: MAX_BANDS }, () => new Detector(sampleRate));
    this.centers = new Float64Array(MAX_BANDS);
    this.last = { bands: -1, low: -1, high: -1, attack: -1, release: -1 };
    this.phase = 0;
    this.seed = 0x3779b9;
  }

  _tune(bands, low, high, steps = 0) {
    for (let b = 0; b < bands; b++) {
      const hz = low * Math.pow(high / low, b / (bands - 1));
      this.centers[b] = hz;
      // Adjacent bands overlap at their skirts: the Q follows the spacing.
      const q = 1 / (Math.pow(high / low, 1 / (bands - 1)) - 1) * 1.2;
      this.modBands[b].glideTo(BANDPASS, hz, 0, q, this.sampleRate, steps);
      this.carBands[b].follow(this.modBands[b]);
    }
  }

  process(inputs, outputs, count, params, sidechain) {
    const bands = Math.max(8, Math.min(MAX_BANDS, Math.round(at(params.bands, 0) / 4) * 4));
    const low = at(params.low, 0);
    const high = at(params.high, 0);
    if (bands !== this.last.bands || low !== this.last.low || high !== this.last.high) {
      // A band COUNT change is a different bank, so it lands at once; moving the edges of the
      // same bank is a sweep and glides across the block like any other filter.
      this._tune(bands, low, high, bands === this.last.bands ? count : 0);
      this.last.bands = bands; this.last.low = low; this.last.high = high;
    }
    const attack = at(params.attack, 0);
    const release = at(params.release, 0);
    if (attack !== this.last.attack || release !== this.last.release) {
      for (const d of this.detectors) d.setTimes(attack, release);
      this.last.attack = attack; this.last.release = release;
    }
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const side = sidechain?.[0] ?? null;
    const carrierMode = Math.round(at(params.carrier, 0));
    const useTrackAsCarrier = carrierMode === 0 && side;
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sr = this.sampleRate;
    const hz = 440 * Math.pow(2, (at(params.note, 0) - 69) / 12);
    for (let i = 0; i < count; i++) {
      const track = ((inL ? inL[i] : 0) + (inR ? inR[i] : 0)) * 0.5;
      let modulator;
      let carrier;
      if (useTrackAsCarrier) {
        modulator = side[i];
        carrier = track;
      } else {
        modulator = track;
        if (carrierMode === 2 || (carrierMode === 0 && !side)) {
          let x = this.seed; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.seed = x;
          carrier = x / 2147483648 - 1;
        } else {
          this.phase += hz / sr;
          if (this.phase >= 1) this.phase -= 1;
          carrier = this.phase * 2 - 1;
        }
        if (carrierMode === 0 && !side) carrier *= 0.5;
      }
      const emphasis = at(params.emphasis, i);
      let wet = 0;
      for (let b = 0; b < bands; b++) {
        const m = this.modBands[b].next(modulator);
        const env = this.detectors[b].next(Math.abs(m));
        const c = this.carBands[b].next(carrier);
        const tilt = 1 + emphasis * 3 * (b / (bands - 1));
        wet += c * env * tilt;
      }
      wet *= 2;
      const mix = at(params.mix, i);
      const dry = useTrackAsCarrier ? track : track;
      outL[i] = dry + (wet - dry) * mix;
      if (outR !== outL) outR[i] = outL[i];
    }
    if (!Number.isFinite(outL[count - 1])) {
      for (const b of this.modBands) b.reset();
      for (const b of this.carBands) b.reset();
    }
  }
}
