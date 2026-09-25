// The wavetable oscillator. The test that matters here is the aliasing one: band-limiting
// against the post-warp traversal rate is the reason this oscillator is more than twenty lines,
// so it is measured rather than asserted, and measured against the naive read it replaces.

import test from 'node:test';
import assert from 'node:assert/strict';

import { harmonicsOf } from './src/dsp/fft.mjs';
import { buildTable, builtInTables } from './src/dsp/tables.mjs';
import { WavetableOscillator } from './src/dsp/oscillator.mjs';
import { WARP_INDEX } from './src/dsp/warp.mjs';

const SR = 48000;
const N = 8192;                     // one analysis window
const BIN = SR / N;                 // 5.859375 Hz - every test frequency is a whole number of these

const tables = builtInTables();
const basic = tables[0];
const sineTable = buildTable('Sine', [basic.mips[0][0]]);
const sawTable = buildTable('Saw', [basic.mips[2][0]]);

/** The same table with only its brightest level, which is the naive oscillator this replaces. */
function unlimited(table) {
  return { ...table, levels: 1, mips: table.mips.map((m) => [m[0]]) };
}

/** Renders `count` samples in blocks, the way a worklet would. */
function render(osc, count, { block = 128 } = {}) {
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  for (let at = 0; at < count; at += block) {
    const n = Math.min(block, count - at);
    bl.fill(0);
    br.fill(0);
    osc.process(bl, br, n, 0);
    left.set(bl.subarray(0, n), at);
    right.set(br.subarray(0, n), at);
  }
  return { left, right };
}

function makeOsc(table, frequency, over = {}) {
  const osc = new WavetableOscillator(SR);
  osc.setTable(table);
  osc.frequency = frequency;
  Object.assign(osc, over);
  osc.start(1);
  return osc;
}

/**
 * The share of the signal's energy that is NOT at a whole multiple of its own frequency.
 * Aliasing has nowhere else to land, so this is what it measures.
 */
function inharmonicEnergy(signal, fundamentalBin) {
  const { amp } = harmonicsOf(signal);
  let harmonic = 0;
  let other = 0;
  for (let k = 1; k < amp.length; k++) {
    const e = amp[k] * amp[k];
    // A whole multiple, give or take the one bin of smear a float32 render leaves behind.
    const ratio = k / fundamentalBin;
    const isHarmonic = Math.abs(ratio - Math.round(ratio)) * fundamentalBin < 1.5;
    if (isHarmonic) harmonic += e; else other += e;
  }
  return other / (harmonic + other);
}

test('a sine table plays a sine at the frequency it was asked for and nothing else', () => {
  const freq = BIN * 100;
  const osc = makeOsc(sineTable, freq);
  const { left } = render(osc, N);
  const { amp } = harmonicsOf(left);
  let loudest = 0;
  let loudestBin = 0;
  for (let k = 1; k < amp.length; k++) if (amp[k] > loudest) { loudest = amp[k]; loudestBin = k; }
  assert.equal(loudestBin, 100, 'the loudest bin should be the note itself');
  assert.ok(inharmonicEnergy(left, 100) < 1e-6, 'a sine should have nothing else in it');
});

// The point of the whole exercise. A saw at 3 kHz has room for eight harmonics under the
// Nyquist rate; its table holds 1024. Reading the table without band-limiting folds the other
// 1016 back down into the audible range as inharmonic hash.
test('a bright table played high does not alias, and the naive read it replaces does', () => {
  // The fundamental is deliberately an ODD number of bins, and so coprime with the window. A
  // frequency that divides the sample rate evenly - 3 kHz into 48 kHz, say - folds every one of
  // its aliased partials back onto one of its own harmonics, where no measurement of inharmonic
  // energy can see them, and the test would pass while the oscillator aliased freely.
  const freq = BIN * 301;   // about 1764 Hz, room for thirteen harmonics
  const limited = render(makeOsc(sawTable, freq), N).left;
  const naive = render(makeOsc(unlimited(sawTable), freq), N).left;

  const limitedNoise = inharmonicEnergy(limited, 301);
  const naiveNoise = inharmonicEnergy(naive, 301);

  assert.ok(limitedNoise < 1e-3, `band-limited render was ${(limitedNoise * 100).toFixed(3)}% inharmonic`);
  assert.ok(naiveNoise > limitedNoise * 50, `the naive read should be far worse: ${(naiveNoise * 100).toFixed(2)}% against ${(limitedNoise * 100).toFixed(3)}%`);
});

test('a warp that reads the table several times per cycle is band-limited for that rate too', () => {
  const freq = BIN * 101;   // about 592 Hz, where a saw alone has plenty of room
  const synced = makeOsc(sawTable, freq, { warpAmount: 1, warpMode: WARP_INDEX.sync });
  const noise = inharmonicEnergy(render(synced, N).left, 101);
  // Sync at full amount traverses the table sixteen times per cycle. Without measuring the
  // post-warp rate the oscillator would band-limit for 750 Hz and alias as if it were at 12 kHz.
  assert.ok(noise < 0.02, `synced render was ${(noise * 100).toFixed(2)}% inharmonic`);

  const naive = makeOsc(unlimited(sawTable), freq, { warpAmount: 1, warpMode: WARP_INDEX.sync });
  const naiveNoise = inharmonicEnergy(render(naive, N).left, 101);
  assert.ok(naiveNoise > noise * 3, `expected the naive read to be much worse, got ${(naiveNoise * 100).toFixed(2)}%`);
});

test('a low note keeps its harmonics - band-limiting must not just be a lowpass', () => {
  const freq = BIN * 8;   // about 47 Hz
  const { left } = render(makeOsc(sawTable, freq), N);
  const { amp } = harmonicsOf(left);
  // The hundredth harmonic of a 47 Hz saw sits at 4.7 kHz and must still be there.
  assert.ok(amp[8 * 100] > 0, 'the hundredth harmonic went missing');
  assert.ok(amp[8 * 100] > amp[8] / 200, 'the hundredth harmonic is far quieter than a 1/k saw should be');
});

test('unison holds its level: stacking copies must not make the patch louder', () => {
  const freq = BIN * 40;
  const rms = (buf) => Math.sqrt(buf.reduce((a, b) => a + b * b, 0) / buf.length);
  const one = rms(render(makeOsc(sawTable, freq, { unison: 1 }), N).left);
  for (const unison of [2, 4, 8]) {
    const many = rms(render(makeOsc(sawTable, freq, { unison, detuneCents: 12, phaseRand: 1 }), N).left);
    const ratio = many / one;
    assert.ok(ratio > 0.55 && ratio < 1.5, `unison ${unison} came out ${ratio.toFixed(2)}x the level of one copy`);
  }
});

test('detune spreads the copies in pitch, and zero detune leaves them all in tune', () => {
  const freq = BIN * 100;
  const spread = render(makeOsc(sawTable, freq, { unison: 4, detuneCents: 50 }), N).left;
  const tight = render(makeOsc(sawTable, freq, { unison: 4, detuneCents: 0 }), N).left;
  const width = (signal) => {
    const { amp } = harmonicsOf(signal);
    // Energy either side of the fundamental bin is what a detune puts there.
    let around = 0;
    for (let k = 95; k <= 105; k++) if (k !== 100) around += amp[k] * amp[k];
    return around / (amp[100] * amp[100]);
  };
  assert.ok(width(spread) > width(tight) * 10, 'detuning should smear the fundamental');
  assert.ok(width(tight) < 1e-3, 'copies with no detune should land on one pitch');
});

test('pan spread moves the copies apart without moving a single copy off center', () => {
  const freq = BIN * 60;
  const mono = makeOsc(sawTable, freq, { unison: 1, panSpread: 1 });
  const { left: l1, right: r1 } = render(mono, N);
  for (let i = 0; i < N; i++) assert.ok(Math.abs(l1[i] - r1[i]) < 1e-6, 'one copy should sit in the middle');

  const wide = makeOsc(sawTable, freq, { unison: 4, detuneCents: 20, panSpread: 1, phaseRand: 1 });
  const { left, right } = render(wide, N);
  let difference = 0;
  for (let i = 0; i < N; i++) difference += (left[i] - right[i]) ** 2;
  assert.ok(difference > 0, 'a spread unison should differ between the channels');
});

test('a phase offset moves the waveform, and an array of it is read per sample', () => {
  const freq = BIN * 50;
  const dry = render(makeOsc(sineTable, freq), N).left;
  // Half a cycle of phase shift inverts a sine.
  const shifted = render(makeOsc(sineTable, freq, { phase: 0.5 }), N).left;
  for (let i = 0; i < 2000; i++) assert.ok(Math.abs(dry[i] + shifted[i]) < 1e-5, `sample ${i} was not inverted`);

  // A per-sample buffer is what a bus patched into the parameter actually arrives as, and the
  // oscillator reads it from the offset it is given - the second half of this block is the
  // shifted sine, the first half is not.
  const block = new Float32Array(256);
  block.fill(0.5, 128);
  const osc = makeOsc(sineTable, freq, { phaseA: block });
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  osc.process(l, r, 128, 128);
  const ref = makeOsc(sineTable, freq, { phase: 0.5 });
  const l2 = new Float32Array(128);
  const r2 = new Float32Array(128);
  ref.process(l2, r2, 128, 0);
  for (let i = 0; i < 128; i++) assert.ok(Math.abs(l[i] - l2[i]) < 1e-6, `sample ${i} should read the array at its offset`);
});

test('a signal on the semitone control is frequency modulation: twelve up doubles the pitch', () => {
  const freq = BIN * 50;
  const still = render(makeOsc(sineTable, freq, { semis: 12 }), N).left;
  const moving = render(makeOsc(sineTable, freq, { semisA: new Float32Array(128).fill(12) }), N).left;
  for (const [label, signal] of [['still', still], ['moving', moving]]) {
    const { amp } = harmonicsOf(signal);
    let loudest = 0;
    let loudestBin = 0;
    for (let k = 1; k < amp.length; k++) if (amp[k] > loudest) { loudest = amp[k]; loudestBin = k; }
    assert.equal(loudestBin, 100, `${label}: one octave up should double the frequency`);
  }
});

test('a swept position and a swept warp are read per sample, not once a block', () => {
  const freq = BIN * 40;
  // A position ramp across one block: the first sample reads the first frame, the last the
  // second. Rendered against the two still positions it must land between.
  const ramp = new Float32Array(128);
  for (let i = 0; i < 128; i++) ramp[i] = (i / 127) / (basic.frameCount - 1);
  const swept = makeOsc(basic, freq, { positionA: ramp });
  const l = new Float32Array(128); const r = new Float32Array(128);
  swept.process(l, r, 128, 0);
  const first = makeOsc(basic, freq, { position: 0 });
  const l0 = new Float32Array(128); const r0 = new Float32Array(128);
  first.process(l0, r0, 128, 0);
  const second = makeOsc(basic, freq, { position: 1 / (basic.frameCount - 1) });
  const l1 = new Float32Array(128); const r1 = new Float32Array(128);
  second.process(l1, r1, 128, 0);
  assert.ok(Math.abs(l[0] - l0[0]) < 1e-6, 'the first sample reads the first frame');
  assert.ok(Math.abs(l[127] - l1[127]) < 1e-6, 'the last sample reads the second frame');
  let between = false;
  for (let i = 30; i < 100; i++) if (Math.abs(l[i] - l0[i]) > 1e-4 && Math.abs(l[i] - l1[i]) > 1e-4) { between = true; break; }
  assert.ok(between, 'the middle of the block is neither frame, which a per-block read could not do');

  // The warp: a block whose amount steps from zero to full halfway must render the first half
  // as an unwarped saw and the second half warped.
  const warp = new Float32Array(128);
  warp.fill(1, 64);
  const half = makeOsc(sawTable, freq, { warpAmountA: warp, warpMode: WARP_INDEX.sync });
  const hl = new Float32Array(128); const hr = new Float32Array(128);
  half.process(hl, hr, 128, 0);
  const plain = makeOsc(sawTable, freq);
  const pl = new Float32Array(128); const pr = new Float32Array(128);
  plain.process(pl, pr, 128, 0);
  // The band limit is chosen for the block's worst case, so the unwarped half is duller than a
  // plain saw - but it is a saw, not a synced one: the two agree far more closely than the
  // warped half does.
  let firstHalf = 0; let secondHalf = 0;
  for (let i = 0; i < 64; i++) firstHalf += Math.abs(hl[i] - pl[i]);
  for (let i = 64; i < 128; i++) secondHalf += Math.abs(hl[i] - pl[i]);
  assert.ok(secondHalf > firstHalf * 4, `the warp should only take hold halfway: ${firstHalf.toFixed(3)} before, ${secondHalf.toFixed(3)} after`);
});

test('a note is reproducible: the same seed renders the same samples', () => {
  const freq = BIN * 33;
  const a = render(makeOsc(sawTable, freq, { unison: 6, detuneCents: 25, phaseRand: 1 }), 4096).left;
  const b = render(makeOsc(sawTable, freq, { unison: 6, detuneCents: 25, phaseRand: 1 }), 4096).left;
  assert.deepEqual([...a], [...b]);
});

test('no phase randomization means every copy starts together, which is a hard attack', () => {
  const osc = makeOsc(sawTable, BIN * 20, { unison: 6, detuneCents: 20, phaseRand: 0 });
  for (let i = 1; i < 6; i++) assert.equal(osc.phases[i], osc.phases[0]);
});

test('an oscillator with no table renders silence rather than throwing', () => {
  const osc = new WavetableOscillator(SR);
  const l = new Float32Array(64);
  const r = new Float32Array(64);
  osc.process(l, r, 64, 0);
  assert.ok(l.every((v) => v === 0) && r.every((v) => v === 0));
});

test('the position sweeps between frames, and the ends of the sweep are the end frames', () => {
  const freq = BIN * 40;
  const atSine = render(makeOsc(basic, freq, { position: 0 }), N).left;
  const pureSine = render(makeOsc(sineTable, freq), N).left;
  for (let i = 0; i < 1000; i++) assert.ok(Math.abs(atSine[i] - pureSine[i]) < 1e-5, `position 0 should be the first frame`);

  // Halfway between two frames is neither of them but is bounded by both.
  const mid = render(makeOsc(basic, freq, { position: 0.5 / (basic.frameCount - 1) }), N).left;
  let differs = false;
  for (let i = 0; i < 1000; i++) if (Math.abs(mid[i] - atSine[i]) > 1e-4) { differs = true; break; }
  assert.ok(differs, 'a position between frames should not be the first frame');
});

test('nothing rendered is out of range or not a number, across every warp mode', () => {
  for (let mode = 0; mode < 18; mode++) {
    const osc = makeOsc(basic, BIN * 90, { warpAmount: 0.8, warpMode: mode, position: 0.4, unison: 3, detuneCents: 15 });
    const { left, right } = render(osc, 2048);
    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(left[i]) && Math.abs(left[i]) < 8, `mode ${mode} left sample ${i} was ${left[i]}`);
      assert.ok(Number.isFinite(right[i]) && Math.abs(right[i]) < 8, `mode ${mode} right sample ${i} was ${right[i]}`);
    }
  }
});
