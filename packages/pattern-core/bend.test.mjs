// Pitch bend - Sig#bend, the roll's drawn curve, and how the two reach the engine.
//
// One control serves both kinds of track, which is the whole design: `bend` is a number of
// SEMITONES on the track's channel strip, sampled continuously like pan or gain. A sampler bends by
// repitching; a plugin gets MIDI pitch bend, encoded against `bendrange` on the engine side (see
// bend-sclang.test.js in osc-engine for that half). Here: the pattern math and what the scheduler
// emits - no engine, no roll panel.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, note, synth, pianoroll, _roll, lfo, sine, CHANNEL_DEFAULTS, DEFAULT_BEND_RANGE, setPatternWarn } from './src/signal.mjs';
import { parseBendPoints, serializeBendPoints, sampleBendPoints, bendIsFlat } from './src/shape.mjs';
import { clearRolls, setRollLayer } from './src/rolls.mjs';
import { Scheduler } from './src/scheduler.mjs';

const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

/** The bend channel's value at an absolute cycle position. */
const bendAt = (sig, pos) => sig.channel.bend?.sample(pos, 1, pos) ?? null;

// ------------------------------------------------------------------ the breakpoint format

test('a bend curve reads cells and semitones, unclamped on both axes', () => {
  const pts = parseBendPoints('0,0 4,2 8,-12,-3');
  assert.deepEqual(pts.map((p) => p.x), [0, 4, 8]);
  // Negative semitones are a bend DOWN, and an octave is a legal thing to ask a sampler for - so
  // neither axis is clamped in the data. The limits live where the limits are (the MIDI encoding,
  // and what a sample survives), not in the drawing.
  assert.deepEqual(pts.map((p) => p.y), [0, 2, -12]);
  assert.equal(pts[2].c, -3);
  assert.equal(serializeBendPoints(pts), '0,0 4,2 8,-12,-3', 'round-trips, curvature and all');
});

test('a curve holds its ends rather than snapping back to centre', () => {
  const pts = parseBendPoints('4,2 8,0');
  assert.equal(sampleBendPoints(pts, 0), 2, 'before the first point it sits where the curve starts');
  assert.equal(sampleBendPoints(pts, 6), 1, '...and interpolates between them');
  assert.equal(sampleBendPoints(pts, 99), 0, '...and holds the last value after the end');
});

test('flat is nothing: no points, or every point at zero', () => {
  assert.equal(bendIsFlat([]), true);
  assert.equal(bendIsFlat(parseBendPoints('0,0 16,0')), true);
  assert.equal(bendIsFlat(parseBendPoints('0,0 4,0.01 16,0')), false, 'a small bend is still a bend');
});

test('a half-typed breakpoint is refused by name, not silently read as zero', () => {
  // Number("") is 0, so "8," would otherwise parse as a point pulling the curve to centre - which
  // on a bend is the slide vanishing while you are still typing its value.
  assert.throws(() => parseBendPoints('0,0 8,'), /bad breakpoint/);
  assert.throws(() => parseBendPoints('8,2 4,0'), /ascending cell order/);
});

// ------------------------------------------------------------------ .bend() on the chain

test('bend and bendrange are channel controls with neutral defaults', () => {
  // Neutral means a track that never mentions bend sounds exactly as it always did - and it is what
  // the scheduler snaps the control back to when a pattern drops it.
  assert.equal(CHANNEL_DEFAULTS.bend, 0);
  assert.equal(CHANNEL_DEFAULTS.bendrange, DEFAULT_BEND_RANGE);
  assert.equal(DEFAULT_BEND_RANGE, 2, 'the range nearly every synth powers up on');
});

test('.bend() takes anything a control takes, on either kind of track', () => {
  assert.equal(bendAt(s('bd*4').bend(-2), 0), -2, 'a constant, on a sampler');
  assert.equal(bendAt(note('c3').synth('Serum 2').bend('<0 2>'), 0), 0, 'a mini string, on a synth');
  assert.equal(bendAt(note('c3').synth('Serum 2').bend('<0 2>'), 1), 2, '...stepping per cycle');
  // A modulator is the case the whole thing is for: a continuous wobble the track bends to.
  const wobble = s('acap').bend(sine(1).range(-1, 1));
  assert.equal(Math.round(bendAt(wobble, 0.25) * 1000) / 1000, 1, 'an LFO rides the channel');
});

test('setting bend replaces what was there, the way every control does', () => {
  const roll = pianoroll('60,0,4', { grid: 8, len: 8, bend: '0,0 4,2 8,0' });
  assert.equal(bendAt(roll, 0.5), 2, 'the drawn curve, at its peak - cell 4 of 8 per cycle');
  assert.equal(bendAt(roll.bend(-5), 0.5), -5, '...replaced outright by a .bend() on the chain');
});

test('the range rides the channel too, and a nonsense one is refused outright', () => {
  const p = note('c3').synth('Serum 2').bend(1, 12);
  assert.equal(bendAt(p, 0), 1);
  assert.equal(p.channel.bendrange.sample(0, 1, 0), 12);
  // Thrown, not warned: a range of zero has no interpretation at all - every bend would encode as
  // an infinity - so there is nothing to fall back to and play.
  assert.throws(() => note('c3').synth('X').bend(1, 0), /has to be positive/);
});

test('a constant bend past the range says so, and a sampler is left alone', () => {
  const { lines } = capture(() => note('c3').synth('Serum 2').bend(7));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /reaches 7 semitones but this track's MIDI bend range is 2/);
  assert.match(lines[0], /\.bend\(sig, 7\)/, 'the message carries the fix');
  // Within the stated range there is nothing to say...
  assert.deepEqual(capture(() => note('c3').synth('Serum 2').bend(7, 12)).lines, []);
  // ...and a sampler has no MIDI range to exceed: it repitches, so it bends as far as it is asked.
  assert.deepEqual(capture(() => s('acap').bend(7)).lines, []);
});

// ------------------------------------------------------------------ the roll's drawn curve

test('a drawn curve loops with the roll it was drawn on', () => {
  // grid 8, len 4: the roll turns over every half cycle, and so must its bend.
  const roll = pianoroll('60,0,2', { grid: 8, len: 4, bend: '0,0 2,4 4,0' });
  assert.equal(bendAt(roll, 0), 0);
  assert.equal(bendAt(roll, 0.25), 4, 'cell 2 of the first pass');
  assert.equal(bendAt(roll, 0.5), 0, 'the loop turns over');
  assert.equal(bendAt(roll, 0.75), 4, 'cell 2 of the second pass - the same place in the curve');
});

test('a curve is read in the same cells the notes are written in, window and all', () => {
  // start: 4 means loop position 0 IS cell 4, for the curve exactly as for the notes - so a bend
  // drawn under a note stays under it when the window is slid.
  const roll = pianoroll('64,4,4', { grid: 8, len: 4, start: 4, bend: '4,0 6,3 8,0' });
  assert.equal(bendAt(roll, 0), 0, 'loop position 0 is cell 4');
  assert.equal(bendAt(roll, 0.25), 3, '...and cell 6 is a quarter cycle in');
});

test('a flat or absent curve gives the roll no bend channel at all', () => {
  // Not a channel reading zero: a channel that is there costs the track a polled control and an
  // engine-side ramp, and a roll that does not bend should cost exactly what it always did.
  assert.equal(pianoroll('60,0,4', { grid: 8, len: 8 }).channel.bend, undefined);
  assert.equal(pianoroll('60,0,4', { grid: 8, len: 8, bend: '0,0 8,0' }).channel.bend, undefined);
  assert.equal(pianoroll('60,0,4', { grid: 8, len: 8, bend: '' }).channel.bend, undefined);
});

test('a broken curve warns and the roll plays straight', () => {
  const { value, lines } = capture(() => pianoroll('60,0,4', { grid: 8, len: 8, bend: '0,0 4,' }));
  assert.equal(value.channel.bend, undefined, 'the notes still play');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /plays with no bend/);
});

test('a swung roll keeps its bend', () => {
  // The swing path rebuilds the Sig twice over (channels, then a stamp on every event); the curve
  // has to survive both, since a groove and a bend are unrelated things to ask of one roll.
  const roll = pianoroll('60,0,1 60,1,1 60,2,1 60,3,1', { grid: 8, len: 8, swing: 0.2, bend: '0,0 4,2 8,0' });
  assert.equal(bendAt(roll, 0.5), 2);
});

// ------------------------------------------------------------------ rolls played by name

test('a pattern of roll names bends with whichever roll is playing', () => {
  fresh();
  _roll('up', '60,0,4', { grid: 8, len: 8, bend: '0,0 4,2 8,0' });
  _roll('down', '60,0,4', { grid: 8, len: 8, bend: '0,0 4,-2 8,0' });
  const part = pianoroll('<up down>');
  assert.equal(bendAt(part, 0.5), 2, 'cycle 0 plays "up"');
  assert.equal(bendAt(part, 1.5), -2, 'cycle 1 plays "down" - and bends its way');
});

test('a roll that has never bent answers nothing, so it costs the track nothing', () => {
  fresh();
  _roll('plain', '60,0,4', { grid: 8, len: 8 });
  // null, not 0: the poll skips a control that answers null entirely, which is what keeps a bend
  // channel off every named-roll track in a patch that uses no bends at all.
  assert.equal(bendAt(pianoroll('plain'), 0), null);
});

test('once one roll has bent, a roll that does not answers centre', () => {
  fresh();
  _roll('bendy', '60,0,4', { grid: 8, len: 8, bend: '0,0 4,2 8,0' });
  _roll('plain', '60,0,4', { grid: 8, len: 8 });
  const part = pianoroll('<bendy plain>');
  assert.equal(bendAt(part, 0.5), 2, 'the bending roll');
  // Silence here would leave the track parked on the last curve's value for the whole next cycle.
  assert.equal(bendAt(part, 1.5), 0, 'the plain roll puts it back to centre, rather than saying nothing');
});

// ------------------------------------------------------------------ what reaches the engine

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, calls, sends: (name) => calls.filter((c) => c.method === 'setParam' && c.args[1] === -1 && c.args[2] === name).map((c) => c.args[3]) };
}

test('bend polls as an ordinary channel control', () => {
  const { engine, calls, sends } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(s('acap').bend(3));
  calls.length = 0;
  sch._pollGenericParams(0);
  assert.deepEqual(sends('bend'), [3], 'pseudo-slot -1, like gain and pan');
});

test('dropping a bend snaps the track back to centre - name gone, or curve deleted', () => {
  fresh();
  _roll('lead', '60,0,4', { grid: 8, len: 8, bend: '0,0 4,2 8,0' });
  const { engine, calls, sends } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(pianoroll('lead').synth('Serum 2'));
  sch._pollGenericParams(0);
  assert.equal(sends('bend').length, 1, 'it is being driven');

  // The .bend() spelling: the control is gone from the pattern, so the name-based reset catches it.
  calls.length = 0;
  sch.setPattern(note('c3').synth('Serum 2'));
  assert.deepEqual(sends('bend'), [0], 'reset to centre on re-eval');

  // The drawn spelling, which the name-based reset CANNOT catch: a pattern of roll names always
  // carries a bend channel, so deleting the curve leaves the channel present and answering null.
  // Without the value check in setPattern the engine would stay parked on the old curve's bend.
  sch.setPattern(pianoroll('lead').synth('Serum 2'));
  sch._pollGenericParams(0);
  _roll('lead', '60,0,4', { grid: 8, len: 8 }); // the curve, deleted in the panel
  calls.length = 0;
  sch.setPattern(pianoroll('lead').synth('Serum 2'));
  assert.deepEqual(sends('bend'), [0], 'a channel that answers nothing counts as dropped');
});

test('a whole modulator past the range says so at eval - it never reaches the poll', () => {
  // One whole modulator on a control is programmed into the engine and run natively, so nothing is
  // sampled per tick and the poll's check would never fire. Its bounds are on the IR instead.
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  const { lines } = capture(() => sch.setPattern(note('c3').synth('Serum 2').bend(lfo('saw').range(0, 9))));
  const said = lines.filter((l) => /MIDI bend range/.test(l));
  assert.equal(said.length, 1);
  assert.match(said[0], /track "lead"/);
  assert.match(said[0], /reaches 9 semitones/);
  // ...and one that stays inside the range it was told about is left alone.
  assert.deepEqual(
    capture(() => sch.setPattern(note('c3').synth('Serum 2').bend(lfo('saw').range(0, 9), 12))).lines.filter((l) => /MIDI bend range/.test(l)),
    []);
});

test('a COMPOSED bend past the range is caught at the poll, once', () => {
  // Anything that is not one whole modulator is polled, and that is where it gets checked - once
  // per evaluation, because a swept bend would otherwise fill the console 33 times a second.
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  const { lines } = capture(() => {
    sch.setPattern(note('c3').synth('Serum 2').bend(sine(1).range(-1, 1).mul(9)));
    for (let i = 0; i < 20; i++) sch._pollGenericParams(i * 0.03);
  });
  assert.equal(lines.filter((l) => /MIDI bend range/.test(l)).length, 1);
});

test('a sampler sweeping past two semitones is never warned about', () => {
  // It repitches rather than sending MIDI, so there is no range for it to exceed - by either route.
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'vox' });
  const { lines } = capture(() => {
    sch.setPattern(s('acap').bend(lfo('saw').range(-12, 12)));
    for (let i = 0; i < 20; i++) sch._pollGenericParams(i * 0.03);
    sch.setPattern(s('acap').bend(sine(1).range(-1, 1).mul(12)));
    for (let i = 0; i < 20; i++) sch._pollGenericParams(i * 0.03);
  });
  assert.deepEqual(lines.filter((l) => /MIDI bend range/.test(l)), []);
});
