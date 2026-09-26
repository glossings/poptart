// The Stutter effect: catches a slice of what is playing and repeats it on the grid.
//
// The incoming audio is written into a buffer. Every interval on the transport's clock the effect
// may - with the chance set - grab the slice that just went by, one grid division long, and play
// it over and over for the number of repeats, each one quieter and
// lower than the last if asked. The chance is decided by a hash of the beat it falls on, so a
// song stutters in the same places every time it is played. While a repeat sounds the original
// is held at the dry level - cut, by default, so the repeats take its place - and the repeats
// themselves at the wet level.
//
// The caught slice is frozen for as long as it repeats. Recording carries on around it, so a
// catch made later - even one that interrupts a repeat - is still of what just went by, but the
// write head never enters the slice: a long grid times many repeats would otherwise have it
// overwrite what is playing, and the later repeats would be the live input instead. If the head
// comes all the way round to the slice it waits there, and once the repeat ends the buffer is
// short of fresh audio until a whole grid division has been recorded again; a catch that falls
// in that gap is let go rather than stitched together from audio seconds apart.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { SYNC_OPTIONS, syncedSeconds } from '../dsp/sync.mjs';

const REPEAT_MAX_SEC = 4;

export const STUTTER = defineDevice({
  id: 'Stutter',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-stutter',
  description: 'A stutter on the grid: every interval, with the chance set, the last grid division of audio is caught and repeated, falling in level and pitch if asked.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'interval', name: 'Interval', default: 12, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'How often a repeat may start.' },
    { id: 'grid', name: 'Grid', default: 2, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'How long the caught slice is.' },
    { id: 'chance', name: 'Chance', min: 0, max: 1, default: 1,
      description: 'The odds a given interval repeats. Decided per beat rather than per play, so a song repeats in the same places every time.' },
    { id: 'repeats', name: 'Repeats', min: 1, max: 32, default: 8, step: 1, rate: 'k', ui: 'number' },
    { id: 'decay', name: 'Decay', min: 0, max: 1, default: 0,
      description: 'How much quieter each repeat is than the one before.' },
    { id: 'pitch', name: 'Pitch', min: -12, max: 0, default: 0, unit: 'st', step: 1, ui: 'number',
      description: 'How far each repeat drops in pitch from the one before, in semitones.' },
    { id: 'dry', name: 'Dry', min: 0, max: 1, default: 0,
      description: 'The level of what is playing while a repeat runs. Zero cuts it, so the repeats take its place; one leaves it under them.' },
    { id: 'wet', name: 'Wet', min: 0, max: 1, default: 1,
      description: 'The level of the repeats.' },
    { id: 'seed', name: 'Seed', min: 0, max: 99, default: 0, step: 1, rate: 'k', ui: 'number',
      description: 'Another seed is another pattern of chances.' },
  ],
  figures: [
    {
      id: 'repeats',
      kind: 'repeats',
      title: 'repeats',
      description: 'One catch and its repeats: how long each plays and how far it falls in level and pitch, against the interval the next may start on.',
      params: { grid: 'grid', repeats: 'repeats', decay: 'decay', pitch: 'pitch', interval: 'interval' },
    },
  ],
});

/** A deterministic 0..1 for a beat and a seed - the same chance the same beat, every play. */
function hashChance(beat, seed) {
  let h = ((beat | 0) * 2654435761 + (seed | 0) * 40503 + 0x9e3779b9) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h / 4294967296;
}

export class StutterProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    const size = Math.ceil(sampleRate * REPEAT_MAX_SEC);
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.size = size;
    this.write = 0;
    // How much contiguous, current audio sits behind the write head. The buffer starts out as
    // silence, which counts: it is what went by before anything played.
    this.fresh = size;
    this.bpm = 120;
    this.anchorSec = 0;
    this.lastInterval = -1;
    this.frames = 0;
    // The repeat in progress, if any.
    this.active = false;
    this.start = 0;          // where the slice begins in the buffer
    this.length = 0;         // the slice, in samples
    this.pos = 0;            // read position inside the slice, fractional
    this.count = 0;          // repeats played so far
    this.total = 0;
    this.fade = 0;
  }

  setTempo(bpm, anchorSec = null) {
    this.bpm = bpm;
    if (anchorSec != null) this.anchorSec = anchorSec;
  }

  process(inputs, outputs, count, params, sidechain, timeSec = null) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sr = this.sampleRate;
    const interval = syncedSeconds(Math.round(at(params.interval, 0)), this.bpm, 2);
    const grid = Math.min(REPEAT_MAX_SEC * 0.9, syncedSeconds(Math.round(at(params.grid, 0)), this.bpm, 0.125));
    const seed = Math.round(at(params.seed, 0));
    const total = Math.max(1, Math.round(at(params.repeats, 0)));
    for (let i = 0; i < count; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      // Recording stops where the slice being repeated begins, so it is never written over.
      const recording = !(this.active && this.write === this.start);
      if (recording) {
        // A number that cannot be played is stored as silence, or it would be repeated.
        this.bufL[this.write] = Number.isFinite(l) ? l : 0;
        this.bufR[this.write] = Number.isFinite(r) ? r : 0;
      } else {
        this.fresh = 0;
      }

      // A new interval on the clock: maybe catch the slice that just went by.
      const t = (timeSec ?? this.frames / sr) - this.anchorSec;
      const beat = Math.floor(t / interval);
      if (beat !== this.lastInterval) {
        const length = Math.max(1, Math.round(grid * sr));
        if (this.lastInterval >= 0 && this.fresh >= length && hashChance(beat, seed) < at(params.chance, i)) {
          this.length = length;
          this.start = (this.write - this.length + this.size) % this.size;
          this.pos = 0;
          this.count = 0;
          this.total = total;
          this.active = true;
        }
        this.lastInterval = beat;
      }
      this.frames += 1;

      let wetL = 0;
      let wetR = 0;
      let playing = false;
      if (this.active) {
        const decay = at(params.decay, i);
        const pitch = at(params.pitch, i);
        const level = Math.pow(1 - decay, this.count);
        const rate = Math.pow(2, (pitch * this.count) / 12);
        const p = this.pos;
        const whole = Math.floor(p);
        const frac = p - whole;
        const a = (this.start + whole) % this.size;
        const b = (a + 1) % this.size;
        // A short fade at both ends of each repeat, so the loop point does not click.
        const edge = Math.min(1, Math.min(p, this.length - p) / 64);
        wetL = (this.bufL[a] + (this.bufL[b] - this.bufL[a]) * frac) * level * edge;
        wetR = (this.bufR[a] + (this.bufR[b] - this.bufR[a]) * frac) * level * edge;
        playing = true;
        this.pos += rate;
        if (this.pos >= this.length) {
          this.pos -= this.length;
          this.count += 1;
          if (this.count >= this.total) this.active = false;
        }
      }
      if (recording) {
        this.write = (this.write + 1) % this.size;
        if (this.fresh < this.size) this.fresh += 1;
      }
      // The original at its own level only while a repeat is sounding: between repeats the
      // track plays as it is, whatever the dry control says.
      const dry = playing ? at(params.dry, i) : 1;
      const wet = at(params.wet, i);
      outL[i] = l * dry + wetL * wet;
      if (outR !== outL) outR[i] = r * dry + wetR * wet;
    }
  }
}
