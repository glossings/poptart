// The gestures on a generated device window's figures (public/client.js).
//
// The pictures themselves are computed in web-engine and tested there, without a DOM. What lives
// only in the browser file is how a pointer becomes a parameter, and that is the part with the
// corners in it: two kinds of grab, an axis that has to agree with a knob's curve, and a time that
// is drawn scaled and written back unscaled. None of it needs a canvas, so none of it is tested
// through one - the functions are lifted out of the source the way the slice editor's tests lift
// theirs, and run against the real figures web-engine builds.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultValues } from '../web-engine/src/descriptor.mjs';
import { normalize } from '../web-engine/src/descriptor.mjs';
import { buildFigures } from '../web-engine/src/figures.mjs';
import { WAVETABLE } from '../web-engine/src/devices/wavetable.mjs';
import { FILTER } from '../web-engine/src/devices/filter.mjs';
import { FMSYNTH } from '../web-engine/src/devices/fmsynth.mjs';
import { sharedBuiltInTables } from '../web-engine/src/dsp/tables.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

/** One function's source, by name - if it is renamed this test says so rather than going quiet. */
function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

/** The constants the grabbed functions close over, read out of the source rather than restated. */
function constant(name) {
  const m = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return m[1];
}

const bodies = ['fieldGrab', 'figurePosition', 'adsrGrab', 'figureLevelY', 'figureLevelAt', 'figurePad', 'figureSeconds', 'figureHz', 'isPlainSetting', 'wrappedSpans', 'matrixGeometry', 'matrixCell', 'matrixGrab']
  .map(grab).join('\n\n');
const { fieldGrab, figurePosition, adsrGrab, figureLevelY, figureLevelAt, figureSeconds, figureHz, isPlainSetting, wrappedSpans, matrixGeometry, matrixCell, matrixGrab } =
  new Function(`
    const FIGURE_HIT_PX = ${constant('FIGURE_HIT_PX')};
    const FIGURE_PAD_Y = ${constant('FIGURE_PAD_Y')};
    const AXIS_LATCH = ${constant('AXIS_LATCH')};
    ${bodies}
    return { fieldGrab, figurePosition, adsrGrab, figureLevelY, figureLevelAt, figureSeconds, figureHz, isPlainSetting, wrappedSpans, matrixGeometry, matrixCell, matrixGrab };
  `)();

const tables = sharedBuiltInTables();
const defaults = defaultValues(WAVETABLE);
// The Wavetable's figures and the Filter effect's, together: the response curve moved to the
// effect when the synth lost its filter, and the gestures on it are the same.
const figureOf = (kind, over = {}, nth = 0) => [
  ...buildFigures(WAVETABLE, { ...defaults, ...over }, { tables, sampleRate: 48000 }),
  ...buildFigures(FILTER, { ...defaultValues(FILTER), ...over }, { tables, sampleRate: 48000 }),
].filter((f) => f.kind === kind)[nth];

const param = (id) => WAVETABLE.params.find((p) => p.id === id) ?? FILTER.params.find((p) => p.id === id);

// --- the axis a field is laid out on ----------------------------------------------------------

test('a figure axis agrees with the knob curve of the parameter it drags', () => {
  // This is the whole reason a field drag sends POSITIONS. The response curve's x axis is
  // logarithmic and the cutoff parameter's curve is exponential; if the two ever disagreed, a
  // horizontal drag would land somewhere other than where the pointer was put.
  for (const cutoff of [20, 100, 440, 1000, 5000, 20000]) {
    const f = figureOf('response', { 'cutoff': cutoff });
    assert.ok(
      Math.abs(figurePosition(f, 'x') - normalize(param('cutoff'), cutoff)) < 1e-12,
      `${cutoff} Hz sits at the same place on the axis as on the knob`,
    );
  }
  // And the same for the plain linear ones.
  for (const pos of [0, 0.42, 1]) {
    assert.equal(figurePosition(figureOf('wavetable', { 'osc1.position': pos }), 'x'), pos);
  }
  const spread = figureOf('unison', { 'osc1.detune': 40, 'osc1.spread': 0.25 });
  assert.equal(figurePosition(spread, 'y'), normalize(param('osc1.spread'), 0.25));
  assert.equal(figurePosition(spread, 'x'), normalize(param('osc1.detune'), 40));
});

// --- a field grab -----------------------------------------------------------------------------

test('a field drag is relative, so taking hold of it never jumps the value', () => {
  const f = figureOf('response', { 'cutoff': 1000, 'resonance': 0.4 });
  const grabbed = fieldGrab(f);
  // Pressed and not moved: both controls are exactly where they were.
  const still = grabbed.at(0, 0).params;
  assert.deepEqual(still.map((p) => p.id), ['cutoff', 'resonance']);
  assert.ok(Math.abs(still[0].position - figurePosition(f, 'x')) < 1e-12);
  assert.ok(Math.abs(still[1].position - figurePosition(f, 'y')) < 1e-12);
  // And a movement carries on from where the control already was.
  const moved = grabbed.at(0.05, 0).params.find((p) => p.id === 'cutoff');
  assert.ok(Math.abs(moved.position - (figurePosition(f, 'x') + 0.05)) < 1e-12);
});

test('a two-axis field is an x-y control: both move at once, in one request', () => {
  // It used to pick one axis per gesture, which was a fix for re-deciding the axis every frame
  // and sticking. But a pad that moves one way at a time is not a pad: the thing wanted from a
  // filter's picture is to sweep the cutoff and the resonance together.
  const f = figureOf('response', { 'cutoff': 1000, 'resonance': 0.4 });
  const both = fieldGrab(f).at(0.3, -0.2).params;
  const cutoff = both.find((p) => p.id === 'cutoff');
  const resonance = both.find((p) => p.id === 'resonance');
  assert.ok(cutoff.position > figurePosition(f, 'x'), 'sideways moved the cutoff');
  assert.ok(resonance.position > figurePosition(f, 'y'), 'and up raised the resonance, in the same gesture');
  // Up is more, not less - the y axis is inverted between the pointer and the value.
  assert.ok(fieldGrab(f).at(0, 0.2).params.find((p) => p.id === 'resonance').position < figurePosition(f, 'y'), 'dragging down lowers it');
});

test('a field drag cannot be pushed past either end of the parameter', () => {
  const f = figureOf('response', { 'cutoff': 1000, 'resonance': 0.5 });
  const at = (dx, dy, id) => fieldGrab(f).at(dx, dy).params.find((p) => p.id === id).position;
  assert.equal(at(50, 0, 'cutoff'), 1);
  assert.equal(at(-50, 0, 'cutoff'), 0);
  assert.equal(at(0, -50, 'resonance'), 1);
  assert.equal(at(0, 50, 'resonance'), 0);
});

test('an axis something else is driving does not drag, and a figure driven throughout does not either', () => {
  const driven = (map) => buildFigures(FILTER, defaultValues(FILTER), { tables, modulated: new Map(map) })
    .find((f) => f.kind === 'response');

  // The cutoff is being moved by an LFO, so only the resonance is left to drag - whichever way the
  // gesture goes.
  const one = fieldGrab(driven([['cutoff', 'lfo']]));
  assert.deepEqual(one.at(0.5, 0).params.map((p) => p.id), ['resonance']);
  assert.deepEqual(one.at(0, 0.5).params.map((p) => p.id), ['resonance']);

  // Both driven: there is nothing to take hold of, and the gesture never starts.
  assert.equal(fieldGrab(driven([['cutoff', 'lfo'], ['resonance', 'env']])), null);
});

test('a figure with nothing declared draggable is not draggable', () => {
  assert.equal(fieldGrab({ kind: 'response', drag: null }), null);
});

// --- an envelope grab -------------------------------------------------------------------------

const W = 400;
const H = 108;
const envFig = (over) => figureOf('adsr', {
  'ampenv.attack': 0.1, 'ampenv.decay': 0.2, 'ampenv.sustain': 0.5, 'ampenv.release': 0.3, ...over,
});

/** Where a handle is drawn, in the canvas coordinates a pointer arrives in. */
const handleAt = (f, role) => {
  const h = f.handles.find((x) => x.role === role);
  return { x: h.x * W, y: figureLevelY(h.y, H) };
};

test('a press picks up the handle it is on, and nothing when it is on none', () => {
  const f = envFig();
  for (const role of ['attack', 'decay', 'release']) {
    const at = handleAt(f, role);
    const grabbed = adsrGrab(f, at.x, at.y, W, H);
    assert.ok(grabbed, `${role} is grabbable where it is drawn`);
    const moved = grabbed.at(0.1, 0, at.y, H);
    assert.equal(moved.id, `ampenv.${role}`, `and moves the ${role}`);
  }
  // Empty space is NOT nothing any more: a press away from the handles is on a SEGMENT, and a
  // vertical drag there bends it - the gesture the shape editor and the bend lane already use.
  const onRelease = adsrGrab(f, W * 0.8, H - 2, W, H);
  assert.equal(onRelease.role, 'rcurve', 'the release segment, which is what sits there');
  assert.equal(onRelease.at(0, -0.2).id, 'env.rcurve');
  // Over the sustain there is no segment to bend - a sustain is a level, not a ramp - so a
  // press there, away from the plateau's own line, takes hold of nothing.
  assert.equal(adsrGrab(f, W * 0.5, H - 2, W, H), null);
});

test('a handle moves its stage by how far the pointer went, in the figure\'s own seconds', () => {
  const f = envFig();
  const at = handleAt(f, 'attack');
  const g = adsrGrab(f, at.x, at.y, W, H);
  assert.ok(Math.abs(g.at(0, 0, at.y, H).value - 0.1) < 1e-12, 'unmoved, it sends what it had');
  // A tenth of the width is a tenth of the span, added to the attack it started from.
  assert.ok(Math.abs(g.at(0.1, 0, at.y, H).value - (0.1 + 0.1 * f.span)) < 1e-12);
  assert.equal(g.at(-50, 0, at.y, H).value, 0, 'and it cannot be dragged below zero');
});

test('a time is drawn scaled and written back unscaled', () => {
  // The figure is drawn in the seconds the generator runs, envscale folded in; `.param("Amp
  // Attack", …)` is the time before it. Writing the scaled number back would move the value by the
  // scale a second time, and the handle would run away from the pointer.
  const f = envFig({ 'env.scale': 4 });
  assert.equal(f.attack, 0.4, 'drawn at four times the parameter');
  const at = handleAt(f, 'attack');
  const g = adsrGrab(f, at.x, at.y, W, H);
  assert.ok(Math.abs(g.at(0, 0, at.y, H).value - 0.1) < 1e-12, 'and written back as the parameter');
});

test('the decay point is two controls at once, the way the sampler\'s is', () => {
  const f = envFig();
  const at = handleAt(f, 'decay');
  const fresh = () => adsrGrab(f, at.x, at.y, W, H);
  assert.equal(fresh().at(0.2, 0.02, at.y, H).id, 'ampenv.decay', 'sideways is the decay');
  const up = fresh().at(0.02, -0.2, figureLevelY(0.9, H), H);
  assert.equal(up.id, 'ampenv.sustain', 'and up is the sustain');
  assert.ok(Math.abs(up.value - 0.9) < 1e-9, 'which follows the pointer rather than a delta');

  // Decided once, like a field's: a decay dragged out sideways stays the decay even where the
  // hand drifts up more than it went along.
  const g = fresh();
  assert.equal(g.at(0.2, 0, at.y, H).id, 'ampenv.decay');
  assert.equal(g.at(0.21, 0.5, at.y, H).id, 'ampenv.decay');
});

test('the plateau sets the sustain level and only that', () => {
  const f = envFig();
  const midX = ((f.plateau.x0 + f.plateau.x1) / 2) * W;
  const g = adsrGrab(f, midX, figureLevelY(f.plateau.y, H), W, H);
  assert.ok(g, 'the plateau is grabbable along its length');
  const moved = g.at(0.3, -0.2, figureLevelY(0.25, H), H);
  assert.equal(moved.id, 'ampenv.sustain');
  assert.ok(Math.abs(moved.value - 0.25) < 1e-9, 'however far sideways the pointer also went');
});

test('a level follows the pointer and stops at the top and bottom of the axis', () => {
  assert.equal(figureLevelAt(figureLevelY(0.42, H), H).toFixed(10), (0.42).toFixed(10));
  assert.equal(figureLevelAt(-100, H), 1);
  assert.equal(figureLevelAt(H + 100, H), 0);
});

test('an envelope whose times something else is driving does not drag by them', () => {
  const f = buildFigures(WAVETABLE, defaults, { tables, modulated: new Map([['ampenv.attack', 'lfo']]) })
    .find((x) => x.id === 'ampenv');
  const at = handleAt(f, 'attack');
  // The attack handle moves nothing but the attack, and the attack is taken - so there is no grab.
  assert.equal(adsrGrab(f, at.x, at.y, W, H), null);
  // The decay handle still has the sustain to move, so it is grabbable for that alone.
  const d = handleAt(f, 'decay');
  const g = adsrGrab(f, d.x, d.y, W, H);
  assert.equal(g.at(0.3, 0, d.y, H).id, 'ampenv.decay');
});

// --- the readouts -----------------------------------------------------------------------------

test('a readout prints a time and a frequency in the unit it reads best in', () => {
  // Fixed decimals AND a fixed width: a readout being dragged past a power of ten must not
  // shove everything beside it sideways. The padding is a figure space, as wide as a digit.
  const bare = (t) => t.replace(/\u2007/g, '');
  assert.equal(bare(figureSeconds(0)), '0.0 ms');
  assert.equal(bare(figureSeconds(0.005)), '5.0 ms');
  assert.equal(bare(figureSeconds(0.15)), '150.0 ms');
  assert.equal(bare(figureSeconds(1.5)), '1.50 s');
  assert.equal(bare(figureHz(440)), '440 Hz');
  assert.equal(bare(figureHz(1000)), '1.00 kHz');
  assert.equal(bare(figureHz(12800)), '12.80 kHz');
  for (const s of [0, 0.005, 0.15, 0.9999, 1.5, 99]) assert.equal(figureSeconds(s).length, 8, `${s} s`);
  for (const hz of [20, 440, 999, 1000, 12800, 20000]) assert.equal(figureHz(hz).length, 9, `${hz} Hz`);
});

// --- what a capture replaces ------------------------------------------------------------------

test('a capture replaces the settings a preset now carries, and leaves the modulation alone', () => {
  // A device we wrote is captured whole, so a `.param()` holding one of its numbers is a second
  // copy of what the preset says - and the copy that wins, since a polled control is re-sent
  // every tick. These are the arguments that make a call worth dropping.
  for (const arg of ['0.5', '-3', '1', '0.009479', '1e-3', '"Sync"', '"wt:Basic/saw.wav"', "'fold'"]) {
    assert.equal(isPlainSetting(arg), true, `${arg} is a setting`);
  }
  // And these are not settings at all - they are what is MOVING the control, which no preset can
  // hold and which must survive the capture.
  for (const arg of ['lfo(2)', 'audio("mod")', 'env()', 'sine(0.25).range(0.3, 0.8)', 'macro(1)', '"<a b>"', '"a b"', '"saw*2"', '"[a,b]"', 'x']) {
    assert.equal(isPlainSetting(arg), false, `${arg} is not a setting`);
  }
});

// --- a read position that runs off the end of a file -------------------------------------------

test('a spray band that wraps past the end of a file is drawn as the two pieces it is', () => {
  const near = (span, [from, to]) => assert.ok(Math.abs(span[0] - from) < 1e-12 && Math.abs(span[1] - to) < 1e-12, `${span} is ${from}..${to}`);
  const plain = wrappedSpans(0.2, 0.4);
  assert.equal(plain.length, 1);
  near(plain[0], [0.2, 0.4]);
  // Off the right-hand end: the rest of it comes back in at the left, which is where the grains
  // really are - the read wraps.
  const [head, tail] = wrappedSpans(0.9, 1.1);
  near(head, [0.9, 1]);
  near(tail, [0, 0.1]);
  // And off the left-hand end, the same way round.
  const [a, b] = wrappedSpans(-0.1, 0.1);
  near(a, [0.9, 1]);
  near(b, [0, 0.1]);
  // A spray of everything is the whole file, not a band round and round it.
  assert.deepEqual(wrappedSpans(-0.5, 1.5), [[0, 1]]);
});

// --- the FM matrix ----------------------------------------------------------------------------
//
// Sixty-four cells with no labels on either axis: the operator number was buried in the diagonal,
// so "2 modulating 1" and "1 modulating 2" were two squares either side of a line with nothing to
// say which was which. The axes are labeled now, which means the grid no longer starts at the
// corner of the canvas - and the hit test has to move with the drawing or every cell answers for
// its neighbor. Both read one geometry, and this is what pins them together.

const MATRIX_W = 400;
const MATRIX_H = 176;
const fmMatrix = () => buildFigures(FMSYNTH, defaultValues(FMSYNTH), { sampleRate: 48000 })
  .find((f) => f.kind === 'matrix');

/** The middle of the cell at (row, col), in canvas pixels. */
function centerOf(f, row, col) {
  const { gx, gy, cw, rh } = matrixGeometry(f, MATRIX_W, MATRIX_H);
  return [gx + col * cw + cw / 2, gy + row * rh + rh / 2];
}

test('the matrix grid leaves room for its labels and fills the rest', () => {
  const f = fmMatrix();
  const { gx, gy, cols, cw, rh } = matrixGeometry(f, MATRIX_W, MATRIX_H);
  assert.ok(gx > 0 && gy > 0, 'there is a gutter for the operator numbers on both axes');
  assert.ok(Math.abs(gx + cols * cw - MATRIX_W) < 1e-9, 'the columns reach the right edge');
  assert.ok(Math.abs(gy + f.ops * rh - MATRIX_H) < 1e-9, 'and the rows reach the bottom');
  assert.equal(cols, f.ops + 1, 'every operator, then the output column');
});

test('a press lands on the cell it looks like it is on', () => {
  const f = fmMatrix();
  for (const [row, col] of [[0, 0], [0, 7], [7, 0], [3, 5], [7, 8], [2, 8]]) {
    const [x, y] = centerOf(f, row, col);
    const at = matrixCell(f, x, y, MATRIX_W, MATRIX_H);
    assert.ok(at, `(${row},${col}) is a cell`);
    assert.equal(at.row, row, `row of (${row},${col})`);
    assert.equal(at.col, col, `column of (${row},${col})`);
  }
});

test('the labels are not cells, and neither is anything off the grid', () => {
  const f = fmMatrix();
  const { gx, gy } = matrixGeometry(f, MATRIX_W, MATRIX_H);
  assert.equal(matrixCell(f, gx / 2, MATRIX_H / 2, MATRIX_W, MATRIX_H), null, 'the row numbers');
  assert.equal(matrixCell(f, MATRIX_W / 2, gy / 2, MATRIX_W, MATRIX_H), null, 'the column numbers');
  assert.equal(matrixCell(f, -4, MATRIX_H / 2, MATRIX_W, MATRIX_H), null, 'off the left');
  assert.equal(matrixCell(f, MATRIX_W / 2, MATRIX_H + 4, MATRIX_W, MATRIX_H), null, 'off the bottom');
});

test('a cell writes the connection its position means: the ROW modulates the COLUMN', () => {
  // The direction is the thing that was unreadable, so it is the thing asserted: the cell in row
  // 2, column 1 is operator 2 modulating operator 1, and its opposite number is a different
  // parameter entirely.
  const f = fmMatrix();
  const [x, y] = centerOf(f, 1, 0);
  const grabbed = matrixGrab(f, x, y, MATRIX_W, MATRIX_H);
  assert.equal(grabbed.at(0, 0).id, 'mod.2.1', 'row 2, column 1 is 2 modulating 1');

  const [bx, by] = centerOf(f, 0, 1);
  assert.equal(matrixGrab(f, bx, by, MATRIX_W, MATRIX_H).at(0, 0).id, 'mod.1.2', 'and the mirror is the other way round');

  // The last column is the operator's own level to the output, not a modulation at all.
  const [ox, oy] = centerOf(f, 4, 8);
  assert.equal(matrixGrab(f, ox, oy, MATRIX_W, MATRIX_H).at(0, 0).id, 'op5.level');
});

test('a grabbed cell names itself, so the heading can say which connection is moving', () => {
  const f = fmMatrix();
  const [x, y] = centerOf(f, 1, 0);
  assert.equal(matrixGrab(f, x, y, MATRIX_W, MATRIX_H).role, '1:0');
});

test('dragging a cell upward raises it and downward lowers it', () => {
  const f = fmMatrix();
  const [x, y] = centerOf(f, 1, 0);
  const grabbed = matrixGrab(f, x, y, MATRIX_W, MATRIX_H);
  const up = grabbed.at(0, -0.2).position;
  const down = grabbed.at(0, 0.2).position;
  assert.ok(up > down, `up is more than down: ${up} against ${down}`);
  assert.ok(up <= 1 && down >= 0, 'and neither runs off the end of the control');
});
