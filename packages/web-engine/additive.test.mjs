import test from 'node:test';
import assert from 'node:assert/strict';

import { ADDITIVE, ADDITIVE_PARTIALS, AdditiveSynth, spectrumLevel } from './src/devices/additive.mjs';
import { hashPhase } from './src/dsp/oscillator.mjs';
import { midiToHz } from './src/dsp/voice.mjs';

const SR = 48000;
const BLOCK = 128;

const defaults = () => Object.fromEntries(ADDITIVE.params.map((p) => [p.id, p.default]));

/** A synth playing `notes` from the first block, with `settings` over the defaults. */
function playing(settings = {}, notes = [48]) {
  const synth = new AdditiveSynth(SR);
  const values = { ...defaults(), ...settings };
  synth.setParams(values);
  synth.setBend(0);
  for (const note of notes) synth.queueNoteOn(note, 1, 0);
  return { synth, values };
}

/** `blocks` blocks of the left channel; `each(b)` may change the controls before block b. */
function render(synth, values, blocks, each = null) {
  const out = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    each?.(b, values);
    synth.setParams(values);
    l.fill(0);
    r.fill(0);
    synth.process(l, r, BLOCK);
    out.set(l, b * BLOCK);
  }
  return out;
}

test('the partials sit at whole-number ratios of the note, and Stretch pulls them apart', () => {
  for (const stretch of [0, 0.03, -0.2]) {
    const { synth, values } = playing({ partials: 8, stretch });
    render(synth, values, 2);
    const v = synth.voices[0];
    const hz = midiToHz(48);
    for (let k = 0; k < 8; k++) {
      assert.ok(Math.abs((v.inc[k] * SR) / hz - Math.pow(k + 1, 1 + stretch)) < 1e-9, `partial ${k + 1} at stretch ${stretch}`);
    }
  }
});

test('Partials sets how many play, and the ones past Nyquist are left out', () => {
  const { synth, values } = playing({ partials: 5 });
  render(synth, values, 2);
  const g = synth.voices[0].gain;
  for (let k = 0; k < 5; k++) assert.ok(g[k] > 0, `partial ${k + 1} plays`);
  for (let k = 5; k < ADDITIVE_PARTIALS; k++) assert.equal(g[k], 0, `partial ${k + 1} is out`);

  // A high note: 64 partials of 2.6 kHz reach far past 24 kHz.
  const high = playing({ partials: 64 }, [100]);
  render(high.synth, high.values, 2);
  const hz = midiToHz(100);
  const voice = high.synth.voices[0];
  for (let k = 0; k < ADDITIVE_PARTIALS; k++) {
    if ((k + 1) * hz >= SR / 2) assert.equal(voice.gain[k], 0, `partial ${k + 1} at ${((k + 1) * hz).toFixed(0)} Hz`);
    if ((k + 1) * hz < 0.4 * SR) assert.ok(voice.gain[k] > 0, `partial ${k + 1} under the fade plays`);
  }
});

test('Tilt is a slope in decibels an octave, and the levels are brought to one loudness', () => {
  for (const tilt of [0, -6, -12, 6]) {
    const { synth, values } = playing({ partials: 16, tilt });
    render(synth, values, 2);
    const g = synth.voices[0].gain;
    const db = 20 * Math.log10(g[1] / g[0]);
    assert.ok(Math.abs(db - tilt) < 1e-9, `octave one at ${tilt}: ${db}`);
    const db2 = 20 * Math.log10(g[7] / g[3]);
    assert.ok(Math.abs(db2 - tilt) < 1e-9, `partial 4 to 8 at ${tilt}: ${db2}`);
    let power = 0;
    for (let k = 0; k < ADDITIVE_PARTIALS; k++) power += g[k] * g[k];
    assert.ok(Math.abs(power - 1) < 1e-9, `the partials sum to unit power at tilt ${tilt}`);
  }
});

test('Odd plays only the odd partials at one end, only the even at the other, and both between', () => {
  const at = (odd) => {
    const { synth, values } = playing({ partials: 8, tilt: 0, odd });
    render(synth, values, 2);
    return [...synth.voices[0].gain.subarray(0, 8)];
  };
  const odd = at(1);
  const even = at(-1);
  const both = at(0);
  const half = at(0.5);
  for (let k = 0; k < 8; k++) {
    const isOdd = (k + 1) % 2 === 1;
    assert.equal(odd[k] > 0, isOdd, `odd only: partial ${k + 1}`);
    assert.equal(even[k] > 0, !isOdd, `even only: partial ${k + 1}`);
    assert.ok(both[k] > 0, `both: partial ${k + 1}`);
  }
  assert.ok(Math.abs(both[1] / both[0] - 1) < 1e-12);
  assert.ok(Math.abs(half[1] / half[0] - 0.5) < 1e-12, 'halfway to odd halves the even partials');
});

test('Damp brings the higher partials down faster through each note, and none at zero', () => {
  const { synth, values } = playing({ partials: 16, damp: 0.5 });
  render(synth, values, Math.round((0.2 * SR) / BLOCK));
  const d = synth.voices[0].damp;
  assert.equal(d[0], 1, 'the fundamental holds');
  for (let k = 1; k < 16; k++) assert.ok(d[k] < d[k - 1], `partial ${k + 1} is further down than partial ${k}`);
  assert.ok(d[15] < 0.01, `the sixteenth has all but gone in 200 ms: ${d[15]}`);

  const still = playing({ partials: 16, damp: 0 });
  render(still.synth, still.values, 20);
  for (let k = 0; k < 16; k++) assert.equal(still.synth.voices[0].damp[k], 1);

  // A new note starts every partial over.
  synth.queueNoteOn(55, 1, 0);
  render(synth, values, 1);
  const voice = synth.voices.find((v) => v.note === 55);
  assert.ok(voice.damp[15] > 0.5, `a block into the new note: ${voice.damp[15]}`);
});

test('a drawn Spectrum sets each partial\'s level, first partial at the left, the last at the right', () => {
  const table = Float32Array.from({ length: 256 }, (_, i) => (i < 128 ? 1 : 0.25));
  const { synth, values } = playing({ partials: 64, tilt: 0, spectrum: 1 }, [24]);
  assert.equal(synth.loadShape('spectrum', 1, table), true);
  assert.equal(synth.loadShape('partials', 1, table), false, 'only the control that takes one');
  render(synth, values, 2);
  const g = synth.voices[0].gain;
  assert.ok(Math.abs(g[63] / g[0] - 0.25) < 1e-6, `the top partial at a quarter: ${g[63] / g[0]}`);
  assert.ok(Math.abs(g[10] / g[0] - 1) < 1e-12);
  // Flat, and a slot nothing is drawn in, leave every partial alone.
  assert.equal(spectrumLevel(null, 0.5), 1);
  values.spectrum = 0;
  render(synth, values, 1);
  assert.ok(Math.abs(synth.voices[0].gain[63] / synth.voices[0].gain[0] - 1) < 1e-12);
});

test('a voice\'s partials start at phases its seed picks, the same every time', () => {
  const one = playing({ partials: 32 });
  const two = playing({ partials: 32 });
  const a = render(one.synth, one.values, 8);
  const b = render(two.synth, two.values, 8);
  assert.deepEqual(a, b);
  const fresh = new AdditiveSynth(SR);
  const seed = (1 * 1664525 + 1013904223) >>> 0;
  fresh.setParams(defaults());
  fresh.setBend(0);
  fresh.queueNoteOn(60, 1, 0);
  const l = new Float32Array(1);
  fresh.process(l, new Float32Array(1), 1);
  // One sample in: each phase is its seeded start plus one step.
  const v = fresh.voices[0];
  for (let k = 0; k < 4; k++) {
    const want = (hashPhase(seed, k) + (Math.pow(k + 1, 1) * midiToHz(60)) / SR) % 1;
    assert.ok(Math.abs(v.phase[k] - want) < 1e-12, `partial ${k + 1}`);
  }
});

/** The largest jump between neighboring samples. */
function largestStep(x, from = 1, to = x.length) {
  let worst = 0;
  for (let i = Math.max(1, from); i < to; i++) worst = Math.max(worst, Math.abs(x[i] - x[i - 1]));
  return worst;
}

test('moving any control between blocks glides the partials there rather than stepping them', () => {
  // A low note with few partials moves slowly from sample to sample, so a step in any partial's
  // level would stand out against it.
  const changes = {
    partials: [2, 64], tilt: [-24, 6], odd: [1, -1], stretch: [0, 0.4], damp: [0, 1], spectrum: [0, 1],
  };
  const table = Float32Array.from({ length: 256 }, (_, i) => (i % 2 ? 1 : 0));
  for (const [id, [from, to]] of Object.entries(changes)) {
    const base = { partials: 3, tilt: -12, [id]: from };
    const { synth, values } = playing(base, [36]);
    synth.loadShape('spectrum', 1, table);
    const out = render(synth, values, 12, (b, v) => { if (b === 8) v[id] = to; });
    const before = largestStep(out, BLOCK * 2, BLOCK * 8);
    const across = largestStep(out, BLOCK * 8 - 1, BLOCK * 9 + 1);
    assert.ok(across < Math.max(before * 4, 0.02), `${id}: a jump of ${across} where the control changed, against ${before} before it`);
  }
});

test('one partial alone is a sine at the level the voice is set to', () => {
  const { synth, values } = playing({ partials: 1, 'ampenv.attack': 0, 'ampenv.decay': 0, 'ampenv.sustain': 1, level: 0.8 }, [57]);
  const out = render(synth, values, 40);
  let peak = 0;
  for (let i = BLOCK * 4; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(Math.abs(peak - 0.8 * 0.32) < 1e-3, `peak ${peak}`);
});

test('a note-off releases, and a pitch held twice lets go only at its last off', () => {
  const { synth, values } = playing({ 'ampenv.release': 0.01 }, [48, 48]);
  render(synth, values, 4);
  synth.queueNoteOff(48, 0);
  render(synth, values, 20);
  assert.equal(synth.activeVoices, 1, 'one off of two keeps it');
  synth.queueNoteOff(48, 0);
  render(synth, values, 20);
  assert.equal(synth.activeVoices, 0);
});

test('64 partials a voice stay affordable', () => {
  const { synth, values } = playing({ partials: 64, voices: 8 }, [24, 26, 28, 29, 31, 33, 35, 36]);
  const seconds = 1;
  const blocks = Math.round((seconds * SR) / BLOCK);
  render(synth, values, 50);
  const t0 = performance.now();
  render(synth, values, blocks);
  const ms = performance.now() - t0;
  // Generous: a fraction of a second for a second of eight full voices on any machine CI runs.
  assert.ok(ms < 1000 * seconds * 0.6, `eight voices of 64 partials took ${ms.toFixed(0)} ms for ${seconds} s`);
});

test('a moving bend carries every partial with it', () => {
  const { synth, values } = playing({ partials: 8 }, [48]);
  render(synth, values, 2);
  const bend = Float32Array.from({ length: BLOCK }, (_, i) => (12 * i) / (BLOCK - 1));
  synth.setBend(bend);
  const l = new Float32Array(BLOCK);
  synth.process(l, new Float32Array(BLOCK), BLOCK);
  assert.ok(l.every(Number.isFinite));
  const before = synth.voices[0].phase[2];
  synth.setBend(12);
  synth.process(new Float32Array(BLOCK), new Float32Array(BLOCK), BLOCK);
  // An octave up, partial 3 steps twice as far a sample as it did unbent.
  const v = synth.voices[0];
  assert.ok(Math.abs(v.inc[2] - (3 * midiToHz(60)) / SR) < 1e-12);
  assert.notEqual(v.phase[2], before);
});

test('the picture of the partials draws the levels the synth plays, with Spectrum in its heading', async () => {
  const { buildFigures, subsumedParams } = await import('./src/figures.mjs');
  assert.ok(subsumedParams(ADDITIVE).has('spectrum'), 'the picker heads the picture, not a cell of its own');
  const settings = { partials: 12, tilt: -4, odd: 0.4, stretch: 0.05, damp: 0.3 };
  const figure = buildFigures(ADDITIVE, settings, { sampleRate: SR }).find((f) => f.kind === 'partials');
  const { synth, values } = playing(settings, [60]);
  render(synth, values, 2);
  const g = synth.voices[0].gain;
  assert.equal(figure.bars.length, 12);
  figure.bars.forEach((bar, k) => {
    assert.ok(Math.abs(bar.level - g[k]) < 1e-12, `partial ${k + 1}: ${bar.level} drawn, ${g[k]} played`);
    assert.ok(Math.abs(bar.ratio - Math.pow(k + 1, 1.05)) < 1e-12);
    assert.ok(bar.damped < bar.level || k === 0, `Damp takes from partial ${k + 1}`);
  });
  assert.equal(figure.curveName, 'flat');
  // A drawn spectrum is read from the slot it was loaded into, as the synth reads it.
  const points = Array.from({ length: 256 }, (_, i) => (i < 128 ? 1 : 0.1));
  const drawn = buildFigures(ADDITIVE, { ...settings, partials: 64, spectrum: 1 }, { sampleRate: SR, shapes: { 1: { name: 'half', data: 'half', points } } })
    .find((f) => f.kind === 'partials');
  assert.equal(drawn.curveName, 'half');
  assert.ok(drawn.bars.at(-1).level < drawn.bars[0].level * 0.2);
});
