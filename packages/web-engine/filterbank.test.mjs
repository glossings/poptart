// The filter bank under Filterbank and Resonator: the moving picture (scroll and ripple), the bands, the
// lists a pattern lays over them, and what the Resonator is tuned to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ShapeField, listLevel, pitchHz } from './src/dsp/filterbank.mjs';
import { FILTERBANK, FilterbankProcessor } from './src/devices/filterbank.mjs';
import { RESONATOR, ResonatorProcessor } from './src/devices/resonator.mjs';
import { spareListSlot } from './src/engine/web-audio-engine.mjs';
import { parseScaleName } from '../pattern-core/src/notes.mjs';

const SR = 48000;

/** A field of n cells run for `seconds`, Shape from `shape(t)`; calls `look(sample, field)` each sample. */
function runField(n, settings, seconds, shape, look, sr = SR) {
  const f = new ShapeField();
  f.ensure(n);
  const { mode = 0, scroll = 0, where = 0, speed = 0, damping = 0, stereo = 0 } = settings;
  f.setup(n, sr, mode, scroll, where, speed, damping, stereo);
  const frames = Math.round(seconds * sr);
  for (let i = 0; i < frames; i++) {
    f.tick(shape(i / sr));
    look?.(i, f);
  }
  return f;
}

/** When each cell first crossed `level`, in seconds (Infinity for one that never did). */
function arrivals(n, settings, seconds, shape, level, side = 'lvL', sr = SR) {
  const when = new Array(n).fill(Infinity);
  runField(n, settings, seconds, shape, (i, f) => {
    for (let k = 0; k < n; k++) if (when[k] === Infinity && f.cells[side][k] >= level) when[k] = i / sr;
  }, sr);
  return when;
}

const defaults = (d) => Object.fromEntries(d.params.map((p) => [p.id, p.default]));

/** A device run over `input` (a function of time, or white noise), block by block. */
function play(Processor, descriptor, params, seconds, { input = null, shapes = [], notes = [], sr = SR } = {}) {
  const fx = new Processor(sr);
  for (const s of shapes) fx.loadShape(s.param, s.slot, s.table);
  const frames = Math.round(seconds * sr);
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  let seed = 1;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  let nextNote = 0;
  for (let at = 0; at < frames; at += 128) {
    const n = Math.min(128, frames - at);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let i = 0; i < n; i++) {
      const v = input ? input((at + i) / sr) : noise() * 0.5;
      l[i] = v;
      r[i] = v;
    }
    while (nextNote < notes.length && notes[nextNote].at * sr < at + n) {
      const one = notes[nextNote++];
      if (one.velocity > 0) fx.noteOn(one.note, one.velocity, one.at);
      else fx.noteOff(one.note, one.at);
    }
    const ol = new Float32Array(128);
    const or = new Float32Array(128);
    fx.process([l, r], [ol, or], n, { ...defaults(descriptor), ...params }, null, at / sr);
    outL.set(ol.subarray(0, n), at);
    outR.set(or.subarray(0, n), at);
  }
  return { fx, outL, outR };
}

const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

// ---- scroll ------------------------------------------------------------------------------------

test('scroll: band k shows what Shape was k bands ago, at the speed asked for', () => {
  const n = 9;
  const speed = 100; // bands per second
  const t0 = 0.05;
  const when = arrivals(n, { mode: 0, scroll: speed }, 0.2, (t) => (t >= t0 ? 1 : 0), 0.5);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(when[k] - (t0 + k / speed)) < 1.5 / speed, `band ${k} saw the step at ${when[k]}, not ${t0 + k / speed}`);
  }
  for (let k = 1; k < n; k++) assert.ok(when[k] > when[k - 1], 'the step travels upwards in order');
});

test('scroll: a negative speed runs the other way, from the top band down', () => {
  const n = 7;
  const when = arrivals(n, { mode: 0, scroll: -60 }, 0.3, (t) => (t >= 0.02 ? 1 : 0), 0.5);
  assert.ok(when[n - 1] < when[0], 'the top band hears it first');
  for (let k = 0; k < n - 1; k++) assert.ok(when[k] > when[k + 1]);
});

test('scroll: Stereo at 1 mirrors the right side, and at 0 the two sides are one picture', () => {
  const n = 8;
  const shape = (t) => (t >= 0.02 ? 1 : 0);
  const left = arrivals(n, { mode: 0, scroll: 80, stereo: 1 }, 0.25, shape, 0.5, 'lvL');
  const right = arrivals(n, { mode: 0, scroll: 80, stereo: 1 }, 0.25, shape, 0.5, 'lvR');
  for (let k = 0; k < n; k++) assert.equal(right[k], left[n - 1 - k]);
  const same = arrivals(n, { mode: 0, scroll: 80, stereo: 0 }, 0.25, shape, 0.5, 'lvR');
  assert.deepEqual(same, arrivals(n, { mode: 0, scroll: 80 }, 0.25, shape, 0.5, 'lvL'));
});

test('scroll: a slow scroll keeps one snapshot per band, not a second of samples', () => {
  const f = runField(16, { mode: 0, scroll: 0.5 }, 0.1, () => 0.3);
  assert.ok(f.cells.cap <= 17, `the history is ${f.cells.cap} long`);
});

// ---- ripple ------------------------------------------------------------------------------------

test('ripple: a strike at the bottom travels up the bank at the wave speed', () => {
  const n = 41;
  const speed = 400;
  const when = arrivals(n, { mode: 1, speed, where: 0, damping: 0 }, 0.12, (t) => (t >= 0.001 && t < 0.005 ? 1 : 0), 0.05);
  for (const k of [10, 20, 30]) {
    const expected = 0.001 + k / speed;
    assert.ok(Math.abs(when[k] - expected) < 0.35 * expected + 0.005, `band ${k}: ${when[k]} against ${expected}`);
  }
  assert.ok(when[10] < when[20] && when[20] < when[30]);
});

test('ripple: the ends reflect - a ripple that reached the top comes back down', () => {
  const n = 61;
  const speed = 400;
  // A smooth bump at the bottom: band 10 sees it go past on the way up, then again once it has
  // bounced off the top, (60 - 10) * 2 bands later.
  const bump = (t) => (t >= 0.001 && t < 0.021 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - 0.001)) / 0.02) : 0);
  const out = { at: 0, v: 0 };
  const back = { at: 0, v: 0 };
  runField(n, { mode: 1, speed, where: 0, damping: 0 }, 0.4, bump, (i, f) => {
    const t = i / SR;
    const v = f.cells.uL[10];
    if (t < 0.1 && v > out.v) { out.v = v; out.at = t; }
    if (t > 0.15 && v > back.v) { back.v = v; back.at = t; }
  });
  const expected = out.at + (2 * (60 - 10)) / speed;
  assert.ok(back.v > 0.3 * out.v, `the echo is ${back.v} against ${out.v}`);
  assert.ok(Math.abs(back.at - expected) < 0.15 * expected, `the echo came back at ${back.at}, not ${expected}`);
});

test('ripple: damping makes ripples die sooner, and a held Shape settles the whole bank', () => {
  const n = 31;
  const swing = (damping) => {
    let peak = 0;
    runField(n, { mode: 1, speed: 300, where: 0, damping }, 0.15, (t) => (t >= 0.001 && t < 0.004 ? 1 : 0), (i, f) => {
      if (i > SR * 0.05) peak = Math.max(peak, Math.abs(f.cells.uL[25]));
    });
    return peak;
  };
  const light = swing(0.01);
  const heavy = swing(0.3);
  assert.ok(heavy < light * 0.5, `damped ${heavy} against ${light}`);
  const f = runField(n, { mode: 1, speed: 300, where: 0.5, damping: 0.2 }, 2, () => 0.6);
  for (let k = 0; k < n; k++) assert.ok(Math.abs(f.cells.lvL[k] - 0.6) < 1e-3, `cell ${k} settled at ${f.cells.lvL[k]}`);
});

test('ripple: Stereo strikes the right side at the mirror of Where', () => {
  const n = 21;
  const shape = (t) => (t >= 0.001 && t < 0.004 ? 1 : 0);
  const right = arrivals(n, { mode: 1, speed: 400, where: 0, damping: 0.05, stereo: 1 }, 0.1, shape, 0.05, 'lvR');
  assert.ok(right[n - 1] < right[0], 'the right side is struck at the top');
});

test('ripple is stable at every extreme: any wave speed, no damping or full, any sample rate', () => {
  for (const sr of [8000, 44100, 192000]) {
    for (const speed of [0, 1, 1e3, 1e5, 1e7]) {
      for (const damping of [0, 0.5, 1]) {
        let worst = 0;
        const f = runField(64, { mode: 1, speed, where: 0.37, damping }, 0.05, (t) => Math.sin(2 * Math.PI * 97 * t) * 0.5 + 0.5, (i, fld) => {
          for (let k = 0; k < 64; k++) worst = Math.max(worst, Math.abs(fld.cells.uL[k]));
        }, sr);
        assert.ok(f.playable(), `sr ${sr} speed ${speed} damping ${damping}: the wave blew up`);
        assert.ok(worst < 50, `sr ${sr} speed ${speed} damping ${damping}: the wave reached ${worst}`);
        // And the step really is under the bound that makes it stable.
        assert.ok(Math.sqrt(f.c2) <= Math.SQRT1_2 + 1e-12);
      }
    }
  }
});

// ---- lists of levels ---------------------------------------------------------------------------

test('a list of levels is one cycle laid across the bank: each band reads the step under its middle', () => {
  const table = Float32Array.from([0, 0.25, 1, 0.25, 0.5, 0, 0.5, 1, 0.5]);
  assert.equal(listLevel(null, 0.3), 1);
  assert.equal(listLevel(table, 0.1), 1);
  assert.equal(listLevel(table, 0.3), 0);
  assert.equal(listLevel(table, 0.9), 0.5);
  assert.equal(listLevel(Float32Array.from([0, 0, 0]), 0.5), 0, 'a cycle of rests is every band at 0');
  // Eight bands under four steps: two each.
  const { fx } = play(FilterbankProcessor, FILTERBANK, { bands: 8, levels: 1 }, 0.01, { shapes: [{ param: 'levels', slot: 1, table: Float32Array.from([0, 0.25, 1, 0.25, 0.5, 0, 0.5, 0.75, 0.5, 0.75, 1, 0.25]) }] });
  assert.deepEqual(Array.from(fx.bank.bands.amp.subarray(0, 8)), [1, 1, 0, 0, 0.5, 0.5, 0.25, 0.25]);
});

test('Filterbank spreads its bands evenly on a log scale and passes a tone at a band more than one between', () => {
  const { fx } = play(FilterbankProcessor, FILTERBANK, { bands: 4, low: 100, high: 1600, width: 0.1 }, 0.01);
  // Four equal shares of 100..1600 Hz: centers at 100 * 16^((k + 0.5) / 4).
  const g = Array.from({ length: 4 }, (_, k) => 100 * 16 ** ((k + 0.5) / 4));
  const tuned = (k) => Math.atan(Math.tan(Math.PI * g[k] / SR)) * SR / Math.PI;
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(tuned(k) - g[k]) < 1e-6);
  const at = (hz) => rms(play(FilterbankProcessor, FILTERBANK, { bands: 4, low: 100, high: 1600, width: 0.1 }, 0.5, { input: (t) => Math.sin(2 * Math.PI * hz * t) }).outL, SR * 0.3);
  assert.ok(at(g[1]) > 5 * at(Math.sqrt(g[1] * g[2])), 'a narrow band rings at its own frequency');
  assert.equal(fx.bank.count, 4);
});

test('Filterbank takes any band count asked for', () => {
  const { fx, outL } = play(FilterbankProcessor, FILTERBANK, { bands: 300 }, 0.02);
  assert.equal(fx.bank.count, 300);
  assert.ok(rms(outL) > 0.01);
});

test('Shape at 0 silences the bank, and Mix 0 is the dry signal exactly', () => {
  const quiet = play(FilterbankProcessor, FILTERBANK, { shape: 0 }, 0.05).outL;
  assert.ok(rms(quiet) < 1e-9);
  const tone = (t) => Math.sin(2 * Math.PI * 440 * t) * 0.5;
  const dry = play(FilterbankProcessor, FILTERBANK, { mix: 0 }, 0.01, { input: tone }).outL;
  for (let i = 0; i < dry.length; i++) assert.equal(dry[i], Math.fround(tone(i / SR)));
});

// ---- the Resonator's tuning --------------------------------------------------------------------

const scaleTable = (name) => {
  const { rootMidi, intervals, period } = parseScaleName(name);
  return Float32Array.from([rootMidi, period, ...intervals]);
};

/** The pitches the Resonator's bands are on this block. */
const bandPitches = (fx) => Array.from(fx.pitch.subarray(0, fx.cellCount));

test('Resonator: a band on every note of the scale across the audible range', () => {
  const { fx } = play(ResonatorProcessor, RESONATOR, { scale: 1 }, 0.01, { shapes: [{ param: 'scale', slot: 1, table: scaleTable('D dorian') }] });
  const pitches = bandPitches(fx);
  const dorian = new Set([2, 4, 5, 7, 9, 11, 0]);
  for (const p of pitches) assert.ok(dorian.has(((p % 12) + 12) % 12), `${p} is not in D dorian`);
  // Every note of the scale in range is there: 7 a period over the ten octaves of hearing.
  const expected = [];
  for (let p = -48; p < 200; p++) if (dorian.has(((p % 12) + 12) % 12) && pitchHz(p) >= 20 && pitchHz(p) < 20000) expected.push(p);
  assert.deepEqual(pitches, expected);
  for (let k = 1; k < pitches.length; k++) assert.ok(pitches[k] > pitches[k - 1]);
});

test('Resonator: a microtonal scale is tuned exactly, off the 12-tone grid', () => {
  const table = scaleTable('31edo');
  const { fx } = play(ResonatorProcessor, RESONATOR, { scale: 1 }, 0.01, { shapes: [{ param: 'scale', slot: 1, table }] });
  const pitches = bandPitches(fx);
  // 31 steps to the octave: each band 12/31 of a semitone above the one under it.
  for (let k = 1; k < pitches.length; k++) assert.ok(Math.abs(pitches[k] - pitches[k - 1] - 12 / 31) < 1e-4);
  assert.ok(pitches.length > 300);
  // Shift moves every band, by a fraction of a semitone too.
  const shifted = bandPitches(play(ResonatorProcessor, RESONATOR, { scale: 1, shift: 0.25 }, 0.01, { shapes: [{ param: 'scale', slot: 1, table }] }).fx);
  const near = shifted.find((p) => p > 60);
  assert.ok(Math.abs(((near - 60.25) / (12 / 31)) - Math.round((near - 60.25) / (12 / 31))) < 1e-3);
});

test('Resonator: with no scale handed over it is on every semitone', () => {
  const pitches = bandPitches(play(ResonatorProcessor, RESONATOR, {}, 0.01).fx);
  for (let k = 1; k < pitches.length; k++) assert.equal(pitches[k] - pitches[k - 1], 1);
});

test('Resonator: a band rings for about as long as Decay', () => {
  // Struck by a click, a band's ring falls 60 dB over Decay.
  const ring = (decay) => {
    const { outL } = play(ResonatorProcessor, RESONATOR, { mix: 1, decay, scale: 1 }, decay * 1.5, {
      input: (t) => (t < 1 / SR ? 1 : 0),
      shapes: [{ param: 'scale', slot: 1, table: Float32Array.from([69, 1200, 0]) }],
    });
    const early = rms(outL, Math.round(0.01 * SR), Math.round(0.02 * SR));
    const late = rms(outL, Math.round(decay * SR) - 480, Math.round(decay * SR) + 480);
    return 20 * Math.log10(late / early);
  };
  for (const decay of [0.3, 1]) {
    const db = ring(decay);
    assert.ok(db < -50 && db > -70, `decay ${decay}: ${db.toFixed(1)} dB after Decay`);
  }
});

test('Resonator: with notes routed in, the bands are the held notes, and a released one rings out', () => {
  const freq = pitchHz(57);
  const { fx, outL } = play(ResonatorProcessor, RESONATOR, { mix: 1, decay: 0.5 }, 1.2, {
    notes: [{ at: 0, note: 57, velocity: 1 }, { at: 0.5, note: 57, velocity: 0 }],
  });
  assert.equal(fx.slots, 1);
  assert.equal(fx.bank.count, 1);
  const b = fx.bank.bands;
  // Its tuning is the note's: g = tan(pi f / sr) solves back to 220 Hz.
  const g = b.a2[0] / b.a1[0];
  assert.ok(Math.abs((Math.atan(g) * SR) / Math.PI - freq) < 1e-6);
  assert.equal(b.held[0], 0, 'let go');
  const held = rms(outL, Math.round(0.3 * SR), Math.round(0.45 * SR));
  const ringing = rms(outL, Math.round(0.52 * SR), Math.round(0.6 * SR));
  const gone = rms(outL, Math.round(1.1 * SR), Math.round(1.2 * SR));
  assert.ok(ringing > held * 0.05, 'it rings on after the note is let go');
  assert.ok(gone < ringing * 0.1, 'and dies away');
});

test('Resonator: a new note takes a released band, and the same note held again takes its own', () => {
  const { fx } = play(ResonatorProcessor, RESONATOR, {}, 0.1, {
    notes: [
      { at: 0, note: 60, velocity: 1 }, { at: 0, note: 64, velocity: 1 },
      { at: 0.02, note: 60, velocity: 0 }, { at: 0.04, note: 67.5, velocity: 0.5 },
      { at: 0.06, note: 64, velocity: 0.8 },
    ],
  });
  assert.equal(fx.slots, 2);
  const b = fx.bank.bands;
  assert.deepEqual([b.note[0], b.note[1]], [67.5, 64]);
  assert.deepEqual([b.vel[0], b.vel[1]], [0.5, 0.8]);
});

// ---- where a list goes on the engine -----------------------------------------------------------

test('a new list takes a slot nothing is still due on: never the one in force, never one pointed at for later', () => {
  const held = { at: new Map() };
  assert.equal(spareListSlot(held, 1, 10), 1);
  held.at.set(1, 9);   // in force since 9
  assert.equal(spareListSlot(held, 1, 10), 2);
  held.at.set(2, 12);  // due at 12
  assert.equal(spareListSlot(held, 1, 10), 3);
  // At 13 the one due at 12 is in force, so 1 is free again.
  assert.equal(spareListSlot(held, 1, 13), 1);
});

test('the browser engine hands a list over into its slot and points the control at it on time', async () => {
  const { WebAudioEngine } = await import('./src/engine/web-audio-engine.mjs');
  const loaded = [];
  const pointed = [];
  const filled = { descriptor: FILTERBANK, built: { loadShape: (param, index, table) => loaded.push([param, index, [...table]]) } };
  const track = { slots: new Map([[1, filled]]), setParamValue: (slot, id, value, at) => pointed.push([slot, id, value, at]) };
  const self = { getTime: () => 5, tracks: new Map([['t', track]]) };
  const engine = Object.assign(Object.create(WebAudioEngine.prototype), self);
  const wants = engine.listParams('t', 1);
  assert.deepEqual(wants.map((w) => [w.id, w.takes]), [['levels', 'list']]);
  const levels = FILTERBANK.params.find((p) => p.id === 'levels');
  engine._loadListParam('t', 1, filled, levels, [0, 0.5, 1, 0.5, 1, 0], 6);
  engine._loadListParam('t', 1, filled, levels, [0, 0.5, 1, 0.5, 1, 0], 7);
  engine._loadListParam('t', 1, filled, levels, [0, 1, 0.25], 8);
  assert.deepEqual(loaded.map(([param, index]) => [param, index]), [['levels', 1], ['levels', 2]]);
  assert.deepEqual(loaded[0][2], [0, 0.5, 1, 0.5, 1, 0]);
  assert.deepEqual(pointed, [[1, 'levels', 1, 6], [1, 'levels', 1, 7], [1, 'levels', 2, 8]]);
});

test('a saved state leaves out Levels and Scale, and a restore has the scheduler hand them over again', async () => {
  const { WebAudioEngine } = await import('./src/engine/web-audio-engine.mjs');
  const pointed = [];
  const filled = {
    descriptor: RESONATOR,
    values: { ...defaults(RESONATOR), levels: 2, scale: 1, decay: 3 },
    extras: { levels: { 2: 'pattern' }, scale: { 1: 'D dorian' } },
    built: { loadShape: () => {} },
  };
  const track = { slots: new Map([[1, filled]]), setParamValue: (slot, id, value) => pointed.push(id) };
  const engine = Object.assign(Object.create(WebAudioEngine.prototype), {
    getTime: () => 0, tracks: new Map([['t', track]]), drivenParams: () => new Map(), _warnOnce: () => {},
  });
  const saved = JSON.parse(Buffer.from(await engine.getPluginState('t', 1), 'base64').toString());
  assert.ok(!('levels' in saved.params) && !('scale' in saved.params), 'the lists are the pattern\'s, not the preset\'s');
  assert.deepEqual(saved.files, {});
  const before = engine.listParams('t', 1)[0].epoch;
  await engine.setPluginState('t', 1, { device: 'Resonator', params: { levels: 5, scale: 4, decay: 2 } });
  assert.ok(!pointed.includes('levels') && !pointed.includes('scale'), 'a restore never moves them');
  assert.notEqual(engine.listParams('t', 1)[0].epoch, before, 'and the scheduler is told to send them again');
});
