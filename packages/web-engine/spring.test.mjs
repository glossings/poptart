// The Spring: that it sounds like a spring tank - echoes that arrive as rising chirps topped out
// at the transition frequency - and that its level, decay, width, drive and mix do what they say.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SPRING, SpringProcessor } from './src/devices/spring.mjs';

const SR = 48000;
const B = 128;

/** Plays `input` (mono, to both sides) through a Spring at the defaults with `over` changed. */
function play(over, input, { during } = {}) {
  const fx = new SpringProcessor(SR);
  const params = {};
  for (const p of SPRING.params) params[p.id] = new Float32Array([p.id in over ? over[p.id] : p.default]);
  const left = new Float32Array(input.length);
  const right = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += B) {
    const n = Math.min(B, input.length - at);
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    const chunk = input.subarray(at, at + n);
    during?.(at, params);
    fx.process([chunk, chunk], [oL, oR], n, params);
    left.set(oL, at);
    right.set(oR, at);
  }
  return { left, right };
}

function impulse(seconds) {
  const x = new Float32Array(Math.round(SR * seconds));
  x[0] = 0.5;
  return x;
}

function noise(seconds, level) {
  let seed = 1;
  return Float32Array.from({ length: Math.round(SR * seconds) }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return ((seed / 4294967296) * 2 - 1) * level;
  });
}

const rms = (x, from = 0, to = x.length) => {
  const a = Math.round(from);
  const b = Math.min(x.length, Math.round(to));
  let e = 0;
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, b - a));
};
const db = (v) => 20 * Math.log10(v + 1e-30);

/** A band-pass at `hz` (RBJ, constant peak gain), run over `x`. */
function band(x, hz, q = 8) {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0; const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0; const a2 = (1 - alpha) / a0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  return Float64Array.from(x, (v) => {
    const y = b0 * v + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    return y;
  });
}

/** Where the loudest moment of `x` is between two times, in seconds. */
function peakTime(x, from, to) {
  let best = 0;
  let at = from;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
    if (Math.abs(x[i]) > best) { best = Math.abs(x[i]); at = i / SR; }
  }
  return at;
}

test('the first echo is a rising chirp: the highs below the transition arrive after the lows', () => {
  const { left } = play({ mix: 1, modulation: 0, length: 0.04, lowcut: 20 }, impulse(0.3));
  // The first echo is over before the second has come round: one trip, plus the chain's delay.
  const low = peakTime(band(left, 300), 0, 0.09);
  const high = peakTime(band(left, 3500), 0, 0.09);
  assert.ok(high > low + 0.01, `3.5 kHz peaked at ${(high * 1000).toFixed(1)} ms, 300 Hz at ${(low * 1000).toFixed(1)} ms`);
});

test('more chirp spreads the echo further in time', () => {
  const spread = (chirp) => {
    const { left } = play({ mix: 1, modulation: 0, length: 0.04, lowcut: 20, chirp }, impulse(0.3));
    // Measured just under the transition frequency (4.3 kHz), where a stronger chirp gathers most
    // of its delay.
    return peakTime(band(left, 4100, 16), 0, 0.3) - peakTime(band(left, 300), 0, 0.3);
  };
  assert.ok(spread(1) > spread(0.2) * 2, `spread at chirp 1: ${spread(1)}, at 0.2: ${spread(0.2)}`);
});

test('above the transition frequency there is only the quiet full-band series', () => {
  for (const transition of [2500, 4300]) {
    const { left } = play({ mix: 1, transition, damping: 16000 }, noise(1.5, 0.3));
    // Each band-pass twice, so the loud band below does not leak into the measurement above.
    const under = rms(band(band(left, transition * 0.7), transition * 0.7), SR / 2);
    const over = rms(band(band(left, transition * 1.6), transition * 1.6), SR / 2);
    assert.ok(db(under) - db(over) > 18, `at ${transition} Hz: ${(db(under) - db(over)).toFixed(1)} dB between below and above`);
  }
});

test('at full mix the tail sits a few decibels under a sustained input', () => {
  const x = noise(3, 0.3);
  const { left } = play({ mix: 1 }, x);
  const level = db(rms(left, SR * 1.5)) - db(rms(x, SR * 1.5));
  assert.ok(level > -9 && level < -3, `the tail measured ${level.toFixed(1)} dB against the input`);
});

test('a longer decay rings longer, falling about sixty decibels over the decay time', () => {
  const fall = (decay) => {
    // Damping wide open, so the decay time is the whole band's.
    const { left } = play({ mix: 1, decay, damping: 16000, lowcut: 20 }, impulse(decay + 1));
    const window = SR / 10;
    const a = db(rms(left, SR * 0.2, SR * 0.2 + window));
    const b = db(rms(left, SR * (0.2 + decay / 2), SR * (0.2 + decay / 2) + window));
    return a - b; // what half the decay time took off
  };
  for (const decay of [1, 4]) {
    const halfway = fall(decay);
    assert.ok(halfway > 22 && halfway < 42, `half of a ${decay} s decay fell ${halfway.toFixed(1)} dB, not about 30`);
  }
});

test('mix 0 is the dry signal, untouched', () => {
  const x = noise(0.2, 0.3);
  const { left, right } = play({ mix: 0 }, x);
  for (let i = 0; i < x.length; i++) {
    assert.equal(left[i], x[i]);
    assert.equal(right[i], x[i]);
  }
});

test('width 1 gives each spring its own side, width 0 puts both in the middle', () => {
  const wide = play({ mix: 1 }, impulse(0.5));
  let differs = 0;
  for (let i = 0; i < wide.left.length; i++) differs = Math.max(differs, Math.abs(wide.left[i] - wide.right[i]));
  assert.ok(differs > 1e-3, 'the two sides were the same at width 1');
  const narrow = play({ mix: 1, width: 0 }, impulse(0.5));
  for (let i = 0; i < narrow.left.length; i++) assert.equal(narrow.left[i], narrow.right[i]);
});

test('drive leaves a quiet input at its level and rounds a loud one off', () => {
  const quiet = noise(1, 0.01);
  const clean = rms(play({ mix: 1 }, quiet).left, SR / 2);
  const driven = rms(play({ mix: 1, drive: 24 }, quiet).left, SR / 2);
  assert.ok(Math.abs(db(driven) - db(clean)) < 1.5, `a quiet input changed ${(db(driven) - db(clean)).toFixed(1)} dB with drive`);
  const loud = noise(1, 0.8);
  const loudClean = rms(play({ mix: 1 }, loud).left, SR / 2);
  const loudDriven = rms(play({ mix: 1, drive: 24 }, loud).left, SR / 2);
  assert.ok(db(loudClean) - db(loudDriven) > 6, `a loud input lost only ${(db(loudClean) - db(loudDriven)).toFixed(1)} dB to drive`);
});

test('every preset and both ends of every control stay finite and under clipping', () => {
  const lows = Object.fromEntries(SPRING.params.map((p) => [p.id, p.min]));
  const highs = Object.fromEntries(SPRING.params.map((p) => [p.id, p.max]));
  const x = noise(3, 0.9);
  for (const [name, over] of [...Object.entries(SPRING.presets), ['lowest', lows], ['highest', highs]]) {
    const { left, right } = play({ ...over, output: 0 }, x);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `${name}: not finite at ${i}`);
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    assert.ok(peak < 4, `${name}: peaked at ${peak.toFixed(2)}`);
  }
});

test('below zero the chirps fall: the lows arrive after the highs', () => {
  const { left } = play({ mix: 1, modulation: 0, length: 0.04, lowcut: 20, chirp: -0.8 }, impulse(0.4));
  const low = peakTime(band(left, 400), 0, 0.3);
  const high = peakTime(band(left, 3800), 0, 0.3);
  assert.ok(low > high + 0.01, `400 Hz peaked at ${(low * 1000).toFixed(1)} ms, 3.8 kHz at ${(high * 1000).toFixed(1)} ms`);
});

test('the transition frequency is not stepped: nearby values sound different', () => {
  const a = play({ mix: 1, transition: 3000 }, impulse(0.3)).left;
  const b = play({ mix: 1, transition: 3100 }, impulse(0.3)).left;
  let differs = 0;
  for (let i = 0; i < a.length; i++) differs = Math.max(differs, Math.abs(a[i] - b[i]));
  assert.ok(differs > 1e-3, '3000 Hz and 3100 Hz came out the same');
});

test('moving the transition frequency bends the tail rather than clearing it, without a jump', () => {
  const swept = play({ mix: 1, decay: 4, modulation: 0 }, impulse(1.5), {
    during: (at, params) => { params.transition[0] = at < SR * 0.5 ? 4300 : 1500; },
  }).left;
  // The tail is still there after the move.
  assert.ok(db(rms(swept, SR * 0.7, SR * 0.9)) > -90, `the tail was ${db(rms(swept, SR * 0.7, SR * 0.9)).toFixed(1)} dB after the move`);
  // And the move glides: nothing leaps from one sample to the next around it.
  let step = 0;
  for (let i = SR * 0.5 - 256; i < SR * 0.5 + 4096; i++) step = Math.max(step, Math.abs(swept[i] - swept[i - 1]));
  let before = 0;
  for (let i = SR * 0.3; i < SR * 0.5 - 256; i++) before = Math.max(before, Math.abs(swept[i] - swept[i - 1]));
  assert.ok(step < before * 4 + 1e-6, `the largest step around the move was ${step}, against ${before} before it`);
});

test('feedback above one holds the tail up instead of letting it decay, and stays bounded', () => {
  const held = play({ mix: 1, feedback: 1.2, decay: 1 }, impulse(4)).left;
  const free = play({ mix: 1, feedback: 0, decay: 1 }, impulse(4)).left;
  const late = (x) => db(rms(x, SR * 3, SR * 4));
  assert.ok(late(held) > -30, `with feedback the tail was ${late(held).toFixed(1)} dB after three seconds`);
  assert.ok(late(free) < -100, `without it the tail was still ${late(free).toFixed(1)} dB`);
  let peak = 0;
  for (const v of held) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak < 4, `feedback peaked at ${peak}`);
});

test('below the decay\'s own gain feedback changes nothing', () => {
  const a = play({ mix: 1, feedback: 0 }, impulse(0.5)).left;
  const b = play({ mix: 1, feedback: 0.3 }, impulse(0.5)).left;
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('a press of Shake knocks the tank once, with no input, and holding it does not knock again', () => {
  const silence = new Float32Array(SR);
  const still = play({ mix: 1 }, silence).left;
  assert.ok(rms(still) < 1e-9, 'the tank made a sound with nothing in it');
  // Pressed at 0.1 s and held to the end.
  const held = play({ mix: 1 }, silence, { during: (at, params) => { params.shake[0] = at >= SR * 0.1 ? 1 : 0; } }).left;
  assert.ok(db(rms(held, SR * 0.1, SR * 0.4)) > -40, `the shake measured ${db(rms(held, SR * 0.1, SR * 0.4)).toFixed(1)} dB`);
  assert.ok(rms(held, 0, SR * 0.1 - 1) < 1e-9, 'it sounded before the press');
  // Pressed twice: released at 0.5 s and pressed again at 0.6 s, so there is more going on late.
  const twice = play({ mix: 1 }, silence, { during: (at, params) => { params.shake[0] = (at >= SR * 0.1 && at < SR * 0.5) || at >= SR * 0.6 ? 1 : 0; } }).left;
  assert.ok(rms(twice, SR * 0.6, SR * 0.9) > rms(held, SR * 0.6, SR * 0.9) * 2, 'a second press did not knock the tank again');
});

/** Plays silence through a Spring with these notes routed in: [frame, note, velocity]. */
function playNotes(over, seconds, notes) {
  const fx = new SpringProcessor(SR);
  const params = {};
  for (const p of SPRING.params) params[p.id] = new Float32Array([p.id in over ? over[p.id] : p.default]);
  fx.setNoteRoute(true);
  const frames = Math.round(SR * seconds);
  const left = new Float32Array(frames);
  const silence = new Float32Array(B);
  let next = 0;
  for (let at = 0; at < frames; at += B) {
    while (next < notes.length && notes[next][0] < at + B) {
      const [frame, note, velocity] = notes[next++];
      fx.noteOn(note, velocity, frame / SR);
    }
    const oL = new Float32Array(B);
    const oR = new Float32Array(B);
    fx.process([silence, silence], [oL, oR], B, params, null, at / SR);
    left.set(oL.subarray(0, Math.min(B, frames - at)), at);
  }
  return left;
}

test('a routed note knocks the tank on its own sample, as hard as its velocity', () => {
  const at = B * 3 + 37;
  const loud = playNotes({ mix: 1, length: 0.03 }, 0.5, [[at, 72, 1]]);
  const quiet = playNotes({ mix: 1, length: 0.03 }, 0.5, [[at, 72, 0.25]]);
  let first = -1;
  for (let i = 0; i < loud.length; i++) if (Math.abs(loud[i]) > 1e-9) { first = i; break; }
  assert.ok(first >= at, `sound started at ${first}, before the note at ${at}`);
  assert.ok(db(rms(loud)) - db(rms(quiet)) > 6, `velocity 1 against 0.25 was only ${(db(rms(loud)) - db(rms(quiet))).toFixed(1)} dB louder`);
});

test('a routed note tunes the ping: a higher note rings higher', () => {
  // The frequency that splits the ping's energy in half, over the octaves it can reach.
  const centroid = (x) => {
    let num = 0;
    let den = 0;
    for (const hz of [200, 300, 450, 700, 1000, 1500, 2200, 3300, 5000]) {
      const e = rms(band(x, hz)) ** 2;
      num += e * Math.log2(hz);
      den += e;
    }
    return 2 ** (num / den);
  };
  const ring = (note) => centroid(playNotes({ mix: 1 }, 1, [[0, note, 1]]).subarray(SR / 10));
  const c3 = ring(60);
  const c4 = ring(72);
  const c5 = ring(84);
  assert.ok(c4 > c3 * 1.2 && c5 > c4 * 1.2, `c3 centered at ${c3.toFixed(0)} Hz, c4 at ${c4.toFixed(0)} Hz, c5 at ${c5.toFixed(0)} Hz`);
});

test('a note off changes nothing, and clearing the route hands Transition back', () => {
  const fx = new SpringProcessor(SR);
  fx.setNoteRoute(true);
  fx.noteOn(72, 1, 0);
  fx.noteOff(72, 0);
  assert.equal(fx.pending.length, 1);
  fx.setNoteRoute(false);
  assert.equal(fx.pending.length, 0);
  assert.equal(fx.noteHz, null);
});
