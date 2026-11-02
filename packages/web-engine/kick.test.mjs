import test from 'node:test';
import assert from 'node:assert/strict';

import { KICK, KICK_PRESETS, KICK_SWEEP_MAX_ST, KickSynth, kickGateAt, kickDrawX } from './src/devices/kick.mjs';
import { midiToHz } from './src/dsp/voice.mjs';
import { fft } from './src/dsp/fft.mjs';

const SR = 48000;
const BLOCK = 128;

/** Plays hits and returns the left channel. `hits` is [{ frame, note, velocity }]. */
function render(change = {}, { frames = SR, hits = [{ frame: 0, note: 29, velocity: 1 }], shapes = [], synth = new KickSynth(SR) } = {}) {
  for (const s of shapes) synth.loadShape(s.param, s.slot, s.table);
  const values = Object.fromEntries(KICK.params.map((p) => [p.id, p.id in change ? change[p.id] : p.default]));
  const out = new Float32Array(frames);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  let next = 0;
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    synth.setParams(values);
    synth.setBend(0);
    while (next < hits.length && hits[next].frame < at + n) {
      const h = hits[next++];
      if (h.velocity > 0) synth.queueNoteOn(h.note, h.velocity, h.frame - at);
      else synth.queueNoteOff(h.note, h.frame - at);
    }
    l.fill(0);
    r.fill(0);
    synth.process(l.subarray(0, n), r.subarray(0, n), n);
    out.set(l.subarray(0, n), at);
  }
  return out;
}

/** Frequency from the rising zero crossings between two times, in seconds. */
function pitchBetween(x, from, to) {
  const crossings = [];
  for (let i = Math.floor(from * SR) + 1; i < to * SR; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
  }
  if (crossings.length < 2) return 0;
  return ((crossings.length - 1) * SR) / (crossings[crossings.length - 1] - crossings[0]);
}

const rmsOf = (x, from, to) => {
  let e = 0;
  for (let i = Math.floor(from * SR); i < to * SR; i++) e += x[i] * x[i];
  return Math.sqrt(e / ((to - from) * SR));
};

/** A harmonic's level against the fundamental over a stretch, Hann-windowed. */
function harmonicDb(x, f, k, from, to) {
  const level = (m) => {
    let re = 0;
    let im = 0;
    const a = Math.floor(from * SR);
    const len = Math.floor((to - from) * SR);
    for (let j = 0; j < len; j++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / len);
      re += w * x[a + j] * Math.cos((2 * Math.PI * m * f * (a + j)) / SR);
      im += w * x[a + j] * Math.sin((2 * Math.PI * m * f * (a + j)) / SR);
    }
    return Math.hypot(re, im);
  };
  return 20 * Math.log10(level(k) / level(1));
}

const quiet = { click: 0, tone: 1 };

test('the sweep settles on the note, by the end of its fixed curve', () => {
  for (const note of [24, 29, 36, 45]) {
    const out = render({ ...quiet, decay: 1 }, { hits: [{ frame: 0, note, velocity: 1 }] });
    const settled = pitchBetween(out, 0.12, 0.3);
    assert.ok(Math.abs(settled / midiToHz(note) - 1) < 0.01, `note ${note}: settled at ${settled.toFixed(2)} Hz`);
  }
});

test('Sweep is how far above the note the hit starts, in semitones', () => {
  const start = (sweep) => pitchBetween(render({ ...quiet, sweep }), 0.001, 0.015);
  const f0 = midiToHz(29);
  assert.ok(Math.abs(pitchBetween(render({ ...quiet, sweep: 0 }), 0, 0.1) / f0 - 1) < 0.01, 'no sweep, no fall');
  for (const st of [24, 36, 48]) {
    const got = 12 * Math.log2(start(st) / f0);
    // The first fifteen milliseconds, while it holds and starts to fall: just under Sweep.
    assert.ok(got < st && got > st - 8, `Sweep ${st}: started ${got.toFixed(1)} st above the note`);
  }
});

test('a shorter click charges the sweep less and clicks brighter', () => {
  const long = pitchBetween(render({ ...quiet, sweep: 36, clicklength: 5 }), 0.004, 0.012);
  const short = pitchBetween(render({ ...quiet, sweep: 36, clicklength: 0.1 }), 0.002, 0.01);
  assert.ok(short < long * 0.8, `sweep at 0.1 ms ${short.toFixed(1)} Hz, at 5 ms ${long.toFixed(1)} Hz`);
  const brightAt = (clicklength) => {
    const settings = { sweep: 0, level: 1, tone: 1, drive: 0, click: 1, clicktone: 0, decay: 0.05, clicklength };
    const x = render(settings, { frames: 4096 });
    const body = render({ ...settings, click: 0 }, { frames: 4096 });
    const re = new Float64Array(4096);
    const im = new Float64Array(4096);
    for (let i = 0; i < 4096; i++) re[i] = x[i] - body[i];
    fft(re, im);
    let hi = 0;
    let all = 0;
    for (let k = 1; k < 2048; k++) {
      const e = re[k] * re[k] + im[k] * im[k];
      all += e;
      if ((k * SR) / 4096 > 2000) hi += e;
    }
    return hi / all;
  };
  assert.ok(brightAt(0.3) > brightAt(10) * 4, 'a short pulse is the brighter click');
});

test('the band-limited pulse keeps its area and its length', () => {
  for (const edge of [4.8, 24, 37.25, 720]) {
    let area = 0;
    for (let n = 0; n < edge + 3; n++) area += kickGateAt(n, edge);
    assert.ok(Math.abs(area - edge) < 1e-9, `a pulse ${edge} samples long has area ${area}`);
  }
});

test('Decay is when the level reaches zero, and Tail keeps the belly', () => {
  const synth = new KickSynth(SR);
  const out = render({ ...quiet, decay: 0.4 }, { synth });
  assert.ok(rmsOf(out, 0.02, 0.05) > 0.1, 'it sounds');
  // Once Decay has passed, only the coupling highpass settling is left, 50 dB down.
  assert.ok(rmsOf(out, 0.42, 0.5) < rmsOf(out, 0.02, 0.05) * 0.003, 'and is gone once Decay has passed');
  assert.equal(synth.activeVoices, 0, 'and has finished within the second');
  const thin = render({ ...quiet, decay: 0.4, tail: 0 });
  const full = render({ ...quiet, decay: 0.4, tail: 1 });
  assert.ok(rmsOf(full, 0.18, 0.22) > rmsOf(thin, 0.18, 0.22) * 3, 'more Tail, more belly');
});

test('Drive squares the body off, with the circuit\'s even harmonics', () => {
  const f = midiToHz(36);
  const at = (drive) => render({ ...quiet, drive, decay: 4, tail: 1 }, { hits: [{ frame: 0, note: 36, velocity: 1 }] });
  const clean = at(0);
  const hard = at(1);
  const fitted = at(0.32);
  assert.ok(harmonicDb(clean, f, 3, 0.3, 0.5) < -40, `the clean third: ${harmonicDb(clean, f, 3, 0.3, 0.5).toFixed(1)} dB`);
  assert.ok(harmonicDb(hard, f, 3, 0.3, 0.5) > -12, `the driven third: ${harmonicDb(hard, f, 3, 0.3, 0.5).toFixed(1)} dB`);
  // The measured hits' second harmonic sits about 25 dB down, which the saturator's offset gives.
  const second = harmonicDb(fitted, f, 2, 0.3, 0.5);
  assert.ok(second > -30 && second < -20, `the second at the default Drive: ${second.toFixed(1)} dB`);
});

test('a new hit restarts the sweep and fades the old one out without a step', () => {
  const second = Math.round(0.2 * SR) + 17;
  const out = render({ ...quiet }, { hits: [{ frame: 0, note: 29, velocity: 1 }, { frame: second, note: 29, velocity: 1 }] });
  const alone = render({ ...quiet });
  const a = pitchBetween(alone, 0.005, 0.05);
  const b = pitchBetween(out, second / SR + 0.005, second / SR + 0.05);
  assert.ok(Math.abs(a / b - 1) < 0.02, `first hit's sweep ${a.toFixed(1)} Hz, second's ${b.toFixed(1)} Hz`);
  let jump = 0;
  for (let i = second - 2; i < second + 300; i++) jump = Math.max(jump, Math.abs(out[i + 1] - out[i]));
  let slope = 0;
  for (let i = 1; i < 300; i++) slope = Math.max(slope, Math.abs(alone[i + 1] - alone[i]));
  assert.ok(jump < slope * 1.5, 'no click where the old hit gave way');
});

test('a hit plays out whatever its note length', () => {
  const held = render({ ...quiet });
  const cut = render({ ...quiet }, { hits: [{ frame: 0, note: 29, velocity: 1 }, { frame: 100, note: 29, velocity: 0 }] });
  assert.deepEqual(cut, held);
});

test('velocity scales the hit', () => {
  const loud = render({ ...quiet });
  const soft = render({ ...quiet }, { hits: [{ frame: 0, note: 29, velocity: 0.5 }] });
  assert.ok(Math.abs(rmsOf(soft, 0, 0.3) / rmsOf(loud, 0, 0.3) - 0.5) < 1e-6);
});

test('a drawn curve is the pitch over time, in semitones above the note on a square-root time axis', () => {
  // Two octaves up for the first 100 ms, then the note.
  const table = Float32Array.from({ length: 256 }, (_, i) => (i / 255 < kickDrawX(0.1) ? 24 / KICK_SWEEP_MAX_ST : 0));
  for (const note of [29, 41]) {
    const out = render({ ...quiet, decay: 1, pitchenv: 1 }, { shapes: [{ param: 'pitchenv', slot: 1, table }], hits: [{ frame: 0, note, velocity: 1 }] });
    const early = pitchBetween(out, 0.01, 0.09);
    const late = pitchBetween(out, 0.12, 0.3);
    assert.ok(Math.abs(early / (4 * midiToHz(note)) - 1) < 0.02, `note ${note}: two octaves up early, at ${early.toFixed(1)} Hz`);
    assert.ok(Math.abs(late / midiToHz(note) - 1) < 0.01, `note ${note}: on the note after 100 ms, at ${late.toFixed(1)} Hz`);
  }
  // A slot with nothing drawn in it plays the fixed curve.
  assert.deepEqual(render({ ...quiet, pitchenv: 3 }), render({ ...quiet }));
});

test('the Pitch Env picker heads the sweep picture, a graph labeled for the note last played', async () => {
  const { buildPanel } = await import('./src/panel.mjs');
  const { buildFigures } = await import('./src/figures.mjs');
  const panel = buildPanel(KICK, {});
  assert.ok(!panel.sections.flatMap((s) => s.widgets.map((w) => w.id)).includes('pitchenv'), 'no picker in a row of knobs');
  const figs = panel.sections.flatMap((s) => s.figures);
  assert.deepEqual(figs.map((f) => [f.kind, (f.widgets ?? []).map((w) => w.id)]), [['hitpitch', ['pitchenv']]]);

  const [before] = buildFigures(KICK, {});
  assert.equal(before.shapeAxes.grid.y[0].label, '44 Hz f0', 'f0 before anything has played');
  const synth = new KickSynth(SR);
  render({}, { synth, hits: [{ frame: 0, note: 33, velocity: 1 }], frames: 1024 });
  const [after] = buildFigures(KICK, {}, { report: synth.report() });
  assert.equal(after.shapeAxes.grid.y[0].label, '55 Hz a0');
  assert.deepEqual(after.shapeAxes.grid.x.map((t) => t.label), ['10 ms', '25 ms', '50 ms', '100 ms', '200 ms', '400 ms']);
  // The fixed curve follows Sweep, and reads as the hit plays: starting just under it.
  const peak = (sweep) => Math.max(...buildFigures(KICK, { sweep })[0].points.map((p) => p.y)) * KICK_SWEEP_MAX_ST;
  assert.ok(peak(36) > peak(18) * 1.8 && peak(36) < 36, `peaks ${peak(18).toFixed(1)}, ${peak(36).toFixed(1)} st`);
  // A drawn curve is drawn as it is.
  const ramp = Array.from({ length: 256 }, (_, i) => 1 - i / 255);
  const [drawn] = buildFigures(KICK, { pitchenv: 2 }, { shapes: { 2: { name: 'down', points: ramp } } });
  assert.equal(drawn.curveName, 'down');
  assert.ok(Math.abs(drawn.points[96].y - (1 - 96 / 191)) < 0.01);
});

test('the presets set controls the Kick has, inside their ranges', () => {
  assert.ok(Object.keys(KICK_PRESETS).length >= 4);
  for (const [name, values] of Object.entries(KICK_PRESETS)) {
    assert.match(name, /^[a-z][a-z0-9]*$/);
    for (const [id, v] of Object.entries(values)) {
      const p = KICK.params.find((x) => x.id === id);
      assert.ok(p, `${name} sets ${id}, which the Kick does not have`);
      assert.ok(Number.isFinite(v) && v >= p.min && v <= p.max, `${name}: ${id} = ${v}`);
    }
  }
});

test('a high, driven note does not alias', () => {
  const note = 84;
  const f = midiToHz(note);
  const x = render({ ...quiet, sweep: 0, drive: 1, decay: 4, tail: 1 }, { hits: [{ frame: 0, note, velocity: 1 }] });
  const N = 8192;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const from = Math.floor(0.2 * SR);
  for (let i = 0; i < N; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft(re, im);
  let total = 0;
  let off = 0;
  for (let k = 1; k < N / 2; k++) {
    const e = re[k] * re[k] + im[k] * im[k];
    const hz = (k * SR) / N;
    total += e;
    const h = hz / f;
    if (Math.abs(h - Math.round(h)) * f > 60) off += e;
  }
  const db = 10 * Math.log10(off / total);
  assert.ok(db < -50, `${db.toFixed(1)} dB away from the harmonics`);
});
