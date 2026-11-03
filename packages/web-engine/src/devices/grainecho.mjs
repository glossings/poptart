// The Grain Echo effect: a delay whose repeats are grains.
//
// The input goes into a buffer, and grains are read out of it from around the delay time back:
// each one a short windowed piece, repitched, scattered in time by the spray, and fed back into
// the buffer so the next generation of grains reads the last. At a low density and no pitch it
// is a delay with a texture; pushed, it is a cloud.
//
// The grains are summed and divided by how many overlap (Size times Density, past two), so a
// denser cloud is not a louder one and the feedback can never gain on itself. The sum then goes
// through a DC blocker before it is heard or fed back: windowed, repitched grains leave an
// offset, and round the loop it would build up.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { SYNC_OPTIONS, syncedSeconds, migrateSyncLists } from '../dsp/sync.mjs';

const GRAIN_MAX_SEC = 4;
const MAX_GRAINS = 48;
/** Where the DC blocker on the grains starts to let through, in Hz. */
const GRAINECHO_DC_HZ = 20;

/** Starting points for the preset menu: each the defaults with these controls changed. */
export const GRAINECHO_PRESETS = Object.freeze({
  smear: { time: 0.4, size: 250, density: 8, spray: 0.6, feedback: 0.45 },
  glitch: { sync: 4, size: 15, density: 80, spray: 0.05, feedback: 0.6 },
  shimmer: { pitch: 12, size: 120, density: 15, spray: 0.3, feedback: 0.5, mix: 0.4 },
  descend: { pitch: -12, size: 150, density: 25, feedback: 0.5, mix: 0.45 },
  sinking: { sync: 7, pitch: -3, size: 150, density: 15, spray: 0.05, feedback: 0.7 },
  cloud: { size: 60, density: 30, random: 12, spray: 1, feedback: 0.35, spread: 1, mix: 0.45 },
  rhythmic: { sync: 9, size: 200, density: 8, spray: 0, feedback: 0.5 },
  wash: { time: 1, size: 500, density: 4, spray: 1, feedback: 0.7, spread: 1, mix: 0.6 },
});

export const GRAINECHO = defineDevice({
  id: 'GrainEcho',
  kind: 'fx',
  version: 2,
  // Version 2 inserted 1/32T and 1/32. into the sync list (see dsp/sync.mjs).
  migrate: migrateSyncLists(['sync']),
  license: 'AGPL-3.0-only',
  processor: 'poptart-grainecho',
  description: 'A delay whose repeats are grains: short repitched windows read from around the delay time and scattered, feeding back into themselves.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'sync', name: 'Sync', default: 0, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'A division of the beat overrides the time and follows the tempo.' },
    { id: 'time', name: 'Time', min: 0.01, max: 2, default: 0.25, unit: 's', curve: 'exp',
      active: { param: 'sync', is: 'free' } },
    { id: 'size', name: 'Size', min: 5, max: 500, default: 80, unit: 'ms', curve: 'exp',
      description: 'How long each grain is.' },
    { id: 'density', name: 'Density', min: 1, max: 200, default: 20, unit: 'Hz', curve: 'exp',
      description: 'How many grains start each second.' },
    { id: 'pitch', name: 'Pitch', min: -24, max: 24, default: 0, unit: 'st',
      description: 'Every grain is transposed by this.' },
    { id: 'random', name: 'Random Pitch', min: 0, max: 12, default: 0, unit: 'st',
      description: 'Each grain is transposed by up to this much more, either way.' },
    { id: 'spray', name: 'Spray', min: 0, max: 1, default: 0.2,
      description: 'How far a grain may start from the delay time, as a share of it.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 0.95, default: 0.3 },
    { id: 'spread', name: 'Spread', min: 0, max: 1, default: 0.5,
      description: 'How far grains are panned either way.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5 },
  ],
  figures: [
    {
      id: 'cloud',
      kind: 'cloud',
      title: 'cloud',
      description: 'The grains one hit sets off, time across and pitch up: each repeat a scatter of grains Size long, as many as Density catches, spread by Spray and Random Pitch, a step of Pitch from the last and quieter by Feedback. Left and right grains are drawn in two shades. Drag across for the time, up for the pitch.',
      params: { time: 'time', sync: 'sync', size: 'size', density: 'density', pitch: 'pitch', random: 'random', spray: 'spray', feedback: 'feedback', spread: 'spread' },
      drag: { x: 'time', y: 'pitch' },
    },
  ],
  presets: GRAINECHO_PRESETS,
});

/** The grains' random sequence: xorshift32 on a 32-bit seed, the next seed. */
function nextSeed(seed) {
  let x = seed;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  return x;
}

/** Where the grains' random sequence starts. */
const GRAINECHO_SEED = 0x2545f491;

/** The most repeats, and grains a repeat, the picture draws. */
const CLOUD_REPEATS = 16;
const CLOUD_GRAINS = 24;
/** The quietest repeat drawn, in decibels under the first. */
const CLOUD_FLOOR_DB = -60;
/** The longest the picture runs, in seconds. */
const CLOUD_SPAN_MAX = 8;

/**
 * The cloud one hit makes, for the device's picture: every grain of every repeat, where it is
 * heard, at what pitch, how loud, and which way it is panned.
 *
 * Built the way the processor builds it. A hit is caught by the grains whose window covers it
 * when they read it back - about Density times Size of them - and each is heard Time back, give
 * or take Spray of it, plus half a grain, since a grain starts reading half its length before the
 * point it is centered on. Each of those grains is caught again by the next repeat, Feedback
 * quieter, transposed by Pitch again and by its own Random Pitch, so a repeat's grains sit around
 * its parents'. The random draws are the processor's own sequence from its own seed, so the
 * picture is a sample of the same spread the sound draws from, and the same sample each time.
 */
export function grainEchoCloud({ time, size, density, pitch, random, spray, feedback, spread }) {
  let seed = GRAINECHO_SEED;
  const rnd = () => {
    seed = nextSeed(seed);
    return seed / 4294967296;
  };
  const len = Math.max(0.001, size * 0.001);
  const caught = Math.max(1, Math.min(CLOUD_GRAINS, Math.round(density * len)));
  const fbDb = feedback > 0 ? 20 * Math.log10(feedback) : -Infinity;
  const grains = [];
  let parents = [{ t: 0, st: 0 }];
  for (let n = 1; n <= CLOUD_REPEATS; n++) {
    const db = (n - 1) * fbDb;
    if (!(db > CLOUD_FLOOR_DB)) break;
    const next = [];
    for (let g = 0; g < caught; g++) {
      const parent = parents[Math.floor(rnd() * parents.length)];
      const back = Math.max(0.001, time + spray * time * (rnd() * 2 - 1));
      const st = parent.st + pitch + random * (rnd() * 2 - 1);
      const pan = (rnd() * 2 - 1) * spread;
      const t = parent.t + back + len / 2;
      if (t - len / 2 > CLOUD_SPAN_MAX) continue;
      next.push({ t, st });
      grains.push({ t, length: len, st, db, pan, repeat: n });
    }
    if (!next.length) break;
    parents = next;
  }
  const last = grains.reduce((m, g) => Math.max(m, g.t + g.length / 2), 0);
  return { grains, span: Math.min(CLOUD_SPAN_MAX, Math.max(0.3, last * 1.08)), floorDb: CLOUD_FLOOR_DB };
}

/** One grain: where it reads, how far through it is, its rate and pan. */
class DelayGrain {
  constructor() { this.on = false; this.pos = 0; this.len = 1; this.at = 0; this.rate = 1; this.l = 1; this.r = 1; }
}

export class GrainEchoProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.size = Math.ceil(sampleRate * GRAIN_MAX_SEC);
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.write = 0;
    this.grains = Array.from({ length: MAX_GRAINS }, () => new DelayGrain());
    this.until = 0;        // samples until the next grain starts
    this.seed = GRAINECHO_SEED;
    this.bpm = 120;
    this.dcK = 1 - (2 * Math.PI * GRAINECHO_DC_HZ) / sampleRate;
    this.dcInL = 0; this.dcInR = 0; this.dcOutL = 0; this.dcOutR = 0;
  }

  setTempo(bpm) { this.bpm = bpm; }

  /** A deterministic 0..1, so the cloud is the same cloud every play. */
  random() {
    this.seed = nextSeed(this.seed);
    return this.seed / 4294967296;
  }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sr = this.sampleRate;
    const sync = Math.round(at(params.sync, 0));
    for (let i = 0; i < count; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      // Start a grain when one is due.
      if (--this.until <= 0) {
        const density = at(params.density, i);
        this.until = Math.max(1, Math.round(sr / density * (0.7 + 0.6 * this.random())));
        const g = this.grains.find((x) => !x.on);
        if (g) {
          const time = Math.min(GRAIN_MAX_SEC * 0.9, syncedSeconds(sync, this.bpm, at(params.time, i)));
          const spray = at(params.spray, i) * time * (this.random() * 2 - 1);
          const back = Math.max(0.001, time + spray) * sr;
          let len = Math.max(32, Math.round(at(params.size, i) * 0.001 * sr));
          const rate = Math.pow(2, (at(params.pitch, i) + at(params.random, i) * (this.random() * 2 - 1)) / 12);
          // A grain read faster than time passes gains on the write head by (rate - 1) samples
          // a sample, and one read slower falls behind by (1 - rate). It has to stay inside the
          // recorded audio for its whole life: start it far enough back that it never reaches
          // the head, where it would read what was written a whole buffer ago, and not so far
          // that it runs off the far end. A grain too long to fit either way is shortened.
          if (rate > 1 && (rate - 1) * len > this.size - 8) len = Math.max(32, Math.floor((this.size - 8) / (rate - 1)));
          const gains = rate > 1 ? (rate - 1) * len : 0;
          const loses = rate < 1 ? (1 - rate) * len : 0;
          const start = Math.min(this.size - 2 - loses, Math.max(2 + gains, back + len * 0.5));
          g.len = len;
          g.rate = rate;
          g.pos = (this.write - start + this.size * 4) % this.size;
          g.at = 0;
          const pan = (this.random() * 2 - 1) * at(params.spread, i);
          g.l = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
          g.r = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
          g.on = true;
        }
      }
      let wetL = 0;
      let wetR = 0;
      for (const g of this.grains) {
        if (!g.on) continue;
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * g.at) / g.len);
        const p = g.pos;
        const whole = Math.floor(p);
        const frac = p - whole;
        const a = whole % this.size;
        const b = (a + 1) % this.size;
        const sl = (this.bufL[a] + (this.bufL[b] - this.bufL[a]) * frac) * w;
        const sr2 = (this.bufR[a] + (this.bufR[b] - this.bufR[a]) * frac) * w;
        const mono = (sl + sr2) * 0.5;
        wetL += mono * g.l;
        wetR += mono * g.r;
        g.pos += g.rate;
        if (g.pos >= this.size) g.pos -= this.size;
        if (++g.at >= g.len) g.on = false;
      }
      // Two Hann windows overlapping half way sum to one; more than that is brought back to it.
      const overlap = Math.min(MAX_GRAINS, at(params.size, i) * 0.001 * at(params.density, i));
      const norm = 1 / Math.max(1, overlap * 0.5);
      const rawL = wetL * norm;
      const rawR = wetR * norm;
      wetL = rawL - this.dcInL + this.dcK * this.dcOutL;
      wetR = rawR - this.dcInR + this.dcK * this.dcOutR;
      this.dcInL = rawL; this.dcInR = rawR;
      this.dcOutL = wetL; this.dcOutR = wetR;
      const fb = at(params.feedback, i);
      // A number that cannot be played is stored as silence: kept, it would come back round
      // the feedback for as long as the device lives.
      const keepL = l + Math.tanh(wetL * fb);
      const keepR = r + Math.tanh(wetR * fb);
      this.bufL[this.write] = Number.isFinite(keepL) ? keepL : 0;
      this.bufR[this.write] = Number.isFinite(keepR) ? keepR : 0;
      this.write = (this.write + 1) % this.size;
      const mix = at(params.mix, i);
      outL[i] = l + (wetL - l) * mix;
      if (outR !== outL) outR[i] = r + (wetR - r) * mix;
    }
  }
}
