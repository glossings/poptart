// Renders poptart's shipped sample packs from its own DSP.
//
// The web build needs default sounds, and a default sound has to be redistributable. The usual
// route - find a free drum pack - is where this goes wrong: "free" nearly always means free to
// use in music rather than free to republish, the terms are often unstated, and the well-known
// sets that circulate in live-coding projects have murkier provenance than their popularity
// suggests. Chasing that down per file is real work and the answer is sometimes no.
//
// Rendering them from the synthesis already in this package sidesteps all of it. These are
// sounds poptart made, so poptart can give them away: every file below is CC0, with a source
// that names this script. They are also honest about what they are - a usable starter kit, not
// a replacement for somebody's own samples, and the sample browser takes a folder from disk the
// moment anybody has better ones.
//
// Run with `node build/render-packs.mjs`. The output is committed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Adsr } from '../src/dsp/adsr.mjs';
import { DcBlocker, Ladder, Svf } from '../src/dsp/filters.mjs';
import { Reverb } from '../src/dsp/reverb.mjs';
import { WavetableOscillator } from '../src/dsp/oscillator.mjs';
import { buildTable, builtInTables } from '../src/dsp/tables.mjs';
import { WARP_INDEX } from '../src/dsp/warp.mjs';
import { shape, SHAPER_INDEX } from '../src/dsp/shapers.mjs';
import { validateManifest, builtInLibrary } from '../src/packs/manifest.mjs';
import { encodeWav, finish, trim } from './wav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SR = 48000;

const TABLES = builtInTables();
const SINE = buildTable('sine', [TABLES[0].mips[0][0]]);
const TRI = buildTable('tri', [TABLES[0].mips[1][0]]);
const SAW = buildTable('saw', [TABLES[0].mips[2][0]]);
const SQUARE = buildTable('square', [TABLES[0].mips[3][0]]);

const seconds = (s) => Math.round(s * SR);

/** A deterministic noise source - every render of this pack has to come out identical. */
function noise(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return (state / 2147483648) - 1;
  };
}

/** A stereo pair of the given length. */
const pair = (n) => [new Float32Array(n), new Float32Array(n)];

/**
 * A pitched body with a falling pitch envelope - the thing every drum synth is built out of and
 * the one thing the live synth deliberately does not have, since its modulation comes from the
 * pattern language rather than from an internal matrix. Offline, here, it is three lines.
 */
function body({ table = SINE, startHz, endHz, sweep, length, decay, curve = -4, warp = 0, warpMode = 0 }) {
  const out = pair(length);
  const osc = new WavetableOscillator(SR);
  osc.setTable(table);
  osc.warpAmount = warp;
  osc.warpMode = warpMode;
  osc.start(1);
  const env = new Adsr(SR);
  env.set({ attack: 0.0005, decay, sustain: 0, release: 0.001, curve });
  env.gateOn(false);

  const block = 32;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  for (let at = 0; at < length; at += block) {
    const n = Math.min(block, length - at);
    const t = at / SR;
    osc.frequency = endHz + (startHz - endHz) * Math.exp(-t / sweep);
    l.fill(0); r.fill(0);
    osc.process(l, r, n, null, null, 1);
    for (let i = 0; i < n; i++) {
      const g = env.next();
      out[0][at + i] += l[i] * g;
      out[1][at + i] += r[i] * g;
    }
  }
  return out;
}

/** Filtered noise with its own envelope - the other half of every drum. */
function noiseBurst({ length, decay, cutoff, resonance = 0.2, mode = 0, seed = 7, attack = 0.0005, curve = -4 }) {
  const out = pair(length);
  const rnd = noise(seed);
  const filterL = new Svf(SR);
  const filterR = new Svf(SR);
  filterL.setCutoff(cutoff, resonance);
  filterR.setCutoff(cutoff, resonance);
  const env = new Adsr(SR);
  env.set({ attack, decay, sustain: 0, release: 0.001, curve });
  env.gateOn(false);
  for (let i = 0; i < length; i++) {
    const g = env.next();
    // Two independent noise streams so the result is genuinely stereo rather than a mono hit.
    out[0][i] = filterL.next(rnd(), mode) * g;
    out[1][i] = filterR.next(rnd(), mode) * g;
  }
  return out;
}

function mix(...layers) {
  const length = Math.max(...layers.map((l) => l[0].length));
  const out = pair(length);
  for (const layer of layers) {
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < layer[c].length; i++) out[c][i] += layer[c][i];
    }
  }
  return out;
}

function drive(channels, mode, amount) {
  const dc = [new DcBlocker(SR), new DcBlocker(SR)];
  return channels.map((c, ch) => {
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = dc[ch].next(shape(c[i], mode, amount, 0, 8));
    return out;
  });
}

function reverb(channels, { decay = 1.2, mix: wet = 0.25, size = 0.5 } = {}) {
  const verb = new Reverb(SR);
  verb.set({ decay, size, damping: 5000, preDelay: 0.005, lowCut: 200, modulation: 0.2 });
  const tail = seconds(decay * 0.8);
  const length = channels[0].length + tail;
  const inL = new Float32Array(length);
  const inR = new Float32Array(length);
  inL.set(channels[0]);
  inR.set(channels[1]);
  const wetL = new Float32Array(length);
  const wetR = new Float32Array(length);
  verb.process(inL, inR, wetL, wetR, length);
  const out = pair(length);
  for (let i = 0; i < length; i++) {
    out[0][i] = inL[i] * (1 - wet) + wetL[i] * wet;
    out[1][i] = inR[i] * (1 - wet) + wetR[i] * wet;
  }
  return out;
}

// -- the drum kit ---------------------------------------------------------------------------

const DRUMS = [
  ['kick', () => {
    const thump = body({ startHz: 150, endHz: 44, sweep: 0.03, length: seconds(0.7), decay: 0.42, curve: -6 });
    const click = noiseBurst({ length: seconds(0.02), decay: 0.006, cutoff: 3500, mode: 1, seed: 11 });
    return drive(mix(thump, click), SHAPER_INDEX.soft, 1.4);
  }],
  ['snare', () => {
    const tone = body({ table: TRI, startHz: 330, endHz: 175, sweep: 0.012, length: seconds(0.3), decay: 0.11 });
    const rattle = noiseBurst({ length: seconds(0.3), decay: 0.16, cutoff: 2200, resonance: 0.25, seed: 23 });
    const quiet = mix(tone.map((c) => c.map((v) => v * 0.7)), rattle.map((c) => c.map((v) => v * 0.9)));
    return drive(quiet, SHAPER_INDEX.tube, 1.2);
  }],
  ['rim', () => {
    const tone = body({ table: SQUARE, startHz: 1700, endHz: 900, sweep: 0.004, length: seconds(0.09), decay: 0.035 });
    const tick = noiseBurst({ length: seconds(0.09), decay: 0.012, cutoff: 5000, mode: 2, resonance: 0.5, seed: 31 });
    return mix(tone.map((c) => c.map((v) => v * 0.6)), tick);
  }],
  ['clap', () => {
    // Four bursts a few milliseconds apart, the last one longer - which is what a clap is.
    const length = seconds(0.42);
    const out = pair(length);
    const offsets = [0, 0.011, 0.021, 0.032];
    offsets.forEach((offset, index) => {
      const last = index === offsets.length - 1;
      const burst = noiseBurst({
        length: length - seconds(offset),
        decay: last ? 0.19 : 0.012,
        cutoff: 1500,
        resonance: 0.45,
        mode: 2,
        seed: 41 + index,
      });
      const at = seconds(offset);
      const level = last ? 1 : 0.8;
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < burst[c].length; i++) out[c][at + i] += burst[c][i] * level;
      }
    });
    return out;
  }],
  ['hat', () => {
    // Metallic content from a heavily warped square: six inharmonic partials, which is what a
    // hi-hat needs and what a plain noise source cannot give on its own.
    const metal = body({
      table: SQUARE, startHz: 5400, endHz: 5400, sweep: 1, length: seconds(0.1), decay: 0.035,
      warp: 0.8, warpMode: WARP_INDEX.fold,
    });
    const hiss = noiseBurst({ length: seconds(0.1), decay: 0.03, cutoff: 9000, mode: 1, seed: 53 });
    return mix(metal.map((c) => c.map((v) => v * 0.45)), hiss);
  }],
  ['hatopen', () => {
    const metal = body({
      table: SQUARE, startHz: 5400, endHz: 5400, sweep: 1, length: seconds(0.62), decay: 0.34,
      warp: 0.8, warpMode: WARP_INDEX.fold,
    });
    const hiss = noiseBurst({ length: seconds(0.62), decay: 0.3, cutoff: 8500, mode: 1, seed: 53 });
    return mix(metal.map((c) => c.map((v) => v * 0.45)), hiss);
  }],
  ['tomlo', () => body({ startHz: 190, endHz: 85, sweep: 0.05, length: seconds(0.6), decay: 0.34 })],
  ['tomhi', () => body({ startHz: 300, endHz: 150, sweep: 0.04, length: seconds(0.45), decay: 0.26 })],
];

// -- the melodic pack -----------------------------------------------------------------------
//
// Every file is rendered at middle C, because that is the pitch poptart's sampler treats as "as
// recorded": `.note(72)` on one of these plays it an octave up, and nothing has to be told what
// key it was in.

const MIDDLE_C_HZ = 261.6255653005986;

function pitched({ table, length, decay, cutoff, resonance = 0.2, warp = 0, warpMode = 0, detune = 0, unison = 1, ladder = false }) {
  const out = pair(length);
  const osc = new WavetableOscillator(SR);
  osc.setTable(table);
  osc.frequency = MIDDLE_C_HZ;
  osc.warpAmount = warp;
  osc.warpMode = warpMode;
  osc.unison = unison;
  osc.detuneCents = detune;
  osc.panSpread = unison > 1 ? 0.6 : 0;
  osc.phaseRand = unison > 1 ? 1 : 0;
  osc.start(9);

  const env = new Adsr(SR);
  env.set({ attack: 0.003, decay, sustain: 0, release: 0.001, curve: -4 });
  env.gateOn(false);
  const filterL = ladder ? new Ladder(SR) : new Svf(SR);
  const filterR = ladder ? new Ladder(SR) : new Svf(SR);

  const block = 32;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  for (let at = 0; at < length; at += block) {
    const n = Math.min(block, length - at);
    const t = at / SR;
    // The filter follows the amplitude, which is the one bit of internal modulation a one-shot
    // needs to sound played rather than gated.
    const open = cutoff * Math.exp(-t / (decay * 0.8));
    filterL.setCutoff(Math.max(80, open), resonance);
    filterR.setCutoff(Math.max(80, open), resonance);
    l.fill(0); r.fill(0);
    osc.process(l, r, n, null, null, 1);
    for (let i = 0; i < n; i++) {
      const g = env.next();
      out[0][at + i] = (ladder ? filterL.next(l[i]) : filterL.next(l[i], 0)) * g;
      out[1][at + i] = (ladder ? filterR.next(r[i]) : filterR.next(r[i], 0)) * g;
    }
  }
  return out;
}

const KEYS = [
  ['pluck', () => pitched({ table: SAW, length: seconds(0.9), decay: 0.5, cutoff: 5200, resonance: 0.3, ladder: true })],
  ['bell', () => reverb(pitched({
    table: SINE, length: seconds(1.6), decay: 1.1, cutoff: 12000,
    warp: 0.45, warpMode: WARP_INDEX.fold,
  }), { decay: 1.6, mix: 0.3 })],
  ['bass', () => drive(pitched({
    table: SQUARE, length: seconds(0.8), decay: 0.45, cutoff: 2200, resonance: 0.35, ladder: true,
  }), SHAPER_INDEX.tube, 1.6)],
  ['pad', () => reverb(pitched({
    table: SAW, length: seconds(2.4), decay: 1.6, cutoff: 3200, unison: 6, detune: 22,
  }), { decay: 2.4, mix: 0.4, size: 0.8 })],
  ['stab', () => pitched({
    table: TRI, length: seconds(0.55), decay: 0.3, cutoff: 4200, resonance: 0.45,
    warp: 0.3, warpMode: WARP_INDEX.asym, unison: 3, detune: 12,
  })],
];

// -- rendering ------------------------------------------------------------------------------

const SOURCE = 'rendered by packages/web-engine/build/render-packs.mjs';

function manifestFor(id, title, description, kind, names) {
  return validateManifest({
    id,
    title,
    description,
    kind,
    files: names.map((name) => ({
      file: `${name}.wav`,
      name,
      license: 'CC0-1.0',
      source: SOURCE,
    })),
  });
}

export function renderPacks({ write = true } = {}) {
  const packs = [
    { id: 'pt_kit', title: 'poptart kit', description: 'A starter drum kit, synthesized.', kind: 'drums', items: DRUMS },
    { id: 'pt_keys', title: 'poptart keys', description: 'Melodic one-shots, all at middle C.', kind: 'melodic', items: KEYS },
  ];

  const manifests = [];
  const rendered = [];
  for (const pack of packs) {
    const dir = path.join(root, 'public', 'packs', pack.id);
    if (write) fs.mkdirSync(dir, { recursive: true });
    for (const [name, make] of pack.items) {
      const bytes = encodeWav(finish(trim(make())), SR);
      if (write) fs.writeFileSync(path.join(dir, `${name}.wav`), bytes);
      rendered.push({ pack: pack.id, name, bytes: bytes.length });
    }
    const manifest = manifestFor(pack.id, pack.title, pack.description, pack.kind, pack.items.map(([n]) => n));
    if (write) fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    manifests.push(manifest);
  }

  if (write) {
    fs.writeFileSync(path.join(root, 'public', 'packs', 'built-in.js'), builtInLibrary(manifests));
  }
  return { manifests, rendered };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { rendered } = renderPacks();
  for (const r of rendered) {
    // eslint-disable-next-line no-console
    console.log(`${r.pack}/${r.name}.wav  ${(r.bytes / 1024).toFixed(1)} kB`);
  }
}
