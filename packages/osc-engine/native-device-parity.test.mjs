// poptart's own devices, on both engines, over the same audio.
//
// THIS IS THE GUARANTEE FOR THE HALF OF THE PORT THAT IS WRITTEN TWICE. The ported modules
// (Plaits, Clouds, Galactic, ...) are one C++ source compiled for WebAssembly and for scsynth, so
// they cannot drift. poptart's own devices could not be done that way - their DSP was written in
// JavaScript, for an AudioWorklet, and a server cannot run a worklet - so there are two
// implementations of each, and what holds them together is this: the browser's processor and the
// compiled device are played the same input with the same controls, and the output is compared
// sample by sample.
//
// A change to one side that is not a change to the other fails here, which is the whole point.
// When it does fail, the two to look at are named in the message: the device's .mjs under
// web-engine/src/devices and its .cc under osc-engine/native/devices/own.
//
// Needs a compiler and nothing else: the harness links the devices, the ABI and a generated
// registry, none of which includes a SuperCollider header. Where there is no clang++ the test
// skips rather than fails, as the sclang tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ownDevices, ownIdsSource, registrySource } from '../web-engine/build/devices/native.mjs';
import { denormalize } from '../web-engine/src/descriptor.mjs';
import { FilterProcessor } from '../web-engine/src/devices/filter.mjs';
import { EqProcessor } from '../web-engine/src/devices/eq.mjs';
import { CrushProcessor } from '../web-engine/src/devices/crush.mjs';
import { OverdriveProcessor } from '../web-engine/src/devices/overdrive.mjs';
import { CompressorProcessor } from '../web-engine/src/devices/compressor.mjs';
import { DistortProcessor } from '../web-engine/src/devices/distort.mjs';
import { LimiterProcessor } from '../web-engine/src/devices/limiter.mjs';
import { MultibandProcessor } from '../web-engine/src/devices/multiband.mjs';
import { ReverbProcessor } from '../web-engine/src/devices/reverb.mjs';
import { FreqShiftProcessor } from '../web-engine/src/devices/freqshift.mjs';
import { VoiceProcessor } from '../web-engine/src/devices/voice.mjs';
import { ChorusProcessor } from '../web-engine/src/devices/chorus.mjs';
import { FlangerProcessor } from '../web-engine/src/devices/flanger.mjs';
import { PhaserProcessor } from '../web-engine/src/devices/phaser.mjs';
import { DelayProcessor } from '../web-engine/src/devices/delay.mjs';
import { GrainEchoProcessor } from '../web-engine/src/devices/grainecho.mjs';
import { StutterProcessor } from '../web-engine/src/devices/stutter.mjs';
import { DuckerProcessor } from '../web-engine/src/devices/ducker.mjs';
import { FmSynth } from '../web-engine/src/devices/fmsynth.mjs';
import { WavetableSynth } from '../web-engine/src/devices/wavetable.mjs';
import { GranularSynth } from '../web-engine/src/devices/granular.mjs';
import { NoiseSynth } from '../web-engine/src/devices/noise.mjs';
import { LpgProcessor } from '../web-engine/src/devices/lpg.mjs';
import { CrossoverProcessor } from '../web-engine/src/devices/crossover.mjs';
import { IR_NAMES, bufferFromChannels, synthesizeImpulse } from '../web-engine/src/devices/builtins.mjs';
import { Biquad, BIQUAD_TYPES } from '../web-engine/src/dsp/biquad.mjs';
import { readReport } from './native-devices.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.join(here, 'native', 'devices');
const WORK = path.join(here, '..', 'web-engine', '.pack-cache', 'devices', 'native', 'parity');

const SAMPLE_RATE = 48000;
const BLOCK = 128;

/** The browser-side processor for each device the harness can be asked for. */
const PROCESSORS = {
  Filter: FilterProcessor,
  EQ: EqProcessor,
  Crush: CrushProcessor,
  Overdrive: OverdriveProcessor,
  Compressor: CompressorProcessor,
  Distort: DistortProcessor,
  Limiter: LimiterProcessor,
  Multiband: MultibandProcessor,
  Reverb: ReverbProcessor,
  FreqShift: FreqShiftProcessor,
  Voice: VoiceProcessor,
  Chorus: ChorusProcessor,
  Flanger: FlangerProcessor,
  Phaser: PhaserProcessor,
  Delay: DelayProcessor,
  GrainEcho: GrainEchoProcessor,
  Stutter: StutterProcessor,
  Ducker: DuckerProcessor,
  FM: FmSynth,
  Wavetable: WavetableSynth,
  Granular: GranularSynth,
  Noise: NoiseSynth,
  LPG: LpgProcessor,
  Crossover: CrossoverProcessor,
  // Convolver is deliberately not here: there is no JavaScript processor for it to be compared
  // against, because in the browser it IS a ConvolverNode. It has a test of its own at the end
  // of this file, against Chromium's documented behavior.
};

/** The devices whose browser side is a stock Web Audio node rather than a processor of ours. */
const STOCK_NODES = new Set(['Convolver']);

/** How many channels a device takes in (its own pair, and a key's) and puts out (every pair). */
const inChannelsOf = (descriptor) => (descriptor.sidechain || descriptor.channels.key ? 4 : 2);
const outChannelsOf = (descriptor) => 2 * (descriptor.channels.outputs ?? 1);

// ---- the harness ------------------------------------------------------------------------------

function haveCompiler() {
  return spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 * Builds the harness, with the same flags the shipped extension is built with.
 *
 * The flags matter: -O3 -ffast-math is what the devices are compiled with for real, so testing
 * them compiled any other way would be testing something nobody runs.
 */
function buildHarness(devices) {
  fs.mkdirSync(WORK, { recursive: true });
  const ids = path.join(WORK, 'pd-own-ids.h');
  const registry = path.join(WORK, 'pd-own-registry.cc');
  fs.writeFileSync(ids, ownIdsSource(devices), 'utf8');
  fs.writeFileSync(registry, registrySource(devices.map((d) => d.device)), 'utf8');
  const binary = path.join(WORK, 'harness');
  const sources = [
    ...devices.map((d) => d.file),
    path.join(NATIVE_DIR, 'pd-device.cc'),
    path.join(NATIVE_DIR, 'own', 'harness.cc'),
    registry,
  ];
  const newest = Math.max(...sources.map((f) => fs.statSync(f).mtimeMs), fs.statSync(ids).mtimeMs);
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs > newest) return binary;
  execFileSync('clang++', [
    '-O3', '-std=c++17', '-ffast-math', '-fno-rtti',
    '-I', NATIVE_DIR, '-I', WORK,
    ...sources, '-o', binary,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return binary;
}

/** One device's output: the values in real units, the input, and what comes back. */
function runNative(binary, { id, values, input, frames, notes = [], bpm = 120, keyed = null, samples = [], moving = [], shapes = [], report = null, outs = 2 }) {
  const stdin = Buffer.alloc(values.length * 4 + input.length * 4);
  for (let i = 0; i < values.length; i++) stdin.writeFloatLE(Math.fround(values[i]), i * 4);
  for (let i = 0; i < input.length; i++) stdin.writeFloatLE(input[i], values.length * 4 + i * 4);
  const args = [id, String(SAMPLE_RATE), String(frames), String(BLOCK), String(bpm)];
  if (keyed !== null) args.push('-k', keyed ? '1' : '0');
  for (const one of samples) args.push('-S', `${one.param}:${one.slot}:${one.rate}:${one.channels ?? 1}:${one.frameLength ?? 0}:${one.file}`);
  for (const one of shapes) args.push('-H', `${one.param}:${one.slot}:${one.file}`);
  if (report) args.push('-R', report);
  for (const n of notes) args.push('-n', `${n.frame}:${n.note}:${n.velocity}`);
  for (const one of moving) args.push('-A', `${one.param}:${one.file}`);
  const run = spawnSync(binary, args, { input: stdin, maxBuffer: 1 << 28 });
  assert.equal(run.status, 0, `${id}: the harness failed - ${run.stderr?.toString()}`);
  const out = new Float32Array(frames * outs);
  for (let i = 0; i < out.length; i++) out[i] = run.stdout.readFloatLE(i * 4);
  return out;
}

/** A device's outputs for one block, as the effects worklet hands them over: the first pair, then the rest. */
function blockOutputs(descriptor) {
  return Array.from({ length: descriptor.channels.outputs ?? 1 }, () => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
}

/** Runs one block of an effect and writes every output pair, interleaved, into `out` at `at`. */
function processBlock(fx, descriptor, inputs, n, params, key, at, out) {
  const outputs = blockOutputs(descriptor);
  fx.process(inputs, outputs[0], n, params, key, at / SAMPLE_RATE, outputs.length > 1 ? outputs.slice(1) : null);
  const width = outputs.length * 2;
  for (let i = 0; i < n; i++) {
    outputs.forEach((pair, k) => {
      out[(at + i) * width + 2 * k] = pair[0][i];
      out[(at + i) * width + 2 * k + 1] = pair[1][i];
    });
  }
}

/**
 * The same run through the browser's own processor, block by block as a worklet would.
 *
 * An instrument has a different surface from an effect - setParams, queueNoteOn, setBend and a
 * process that is handed its two output channels - exactly as the two worklets that host them do
 * (web-engine/src/worklets), so this stands in for both.
 */
function runBrowser(descriptor, { values, input, frames, notes = [], bpm = 120, channels = 2, keyed = true, load = null, shapes = [], onDone = null }) {
  if (descriptor.kind === 'synth') return runBrowserSynth(descriptor, { values, frames, notes, bpm, load, shapes, onDone });
  const Processor = PROCESSORS[descriptor.id];
  const fx = new Processor(SAMPLE_RATE);
  if (load) fx.loadSample(load.param, load.slot, { channels: load.channels ?? [load.data], sampleRate: load.rate, frameLength: load.frameLength || null });
  for (const one of shapes) fx.loadShape(one.param, one.slot, one.table);
  if (typeof fx.setTempo === 'function') fx.setTempo(bpm, 0);
  const params = {};
  descriptor.params.forEach((p, i) => { params[p.id] = Math.fround(values[i]); });
  const out = new Float32Array(frames * outChannelsOf(descriptor));
  const inputs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  // A sidechained device is handed its key as a second input, exactly as the browser's host
  // hands it one: `inputs[1]` of the worklet node, which is a pair of its own.
  const key = channels >= 4 && keyed ? [new Float32Array(BLOCK), new Float32Array(BLOCK)] : null;
  let nextNote = 0;
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    while (nextNote < notes.length && notes[nextNote].frame < at + n) {
      const one = notes[nextNote++];
      // At the note's own time: the processor places it inside the block itself.
      if (one.velocity > 0) fx.noteOn?.(one.note, one.velocity, one.frame / SAMPLE_RATE);
      else fx.noteOff?.(one.note, one.frame / SAMPLE_RATE);
    }
    for (let i = 0; i < n; i++) {
      inputs[0][i] = input[(at + i) * channels];
      inputs[1][i] = input[(at + i) * channels + 1];
      if (key) {
        key[0][i] = input[(at + i) * channels + 2];
        key[1][i] = input[(at + i) * channels + 3];
      }
    }
    for (let i = n; i < BLOCK; i++) {
      inputs[0][i] = 0;
      inputs[1][i] = 0;
      if (key) { key[0][i] = 0; key[1][i] = 0; }
    }
    processBlock(fx, descriptor, inputs, n, params, key, at, out);
  }
  onDone?.(fx);
  return out;
}

/** An instrument, played the way the synth worklet plays one. */
function runBrowserSynth(descriptor, { values, frames, notes, bpm, load = null, shapes = [], onDone = null }) {
  const Synth = PROCESSORS[descriptor.id];
  const synth = new Synth(SAMPLE_RATE);
  // A file the device plays, handed over as the engine hands one over: plain channels of
  // samples at the file's own rate (web-audio-engine.mjs's _loadSampleParam).
  if (load) synth.loadSample(load.param, load.slot, { channels: load.channels ?? [load.data], sampleRate: load.rate, frameLength: load.frameLength || null });
  for (const one of shapes) synth.loadShape(one.param, one.slot, one.table);
  if (typeof synth.setTempo === 'function') synth.setTempo(bpm, 0);
  const params = {};
  descriptor.params.forEach((p, i) => { params[p.id] = Math.fround(values[i]); });
  const out = new Float32Array(frames * 2);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  let nextNote = 0;
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    synth.setParams(params);
    synth.setBend(0);
    // Notes land on their own sample, as they do on the desktop: the UGen cuts its render at a
    // note's offset into the block (World's mSampleOffset), and the synth here splits its block
    // at the offset it is queued with.
    while (nextNote < notes.length && notes[nextNote].frame < at + n) {
      const one = notes[nextNote++];
      if (one.velocity > 0) synth.queueNoteOn(one.note, one.velocity, one.frame - at);
      else synth.queueNoteOff(one.note, one.frame - at);
    }
    left.fill(0);
    right.fill(0);
    synth.process(left, right, n);
    for (let i = 0; i < n; i++) {
      out[(at + i) * 2] = left[i];
      out[(at + i) * 2 + 1] = right[i];
    }
  }
  onDone?.(synth);
  return out;
}

// ---- what is played through them --------------------------------------------------------------

/** A deterministic pseudo-random generator, so a failure is a failure again next run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Something with content at every frequency and a shape in time: noise, two tones and a gap.
 *
 * The gap is there on purpose - a compressor's release, a delay's tail and a filter's ring are
 * all things that only happen when the input stops.
 */
function testSignal(frames, channels = 2, seed = 7, keyed = true) {
  const next = rng(seed);
  const sig = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const env = i < frames * 0.6 ? 1 : 0;
    const noise = (next() * 2 - 1) * 0.25;
    const l = (Math.sin(2 * Math.PI * 220 * t) * 0.4 + noise) * env;
    const r = (Math.sin(2 * Math.PI * 330 * t + 0.7) * 0.4 + noise * 0.8) * env;
    sig[i * channels] = Math.fround(l);
    sig[i * channels + 1] = Math.fround(r);
    // The key, for a device that takes one: a hit every 16 ms, which is what a compressor is
    // asked to duck under and a ducker to open for.
    if (channels >= 4) {
      // With nothing routed in, the key is this track's own signal: that is what the UGen puts
      // there (PoptartDevice's fillInput) and what the browser's processor falls back to when
      // its host hands it no sidechain, so the two are being fed the same thing either way.
      const phase = (i % Math.round(SAMPLE_RATE * 0.016)) / (SAMPLE_RATE * 0.016);
      const hit = Math.exp(-phase * 12) * Math.sin(2 * Math.PI * 60 * t);
      sig[i * channels + 2] = keyed ? Math.fround(hit) : sig[i * channels];
      sig[i * channels + 3] = keyed ? Math.fround(hit * 0.9) : sig[i * channels + 1];
    }
  }
  return sig;
}

/**
 * The devices that play a FILE, and the control that takes one.
 *
 * `slot` is the entry on that control's option list the file is loaded into, which is the first
 * one past the options the descriptor ships with - the browser's own rule (its _spareOption),
 * mirrored on the desktop by osc-engine's sample path.
 */
/**
 * The devices that are compared over a longer run than the rest: one that is late by design says
 * nothing for its first 50 ms, and has to have tracked a pitch and laid down grains before the two
 * engines can be said to agree about it.
 */
const LONG_RUN = { Voice: BLOCK * 240 };

// Settings a device is always ALSO played at, on top of its defaults and the seeded draws: a
// mode the draws may never land on, with whatever it depends on turned up. Each is the defaults
// with these controls changed.
const PINNED = {
  // Always-glide, with a glide long enough to still be moving when the chords change.
  Wavetable: [{ 'glide': 0.05, 'glide.mode': 1 }, { 'glide': 0.05, 'glide.mode': 0 }],
  // Every color, filtered and narrowed so the tone and width paths run too, and the digital
  // color's long sequence as well as its short one. The chaotic map is in the list on purpose:
  // it is the color one bit of rounding would send somewhere else.
  Noise: [
    ...Array.from({ length: 10 }, (_, color) => ({ color, character: 0.7, tone: 3000, width: 0.4 })),
    { color: 7, character: 0.2, pitch: 12 },
    { color: 8, character: 0 },
    { color: 9, character: 1, pitch: -12 },
  ],
  LPG: [{ mode: 1 }, { mode: 2, resonance: 0.8 }, { level: 0.4, decay: 0.05, resonance: 0.5 }],
};

const SAMPLED = {
  Granular: { param: 'sample' },
  Convolver: { param: 'ir' },
};

/**
 * Something to play: a short sound with transients, tone and noise in it, at a rate that is NOT
 * the engine's.
 *
 * The rate is deliberate. A granulator steps through a file at the ratio between the file's rate
 * and the engine's, and a bug in that ratio is invisible while the two agree.
 */
function testFile(seconds = 0.4, rate = 44100) {
  const next = rng(31);
  const frames = Math.round(seconds * rate);
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const hit = Math.exp(-(t % 0.1) * 30);
    data[i] = Math.fround((Math.sin(2 * Math.PI * 180 * t) * 0.6 + (next() * 2 - 1) * 0.3) * hit);
  }
  return { data, rate, frames };
}

/** The file as the harness takes one: raw floats on disk, which the host would own in memory. */
function writeFile(file, data) {
  const bytes = Buffer.alloc(data.length * 4);
  for (let i = 0; i < data.length; i++) bytes.writeFloatLE(data[i], i * 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

/** Every control at its default, in real units - what a device plays before a pattern moves it. */
function defaultValues(descriptor) {
  return descriptor.params.map((p) => p.default);
}

/**
 * A setting somewhere else in the range: each control at a position the seed picks, with enums
 * and toggles landing on whole options.
 */
function randomValues(descriptor, seed) {
  const next = rng(seed);
  return descriptor.params.map((p) => {
    if (p.options) return Math.min(p.max, Math.max(p.min, Math.round(next() * (p.options.length - 1))));
    return denormalize(p, next());
  });
}

/**
 * The devices whose sound is CHAOTIC, and the control that makes them so.
 *
 * Two implementations of the same arithmetic in two languages differ by one unit in the last
 * place wherever they call exp, sin or pow, because V8 and the system's libm round those
 * differently - and in a feedback loop that difference is not small for long. The FM synth's
 * modulation matrix is exactly that loop: with its sixty-four cells opened up at a random
 * setting, one bit becomes a different waveform inside a few milliseconds, on either engine,
 * and comparing samples would only be measuring the weather.
 *
 * So a chaotic device is compared both ways: sample for sample at a patch with no loop in it,
 * where a difference in the last bit stays one, and by its ENVELOPE with every cell open - which
 * still catches a wrong operator, a wrong envelope or a dropped level.
 */
const CHAOTIC = { FM: /^mod\./ };

/**
 * The same draw with every modulation LOOP taken out: two cells are left open, both of them
 * feed-forward (an operator modulating a lower-numbered one), and the diagonal - which is an
 * operator's own feedback - is closed. What is left is a patch somebody would actually play, and
 * it is stable, because nothing a difference lands in comes back round to where it started.
 */
function thinned(device, values, seed) {
  const pattern = CHAOTIC[device.id];
  if (!pattern) return values;
  const next = rng(seed * 31 + 7);
  const feedForward = device.params
    .map((p, i) => {
      const parts = /^mod\.(\d+)\.(\d+)$/.exec(p.id);
      return parts && Number(parts[1]) > Number(parts[2]) ? i : -1;
    })
    .filter((i) => i >= 0);
  const open = new Set();
  while (open.size < 2 && feedForward.length) open.add(feedForward[Math.floor(next() * feedForward.length)]);
  return values.map((v, i) => (pattern.test(device.params[i].id) && !open.has(i) ? 0 : v));
}

/**
 * How far apart two runs are in LEVEL rather than in waveform: the loudness of each block, and
 * the loudness of the whole run.
 */
function compareEnvelope(id, what, mine, theirs) {
  const blocks = Math.floor(mine.length / 2 / BLOCK);
  let worst = 0;
  let worstAt = -1;
  let totalA = 0;
  let totalB = 0;
  for (let b = 0; b < blocks; b++) {
    let a = 0;
    let c = 0;
    for (let i = 0; i < BLOCK * 2; i++) {
      const x = mine[b * BLOCK * 2 + i];
      const y = theirs[b * BLOCK * 2 + i];
      a += x * x;
      c += y * y;
    }
    totalA += a;
    totalB += c;
    const rmsA = Math.sqrt(a / (BLOCK * 2));
    const rmsB = Math.sqrt(c / (BLOCK * 2));
    // Only where there is something to compare: a block of near-silence has no level to be
    // wrong about, and a relative difference on one would be all noise.
    if (Math.max(rmsA, rmsB) < 1e-3) continue;
    const off = Math.abs(rmsA - rmsB) / Math.max(rmsA, rmsB);
    if (off > worst) { worst = off; worstAt = b; }
  }
  const overall = Math.abs(Math.sqrt(totalA) - Math.sqrt(totalB)) / Math.max(1e-12, Math.sqrt(Math.max(totalA, totalB)));
  assert.ok(worst < 0.35, `${id} ${what}: block ${worstAt} is ${(worst * 100).toFixed(1)}% louder on one engine than the other`);
  assert.ok(overall < 0.1, `${id} ${what}: the whole run is ${(overall * 100).toFixed(1)}% louder on one engine than the other`);
}

/** How far apart the two runs are: the worst single sample, and the level each one came out at. */
function compare(id, what, mine, theirs) {
  let worst = 0;
  let worstAt = -1;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    const b = theirs[i];
    assert.ok(Number.isFinite(a), `${id} ${what}: the compiled device put out ${a} at ${i}`);
    assert.ok(Number.isFinite(b), `${id} ${what}: the browser's device put out ${b} at ${i}`);
    const diff = Math.abs(a - b);
    if (diff > worst) { worst = diff; worstAt = i; }
    energyA += a * a;
    energyB += b * b;
  }
  const rmsA = Math.sqrt(energyA / mine.length);
  const rmsB = Math.sqrt(energyB / theirs.length);
  // Absolute, not relative: these are signals around unity, and a tolerance per sample is what
  // "the same sound" means. 1e-4 is about -80 dB, which is a hundred times under the noise floor
  // of anything that will play it, and is still tight enough to catch a wrong coefficient, a
  // dropped stage or a channel swap.
  assert.ok(
    worst < 1e-4,
    `${id} ${what}: the two engines disagree by ${worst.toExponential(2)} at sample ${worstAt} `
    + `(compiled rms ${rmsA.toExponential(2)}, browser rms ${rmsB.toExponential(2)}) - `
    + `compare src/devices/${id.toLowerCase()}.mjs with native/devices/own/${id.toLowerCase()}.cc`,
  );
  return { worst, rmsA, rmsB };
}

// ---- the test ---------------------------------------------------------------------------------

const compiler = haveCompiler();
const devices = ownDevices();

test('every device poptart ships natively has a browser processor to be compared against', () => {
  for (const { id } of devices) {
    if (STOCK_NODES.has(id)) continue;
    assert.ok(PROCESSORS[id], `${id} is built for the desktop but not listed in PROCESSORS here`);
  }
});

/**
 * Every way a device can be driven, which is not one way for all of them: an effect with a
 * sidechain behaves differently with a key routed in and with nothing routed in, the ducker
 * dips on the clock, on a key or on a routed track's notes, and an instrument does nothing at
 * all until it is played.
 */
function waysToPlay(device) {
  const ways = [];
  if (device.kind === 'synth') {
    ways.push({ what: 'playing two notes', keyed: null, notes: [
      { frame: 0, note: 48, velocity: 0.9 },
      { frame: BLOCK * 4, note: 55, velocity: 0.5 },
      { frame: BLOCK * 14, note: 48, velocity: 0 },
    ] });
    // Two chords that share notes, the first held over the start of the second - the shape that
    // exercises a voice holding the same pitch twice, and a glide dealt across a chord change.
    const chord = (frame, notes, velocity) => notes.map((note) => ({ frame, note, velocity }));
    ways.push({ what: 'playing overlapping chords', keyed: null, notes: [
      ...chord(0, [48, 52, 55, 59], 0.8),
      ...chord(BLOCK * 4, [45, 48, 52, 55], 0.7),
      ...chord(BLOCK * 6, [48, 52, 55, 59], 0),
      ...chord(BLOCK * 12, [45, 48, 52, 55], 0),
    ] });
    // Notes between block edges, which is where nearly every note falls: each has to start on its
    // own sample, not on the edge before it.
    ways.push({ what: 'playing notes off the block edges', keyed: null, notes: [
      { frame: 37, note: 50, velocity: 0.9 },
      { frame: BLOCK * 4 + 91, note: 57, velocity: 0.6 },
      { frame: BLOCK * 9 + 5, note: 50, velocity: 0 },
      { frame: BLOCK * 14 + 127, note: 57, velocity: 0 },
    ] });
    return ways;
  }
  if (device.sidechain) {
    ways.push({ what: 'with a key routed in', keyed: true });
    ways.push({ what: 'with nothing routed in', keyed: false });
  } else {
    ways.push({ what: 'on the chain', keyed: null });
  }
  if (device.notes) {
    ways.push({ what: "on a routed track's notes", keyed: false, notes: [
      { frame: 0, note: 36, velocity: 1 },
      { frame: BLOCK * 8, note: 36, velocity: 1 },
      { frame: BLOCK * 16, note: 36, velocity: 1 },
    ] });
    ways.push({ what: "on a routed track's notes off the block edges", keyed: false, notes: [
      { frame: 61, note: 36, velocity: 1 },
      { frame: BLOCK * 8 + 77, note: 36, velocity: 1 },
    ] });
  }
  return ways;
}

for (const one of devices.filter((d) => !STOCK_NODES.has(d.id))) {
  test(`${one.id} sounds the same compiled as it does in the browser`, { skip: compiler ? false : 'no clang++' }, () => {
    const binary = buildHarness(devices);
    const frames = LONG_RUN[one.id] ?? BLOCK * 24;   // about 64 ms, long enough for a tail
    const { device } = one;
    // A device that plays a file is handed one, on both engines, in the first spare slot of the
    // control that takes it - and that control is then POINTED at it, since a draw across the
    // range would otherwise leave a granulator pointed at "none" and silent.
    const sampled = SAMPLED[one.id];
    const file = sampled ? testFile() : null;
    const slot = sampled ? device.params.find((p) => p.id === sampled.param).options.length : 0;
    const samples = sampled
      ? [{ param: device.params.findIndex((p) => p.id === sampled.param), slot, rate: file.rate,
           file: writeFile(path.join(WORK, `${one.id}.f32`), file.data) }]
      : [];
    const load = sampled ? { param: sampled.param, slot, data: file.data, rate: file.rate } : null;
    const pointAtFile = (values) => (sampled
      ? values.map((v, i) => (device.params[i].id === sampled.param ? slot : v))
      : values);
    // Four channels for a device that takes a key, two for the rest.
    const channels = inChannelsOf(device);
    const outs = outChannelsOf(device);
    const synth = device.kind === 'synth';
    let loudest = 0;

    for (const way of waysToPlay(device)) {
      const keyed = way.keyed;
      const notes = way.notes ?? [];
      // An instrument has no input: what it plays is the notes.
      const input = synth
        ? new Float32Array(frames * channels)
        : testSignal(frames, channels, 7, keyed !== false);
      const runs = [['at its defaults', defaultValues(device)]];
      // And across the range: four settings from the same seeds every run.
      for (const seed of [11, 29, 97, 1234]) runs.push([`at setting ${seed}`, randomValues(device, seed)]);
      for (const pin of PINNED[one.id] ?? []) {
        runs.push([`at ${JSON.stringify(pin)}`, device.params.map((p) => (p.id in pin ? pin[p.id] : p.default))]);
      }

      for (const [when, values] of runs) {
        // A chaotic device is compared sample for sample at a patch that is stable, and by its
        // level at the one that is not (see CHAOTIC).
        const stable = pointAtFile(thinned(device, values, runs.indexOf(runs.find(([w]) => w === when)) + 1));
        const { rmsA } = compare(one.id, `${way.what} ${when}`.trim(),
          runNative(binary, { id: one.id, values: stable, input, frames, notes, keyed, samples, outs }),
          runBrowser(device, { values: stable, input, frames, notes, channels, keyed: keyed !== false, load }));
        if (rmsA > loudest) loudest = rmsA;
        if (CHAOTIC[device.id] && stable !== values) {
          compareEnvelope(one.id, `${way.what} ${when}, every path open`.trim(),
            runNative(binary, { id: one.id, values, input, frames, notes, keyed, samples, outs }),
            runBrowser(device, { values, input, frames, notes, channels, keyed: keyed !== false, load }));
        }
      }
    }
    // Two silences are identical, which would make this test pass for a device that does nothing
    // at all - so somewhere in all of that the device has to have made a sound.
    assert.ok(loudest > 1e-3, `${one.id}: the compiled device never put out anything (rms ${loudest})`);
  });
}

// ---- a control with audio patched onto it ------------------------------------------------------
//
// `.param("Cutoff", audio("mod"))` moves a control every sample. The browser's processor is
// handed a block-long array for it and reads it per sample; the UGen, while anything is patched,
// renders the device one sample at a time with the control set from the bus at that sample
// (kPatchPiece in PoptartDevice.cpp). The harness does the same with `-A`, so these say the two
// still agree when a control is being swept at audio rate - a 300 Hz sine across most of its
// range, which no per-block reading could follow.

/** The control's position swept by a sine, as real values per frame. */
function sweptValues(param, frames, hz = 300) {
  return Float32Array.from({ length: frames }, (_, i) =>
    Math.fround(denormalize(param, 0.5 + 0.3 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE))));
}

/** The browser's processor with one control swept, handed it as the worklet would: per block. */
function runBrowserSwept(descriptor, { values, input, frames, notes, channels, sweptId, swept }) {
  const params = {};
  descriptor.params.forEach((p, i) => { params[p.id] = Math.fround(values[i]); });
  const out = new Float32Array(frames * outChannelsOf(descriptor));
  let nextNote = 0;
  const synth = descriptor.kind === 'synth';
  const dev = new PROCESSORS[descriptor.id](SAMPLE_RATE);
  if (typeof dev.setTempo === 'function') dev.setTempo(120, 0);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  const inputs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const key = channels >= 4 ? [new Float32Array(BLOCK), new Float32Array(BLOCK)] : null;
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    params[sweptId] = swept.subarray(at, at + n);
    left.fill(0);
    right.fill(0);
    if (synth) {
      dev.setParams(params);
      dev.setBend(0);
      while (nextNote < notes.length && notes[nextNote].frame < at + n) {
        const one = notes[nextNote++];
        if (one.velocity > 0) dev.queueNoteOn(one.note, one.velocity, 0);
        else dev.queueNoteOff(one.note, 0);
      }
      dev.process(left, right, n);
    } else {
      for (let i = 0; i < n; i++) {
        inputs[0][i] = input[(at + i) * channels];
        inputs[1][i] = input[(at + i) * channels + 1];
        if (key) {
          key[0][i] = input[(at + i) * channels + 2];
          key[1][i] = input[(at + i) * channels + 3];
        }
      }
      processBlock(dev, descriptor, inputs, n, params, key, at, out);
      continue;
    }
    for (let i = 0; i < n; i++) {
      out[(at + i) * 2] = left[i];
      out[(at + i) * 2 + 1] = right[i];
    }
  }
  return out;
}

const PATCHED = [
  { id: 'Filter', param: 'cutoff' },
  { id: 'LPG', param: 'level' },
  { id: 'Noise', param: 'tone' },
  { id: 'Wavetable', param: 'osc1.phase' },
  { id: 'Crossover', param: 'frequency' },
  { id: 'Distort', param: 'drive' },
  { id: 'Distort', param: 'character' },
  { id: 'FM', param: 'level' },
  { id: 'Wavetable', param: 'osc1.semi' },
];

for (const { id, param } of PATCHED) {
  test(`${id} follows audio patched onto ${param} the same on both engines`, { skip: compiler ? false : 'no clang++' }, () => {
    const binary = buildHarness(devices);
    const { device } = devices.find((d) => d.id === id);
    const frames = BLOCK * 24;
    const index = device.params.findIndex((p) => p.id === param);
    const swept = sweptValues(device.params[index], frames);
    const file = writeFile(path.join(WORK, `${id}-swept.f32`), swept);
    const values = defaultValues(device);
    const synth = device.kind === 'synth';
    const notes = synth ? [{ frame: 0, note: 48, velocity: 0.9 }, { frame: BLOCK * 12, note: 48, velocity: 0 }] : [];
    const channels = inChannelsOf(device);
    const input = synth ? new Float32Array(frames * channels) : testSignal(frames, channels);
    const native = runNative(binary, { id, values, input, frames, notes, samples: [], keyed: null, moving: [{ param: index, file }], outs: outChannelsOf(device) });
    const browser = runBrowserSwept(device, { values, input, frames, notes, channels, sweptId: param, swept });
    const { rmsA } = compare(id, `with ${param} swept at audio rate`, native, browser);
    assert.ok(rmsA > 1e-3, `${id}: nothing came out`);
    // And it has to be moving per sample, not per block: the same run with the control held at
    // each block's first value comes out different.
    const blocky = Float32Array.from(swept, (_, i) => swept[i - (i % BLOCK)]);
    const held = runBrowserSwept(device, { values, input, frames, notes, channels, sweptId: param, swept: blocky });
    let differs = 0;
    for (let i = 0; i < held.length; i++) differs = Math.max(differs, Math.abs(held[i] - browser[i]));
    assert.ok(differs > 1e-3, `${id}: sweeping ${param} per sample sounded no different from per block`);
  });
}

// ---- the convolver, which has no processor of ours to be compared against ----------------------
//
// Every device above is two implementations of one piece of JavaScript. The convolver is not: in
// the browser it is a graph of stock Web Audio nodes, so the thing the compiled device has to
// agree with is CHROMIUM. That cannot be imported, so it is written out here instead - from
// Blink's own source, cited in own/convolver.cc and own/dsp/convolve.h - and the compiled device
// is held to it:
//
//   - a delay that writes the sample and then reads back `delayTime * sampleRate` frames with
//     linear interpolation, so a predelay of nothing passes the signal through;
//   - a convolution, written here as the plain sum over the taps that it is by definition, which
//     is also what checks that the compiled device's partitioned transform is ALIGNED - an
//     overlap-save stage a sample out would pass every other test in this file;
//   - the gain a normalized response is given, which is the one number in all of this that could
//     only be read off Chromium: the response's RMS power inverted, a -58 dB calibration, and
//     44100 over the sample rate;
//   - the two filter sections, with Q in DECIBELS because that is what Web Audio means by Q on a
//     lowpass and a highpass.
//
// The five SPACES are poptart's own JavaScript, and they are the browser's own function here -
// so the responses themselves are compared, not a second opinion about them.

/** A context with just enough of one for synthesizeImpulse, which only asks for these two. */
function fakeContext(sampleRate) {
  return {
    sampleRate,
    createBuffer: (channels, length, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate: rate, numberOfChannels: channels, getChannelData: (i) => data[i] };
    },
  };
}

/** Blink's CalculateNormalizationScale, in the language the reference is written in. */
function normalizationScale(channels, frames, sampleRate) {
  let power = 0;
  for (const data of channels) for (let i = 0; i < frames; i++) power += data[i] * data[i];
  power = Math.sqrt(power / (channels.length * frames));
  if (!Number.isFinite(power) || power < 0.000125) power = 0.000125;
  return (1 / power) * (10 ** (0.05 * -58)) * (44100 / sampleRate);
}

/** A response, normalized as Chromium normalizes one: in place, and rounded to float. */
function normalized(left, right, sampleRate) {
  const scale = normalizationScale([left, right], left.length, sampleRate);
  const l = new Float32Array(left.length);
  const r = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) { l[i] = Math.fround(left[i] * scale); r[i] = Math.fround(right[i] * scale); }
  return { left: l, right: r, scale };
}

/** One of the five spaces, through the browser's own function. */
function spaceResponse(which, seconds) {
  const buffer = synthesizeImpulse(fakeContext(SAMPLE_RATE), IR_NAMES[which] ?? 'hall', seconds);
  return normalized(buffer.getChannelData(0), buffer.getChannelData(1), SAMPLE_RATE);
}

/** Blink's Delay, one channel. */
function delayLine(sampleRate) {
  const length = Math.max(2, Math.round(0.3 * sampleRate)) + 2;
  const buf = new Float64Array(length);
  let at = 0;
  return (x, frames) => {
    const want = Math.min(Math.max(frames, 0), length - 1);
    buf[at] = x;
    let read = at + length - want;
    while (read >= length) read -= length;
    const i1 = Math.floor(read);
    const frac = read - i1;
    const i2 = (i1 + 1) % length;
    at = (at + 1) % length;
    return buf[i1] + frac * (buf[i2] - buf[i1]);
  };
}

/** The whole device, as the browser's graph computes it. */
function convolverReference(descriptor, { values, input, frames, response }) {
  const v = {};
  descriptor.params.forEach((p, i) => { v[p.id] = Math.fround(values[i]); });
  const q = 10 ** (1 / 20);                       // a BiquadFilterNode's default Q, in dB
  const lowpass = BIQUAD_TYPES.indexOf('lowpass');
  const highpass = BIQUAD_TYPES.indexOf('highpass');
  const cut = [new Biquad(), new Biquad()];
  const damp = [new Biquad(), new Biquad()];
  for (const b of cut) b.set(highpass, v.lowcut, 0, q, SAMPLE_RATE);
  for (const b of damp) b.set(lowpass, v.damping, 0, q, SAMPLE_RATE);
  const pre = [delayLine(SAMPLE_RATE), delayLine(SAMPLE_RATE)];
  const taps = [response.left, response.right];
  const history = [new Float64Array(frames), new Float64Array(frames)];
  const out = new Float32Array(frames * 2);
  const gain = 10 ** (v.output / 20);
  const predelayFrames = Math.min(Math.max(v.predelay, 0), 0.3) * SAMPLE_RATE;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < frames; i++) history[ch][i] = pre[ch](input[i * 2 + ch], predelayFrames);
  }
  for (let ch = 0; ch < 2; ch++) {
    const ir = taps[ch];
    const n = Math.min(ir.length, frames);
    for (let i = 0; i < frames; i++) {
      let wet = 0;
      const until = Math.min(n - 1, i);
      for (let k = 0; k <= until; k++) wet += history[ch][i - k] * ir[k];
      wet = damp[ch].next(cut[ch].next(wet));
      out[i * 2 + ch] = Math.fround((input[i * 2 + ch] + wet * v.mix) * gain);
    }
  }
  return out;
}

const CONVOLVER = devices.find((d) => d.id === 'Convolver')?.device;

test('the gain a normalized response gets is the one Chromium gives it', () => {
  // A unit impulse has RMS power 1/sqrt(2 * frames) across two channels, so the scale is a
  // closed form and the formula can be checked rather than only mirrored.
  const left = new Float32Array(16);
  const right = new Float32Array(16);
  left[0] = 1;
  right[0] = 1;
  const scale = normalizationScale([left, right], 16, 44100);
  const want = Math.sqrt(16) * (10 ** (-58 / 20));
  assert.ok(Math.abs(scale - want) / want < 1e-12, `${scale} should be ${want}`);
  // And the sample rate divides it out: the same response read twice as fast is half the gain.
  assert.ok(Math.abs(normalizationScale([left, right], 16, 88200) - scale / 2) < 1e-12);
  // Silence is not amplified without limit.
  assert.ok(normalizationScale([new Float32Array(16), new Float32Array(16)], 16, 44100) <= 1 / 0.000125);
});

test('the Convolver convolves what Chromium would convolve', { skip: compiler ? false : 'no clang++' }, () => {
  const binary = buildHarness(devices);
  const frames = BLOCK * 16;
  const input = testSignal(frames, 2, 7);
  const irParam = CONVOLVER.params.findIndex((p) => p.id === 'ir');
  let loudest = 0;

  // Each of the five spaces, at the shortest length - which is the one whose every partition is
  // laid out on the block the space changes (see Convolver::prepare), so the comparison is of
  // the whole response rather than of a tail still arriving.
  for (let which = 0; which < IR_NAMES.length; which++) {
    const values = defaultValues(CONVOLVER).map((v, i) => (i === irParam ? which : v));
    values[CONVOLVER.params.findIndex((p) => p.id === 'size')] = 0.3;
    const response = spaceResponse(which, 0.3);
    const mine = runNative(binary, { id: 'Convolver', values, input, frames });
    const theirs = convolverReference(CONVOLVER, { values, input, frames, response });
    const { rmsA } = compare('Convolver', `the ${IR_NAMES[which]}`, mine, theirs);
    if (rmsA > loudest) loudest = rmsA;
  }

  // And across the range: predelay, the two filters, the mix and the output level, at four
  // settings from the same seeds every run.
  for (const seed of [11, 29, 97, 1234]) {
    const values = randomValues(CONVOLVER, seed);
    values[irParam] = 1;
    values[CONVOLVER.params.findIndex((p) => p.id === 'size')] = 0.3;
    const response = spaceResponse(1, 0.3);
    compare('Convolver', `at setting ${seed}`,
      runNative(binary, { id: 'Convolver', values, input, frames }),
      convolverReference(CONVOLVER, { values, input, frames, response }));
  }
  assert.ok(loudest > 1e-3, `the compiled convolver never put out anything (rms ${loudest})`);
});

test('a file loaded as the impulse response is convolved with, aligned', { skip: compiler ? false : 'no clang++' }, () => {
  // The sample path, end to end: a response read out of a file by the host, handed to the device
  // through pd_sample, and convolved with - compared against the plain sum over its taps. A
  // partitioned convolution a single sample out of alignment fails here and nowhere else.
  const binary = buildHarness(devices);
  const frames = BLOCK * 16;
  const input = testSignal(frames, 2, 13);
  const next = rng(5);
  // Longer than the directly-convolved head and than the first stage, so that more than one
  // partition size is in play.
  const taps = new Float32Array(2000);
  for (let i = 0; i < taps.length; i++) taps[i] = Math.fround((next() * 2 - 1) * Math.exp(-4 * i / taps.length));
  const file = writeFile(path.join(WORK, 'Convolver.f32'), taps);
  const slot = CONVOLVER.params.find((p) => p.id === 'ir').options.length;
  const irParam = CONVOLVER.params.findIndex((p) => p.id === 'ir');
  const values = defaultValues(CONVOLVER).map((v, i) => (i === irParam ? slot : v));
  // Nothing in the way of the convolution itself: no predelay, the filters out of the band, the
  // wet signal alone.
  values[CONVOLVER.params.findIndex((p) => p.id === 'predelay')] = 0;
  values[CONVOLVER.params.findIndex((p) => p.id === 'lowcut')] = 10;
  values[CONVOLVER.params.findIndex((p) => p.id === 'damping')] = 20000;
  values[CONVOLVER.params.findIndex((p) => p.id === 'mix')] = 1;
  const response = normalized(taps, taps, SAMPLE_RATE);
  const mine = runNative(binary, {
    id: 'Convolver', values, input, frames,
    samples: [{ param: irParam, slot, rate: SAMPLE_RATE, file }],
  });
  const theirs = convolverReference(CONVOLVER, { values, input, frames, response });
  const { rmsA } = compare('Convolver', 'with a file as its response', mine, theirs);
  assert.ok(rmsA > 1e-3, 'the loaded response made no sound');
});

// ---- what a device can be handed besides its controls ------------------------------------------
//
// A wavetable cut from a file, a drawn curve, a stereo response, and what a device reports back.
// Each reaches the compiled device the way the host hands it over (PdSample, /shape, the work
// calls, pd_report) and the browser's processor the way its engine posts it.

/** A file as interleaved frames, at a rate and in channels of its own. */
function interleave(channels) {
  const frames = channels[0].length;
  const out = new Float32Array(frames * channels.length);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels.length; c++) out[i * channels.length + c] = channels[c][i];
  return out;
}

/** A stack of waveforms, one per frame, each `length` long and brighter than the last. */
function tableFile(frames, length, { stereo = false, seed = 3 } = {}) {
  const next = rng(seed);
  const left = new Float32Array(frames * length);
  const right = new Float32Array(frames * length);
  for (let f = 0; f < frames; f++) {
    const harmonics = 1 + f * 3;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      let v = 0;
      for (let k = 1; k <= harmonics; k++) v += Math.sin(2 * Math.PI * k * t) / k;
      left[f * length + i] = Math.fround(v * 0.4 + (next() - 0.5) * 0.01);
      right[f * length + i] = Math.fround(v * 0.3);
    }
  }
  return stereo ? [left, right] : [left];
}

const WAVETABLE = devices.find((d) => d.id === 'Wavetable')?.device;

for (const [what, make] of [
  ['frames 256 long, as the file declares', () => ({ channels: tableFile(8, 256), rate: 44100, frameLength: 256 })],
  ['frames of the usual length, in stereo', () => ({ channels: tableFile(3, 2048, { stereo: true }), rate: 48000, frameLength: 0 })],
  ['a single cycle shorter than a frame', () => ({ channels: tableFile(1, 600), rate: 48000, frameLength: 0 })],
  ['frames that are not a power of two long', () => ({ channels: tableFile(5, 1000), rate: 48000, frameLength: 1000 })],
]) {
  test(`a Wavetable table cut from a file plays the same on both engines: ${what}`, { skip: compiler ? false : 'no clang++' }, () => {
    const binary = buildHarness(devices);
    const { channels, rate, frameLength } = make();
    const device = WAVETABLE;
    const tableParam = device.params.findIndex((p) => p.id === 'osc1.table');
    const slot = device.params[tableParam].options.length;
    const file = writeFile(path.join(WORK, 'Wavetable-table.f32'), interleave(channels));
    const values = defaultValues(device).map((v, i) => (i === tableParam ? slot : v));
    // Between two frames, so the position blend reads the table the file became.
    values[device.params.findIndex((p) => p.id === 'osc1.position')] = 0.4;
    const frames = BLOCK * 24;
    const notes = [{ frame: 0, note: 48, velocity: 0.9 }, { frame: BLOCK * 6 + 17, note: 79, velocity: 0.7 }];
    const native = runNative(binary, {
      id: 'Wavetable', values, input: new Float32Array(frames * 2), frames, notes,
      samples: [{ param: tableParam, slot, rate, channels: channels.length, frameLength, file }],
    });
    const browser = runBrowser(device, {
      values, input: new Float32Array(frames * 2), frames, notes,
      load: { param: 'osc1.table', slot, channels, rate, frameLength },
    });
    const { rmsA } = compare('Wavetable', `with a table cut from ${what}`, native, browser);
    assert.ok(rmsA > 1e-3, 'the loaded table made no sound');
    // And it is the FILE playing, not the first shipped table an empty slot falls back to.
    const shipped = runNative(binary, { id: 'Wavetable', values: values.map((v, i) => (i === tableParam ? 0 : v)), input: new Float32Array(frames * 2), frames, notes });
    let differs = 0;
    for (let i = 0; i < native.length; i++) differs = Math.max(differs, Math.abs(native[i] - shipped[i]));
    assert.ok(differs > 1e-3, 'the loaded table sounded exactly like the shipped one');
  });
}

/** A drawn curve, sampled at the engine's SHAPE_POINTS: lopsided, so it is nobody's named curve. */
function drawnTable(points = 256) {
  return Float32Array.from({ length: points }, (_, i) => {
    const x = i / (points - 1);
    return Math.fround(x < 0.5 ? 0.5 * Math.pow(x * 2, 0.4) : 0.5 + 0.45 * Math.pow((x - 0.5) * 2, 1.8));
  });
}

test('a drawn Distort curve shapes the same on both engines', { skip: compiler ? false : 'no clang++' }, () => {
  const binary = buildHarness(devices);
  const { device } = devices.find((d) => d.id === 'Distort');
  const mode = device.params.findIndex((p) => p.id === 'mode');
  const slot = device.params[mode].options.length;
  const table = drawnTable();
  const file = writeFile(path.join(WORK, 'Distort-shape.f32'), table);
  const frames = BLOCK * 24;
  const input = testSignal(frames);
  for (const [when, change] of [['at its defaults', {}], ['driven, with auto gain', { drive: 12, autogain: 1 }], ['oversampled', { oversample: 2, drive: 6 }]]) {
    const values = device.params.map((p, i) => (i === mode ? slot : (p.id in change ? change[p.id] : p.default)));
    const native = runNative(binary, { id: 'Distort', values, input, frames, shapes: [{ param: mode, slot, file }] });
    const browser = runBrowser(device, { values, input, frames, shapes: [{ param: 'mode', slot, table }] });
    compare('Distort', `on a drawn curve ${when}`, native, browser);
    // Not the straight clip a drawn mode with no curve plays.
    const empty = runNative(binary, { id: 'Distort', values, input, frames });
    let differs = 0;
    for (let i = 0; i < native.length; i++) differs = Math.max(differs, Math.abs(native[i] - empty[i]));
    assert.ok(differs > 1e-3, `Distort ${when}: the drawn curve sounded like no curve at all`);
  }
});

test('a drawn grain window and the grains reported play the same on both engines', { skip: compiler ? false : 'no clang++' }, () => {
  const binary = buildHarness(devices);
  const { device } = devices.find((d) => d.id === 'Granular');
  const sampleParam = device.params.findIndex((p) => p.id === 'sample');
  const sampleSlot = device.params[sampleParam].options.length;
  const windowParam = device.params.findIndex((p) => p.id === 'window');
  const windowSlot = device.params[windowParam].options.length;
  const table = Float32Array.from({ length: 256 }, (_, i) => Math.fround(Math.sin((Math.PI * i) / 255) ** 3));
  const sound = testFile();
  const sampleFile = writeFile(path.join(WORK, 'Granular-grains.f32'), sound.data);
  const shapeFile = writeFile(path.join(WORK, 'Granular-window.f32'), table);
  const values = device.params.map((p, i) => (i === sampleParam ? sampleSlot : i === windowParam ? windowSlot : p.default));
  const frames = BLOCK * 30;
  const notes = [{ frame: 5, note: 60, velocity: 1 }];
  const reportFile = path.join(WORK, 'Granular-report.f32');
  let theirs = null;
  const native = runNative(binary, {
    id: 'Granular', values, input: new Float32Array(frames * 2), frames, notes,
    samples: [{ param: sampleParam, slot: sampleSlot, rate: sound.rate, file: sampleFile }],
    shapes: [{ param: windowParam, slot: windowSlot, file: shapeFile }], report: reportFile,
  });
  const browser = runBrowser(device, {
    values, input: new Float32Array(frames * 2), frames, notes,
    load: { param: 'sample', slot: sampleSlot, data: sound.data, rate: sound.rate },
    shapes: [{ param: 'window', slot: windowSlot, table }], onDone: (synth) => { theirs = synth.report(); },
  });
  const { rmsA } = compare('Granular', 'through a drawn window', native, browser);
  assert.ok(rmsA > 1e-3, 'the granulator made no sound through its drawn window');

  const raw = fs.readFileSync(reportFile);
  const mine = [];
  for (let i = 0; i + 16 <= raw.length; i += 16) mine.push([0, 1, 2, 3].map((k) => raw.readFloatLE(i + k * 4)));
  assert.ok(theirs?.grains?.length > 0, 'the browser reported no grains');
  assert.equal(mine.length, theirs.grains.length, 'the two engines report a different number of grains');
  mine.forEach((g, i) => g.forEach((v, k) => {
    assert.ok(Math.abs(v - theirs.grains[i][k]) < 1e-5, `grain ${i} field ${k}: ${v} against ${theirs.grains[i][k]}`);
  }));
});

test('the compressor reports where the signal is on its curve, and the same history as the browser', { skip: compiler ? false : 'no clang++' }, () => {
  const binary = buildHarness(devices);
  const { device } = devices.find((d) => d.id === 'Compressor');
  const frames = BLOCK * 40;
  // Loud enough to be well over the default threshold, so there is reduction to report. Nothing
  // on the key: both engines then listen to the input itself (see pd_key_patched).
  const input = testSignal(frames, inChannelsOf(device), 5, false);
  const values = device.params.map((p) => p.default);
  const reportFile = path.join(WORK, 'Compressor-report.f32');
  let theirs = null;
  runNative(binary, { id: 'Compressor', values, input, frames, keyed: false, report: reportFile });
  runBrowser(device, { values, input, frames, channels: inChannelsOf(device), keyed: false, onDone: (fx) => { theirs = fx.report(); } });
  const raw = fs.readFileSync(reportFile);
  const floats = Array.from({ length: raw.length / 4 }, (_, i) => raw.readFloatLE(i * 4));
  const mine = readReport('Compressor', floats)?.meters?.curve;
  assert.ok(mine, 'the native compressor reported nothing');
  const curve = theirs?.meters?.curve;
  assert.ok(curve, 'the browser compressor reported nothing');
  assert.ok(curve.grDb < -1, `the test signal was not compressed: ${curve.grDb} dB`);
  const close = (a, b, what) => assert.ok(Math.abs(a - b) < 0.05, `${what}: ${a} against ${b}`);
  close(mine.inDb, curve.inDb, 'the level in');
  close(mine.grDb, curve.grDb, 'the reduction');
  assert.equal(mine.history.end, curve.history.end, 'entries written');
  close(mine.history.blockSec, curve.history.blockSec, 'seconds per entry');
  assert.equal(mine.history.inDb.length, curve.history.inDb.length, 'ring length');
  curve.history.inDb.forEach((v, i) => close(mine.history.inDb[i], v, `level entry ${i}`));
  curve.history.grDb.forEach((v, i) => close(mine.history.grDb[i], v, `reduction entry ${i}`));
});

/** A device's native report, decoded as the engine decodes it. */
function nativeReport(id, file) {
  const raw = fs.readFileSync(file);
  return readReport(id, Array.from({ length: raw.length / 4 }, (_, i) => raw.readFloatLE(i * 4)));
}

/** Two numbers, or two rings of them, the same to within a hair. */
function sameNumbers(mine, theirs, what, tolerance = 0.05) {
  const a = Array.isArray(mine) ? mine : [mine];
  const b = Array.isArray(theirs) ? theirs : [theirs];
  assert.equal(a.length, b.length, `${what}: ${a.length} entries against ${b.length}`);
  // Equal first: a limiter's first entries are minus infinity on both engines, and a difference of two infinities is not a number.
  b.forEach((v, i) => assert.ok(a[i] === v || Math.abs(a[i] - v) < tolerance, `${what}${b.length > 1 ? ` entry ${i}` : ''}: ${a[i]} against ${v}`));
}

/** A dynamics lane - the live pair and the two rings - the same on both engines. */
function sameLane(mine, theirs, what) {
  assert.ok(mine, `${what}: the native device reported nothing`);
  assert.ok(theirs, `${what}: the browser device reported nothing`);
  sameNumbers(mine.inDb, theirs.inDb, `${what} level in`);
  sameNumbers(mine.grDb, theirs.grDb, `${what} reduction`);
  assert.equal(mine.history.end, theirs.history.end, `${what} entries written`);
  sameNumbers(mine.history.blockSec, theirs.history.blockSec, `${what} seconds per entry`, 1e-6);
  sameNumbers(mine.history.inDb, theirs.history.inDb, `${what} level ring`);
  sameNumbers(mine.history.grDb, theirs.history.grDb, `${what} reduction ring`);
}

for (const id of ['Limiter', 'Multiband']) {
  test(`the ${id.toLowerCase()} reports the same lane${id === 'Multiband' ? 's' : ''} as the browser`, { skip: compiler ? false : 'no clang++' }, () => {
    const binary = buildHarness(devices);
    const { device } = devices.find((d) => d.id === id);
    const frames = BLOCK * 40;
    const input = testSignal(frames, 2, 5, false);
    // Driven hard enough to work: the limiter by its gain, the multiband by its thresholds.
    const values = device.params.map((p) => (p.id === 'gain' ? 18 : /threshold/.test(p.id) ? -40 : p.default));
    const reportFile = path.join(WORK, `${id}-report.f32`);
    let theirs = null;
    runNative(binary, { id, values, input, frames, report: reportFile });
    runBrowser(device, { values, input, frames, onDone: (fx) => { theirs = fx.report(); } });
    const mine = nativeReport(id, reportFile);
    assert.ok(mine, `the native ${id} reported nothing`);
    for (const key of Object.keys(theirs.meters)) {
      assert.ok(theirs.meters[key].grDb < -1, `${key}: the test signal was not compressed (${theirs.meters[key].grDb} dB)`);
      sameLane(mine.meters[key], theirs.meters[key], key);
    }
  });
}

test('the ducker reports the dip, the output under it and what is driving it, as the browser does', { skip: compiler ? false : 'no clang++' }, () => {
  const binary = buildHarness(devices);
  const { device } = devices.find((d) => d.id === 'Ducker');
  // Over a second: the clock only dips on a beat change, and the first beat seen is not one.
  const frames = BLOCK * 400;
  const channels = inChannelsOf(device);
  const values = device.params.map((p) => p.default);
  const ways = [
    { what: 'on the clock', keyed: false, notes: [] },
    { what: "on a routed track's notes", keyed: false, notes: [{ frame: BLOCK * 4, note: 60, velocity: 1 }, { frame: BLOCK * 200, note: 62, velocity: 1 }] },
    { what: 'on a key', keyed: true, notes: [] },
  ];
  for (const way of ways) {
    const input = testSignal(frames, channels, 11, way.keyed);
    const reportFile = path.join(WORK, 'Ducker-report.f32');
    let theirs = null;
    runNative(binary, { id: 'Ducker', values, input, frames, keyed: way.keyed, notes: way.notes, report: reportFile });
    runBrowser(device, { values, input, frames, channels, keyed: way.keyed, notes: way.notes, onDone: (fx) => { theirs = fx.report(); } });
    const mine = nativeReport('Ducker', reportFile);
    assert.ok(mine, `${way.what}: the native ducker reported nothing`);
    assert.equal(mine.trigger, theirs.trigger, `${way.what}: trigger`);
    assert.equal(mine.keyed, theirs.keyed, `${way.what}: keyed`);
    assert.equal(mine.history.end, theirs.history.end, `${way.what}: entries written`);
    sameNumbers(mine.history.blockSec, theirs.history.blockSec, `${way.what}: seconds per entry`, 1e-6);
    sameNumbers(mine.history.at, theirs.history.at, `${way.what}: place on the clock`, 1e-3);
    sameNumbers(mine.history.gain, theirs.history.gain, `${way.what}: gain ring`, 1e-3);
    sameNumbers(mine.history.out, theirs.history.out, `${way.what}: output ring`, 1e-3);
    if (theirs.history.key) sameNumbers(mine.history.key, theirs.history.key, `${way.what}: key ring`, 1e-3);
    else assert.equal(mine.history.key, null, `${way.what}: no key ring`);
    assert.ok(theirs.history.gain.some((g) => g < 0.9), `${way.what}: the browser ducker never dipped`);
  }
});

for (const id of ['Chorus', 'Flanger', 'Phaser']) {
  test(`the ${id.toLowerCase()} reports where its sweep is, as the browser does`, { skip: compiler ? false : 'no clang++' }, () => {
    const binary = buildHarness(devices);
    const { device } = devices.find((d) => d.id === id);
    const frames = BLOCK * 25;
    const input = testSignal(frames, 2, 3, false);
    const values = device.params.map((p) => p.default);
    const reportFile = path.join(WORK, `${id}-report.f32`);
    let theirs = null;
    runNative(binary, { id, values, input, frames, report: reportFile });
    runBrowser(device, { values, input, frames, onDone: (fx) => { theirs = fx.report(); } });
    const mine = nativeReport(id, reportFile);
    assert.ok(mine && Number.isFinite(mine.phase), `the native ${id} reported no phase`);
    assert.ok(theirs.phase > 0, `the browser ${id} did not move`);
    sameNumbers(mine.phase, theirs.phase, 'phase', 1e-4);
  });
}

test('a stereo file at another rate is convolved side by side, as Chromium convolves it', { skip: compiler ? false : 'no clang++' }, () => {
  const binary = buildHarness(devices);
  const frames = BLOCK * 16;
  const input = testSignal(frames, 2, 17);
  const next = rng(9);
  const rate = 44100;
  const taps = 1800;
  const left = new Float32Array(taps);
  const right = new Float32Array(taps);
  for (let i = 0; i < taps; i++) {
    left[i] = Math.fround((next() * 2 - 1) * Math.exp(-4 * i / taps));
    right[i] = Math.fround((next() * 2 - 1) * Math.exp(-7 * i / taps) * 0.6);
  }
  const file = writeFile(path.join(WORK, 'Convolver-stereo.f32'), interleave([left, right]));
  const slot = CONVOLVER.params.find((p) => p.id === 'ir').options.length;
  const irParam = CONVOLVER.params.findIndex((p) => p.id === 'ir');
  const values = defaultValues(CONVOLVER).map((v, i) => (i === irParam ? slot : v));
  values[CONVOLVER.params.findIndex((p) => p.id === 'predelay')] = 0;
  values[CONVOLVER.params.findIndex((p) => p.id === 'lowcut')] = 10;
  values[CONVOLVER.params.findIndex((p) => p.id === 'damping')] = 20000;
  values[CONVOLVER.params.findIndex((p) => p.id === 'mix')] = 1;
  // The browser's own resampling of a loaded response to the context's rate, then Chromium's
  // normalization of the two sides together.
  const buffer = bufferFromChannels(fakeContext(SAMPLE_RATE), { sampleRate: rate, channels: [left, right] });
  const response = normalized(buffer.getChannelData(0), buffer.getChannelData(1), SAMPLE_RATE);
  const mine = runNative(binary, {
    id: 'Convolver', values, input, frames,
    samples: [{ param: irParam, slot, rate, channels: 2, file }],
  });
  const theirs = convolverReference(CONVOLVER, { values, input, frames, response });
  const { rmsA } = compare('Convolver', 'with a stereo file at 44.1 kHz as its response', mine, theirs);
  assert.ok(rmsA > 1e-3, 'the loaded stereo response made no sound');
  // The two sides really are convolved apart: summing the response to one channel sounds different.
  const mono = Float32Array.from(left, (v, i) => Math.fround((v + right[i]) / 2));
  const summed = writeFile(path.join(WORK, 'Convolver-summed.f32'), mono);
  const flat = runNative(binary, { id: 'Convolver', values, input, frames, samples: [{ param: irParam, slot, rate, file: summed }] });
  let differs = 0;
  for (let i = 0; i < mine.length; i++) differs = Math.max(differs, Math.abs(mine[i] - flat[i]));
  assert.ok(differs > 1e-3, 'a stereo response sounded the same as its mono sum');
});
