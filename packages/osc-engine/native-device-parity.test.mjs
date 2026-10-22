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
import { IR_NAMES, synthesizeImpulse } from '../web-engine/src/devices/builtins.mjs';
import { Biquad, BIQUAD_TYPES } from '../web-engine/src/dsp/biquad.mjs';

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
  // Convolver is deliberately not here: there is no JavaScript processor for it to be compared
  // against, because in the browser it IS a ConvolverNode. It has a test of its own at the end
  // of this file, against Chromium's documented behavior.
};

/** The devices whose browser side is a stock Web Audio node rather than a processor of ours. */
const STOCK_NODES = new Set(['Convolver']);

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
function runNative(binary, { id, values, input, frames, notes = [], bpm = 120, keyed = null, samples = [] }) {
  const stdin = Buffer.alloc(values.length * 4 + input.length * 4);
  for (let i = 0; i < values.length; i++) stdin.writeFloatLE(Math.fround(values[i]), i * 4);
  for (let i = 0; i < input.length; i++) stdin.writeFloatLE(input[i], values.length * 4 + i * 4);
  const args = [id, String(SAMPLE_RATE), String(frames), String(BLOCK), String(bpm)];
  if (keyed !== null) args.push('-k', keyed ? '1' : '0');
  for (const one of samples) args.push('-S', `${one.param}:${one.slot}:${one.rate}:${one.file}`);
  for (const n of notes) args.push('-n', `${n.frame}:${n.note}:${n.velocity}`);
  const run = spawnSync(binary, args, { input: stdin, maxBuffer: 1 << 28 });
  assert.equal(run.status, 0, `${id}: the harness failed - ${run.stderr?.toString()}`);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < out.length; i++) out[i] = run.stdout.readFloatLE(i * 4);
  return out;
}

/**
 * The same run through the browser's own processor, block by block as a worklet would.
 *
 * An instrument has a different surface from an effect - setParams, queueNoteOn, setBend and a
 * process that is handed its two output channels - exactly as the two worklets that host them do
 * (web-engine/src/worklets), so this stands in for both.
 */
function runBrowser(descriptor, { values, input, frames, notes = [], bpm = 120, channels = 2, keyed = true, load = null }) {
  if (descriptor.kind === 'synth') return runBrowserSynth(descriptor, { values, frames, notes, bpm, load });
  const Processor = PROCESSORS[descriptor.id];
  const fx = new Processor(SAMPLE_RATE);
  if (load) fx.loadSample(load.param, load.slot, { channels: [load.data], sampleRate: load.rate });
  if (typeof fx.setTempo === 'function') fx.setTempo(bpm, 0);
  const params = {};
  descriptor.params.forEach((p, i) => { params[p.id] = Math.fround(values[i]); });
  const out = new Float32Array(frames * 2);
  const inputs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const outputs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  // A sidechained device is handed its key as a second input, exactly as the browser's host
  // hands it one: `inputs[1]` of the worklet node, which is a pair of its own.
  const key = channels >= 4 && keyed ? [new Float32Array(BLOCK), new Float32Array(BLOCK)] : null;
  let nextNote = 0;
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    while (nextNote < notes.length && notes[nextNote].frame < at + n) {
      const one = notes[nextNote++];
      if (one.velocity > 0) fx.noteOn?.(one.note, one.velocity, 0);
      else fx.noteOff?.(one.note);
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
    outputs[0].fill(0);
    outputs[1].fill(0);
    fx.process(inputs, outputs, n, params, key, at / SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      out[(at + i) * 2] = outputs[0][i];
      out[(at + i) * 2 + 1] = outputs[1][i];
    }
  }
  return out;
}

/** An instrument, played the way the synth worklet plays one. */
function runBrowserSynth(descriptor, { values, frames, notes, bpm, load = null }) {
  const Synth = PROCESSORS[descriptor.id];
  const synth = new Synth(SAMPLE_RATE);
  // A file the device plays, handed over as the engine hands one over: plain channels of
  // samples at the file's own rate (web-audio-engine.mjs's _loadSampleParam).
  if (load) synth.loadSample(load.param, load.slot, { channels: [load.data], sampleRate: load.rate });
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
    // Notes land at the start of the block they arrive in, which is where they land on the
    // desktop: an engine sends a note to a device between blocks, with no offset into one.
    while (nextNote < notes.length && notes[nextNote].frame < at + n) {
      const one = notes[nextNote++];
      if (one.velocity > 0) synth.queueNoteOn(one.note, one.velocity, 0);
      else synth.queueNoteOff(one.note, 0);
    }
    left.fill(0);
    right.fill(0);
    synth.process(left, right, n);
    for (let i = 0; i < n; i++) {
      out[(at + i) * 2] = left[i];
      out[(at + i) * 2 + 1] = right[i];
    }
  }
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
    const channels = device.sidechain ? 4 : 2;
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

      for (const [when, values] of runs) {
        // A chaotic device is compared sample for sample at a patch that is stable, and by its
        // level at the one that is not (see CHAOTIC).
        const stable = pointAtFile(thinned(device, values, runs.indexOf(runs.find(([w]) => w === when)) + 1));
        const { rmsA } = compare(one.id, `${way.what} ${when}`.trim(),
          runNative(binary, { id: one.id, values: stable, input, frames, notes, keyed, samples }),
          runBrowser(device, { values: stable, input, frames, notes, channels, keyed: keyed !== false, load }));
        if (rmsA > loudest) loudest = rmsA;
        if (CHAOTIC[device.id] && stable !== values) {
          compareEnvelope(one.id, `${way.what} ${when}, every path open`.trim(),
            runNative(binary, { id: one.id, values, input, frames, notes, keyed, samples }),
            runBrowser(device, { values, input, frames, notes, channels, keyed: keyed !== false, load }));
        }
      }
    }
    // Two silences are identical, which would make this test pass for a device that does nothing
    // at all - so somewhere in all of that the device has to have made a sound.
    assert.ok(loudest > 1e-3, `${one.id}: the compiled device never put out anything (rms ${loudest})`);
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
