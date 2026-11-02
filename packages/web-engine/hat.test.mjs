// The Hat: six band-limited squares, Lofi, a bandpass and a highpass, one hit at a time.
//
// What has to hold: a new hit fades the last one out quickly and without a click; the note retunes
// the squares and middle C plays them at their own frequencies; Decay is the time to fall 60 dB
// and the hit then ends; Body adds a second, longer stage to the tail; Noise blends noise in;
// Lofi holds at a lower rate and fewer bits and is out of the way at zero; velocity sets the level
// and brightens; every hit differs a little, the same way every run; and no edge, of the squares
// or of the hold, folds back off the sample rate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, findParam } from './src/descriptor.mjs';
import { HAT, HAT_PRESETS, HAT_SOURCES, HatSynth, Lofi, lofiBits, lofiRate } from './src/devices/hat.mjs';
import { METAL_HZ, MetalSource } from './src/dsp/metal.mjs';
import { BLEP_HALF } from './src/dsp/blep.mjs';

const SR = 48000;
const BLOCK = 128;

/** Renders hits: `hits` is [{ at, note, velocity }] in samples. */
function render(params, { hits = [{ at: 0, note: 60, velocity: 1 }], frames = SR / 2, onBlock = null } = {}) {
  const synth = new HatSynth(SR);
  const values = { ...defaultValues(HAT), ...params };
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let at = 0; at < frames; at += BLOCK) {
    synth.setParams(values);
    synth.setBend(0);
    for (const h of hits) if (h.at >= at && h.at < at + BLOCK) synth.queueNoteOn(h.note ?? 60, h.velocity ?? 1, h.at - at);
    synth.process(L.subarray(at, at + BLOCK), R.subarray(at, at + BLOCK), BLOCK);
    onBlock?.(synth, at);
  }
  return { L, R, synth };
}

const rms = (x, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, to - from));
};

/** Magnitude at `hz` over a Blackman-Harris-windowed stretch: slow, exact, plenty for a test. */
function magnitude(x, hz, from, length) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < length; i++) {
    const p = (2 * Math.PI * i) / (length - 1);
    const w = 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
    const ph = (2 * Math.PI * hz * i) / SR;
    re += x[from + i] * w * Math.cos(ph);
    im -= x[from + i] * w * Math.sin(ph);
  }
  return Math.hypot(re, im);
}

const db = (a, b) => 20 * Math.log10(a / b);

test('a hit sounds, falls 60 dB over Decay, and then ends', () => {
  // A track's .decay() is this control.
  assert.equal(findParam(HAT, '@amp.decay')?.id, 'decay');
  for (const decay of [0.05, 0.4]) {
    const n = Math.round(decay * SR);
    let endedAt = null;
    const { L } = render({ decay }, {
      frames: n + SR / 10,
      onBlock: (synth, at) => { if (endedAt === null && synth.activeVoices === 0) endedAt = at; },
    });
    const w = Math.round(0.002 * SR);
    const start = rms(L, 0, w);
    assert.ok(start > 0.01, `decay ${decay}: the hit is too quiet (${start})`);
    // A third of the way in it is still well up.
    assert.ok(db(rms(L, Math.round(n / 3), Math.round(n / 3) + w), start) > -20, `decay ${decay}: gone too soon`);
    // Each hit's own length is within a few percent of Decay (see the next test); past that, nothing.
    const past = Math.round(n * 1.07);
    assert.ok(db(rms(L, past, past + w), start) < -80, `decay ${decay}: still ringing past its Decay time`);
    assert.ok(endedAt !== null && endedAt <= n * 1.07 + BLOCK * 4, `decay ${decay}: the hit never ended (${endedAt})`);
  }
});

test('a new hit fades the last one out within a few milliseconds, without a click', () => {
  const cut = Math.round(0.1 * SR) + 37;
  // The open hit alone, and then cut by a hit too quiet to hear.
  const alone = render({ decay: 2 }, { frames: cut + SR / 20 }).L;
  let voices = 0;
  const cutOff = render({ decay: 2 }, {
    frames: cut + SR / 20,
    hits: [{ at: 0, velocity: 1 }, { at: cut, velocity: 1e-6 }],
    onBlock: (synth) => { voices = Math.max(voices, synth.activeVoices); },
  }).L;
  assert.ok(voices <= 2, 'one hit playing and one fading is the most there ever is');
  // Until the cut, the two are the same hit.
  for (let i = 0; i < cut; i++) assert.equal(cutOff[i], alone[i]);
  // Within 4 ms of it, silence.
  const fade = Math.round(0.004 * SR);
  assert.ok(rms(cutOff, cut + fade, cut + fade * 3) < 1e-5, 'the cut hit should be gone');
  assert.ok(rms(alone, cut + fade, cut + fade * 3) > 0.01, 'and on its own it was still ringing');
  // In between, the cut hit is the hit itself under a gain that only ever falls, from all of it
  // to none over a few milliseconds: a fade, not a cut, so no click.
  let last = 1;
  for (let i = cut; i < cut + fade; i++) {
    if (Math.abs(alone[i]) < 0.01) continue;
    const g = cutOff[i] / alone[i];
    assert.ok(g >= -0.01 && g <= last + 0.01, `the gain jumps at ${i - cut}: ${g} after ${last}`);
    last = g;
  }
  const at1ms = cut + Math.round(0.001 * SR);
  let g1 = null;
  for (let i = at1ms; g1 === null; i++) if (Math.abs(alone[i]) > 0.01) g1 = cutOff[i] / alone[i];
  assert.ok(g1 > 0.5, `faded too fast: ${g1} left after a millisecond`);
});

test('the note retunes the squares: middle C plays them at their own frequencies', () => {
  // Two squares only, a dark broad band, a long hit: the lines are easy to find.
  const params = { source: HAT_SOURCES.indexOf('bell'), tone: 0.4, decay: 4 };
  const from = SR / 10;
  const length = SR / 2;
  for (const note of [60, 67, 72]) {
    const { L } = render(params, { hits: [{ at: 0, note }], frames: from + length });
    const ratio = Math.pow(2, (note - 60) / 12);
    const lines = [METAL_HZ[4] * ratio, METAL_HZ[5] * ratio];
    const off = [METAL_HZ[4] * ratio * 1.12, METAL_HZ[5] * ratio * 0.91];
    const floor = Math.max(...off.map((hz) => magnitude(L, hz, from, length)));
    for (const hz of lines) {
      assert.ok(db(magnitude(L, hz, from, length), floor) > 40, `note ${note}: no line at ${hz.toFixed(1)} Hz`);
    }
  }
});

test('octaves of middle C, where a phase lands exactly on an edge, ring out like any note', () => {
  for (const note of [72, 84, 96]) {
    const { L } = render({ decay: 1 }, { hits: [{ at: 0, note }], frames: SR });
    const early = rms(L, 0, SR / 20);
    const late = rms(L, SR / 2, SR / 2 + SR / 20);
    assert.ok(late > early * 0.01, `note ${note} went quiet: ${late} against ${early}`);
  }
});

test('velocity sets the level and brightens, as an accent does', () => {
  const at = (velocity) => render({ decay: 0.2, tone: 0.6 }, { hits: [{ at: 0, velocity }] }).L;
  const loud = at(1);
  const soft = at(0.5);
  assert.ok(rms(loud) > rms(soft) * 1.3, `a soft hit should be quieter: ${rms(loud)} against ${rms(soft)}`);
  // Brighter: more of its energy high up, against a band lower down.
  const from = 200;
  const length = 4096;
  const tilt = (x) => db(magnitude(x, 9000, from, length), magnitude(x, 2500, from, length));
  assert.ok(tilt(loud) > tilt(soft) + 2, `a hard hit should be brighter: ${tilt(loud).toFixed(1)} against ${tilt(soft).toFixed(1)}`);
});

test('every hit differs a little, and the same way every time', () => {
  const hits = [0, 4800, 9600].map((at) => ({ at }));
  const one = render({ decay: 0.05 }, { hits, frames: 14400 }).L;
  const again = render({ decay: 0.05 }, { hits, frames: 14400 }).L;
  assert.deepEqual(again, one, 'the same notes play the same samples');
  // Each hit's length is its own: the 30 dB point lands somewhere different every time.
  const ends = hits.map(({ at }) => {
    const peak = rms(one, at, at + 96);
    for (let i = at; i < at + 4800; i += 48) if (rms(one, i, i + 96) < peak * 0.03) return i - at;
    return null;
  });
  assert.ok(new Set(ends).size > 1, `every hit ended at the same point: ${ends}`);
});

test('Body adds a lower band that rings on after the bright one: a two-stage tail', () => {
  const decay = 0.1;
  const plain = render({ decay, body: 0, hold: 0 }, { frames: SR }).L;
  const full = render({ decay, body: 0.3, hold: 0 }, { frames: SR }).L;
  const w = Math.round(0.005 * SR);
  const at = (x, sec) => rms(x, Math.round(sec * SR), Math.round(sec * SR) + w);
  // Past Decay, the plain hit is gone and the body is still there, a good way up from silence.
  assert.ok(db(at(plain, decay * 1.2), at(plain, 0)) < -60);
  assert.ok(db(at(full, decay * 1.2), at(full, 0)) > -40, 'the body should still be ringing');
  // Two stages: it falls faster at first than it does later.
  const early = db(at(full, 0.06), at(full, 0));
  const later = db(at(full, 0.3), at(full, 0.24));
  assert.ok(early < later - 2, `one slope, not two: ${early.toFixed(1)} then ${later.toFixed(1)} dB`);
  // And it is lower: its energy sits under the bright band's.
  const tilt = (x) => db(magnitude(x, 3000, 200, 4096), magnitude(x, 9000, 200, 4096));
  assert.ok(tilt(full) > tilt(plain) + 3);
});

test('Noise blends white noise in with the squares, and at the top is all noise', () => {
  const params = { source: HAT_SOURCES.indexOf('bell'), tone: 0.4, decay: 4 };
  const from = SR / 10;
  const length = SR / 4;
  const lineAndGap = (noise) => {
    const { L } = render({ ...params, noise }, { frames: from + length });
    return db(magnitude(L, 800, from, length), magnitude(L, 900, from, length));
  };
  // The bell's 800 Hz line stands far over the gap beside it; noise fills the gap in.
  assert.ok(lineAndGap(0) > 40);
  assert.ok(lineAndGap(0.5) < lineAndGap(0) - 15);
  assert.ok(Math.abs(lineAndGap(1)) < 10, 'all noise has no line in it');
});

test('Warp folds the squares into a denser cluster, still band-limited', () => {
  // Two squares alone: straight, the spectrum is their own odd harmonics; folded, sums and
  // differences of them fill the gaps between.
  const levels = [0, 0, 0, 0, 0.5, 0.5];
  const render2 = (warp) => {
    const m = new MetalSource(SR, [1, 1, 1, 1, 3100, 4713.7]);
    return Float64Array.from({ length: SR }, () => m.nextFolded(1, levels, warp));
  };
  const straight = render2(0);
  const folded = render2(1);
  // 4713.7 - 3100 = 1613.7 Hz is no harmonic of either square.
  const fund = (x) => magnitude(x, 3100, SR / 4, SR / 2);
  assert.ok(db(magnitude(straight, 1613.7, SR / 4, SR / 2), fund(straight)) < -90);
  assert.ok(db(magnitude(folded, 1613.7, SR / 4, SR / 2), fund(folded)) > -30, 'folding should cross them');
  // Folded products well past half the sample rate - 7 x 4713.7 and 3 x 4713.7 + 5 x 3100 - would
  // land back at 15004.1 and 18358.9 Hz, where no low product of the two falls.
  for (const alias of [SR - 7 * 4713.7, SR - (3 * 4713.7 + 5 * 3100)]) {
    const level = db(magnitude(folded, alias, SR / 4, SR / 2), fund(folded));
    assert.ok(level < -60, `the fold leaks to ${alias} Hz at ${level.toFixed(1)} dB`);
  }
});

test('Ring puts a resonant peak at the bright band\'s corner', () => {
  const params = { source: HAT_SOURCES.indexOf('dense'), noise: 1, tone: 0.6, decay: 2 };
  const from = 2000;
  const length = 8192;
  // Tone 0.6 puts the band near 4.6 kHz and its highpass at a quarter of that on the dense source.
  const corner = 500 * Math.pow(40, 0.6) * 0.25;
  const peak = (ring) => {
    const { L } = render({ ...params, ring }, { frames: from + length });
    return db(magnitude(L, corner, from, length), magnitude(L, corner * 2.5, from, length));
  };
  assert.ok(peak(1) > peak(0) + 6, `no peak at the corner: ${peak(1).toFixed(1)} against ${peak(0).toFixed(1)}`);
});

test('Filter Sweep starts each hit\'s filters away from Tone and brings them back, further for a harder hit', () => {
  const tilt = (x, from) => db(magnitude(x, 12000, from, 512), magnitude(x, 3000, from, 512));
  const run = (sweep, velocity = 1) => render({ decay: 0.5, tone: 0.6, filtersweep: sweep }, { hits: [{ at: 0, velocity }], frames: SR / 2 }).L;
  const still = run(0);
  const up = run(36);
  const down = run(-36);
  // At the strike, swept up is brighter and swept down darker than unswept...
  assert.ok(tilt(up, 64) > tilt(still, 64) + 6);
  assert.ok(tilt(down, 64) < tilt(still, 64) - 6);
  // ...and a few hundred milliseconds in, they are back where they started.
  assert.ok(Math.abs(tilt(up, SR / 4) - tilt(still, SR / 4)) < 1);
  // A softer hit sweeps less far.
  assert.ok(tilt(run(36, 0.5), 64) < tilt(up, 64) - 2);
});

test('Lofi holds at a lower rate and fewer bits, and is out of the way at zero', () => {
  // At zero the input comes out as it went in, twice BLEP_HALF samples late.
  const clean = new Lofi(SR);
  const input = Array.from({ length: 2000 }, (_, i) => Math.sin(i * 0.05) * 0.7);
  const out = input.map((x) => clean.next(x, 0));
  for (let i = 2 * BLEP_HALF; i < input.length; i++) assert.ok(Math.abs(out[i] - input[i - 2 * BLEP_HALF]) < 1e-12);

  // At the top, a steady level comes out rounded to its bits: 0.3 at four bits is a quarter.
  assert.equal(lofiBits(1), 4);
  const coarse = new Lofi(SR);
  let v = 0;
  for (let i = 0; i < SR / 10; i++) v = coarse.next(0.3, 1);
  assert.ok(Math.abs(v - 0.25) < 1e-6, `held at ${v}`);

  // And a tone is heard with the hold's image beside it, at the hold's rate less the tone.
  const tone = (lofi) => {
    const lf = new Lofi(SR);
    return Float64Array.from({ length: SR }, (_, i) => lf.next(0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR), lofi));
  };
  const rate = lofiRate(1, SR);
  const held = tone(1);
  const plain = tone(0);
  const fund = magnitude(held, 1000, SR / 4, SR / 2);
  assert.ok(db(magnitude(held, rate - 1000, SR / 4, SR / 2), fund) > -25, 'the hold should put an image at its rate less the tone');
  assert.ok(db(magnitude(plain, rate - 1000, SR / 4, SR / 2), magnitude(plain, 1000, SR / 4, SR / 2)) < -100, 'at zero there is no image');

  // On the device, Lofi changes the sound.
  const a = render({ lofi: 0 }).L;
  const b = render({ lofi: 0.6 }).L;
  let differs = 0;
  for (let i = 0; i < a.length; i++) differs = Math.max(differs, Math.abs(a[i] - b[i]));
  assert.ok(differs > 0.01, 'Lofi did nothing');
});

test('no edge folds back: a high square and the hold leave nothing at their alias frequencies', () => {
  // One square at 7 kHz: its fifth, seventh and ninth harmonics are past the sample rate's half,
  // at 35, 49 and 63 kHz, and drawn naively would fold to 13, 1 and 15 kHz at -14 to -19 dB.
  const one = new MetalSource(SR, [7000, 1, 1, 1, 1, 1]);
  const levels = [1, 0, 0, 0, 0, 0];
  const sq = Float64Array.from({ length: SR }, () => one.next(1, levels));
  const fund = magnitude(sq, 7000, SR / 4, SR / 2);
  for (const alias of [13000, 1000, 15000]) {
    const level = db(magnitude(sq, alias, SR / 4, SR / 2), fund);
    assert.ok(level < -80, `a square at 7 kHz folds to ${alias} Hz at ${level.toFixed(1)} dB`);
  }
  // The hold, clocked faster than half the sample rate: its first images, at its rate either side
  // of the tone, are past half the sample rate, and held naively would fold back to 11 and 13 kHz.
  // Rounded to far more bits than Lofi ever uses, so what is measured is the hold alone.
  const rate = 36050;
  const lf = new Lofi(SR);
  const held = Float64Array.from({ length: SR }, (_, i) => lf.hold(0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR), rate, 48));
  const tone = magnitude(held, 1000, SR / 4, SR / 2);
  for (const image of [rate - 1000, rate + 1000]) {
    const folded = SR - image;
    const level = db(magnitude(held, folded, SR / 4, SR / 2), tone);
    assert.ok(level < -80, `the hold's image at ${image.toFixed(0)} Hz folds to ${folded.toFixed(0)} Hz at ${level.toFixed(1)} dB`);
  }
});

test('every preset is a setting of the controls, and plays', () => {
  const ids = new Set(HAT.params.map((p) => p.id));
  for (const [name, preset] of Object.entries(HAT_PRESETS)) {
    assert.match(name, /^[a-z][a-z0-9]*$/, `${name}: a shipped preset's name is one lowercase word`);
    for (const [id, value] of Object.entries(preset)) {
      const p = HAT.params.find((q) => q.id === id);
      assert.ok(ids.has(id), `${name}: no control ${id}`);
      assert.ok(value >= p.min && value <= p.max, `${name}: ${id} out of range`);
    }
    const { L } = render(preset, { frames: SR / 5 });
    const peak = L.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 0.05 && peak < 1, `${name}: peak ${peak}`);
  }
});

test('nothing it can be set to produces a number nobody can play', () => {
  for (const tone of [0, 1]) {
    for (const lofi of [0, 1]) {
      for (let source = 0; source < HAT_SOURCES.length; source++) {
        const { L } = render({ tone, lofi, source, decay: 0.01, body: 1, noise: 0.5, hold: 1 }, { hits: [{ at: 0, note: 127 }, { at: 3000, note: 0 }], frames: SR / 10 });
        for (const v of L) assert.ok(Number.isFinite(v) && Math.abs(v) < 4);
      }
    }
  }
});
