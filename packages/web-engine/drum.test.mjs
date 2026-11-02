// The Drum: a struck body of decaying modes and a burst of noise, one hit per note.
//
// What has to hold: Material moves the body smoothly - no step in what comes out as it moves,
// across the bar in the middle as well; a hit keeps the controls it was struck with, so one track
// plays a whole kit; the noise's bursts land where Stutter puts them; hits ring into one another
// and a note off stops nothing; the note is the pitch of the lowest mode; the
// velocity scales the level, and the click once more; every preset it ships plays.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import {
  BAR_RATIOS, DRUM, DRUM_BURSTS, DRUM_GAP_SEC, DRUM_MODES, DrumSynth, MEMBRANE_RATIOS, TAIL_LENGTH, drive, drumModes, DRUM_CUTOFF_TOP,
} from './src/devices/drum.mjs';

const SR = 48000;
const BLOCK = 128;

/** A body with nothing else on it: no noise, no click, no drop. */
const BARE = { noise: 0, click: 0, drop: 0, level: 1 };

/**
 * Renders hits. `hits` is a list of { at (frames), note, velocity }; `offs` note offs the same way.
 * `moving` maps a control to a function of the frame, handed over a block at a time.
 */
function render(params, { hits = [{ at: 0, note: 60, velocity: 1 }], offs = [], frames = SR / 2, moving = {} } = {}) {
  const synth = new DrumSynth(SR);
  const values = { ...defaultValues(DRUM), ...params };
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let at = 0; at < frames; at += BLOCK) {
    const block = { ...values };
    for (const [id, fn] of Object.entries(moving)) block[id] = Float32Array.from({ length: BLOCK }, (_, i) => fn(at + i));
    synth.setParams(block);
    synth.setBend(0);
    for (const h of hits) if (h.at >= at && h.at < at + BLOCK) synth.queueNoteOn(h.note, h.velocity, h.at - at);
    for (const o of offs) if (o.at >= at && o.at < at + BLOCK) synth.queueNoteOff(o.note, o.at - at);
    synth.process(L.subarray(at, at + BLOCK), R.subarray(at, at + BLOCK), BLOCK);
  }
  return { L, R, synth };
}

const peak = (x, from = 0, to = x.length) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
};

/** The frequency of a steady tone, from its rising zero crossings (interpolated). */
function frequency(x, from, to) {
  const crossings = [];
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
  }
  return (SR * (crossings.length - 1)) / (crossings.at(-1) - crossings[0]);
}

/** The level of one frequency in a stretch, by a windowed DFT bin. */
function levelAt(x, hz, from, n) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    re += x[from + i] * w * Math.cos((2 * Math.PI * hz * i) / SR);
    im -= x[from + i] * w * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return Math.hypot(re, im) / (n / 4);
}

test('Material runs from one mode, through the bar, to the membrane', () => {
  const r = new Float64Array(DRUM_MODES);
  const l = new Float64Array(DRUM_MODES);
  drumModes(0, 0, r, l);
  assert.deepEqual([...l], [1, 0, 0, 0, 0, 0], 'one resonance at the bottom');
  drumModes(0.5, 0, r, l);
  assert.deepEqual([...r].slice(0, 4), BAR_RATIOS.slice(0, 4), 'the bar in the middle');
  assert.equal(l.filter((v) => v > 0).length, 4, 'four modes on the bar');
  drumModes(1, 0, r, l);
  for (let k = 0; k < DRUM_MODES; k++) assert.ok(Math.abs(r[k] - MEMBRANE_RATIOS[k]) < 1e-12);
  assert.equal(l.filter((v) => v > 0).length, 6, 'six on the membrane');
});

test('the modes move by no more than a small step for a small step of Material, anywhere', () => {
  const r0 = new Float64Array(DRUM_MODES);
  const l0 = new Float64Array(DRUM_MODES);
  const r1 = new Float64Array(DRUM_MODES);
  const l1 = new Float64Array(DRUM_MODES);
  const step = 1e-4;
  let worstRatio = 0;
  let worstLevel = 0;
  let worstNorm = 0;
  for (let m = 0; m < 1; m += step) {
    const n0 = drumModes(m, 0, r0, l0);
    const n1 = drumModes(m + step, 0, r1, l1);
    worstNorm = Math.max(worstNorm, Math.abs(n1 - n0));
    for (let k = 0; k < DRUM_MODES; k++) {
      // A silent mode may sit anywhere; one that can be heard may not jump.
      if (l0[k] > 0 || l1[k] > 0) worstRatio = Math.max(worstRatio, Math.abs(r1[k] - r0[k]));
      worstLevel = Math.max(worstLevel, Math.abs(l1[k] - l0[k]));
    }
  }
  // Steepest where the bar's top mode slides down to the membrane's: about 24 a unit of Material.
  assert.ok(worstRatio < 30 * step, `a ratio jumped by ${worstRatio}`);
  assert.ok(worstLevel < 2 * step, `a level jumped by ${worstLevel}`);
  assert.ok(worstNorm < 2 * step, `the loudness jumped by ${worstNorm}`);
});

test('hits struck a little apart in Material sound a little apart, across the whole line', () => {
  // No jump as Material moves: two hits a hair apart in Material start a hair apart, anywhere
  // along the line, the bar in the middle included. Compared over their first 20 ms, before a
  // small difference in frequency has had time to become a large one in phase.
  const hit = (material) => render({ ...BARE, decay: 0.5, material }, { frames: SR / 50 }).L;
  const gap = (a, b) => {
    let e = 0;
    for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i]));
    return e;
  };
  let worst = 0;
  for (let m = 0; m <= 0.999; m += 0.0249) worst = Math.max(worst, gap(hit(m), hit(m + 1e-4)));
  for (const m of [0.4999, 0.5, 0.5001]) worst = Math.max(worst, gap(hit(m), hit(m + 1e-4)));
  assert.ok(worst < 0.01, `a step of 0.0001 in Material moved the sound by ${worst}`);
});

test('a hit keeps the controls it was struck with while it rings, and Level stays live', () => {
  const params = { ...BARE, decay: 1, material: 0.2, pitch: 0, noise: 0.3, noiselength: 0.5 };
  const still = render(params, { frames: SR / 4 }).L;
  // Every sound control moved half way through the ring: nothing changes.
  const later = (a, b) => (i) => (i < SR / 8 ? a : b);
  const moved = render(params, {
    frames: SR / 4,
    moving: {
      material: later(0.2, 1), pitch: later(0, 7), decay: later(1, 0.05), drop: later(0, 12), click: later(0, 1),
      noise: later(0.3, 1), noisetone: later(3000, 200), noiselength: later(0.5, 0.01), stutter: later(0, 1),
    },
  }).L;
  // A moving control arrives as 32-bit floats, a still one as a number: the same hit to within that.
  for (let i = 0; i < still.length; i++) assert.ok(Math.abs(moved[i] - still[i]) < 1e-6, `the ringing hit changed at ${i}`);
  const quieter = render(params, { frames: SR / 4, moving: { level: later(1, 0.5) } }).L;
  for (let i = SR / 8 + 10; i < SR / 4; i += 97) assert.ok(Math.abs(quieter[i] - 0.5 * still[i]) < 1e-6, 'Level follows');
});

test('a change on the same sample as a hit strikes that hit, and the one before rings on', () => {
  const A = { ...BARE, decay: 1, material: 0, pitch: 0 };
  const B = { material: 1, pitch: 7, noise: 0.4, noisetone: 800, noiselength: 0.2, stutter: 0.5, click: 0.6, drop: 5, decay: 0.3 };
  const at = 3000;
  // The change lands on the hit's sample, or a sample after it (two ways of rounding one time).
  for (const lag of [0, 1]) {
    const moving = Object.fromEntries(Object.entries(B).map(([id, v]) => [id, (i) => (i < at + lag ? A[id] ?? defaultValues(DRUM)[id] : v)]));
    const both = render(A, { hits: [{ at: 0, note: 60, velocity: 1 }, { at, note: 60, velocity: 1 }], moving }).L;
    const first = render(A, { hits: [{ at: 0, note: 60, velocity: 1 }] }).L;
    // The second hit alone, struck with B, from the same noise the second voice gets.
    const second = render(A, { hits: [{ at: 0, note: 60, velocity: 0 }, { at, note: 60, velocity: 1 }], moving }).L;
    let worst = 0;
    for (let i = 0; i < both.length; i++) worst = Math.max(worst, Math.abs(both[i] - (first[i] + second[i])));
    assert.ok(worst < 1e-6, `lag ${lag}: the first hit was changed (${worst})`);
    const struckWithB = render({ ...A, ...B }, { hits: [{ at: 0, note: 60, velocity: 0 }, { at, note: 60, velocity: 1 }] }).L;
    let off = 0;
    for (let i = 0; i < both.length; i++) off = Math.max(off, Math.abs(second[i] - struckWithB[i]));
    assert.ok(off < 1e-6, `lag ${lag}: the second hit was not struck with the change (${off})`);
  }
});

test('one track plays a kit: a preset per hit, each ringing as its own', () => {
  const kit = ['snare', 'clap', 'rim', 'conga'];
  const gap = SR / 8;
  const hits = kit.map((_, k) => ({ at: k * gap, note: 60, velocity: 1 }));
  // The presets as a pattern would set them: each one stepped in on its hit's sample.
  const values = (id) => (i) => {
    const k = Math.min(kit.length - 1, Math.floor(i / gap));
    return DRUM.presets[kit[k]][id] ?? defaultValues(DRUM)[id];
  };
  const ids = DRUM.params.filter((p) => p.latch).map((p) => p.id);
  const together = render({ level: 1 }, { hits, frames: SR, moving: Object.fromEntries(ids.map((id) => [id, values(id)])) }).L;
  // Each hit alone with its preset, at its own place, from the same noise (silent hits before it).
  const sum = new Float32Array(SR);
  kit.forEach((name, k) => {
    const alone = render({ ...DRUM.presets[name], level: 1 }, {
      frames: SR, hits: hits.map((h, i) => ({ ...h, velocity: i === k ? 1 : 0 })),
    }).L;
    for (let i = 0; i < SR; i++) sum[i] += alone[i];
  });
  let worst = 0;
  for (let i = 0; i < SR; i++) worst = Math.max(worst, Math.abs(together[i] - sum[i]));
  assert.ok(worst < 1e-5, `the kit is not its hits added up (${worst})`);
});

test('the note is the pitch of the lowest mode, and Pitch moves it', () => {
  const at = (note, params = {}) => {
    const { L } = render({ ...BARE, material: 0, decay: 2, ...params }, { hits: [{ at: 0, note, velocity: 1 }] });
    return frequency(L, SR / 20, SR / 4);
  };
  const c4 = 440 * Math.pow(2, -9 / 12);
  assert.ok(Math.abs(at(60) / c4 - 1) < 1e-3, `middle C played at ${at(60)}`);
  assert.ok(Math.abs(at(72) / (2 * c4) - 1) < 1e-3, 'an octave up');
  assert.ok(Math.abs(at(60, { pitch: -12 }) / (c4 / 2) - 1) < 1e-3, 'Pitch takes it down an octave');
});

test('Drop starts the body above its pitch and lets it fall back', () => {
  const { L } = render({ ...BARE, material: 0, decay: 0.3, drop: 12 });
  const early = frequency(L, 0, SR / 200);
  const late = frequency(L, SR / 4, SR / 4 + SR / 10);
  const c4 = 440 * Math.pow(2, -9 / 12);
  assert.ok(early > c4 * 1.7, `starts near an octave up (${early})`);
  assert.ok(Math.abs(late / c4 - 1) < 2e-3, `settles on the note (${late})`);
});

test('Stutter lays the noise out as three bursts and a tail, 15 ms apart at the top', () => {
  const onsets = (stutter) => {
    const { L } = render({ noise: 1, click: 0, noisetone: 2000, noiselength: 0.4, stutter, level: 1 }, { frames: SR / 10 });
    // A burst starts where the level jumps: the short-window envelope rising tenfold in a
    // millisecond.
    const win = SR / 2000;
    const env = [];
    for (let i = 0; i + win <= L.length; i += win) env.push(peak(L, i, i + win));
    const out = [];
    for (let k = 0; k < env.length; k++) {
      const before = k === 0 ? 0 : env[k - 1];
      if (env[k] > 0.05 && env[k] > 4 * before) out.push((k * win) / SR);
    }
    return out;
  };
  assert.deepEqual(onsets(0).map((t) => Math.round(t * 1000)), [0], 'one hit at zero');
  const top = onsets(1).map((t) => t * 1000);
  assert.equal(top.length, DRUM_BURSTS + 1, `three bursts and a tail (${top})`);
  top.forEach((t, b) => assert.ok(Math.abs(t - b * DRUM_GAP_SEC * 1000) <= 0.5, `burst ${b} at ${t} ms`));
  const half = onsets(0.5).map((t) => t * 1000);
  half.forEach((t, b) => assert.ok(Math.abs(t - b * DRUM_GAP_SEC * 500) <= 0.5, `burst ${b} at ${t} ms, half way`));
});

test('hits ring into one another: two drums together are the sum of each alone', () => {
  const params = { ...BARE, material: 1, decay: 1 };
  const low = render(params, { hits: [{ at: 0, note: 48, velocity: 1 }] }).L;
  const high = render(params, { hits: [{ at: 2000, note: 55, velocity: 0.7 }] }).L;
  const both = render(params, { hits: [{ at: 0, note: 48, velocity: 1 }, { at: 2000, note: 55, velocity: 0.7 }] });
  let worst = 0;
  for (let i = 0; i < low.length; i++) worst = Math.max(worst, Math.abs(both.L[i] - (low[i] + high[i])));
  assert.ok(worst < 1e-6, `two hits were not the sum of each (${worst})`);
  assert.equal(both.synth.activeVoices, 2);
});

test('the same note twice is two hits, and a note off stops nothing', () => {
  const params = { ...BARE, decay: 1 };
  const once = render(params, { hits: [{ at: 0, note: 60, velocity: 1 }] }).L;
  const off = render(params, { hits: [{ at: 0, note: 60, velocity: 1 }], offs: [{ at: 1000, note: 60 }] }).L;
  assert.deepEqual(off, once, 'a note off changed the hit');
  const twice = render(params, { hits: [{ at: 0, note: 60, velocity: 1 }, { at: 3000, note: 60, velocity: 1 }] });
  assert.equal(twice.synth.activeVoices, 2, 'the second hit took a voice of its own');
});

test('past the voice count the oldest hit gives way', () => {
  const { synth } = render({ ...BARE, decay: 2, voices: 2 }, {
    hits: [0, 500, 1000, 1500].map((at, i) => ({ at, note: 48 + i, velocity: 1 })),
  });
  assert.equal(synth.activeVoices, 2);
  assert.deepEqual(synth.voices.filter((v) => v.active).map((v) => v.note).sort(), [50, 51]);
});

test('a hit finishes, and its voice is free again', () => {
  const { synth } = render({ decay: 0.05, noiselength: 0.05 }, { frames: SR / 2 });
  assert.equal(synth.activeVoices, 0);
});

test('velocity scales the level, and the click a second time', () => {
  const body = (velocity) => render({ ...BARE, decay: 1 }, { hits: [{ at: 0, note: 60, velocity }] }).L;
  const full = body(1);
  const half = body(0.5);
  for (let i = 0; i < full.length; i += 97) assert.ok(Math.abs(half[i] - full[i] * 0.5) < 1e-6);
  // The click alone: the same hit with and without it, from the same noise.
  const click = (velocity) => {
    const on = render({ ...BARE, click: 1 }, { hits: [{ at: 0, note: 60, velocity }], frames: 2048 }).L;
    const off = render(BARE, { hits: [{ at: 0, note: 60, velocity }], frames: 2048 }).L;
    return on.map((v, i) => v - off[i]);
  };
  const c1 = click(1);
  const c5 = click(0.5);
  assert.ok(peak(c1) > 0.1, 'there is a click');
  for (let i = 0; i < c1.length; i++) assert.ok(Math.abs(c5[i] - c1[i] * 0.25) < 1e-6);
});

test('Noise crossfades from the body to all noise', () => {
  const mixAt = (noise) => render({ click: 0, drop: 0, decay: 1, noiselength: 1, noisetone: 3000, noise, level: 1 }).L;
  const bodyOnly = mixAt(0);
  const noiseOnly = mixAt(1);
  // No body left at all noise: the lowest mode's bin is down at the noise floor.
  const c4 = 440 * Math.pow(2, -9 / 12);
  assert.ok(levelAt(noiseOnly, c4, SR / 10, 8192) < levelAt(bodyOnly, c4, SR / 10, 8192) / 30);
  const half = mixAt(0.5);
  for (let i = 0; i < half.length; i += 101) assert.ok(Math.abs(half[i] - 0.5 * (bodyOnly[i] + noiseOnly[i])) < 1e-6);
});

test('the snare\'s body is two lower tones, the second about twice the first', () => {
  const { L } = render({ ...DRUM.presets.snare, noise: 0, click: 0, drop: 0 });
  const f0 = 440 * Math.pow(2, (60 + DRUM.presets.snare.pitch - 69) / 12);
  const n = 1536;
  const first = levelAt(L, f0, 0, n);
  // Where the second mode is, found rather than assumed, between 1.8 and 2.2 times the first.
  let second = 0;
  let where = 0;
  for (let ratio = 1.8; ratio <= 2.2; ratio += 0.005) {
    const v = levelAt(L, f0 * ratio, 0, n);
    if (v > second) { second = v; where = ratio; }
  }
  assert.ok(second > first / 6, `the second tone is there (${(20 * Math.log10(second / first)).toFixed(1)} dB)`);
  for (const ratio of [2.9, 3.4, 4.2]) assert.ok(levelAt(L, f0 * ratio, 0, n) < second / 2, `little above it at ${ratio}`);
  assert.ok(where > 1.9 && where < 2.05, `the second at ${where} times the first`);
});

test('every preset sets only real controls and plays something finite and not too loud', () => {
  const names = Object.keys(DRUM.presets);
  assert.equal(names.length, 36);
  for (const must of ['lowtom', 'conga', 'bongo', 'timbale', 'woodblock', 'clave', 'rim', 'snare', 'clap', 'doum', 'tek']) {
    assert.ok(names.includes(must), `ships ${must}`);
  }
  for (const name of names) {
    const { L } = render(DRUM.presets[name], { frames: SR });
    const p = peak(L);
    assert.ok(Number.isFinite(p) && p > 0.05 && p < 2, `${name} peaks at ${p}`);
  }
});

test('no setting at either end of every range makes a number nobody can play', () => {
  for (const edge of [false, true]) {
    const params = {};
    for (const p of DRUM.params) if (p.id !== 'voices') params[p.id] = edge ? (p.uiMax ?? p.max) : p.min;
    const { L } = render(params, { hits: [{ at: 0, note: 127, velocity: 1 }, { at: 100, note: 0, velocity: 1 }] });
    assert.ok(L.every(Number.isFinite), `${edge ? 'top' : 'bottom'} of every range`);
  }
});

test('Edge brings the upper modes forward, past the lowest at the top, at the same loudness', () => {
  const r = new Float64Array(DRUM_MODES);
  const l = new Float64Array(DRUM_MODES);
  const loud = (norm) => Math.sqrt(l.reduce((e, v) => e + (v * norm) ** 2, 0));
  const flat = drumModes(1, 0, r, l);
  assert.equal(l.indexOf(Math.max(...l)), 0, 'the lowest leads at zero');
  assert.ok(Math.abs(loud(flat) - 1) < 1e-12);
  const top = drumModes(1, 1, r, l);
  assert.ok(Math.max(...l.slice(1)) > l[0], 'an upper mode is louder than the lowest at the top');
  assert.ok(Math.abs(loud(top) - 1) < 1e-12, 'and the body is as loud');
});

test('Ring makes the upper modes last as long as the lowest', () => {
  const bandAt = (ring, hz, from) => {
    const { L } = render({ ...BARE, material: 1, decay: 1, ring }, { frames: SR / 2 });
    return levelAt(L, hz, from, 4096);
  };
  const c4 = 440 * Math.pow(2, -9 / 12);
  // The membrane's 2.92 mode, a third of a second in, against the lowest: gone without Ring.
  const ratio = (ring) => bandAt(ring, c4 * 2.92, SR / 3 - 4096) / bandAt(ring, c4, SR / 3 - 4096);
  const start = bandAt(1, c4 * 2.92, 0) / bandAt(1, c4, 0);
  assert.ok(ratio(0) < start / 20, 'without Ring the upper mode has died away');
  assert.ok(Math.abs(ratio(1) / start - 1) < 0.25, `with Ring it keeps its share (${ratio(1) / start})`);
});

test('Noise Tail adds a quieter stage lasting eight times as long as Noise Length', () => {
  const noise = (tail) => render({ noise: 1, click: 0, noisetone: 2000, noiselength: 0.05, noisetail: tail, level: 1 }, { frames: SR / 2 }).L;
  const rms = (x, from, to) => Math.sqrt(x.slice(from, to).reduce((e, v) => e + v * v, 0) / (to - from));
  const none = noise(0);
  const some = noise(1);
  // Past the first stage's 60 dB (50 ms), only the second is left: 60 dB down over 8 x 50 ms.
  assert.ok(rms(none, SR / 10, SR / 10 + 2400) < 1e-4, 'without Noise Tail the noise has gone');
  const a = rms(some, SR / 10, SR / 10 + 2400);
  const b = rms(some, SR / 5, SR / 5 + 2400);
  assert.ok(a > 1e-3, 'with Noise Tail it is still there');
  const db = 20 * Math.log10(a / b);
  const want = (60 * (SR / 10)) / (TAIL_LENGTH * 0.05 * SR);
  assert.ok(Math.abs(db - want) < 2, `falling ${db.toFixed(1)} dB in 100 ms, against ${want}`);
});

test('Drive is nothing at zero, moves the sound smoothly as it turns, and saturates at the top', () => {
  for (const x of [-1.3, -0.2, 0, 0.4, 2]) assert.equal(drive(x, 0), x);
  for (const x of [-1.3, -0.2, 0.4, 2]) assert.ok(Math.abs(drive(x, 1e-4) - x) < 1e-3, 'a hair of Drive is a hair away');
  assert.ok(Math.abs(drive(0.1, 1)) > 0.3, 'quiet parts come up');
  assert.ok(Math.abs(drive(5, 1)) <= 1, 'and the loud ones are held');
  const plain = render({ ...BARE, material: 0, decay: 1 }).L;
  const driven = render({ ...BARE, material: 0, decay: 1, drive: 0.6 }).L;
  const c4 = 440 * Math.pow(2, -9 / 12);
  const third = (x) => levelAt(x, c4 * 3, 4800, 8192) / levelAt(x, c4, 4800, 8192);
  assert.ok(third(driven) > 30 * third(plain), 'it makes harmonics the body does not have');
});

test('FM puts sidebands around each mode at FM Ratio apart, brightest at the strike', () => {
  const c4 = 440 * Math.pow(2, -9 / 12);
  const hit = (fm) => render({ ...BARE, material: 0, decay: 2, fm, fmratio: 2, filterdecay: 0.3 }, { frames: SR }).L;
  const plain = hit(0);
  const bent = hit(0.5);
  const side = (x, from) => levelAt(x, c4 * 3, from, 4096) / levelAt(x, c4, from, 4096);
  assert.ok(side(plain, 0) < 0.01, 'no sideband without FM');
  assert.ok(side(bent, 0) > 0.1, `a sideband at the note plus twice the note (${side(bent, 0)})`);
  assert.ok(side(bent, SR / 2) < side(bent, 0) / 10, 'fading with the sweep envelope');
});

test('the lowpass is not there at its top, darkens below it, and Filter Sweep opens it at the strike', () => {
  const hit = (params) => render({ ...BARE, material: 1, decay: 1, noise: 0.5, noisetone: 6000, noiselength: 1, ...params }, { frames: SR / 2 }).L;
  const open = hit({});
  const top = hit({ cutoff: DRUM_CUTOFF_TOP, filtersweep: 24, resonance: 0.7 });
  for (let i = 0; i < open.length; i++) assert.equal(top[i], open[i]);
  const high = (x, from) => levelAt(x, 6000, from, 4096);
  const shut = hit({ cutoff: 400 });
  assert.ok(high(shut, SR / 4) < high(open, SR / 4) / 30, 'a low cutoff takes the top off');
  const swept = hit({ cutoff: 400, filtersweep: 48, filterdecay: 0.1 });
  assert.ok(high(swept, 0) > 5 * high(shut, 0), 'swept up, the strike is bright');
  assert.ok(high(swept, SR / 4) < 2 * high(shut, SR / 4), 'and it settles back to the cutoff');
});

test('Resonance rings at the cutoff', () => {
  const hit = (resonance) => render({ noise: 1, click: 0, noisetone: 2000, noiselength: 0.5, cutoff: 1000, resonance, level: 1 }, { frames: SR / 4 }).L;
  const peakiness = (x) => levelAt(x, 1000, 2400, 4096) / levelAt(x, 500, 2400, 4096);
  assert.ok(peakiness(hit(0.9)) > 3 * peakiness(hit(0)), 'a peak at the cutoff');
});

test('FM fades as its sidebands near the top of the band, so a high note does not fold them back', () => {
  const hit = (note, fm) => render({ ...BARE, material: 0, decay: 1, fm, fmratio: 3, filterdecay: 4 }, { hits: [{ at: 0, note, velocity: 1 }], frames: SR / 4 }).L;
  // At note 108 (4.2 kHz) a deep FM's sidebands would reach far past the top: it is faded right out.
  const plain = hit(108, 0);
  const bent = hit(108, 1);
  let worst = 0;
  for (let i = 0; i < plain.length; i++) worst = Math.max(worst, Math.abs(bent[i] - plain[i]));
  assert.ok(worst < 1e-9, `the FM was not faded out (${worst})`);
  // Low down it is all there.
  const low = hit(48, 1);
  let moved = 0;
  const lowPlain = hit(48, 0);
  for (let i = 0; i < low.length; i++) moved = Math.max(moved, Math.abs(low[i] - lowPlain[i]));
  assert.ok(moved > 0.1, 'and is there low down');
});

test('at the top of Resonance a hit rings at its cutoff long after the body, and still ends', () => {
  const { L, synth } = render({ ...BARE, material: 0, decay: 0.05, cutoff: 1000, resonance: 1, filtersweep: 24, filterdecay: 0.02 }, { frames: SR * 2 });
  const late = levelAt(L, 1000, SR / 2, 4096);
  assert.ok(late > 1e-4, `still ringing half a second in (${late})`);
  assert.ok(L.every(Number.isFinite) && Math.max(...L.map(Math.abs)) < 4, 'bounded');
  const frames = SR * 12;
  const long = render({ ...BARE, material: 0, decay: 0.05, cutoff: 1000, resonance: 1, filtersweep: 24, filterdecay: 0.02 }, { frames });
  assert.equal(long.synth.activeVoices, 0, 'and the voice is free again in the end');
  assert.ok(synth);
});
