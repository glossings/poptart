// The Granular synth: a sample played as a cloud of grains, one cloud per note.
//
// Name a sample and every note starts a stream of grains read from around a position in it,
// each grain a short windowed piece, transposed to the note and scattered as far as the spray
// allows. Hold the position and a sound freezes; sweep it and the sample is scrubbed through.
// The desktop's sampler has a grain mode of its own; this is the browser's, with a window to
// play it from.

import { defineDevice } from '../descriptor.mjs';
import { Adsr } from '../dsp/adsr.mjs';

export const GRAIN_VOICES = 8;
const MAX_GRAINS = 24;          // per voice
const SAMPLE_SLOTS = 32;

/** How many drawn windows a device holds at once, past the shapes it ships with. */
const SHAPE_SLOTS = 8;

// Grain windows. The order is the parameter's option list, so entries are only ever APPENDED:
// an index is what a saved song holds, and reordering these would change what one plays.
const WINDOWS = Object.freeze(['hann', 'triangle', 'gate', 'pluck', 'ramp up', 'blackman']);

/** The last hundredth of a grain, faded, so a window that ends loud does not click. */
const grainTail = (t) => Math.min(1, (1 - t) * 100);

/** A drawn window, read at `t` - linear between the points the engine sampled. */
export function drawnWindow(table, t) {
  const n = table.length;
  const x = Math.min(1, Math.max(0, t)) * (n - 1);
  const i = Math.floor(x);
  const a = table[i];
  const b = table[Math.min(n - 1, i + 1)];
  return (a + (b - a) * (x - i)) * grainTail(t);
}

/** How many grains the panel is told about at once - enough to read as a cloud, not a list. */
export const REPORTED_GRAINS = 48;

/**
 * One grain's amplitude at `t` through its length, by window shape. Shared by the voice and by
 * the picture the panel draws, so the shape somebody is looking at is the one being applied.
 *
 * A mode past the shipped list is a DRAWN window, which is not a formula and is not here: it is
 * a table the engine sampled and handed over, and `drawnWindow` reads it.
 */
export function grainWindow(mode, t) {
  if (mode === 5) return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
  // A grain with a transient of its own: struck at the front, decaying away. This is what makes
  // a cloud read as notes rather than as a pad, and it is the one shape the three symmetrical
  // windows cannot make.
  if (mode === 4) return grainWindow(3, 1 - t);
  if (mode === 3) return (t < 0.01 ? t * 100 : Math.exp(-6 * (t - 0.01))) * grainTail(t);
  if (mode === 2) return t < 0.05 ? t * 20 : t > 0.95 ? (1 - t) * 20 : 1;
  if (mode === 1) return 1 - Math.abs(t * 2 - 1);
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
}

export const GRANULAR = defineDevice({
  id: 'Granular',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-granular',
  description: 'A granular sampler: name a sample, and every note plays it as a cloud of grains from around a position, transposed to the note.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'sample', name: 'Sample', default: 0, options: ['none'], capacity: SAMPLE_SLOTS, takes: 'sample', rate: 'k', group: 'Source',
      description: 'The sample the grains are read from - "pack:3" or "files:voice.wav". With none named the synth is silent.' },
    { id: 'position', name: 'Position', min: 0, max: 1, default: 0.2, group: 'Source',
      description: 'Where in the sample the grains are read from.' },
    { id: 'spray', name: 'Spray', min: 0, max: 1, default: 0.05, group: 'Source',
      description: 'How far from the position a grain may start, as a share of the sample.' },
    { id: 'scan', name: 'Scan', min: -2, max: 2, default: 0, unit: 'x', group: 'Source',
      description: 'Moves the position through the sample while a note is held, at this multiple of real time.' },
    { id: 'size', name: 'Size', min: 5, max: 1000, default: 120, unit: 'ms', curve: 'exp', group: 'Grains' },
    { id: 'density', name: 'Density', min: 1, max: 200, default: 30, unit: 'Hz', curve: 'exp', group: 'Grains',
      description: 'How many grains start each second.' },
    { id: 'pitch', name: 'Pitch', min: -24, max: 24, default: 0, unit: 'st', group: 'Grains',
      description: 'On top of the note: a note of 60 plays the sample at its own pitch.' },
    { id: 'random', name: 'Random Pitch', min: 0, max: 12, default: 0, unit: 'st', group: 'Grains' },
    { id: 'window', name: 'Window', default: 0, options: [...WINDOWS], capacity: WINDOWS.length + SHAPE_SLOTS,
      takes: 'shape', rate: 'k', group: 'Grains',
      description: 'The amplitude a grain is played through. One of the shapes here, or one you draw - `.param("Window", "0,0 0.1,1 1,0")` takes the same breakpoints lfo() takes.' },
    { id: 'spread', name: 'Spread', min: 0, max: 1, default: 0.5, group: 'Grains',
      description: 'How far grains are panned either way.' },
    { id: 'reverse', name: 'Reverse', min: 0, max: 1, default: 0, group: 'Grains',
      description: 'The share of grains that play backwards.' },
    { id: 'attack', name: 'Attack', min: 0, max: 10, default: 0.02, unit: 's', curve: 'pow', curveExp: 3, group: 'Amp' },
    { id: 'decay', name: 'Decay', min: 0, max: 10, default: 0.1, unit: 's', curve: 'pow', curveExp: 3, group: 'Amp' },
    { id: 'sustain', name: 'Sustain', min: 0, max: 1, default: 1, group: 'Amp' },
    { id: 'release', name: 'Release', min: 0, max: 10, default: 0.3, unit: 's', curve: 'pow', curveExp: 3, group: 'Amp' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: 'Amp' },
    { id: 'voices', name: 'Voices', min: 1, max: GRAIN_VOICES, default: 4, step: 1, rate: 'k', ui: 'number', group: 'Amp' },
  ],
  figures: [
    {
      id: 'cloud',
      kind: 'sample',
      group: 'Source',
      title: 'sample',
      description: 'The file, with the grains being read out of it. Drag across it to move the position, up and down for the spray.',
      params: { sample: 'sample', position: 'position', spray: 'spray', size: 'size', scan: 'scan' },
      drag: { x: 'position', y: 'spray' },
    },
    {
      id: 'shape',
      kind: 'grain',
      group: 'Grains',
      title: 'grain',
      description: 'One grain\'s amplitude across its own length.',
      params: { shape: 'window', size: 'size' },
      // The window control is drawn ON the picture of the window - the picture is what the
      // control means, and a name for it in a row of knobs underneath says the same thing worse.
      subsumes: ['shape'],
    },
    {
      id: 'env',
      kind: 'adsr',
      group: 'Amp',
      title: 'envelope',
      description: 'The note\'s envelope over the cloud.',
      params: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' },
    },
  ],
  panel: { width: 760, rows: [['Source', 'Grains'], ['Amp']] },
});

class VoiceGrain {
  constructor() { this.on = false; this.pos = 0; this.len = 1; this.at = 0; this.rate = 1; this.l = 1; this.r = 1; }
}

class GrainVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.env = new Adsr(sampleRate);
    this.grains = Array.from({ length: MAX_GRAINS }, () => new VoiceGrain());
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.until = 0;
    this.scanned = 0;      // how far the scan has moved the position, in samples
    this.seed = 1;
  }

  get active() { return this.env.active; }

  random() {
    let x = this.seed; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.seed = x;
    return x / 4294967296;
  }

  noteOn(note, velocity, seed) {
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.seed = seed || 1;
    this.until = 0;
    this.scanned = 0;
    for (const g of this.grains) g.on = false;
    this.env.gateOn(true);
  }

  noteOff() { this.releasing = true; this.env.gateOff(); }

  process(outL, outR, count, offset, p, sample, drawn) {
    if (!this.env.active) return;
    this.env.set({ attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release, curve: -4 });
    const sr = this.sampleRate;
    const data = sample?.data;
    const len = data ? data.length : 0;
    const ratioBase = Math.pow(2, (this.note - 60 + p.pitch) / 12) * (sample ? sample.sampleRate / sr : 1);
    const window = p.window;
    // A drawn window is a table rather than a formula (see drawnWindow).
    const table = drawn ?? null;
    for (let i = 0; i < count; i++) {
      const env = this.env.next() * this.velocity;
      if (len > 0 && --this.until <= 0) {
        this.until = Math.max(1, Math.round((sr / p.density) * (0.8 + 0.4 * this.random())));
        const g = this.grains.find((x) => !x.on);
        if (g) {
          this.scanned += 0;
          const spray = (this.random() * 2 - 1) * p.spray * len;
          const center = (p.position * len + this.scanned + spray + len * 4) % len;
          g.len = Math.max(32, Math.round(p.size * 0.001 * sr));
          g.rate = ratioBase * Math.pow(2, (p.random * (this.random() * 2 - 1)) / 12);
          if (this.random() < p.reverse) g.rate = -g.rate;
          g.pos = center;
          g.at = 0;
          const pan = (this.random() * 2 - 1) * p.spread;
          g.l = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
          g.r = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
          g.on = true;
        }
      }
      this.scanned += p.scan * ratioBase;
      let l = 0;
      let r = 0;
      if (len > 0) {
        for (const g of this.grains) {
          if (!g.on) continue;
          const t = g.at / g.len;
          const w = table ? drawnWindow(table, t) : grainWindow(window, t);
          const pos = ((g.pos % len) + len) % len;
          const whole = Math.floor(pos);
          const frac = pos - whole;
          const b = (whole + 1) % len;
          const v = (data[whole] + (data[b] - data[whole]) * frac) * w;
          l += v * g.l;
          r += v * g.r;
          g.pos += g.rate;
          if (++g.at >= g.len) g.on = false;
        }
      }
      const g = env * (p.levelA ? p.levelA[offset + i] : p.level) * 0.5;
      outL[i] += l * g;
      outR[i] += r * g;
    }
  }
}

export class GranularSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.samples = [];        // option index -> { data, sampleRate }
    this.shapes = [];         // option index -> a drawn window, sampled by the engine
    this.p = {
      sample: 0, position: 0.2, spray: 0.05, scan: 0, size: 120, density: 30, pitch: 0, random: 0,
      window: 0, spread: 0.5, reverse: 0, attack: 0.02, decay: 0.1, sustain: 1, release: 0.3, level: 0.7, levelA: null,
    };
    this.voices = Array.from({ length: GRAIN_VOICES }, () => new GrainVoice(sampleRate));
    this.voiceCount = 4;
    this.clock = 0;
    this.seed = 7;
    this.events = [];
  }

  setParams(values) {
    const p = this.p;
    for (const key of Object.keys(p)) {
      if (key === 'levelA') continue;
      const v = values[key];
      if (v === undefined) continue;
      if (typeof v === 'number') { p[key] = v; if (key === 'level') p.levelA = null; }
      else if (v.length > 1) { p[key] = v[0]; if (key === 'level') p.levelA = v; }
      else if (v.length === 1) { p[key] = v[0]; if (key === 'level') p.levelA = null; }
    }
    p.window = Math.round(p.window);
    const voices = values.voices;
    const count = typeof voices === 'number' ? voices : voices?.[0];
    if (Number.isFinite(count)) this.voiceCount = Math.min(GRAIN_VOICES, Math.max(1, Math.round(count)));
  }

  /** Keeps a drawn window in a window slot, for the grains to be played through. */
  loadShape(paramId, index, table) {
    if (paramId !== 'window' || !table?.length) return false;
    this.shapes[Math.max(0, Math.round(index))] = table;
    return true;
  }

  /** Keeps a loaded file, summed to one channel at its own rate, in a sample slot. */
  loadSample(paramId, index, payload) {
    if (paramId !== 'sample' || !payload?.channels?.length) return false;
    const chans = payload.channels;
    let data = chans[0];
    if (chans.length > 1) {
      data = new Float32Array(chans[0].length);
      for (const c of chans) for (let i = 0; i < data.length; i++) data[i] += c[i] / chans.length;
    }
    this.samples[Math.max(0, Math.round(index))] = { data, sampleRate: payload.sampleRate ?? this.sampleRate };
    return true;
  }

  /**
   * Where every sounding grain is in the sample and how loud it is, as shares of the whole - what
   * the panel draws over the waveform while a note is held.
   *
   * Reported rather than inferred, because there is nothing to infer it from: a grain's start is
   * a random draw inside the spray, and a picture that redrew the spray band would be a picture
   * of the settings rather than of the cloud they are making.
   */
  report() {
    const sample = this.samples[Math.round(this.p.sample)] ?? null;
    const drawn = this.shapes[Math.round(this.p.window)] ?? null;
    const len = sample?.data?.length ?? 0;
    if (!len) return null;
    const grains = [];
    for (const v of this.voices) {
      if (!v.active) continue;
      for (const g of v.grains) {
        if (!g.on) continue;
        const drawn = this.shapes[Math.round(this.p.window)] ?? null;
        const t = g.at / g.len;
        grains.push([(((g.pos % len) + len) % len) / len, drawn ? drawnWindow(drawn, t) : grainWindow(this.p.window, t)]);
        if (grains.length >= REPORTED_GRAINS) return { grains };
      }
    }
    return { grains };
  }

  queueNoteOn(note, velocity, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity }); }
  queueNoteOff(note, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 0, note }); }

  allNotesOff() {
    this.events.length = 0;
    for (const v of this.voices) if (v.active) v.noteOff();
  }

  get activeVoices() { return this.voices.filter((v) => v.active).length; }

  allocate(note) {
    let free = null; let oldestReleasing = null; let oldest = null;
    for (let i = 0; i < this.voiceCount; i++) {
      const v = this.voices[i];
      if (v.active && v.note === note && !v.releasing) return v;
      if (!v.active) { if (!free) free = v; continue; }
      if (v.releasing && (!oldestReleasing || v.age < oldestReleasing.age)) oldestReleasing = v;
      if (!oldest || v.age < oldest.age) oldest = v;
    }
    return free ?? oldestReleasing ?? oldest ?? this.voices[0];
  }

  process(outL, outR, count) {
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
    const sample = this.samples[Math.round(this.p.sample)] ?? null;
    const drawn = this.shapes[Math.round(this.p.window)] ?? null;
    let at = 0;
    let next = 0;
    while (at < count) {
      while (next < events.length && events[next].at <= at) {
        const e = events[next++];
        if (e.kind === 1) {
          const voice = this.allocate(e.note);
          voice.age = this.clock++;
          voice.noteOn(e.note, e.velocity, (this.seed = (this.seed * 1664525 + 1013904223) >>> 0));
        } else {
          for (const v of this.voices) if (v.active && v.note === e.note && !v.releasing) v.noteOff();
        }
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at;
      if (n > 0) {
        const l = at === 0 && n === outL.length ? outL : outL.subarray(at, at + n);
        const r = at === 0 && n === outR.length ? outR : outR.subarray(at, at + n);
        for (const v of this.voices) if (v.active) v.process(l, r, n, at, this.p, sample, drawn);
      }
      at = until;
    }
    if (next >= events.length) events.length = 0;
    else this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
  }
}
