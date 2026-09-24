// Nothing steps at the block rate.
//
// This is the test that should have existed before any of these devices shipped. A control that
// is swept - by a hand on a knob, by an envelope, by an LFO - reaches a device as an AudioParam
// full of per-sample values, and a device that reads it ONCE and uses that for the whole block
// turns a smooth sweep into a hundred and fifty steps a second. That is zipper noise, and it is
// not subtle: it is a buzz riding the sound at a pitch nobody chose.
//
// It kept coming back because it is invisible to every other kind of test. The device renders,
// the numbers are finite, the response is at the right frequency - and it sounds wrong.
//
// WHAT IS MEASURED. A control stepping once a block modulates the signal at the block rate, and
// modulation puts SIDEBANDS either side of whatever is playing - at the carrier plus and minus
// the block rate, and its multiples. So a steady tone goes in, the control is swept, and the
// sidebands are measured against the noise between them. Each test renders the sweep twice: once
// handed over per sample, as an automated parameter really arrives, and once as a staircase of
// one value per block. The staircase is the CALIBRATION - it is what the artifact looks like, so
// a test that cannot tell the two apart is a test that has stopped working, and it says so.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, denormalize, findParam, normalize } from './src/descriptor.mjs';
import { FILTER, FilterProcessor } from './src/devices/filter.mjs';
import { EQ, EqProcessor } from './src/devices/eq.mjs';
import { OVERDRIVE, OverdriveProcessor } from './src/devices/overdrive.mjs';
import { DISTORT, DistortProcessor } from './src/devices/distort.mjs';
import { MULTIBAND, MultibandProcessor } from './src/devices/multiband.mjs';
import { CRUSH, CrushProcessor } from './src/devices/crush.mjs';
import { VOCODER, VocoderProcessor } from './src/devices/vocoder.mjs';
import { FMSYNTH, FmSynth } from './src/devices/fmsynth.mjs';

const SR = 48000;
const BLOCK = 128;
const BLOCKS = 64;
const N = BLOCK * BLOCKS;
const CARRIER = 220;
const BLOCK_RATE = SR / BLOCK;

/** One frequency's amplitude, windowed - unwindowed, the carrier leaks into every bin. */
function magnitudeAt(x, hz) {
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
    const s = x[i] * window + coefficient * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2)) / x.length;
}

/**
 * How far the block-rate sidebands stand above the spectrum between them, in decibels.
 *
 * `carrier` is what they are measured either side of - the tone going through an effect, or the
 * note a synth is holding.
 */
function sidebandsDb(x, carrier = CARRIER) {
  let line = 0;
  for (const k of [1, 2]) {
    for (const side of [1, -1]) line = Math.max(line, magnitudeAt(x, carrier + side * BLOCK_RATE * k));
  }
  const floor = Math.max(
    magnitudeAt(x, carrier + BLOCK_RATE * 0.5),
    magnitudeAt(x, carrier - BLOCK_RATE * 0.5),
    magnitudeAt(x, carrier + BLOCK_RATE * 1.5),
  );
  return 20 * Math.log10(line / Math.max(1e-15, floor));
}

/**
 * Renders a device with one control swept from `from` to `to`, and answers with the block-rate
 * artifact in each output channel.
 */
function sweep(Processor, descriptor, sweptId, from, to, fixed = {}) {
  const fx = new Processor(SR, BLOCK);
  const param = findParam(descriptor, sweptId);
  const values = { ...defaultValues(descriptor), ...fixed };
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  const input = new Float32Array(BLOCK);
  const lowPos = normalize(param, from);
  const highPos = normalize(param, to);
  let phase = 0;

  for (let b = 0; b < BLOCKS; b++) {
    for (let i = 0; i < BLOCK; i++) {
      input[i] = Math.sin(2 * Math.PI * phase) * 0.5;
      phase += CARRIER / SR;
    }
    // Handed over per SAMPLE, which is how an automated parameter really arrives.
    const swept = new Float64Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      swept[i] = denormalize(param, lowPos + (highPos - lowPos) * ((b * BLOCK + i) / N));
    }
    fx.process(
      [input, input],
      [left.subarray(b * BLOCK, (b + 1) * BLOCK), right.subarray(b * BLOCK, (b + 1) * BLOCK)],
      BLOCK,
      { ...values, [sweptId]: swept },
    );
  }
  // The opening blocks are the device settling from silence, which is a real transient.
  const settled = (x) => x.subarray(BLOCK * 8);
  return { left: sidebandsDb(settled(left)), right: sidebandsDb(settled(right)) };
}

/**
 * The two ends of the scale, measured rather than assumed: the same tone under a gain that moves
 * smoothly, and under one that jumps once a block.
 *
 * Every threshold below is read off these. A device is not asked to beat a number somebody
 * picked - it is asked to look more like the smooth one than the stepped one, at this carrier,
 * at this block size, in this test run. If the two ever stop being far apart, the measurement
 * has stopped working and the tests say so instead of quietly passing.
 */
function reference(stepped) {
  const out = new Float32Array(N);
  let phase = 0;
  for (let b = 0; b < BLOCKS; b++) {
    for (let i = 0; i < BLOCK; i++) {
      const at = b * BLOCK + i;
      const gain = 0.4 + 0.3 * Math.sin((2 * Math.PI * 0.7 * (stepped ? b * BLOCK : at)) / SR);
      out[at] = Math.sin(2 * Math.PI * phase) * gain;
      phase += CARRIER / SR;
    }
  }
  return sidebandsDb(out.subarray(BLOCK * 8));
}

const SMOOTH_DB = reference(false);
const STEPPED_DB = reference(true);

/** Halfway between the two, in decibels: past this a device is stepping rather than sweeping. */
const LIMIT_DB = (SMOOTH_DB + STEPPED_DB) / 2;

test('the measurement can tell a smooth sweep from a stepped one', () => {
  // Without this every assertion below is an empty one.
  assert.ok(
    STEPPED_DB - SMOOTH_DB > 12,
    `a gain stepping once a block measured ${STEPPED_DB.toFixed(1)} dB of block-rate sidebands and `
    + `a smooth one ${SMOOTH_DB.toFixed(1)} - too close to tell apart, so this file proves nothing`,
  );
});

function assertSmooth(what, Processor, descriptor, id, from, to, fixed = {}) {
  const measured = sweep(Processor, descriptor, id, from, to, fixed);
  for (const channel of ['left', 'right']) {
    assert.ok(
      measured[channel] < LIMIT_DB,
      `${what} (${channel}): a swept control put ${measured[channel].toFixed(1)} dB of block-rate sidebands `
      + `into the output, against ${SMOOTH_DB.toFixed(1)} for a smooth sweep and ${STEPPED_DB.toFixed(1)} for `
      + 'a stepped one - it is stepping',
    );
  }
}

test('sweeping a filter cutoff is smooth, in BOTH channels', () => {
  // The report this exists for. The tuning was recomputed inside the left channel's loop and the
  // right channel then used whatever the last sample of that loop had left behind - one tuning
  // for its whole block. Smooth on the left, a staircase on the right, which is why it was heard
  // on a stereo track and not on a mono one.
  for (const mode of ['lowpass', 'lowpass 24', 'ladder', 'bandpass', 'formant']) {
    const m = FILTER.params.find((p) => p.id === 'mode').options.indexOf(mode);
    assertSmooth(`filter cutoff (${mode})`, FilterProcessor, FILTER, 'cutoff', 300, 6000, { mode: m, resonance: 0.5 });
  }
  assertSmooth('filter resonance', FilterProcessor, FILTER, 'resonance', 0, 0.95, { cutoff: 700 });
});

test('sweeping an equalizer band is smooth', () => {
  assertSmooth('eq freq', EqProcessor, EQ, 'band2.freq', 200, 4000, { 'band2.gain': 12, 'band2.q': 4 });
  assertSmooth('eq gain', EqProcessor, EQ, 'band2.gain', -18, 18, { 'band2.freq': 250, 'band2.q': 4 });
});

test('sweeping the driven region of an overdrive is smooth', () => {
  assertSmooth('overdrive low', OverdriveProcessor, OVERDRIVE, 'low', 40, 3000);
  assertSmooth('overdrive high', OverdriveProcessor, OVERDRIVE, 'high', 400, 16000);
});

test('sweeping a distortion drive is smooth, auto gain and all', () => {
  // Auto gain is worked out once a block by probing the curve, so it is a staircase unless it is
  // walked across the block - which is what made the drive knob buzz.
  assertSmooth('distort drive', DistortProcessor, DISTORT, 'drive', 0, 36, { autogain: 1, mode: 0 });
  assertSmooth('distort tone', DistortProcessor, DISTORT, 'tone', 600, 18000, { drive: 12 });
});

test('sweeping a multiband crossover is smooth', () => {
  assertSmooth('multiband split', MultibandProcessor, MULTIBAND, 'lowsplit', 60, 1800);
});

test('sweeping a crush tone and a vocoder band edge is smooth', () => {
  assertSmooth('crush tone', CrushProcessor, CRUSH, 'tone', 400, 16000, { bits: 16, rate: 24000 });
  assertSmooth('vocoder low', VocoderProcessor, VOCODER, 'low', 80, 900);
});

// --- a synth's own controls ------------------------------------------------------------------
//
// Everything above is an effect with a tone going through it. A synth makes its own tone, and its
// hot controls are read the same way: once a block, at the head of whatever the parameter handed
// over. The FM matrix is the worst case of it - every cell is read on every sample of every
// voice, and a modulation index that jumps at the block boundary buzzes for as long as a cell is
// being dragged, which is exactly while somebody is looking for a sound.

/** The note the FM tests hold, as a fixed frequency so the carrier is exact. */
const FM_CARRIER = 2000;
const FM_MOD = 1000;

/** Both operators flat and silent-enveloped, so the only thing moving is the control under test. */
const fmFlat = () => ({
  ...defaultValues(FMSYNTH),
  'op1.fixed': 1, 'op1.ratio': FM_CARRIER / 100, 'op1.level': 1,
  'op1.attack': 0, 'op1.decay': 0, 'op1.sustain': 1, 'op1.release': 0, 'op1.velocity': 0,
  'op2.fixed': 1, 'op2.ratio': FM_MOD / 100, 'op2.level': 0,
  'op2.attack': 0, 'op2.decay': 0, 'op2.sustain': 1, 'op2.release': 0, 'op2.velocity': 0,
});

/** Renders the FM synth holding one note with a single control swept across the whole render. */
function fmSweep(sweptId, from, to, fixed = {}) {
  const synth = new FmSynth(SR);
  const param = findParam(FMSYNTH, sweptId);
  const values = { ...fmFlat(), ...fixed };
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  const lowPos = normalize(param, from);
  const highPos = normalize(param, to);

  synth.setParams(values);
  synth.queueNoteOn(60, 1, 0);
  for (let b = 0; b < BLOCKS; b++) {
    // Handed over per SAMPLE, which is how an automated parameter really arrives.
    const swept = new Float64Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      swept[i] = denormalize(param, lowPos + (highPos - lowPos) * ((b * BLOCK + i) / N));
    }
    synth.setParams({ ...values, [sweptId]: swept });
    synth.process(left.subarray(b * BLOCK, (b + 1) * BLOCK), right.subarray(b * BLOCK, (b + 1) * BLOCK), BLOCK);
  }
  const settled = (x) => x.subarray(BLOCK * 8);
  return { left: sidebandsDb(settled(left), FM_CARRIER), right: sidebandsDb(settled(right), FM_CARRIER) };
}

function assertSynthSmooth(what, id, from, to, fixed = {}) {
  const measured = fmSweep(id, from, to, fixed);
  for (const channel of ['left', 'right']) {
    assert.ok(
      measured[channel] < LIMIT_DB,
      `${what} (${channel}): a swept control put ${measured[channel].toFixed(1)} dB of block-rate sidebands `
      + `into the output, against ${SMOOTH_DB.toFixed(1)} for a smooth sweep and ${STEPPED_DB.toFixed(1)} for `
      + 'a stepped one - it is stepping',
    );
  }
}

test('sweeping an FM matrix cell is smooth', () => {
  // The report this exists for: dragging a cell buzzed. Every cell was taken from the head of its
  // block and held there for the whole of it.
  assertSynthSmooth('mod 2 to 1', 'mod.2.1', 0, 0.6);
});

test('sweeping the FM depth is smooth, since it is the matrix by another name', () => {
  assertSynthSmooth('depth', 'depth', 0, 1, { 'mod.2.1': 0.4 });
});

test("sweeping an FM operator's level is smooth", () => {
  assertSynthSmooth('op 1 level', 'op1.level', 0.2, 1, { 'mod.2.1': 0.3 });
});

// An operator's FEEDBACK is ramped by the same machinery and is deliberately NOT tested here:
// self-modulation smears its artifact across the spectrum instead of putting it either side of
// the carrier, so this instrument cannot see it, and an assertion that passes whatever the code
// does is worse than no assertion. The three above do fail when the ramp is taken out.
