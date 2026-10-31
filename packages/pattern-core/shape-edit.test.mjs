// The shape editor's span verbs (see shape.mjs): cutting at a span's edges, duplicating a span,
// pasting over one, looping one with its seam faded, a pencil stroke, and moving points together.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseShapePoints, serializeShapePoints, sampleShape,
  splitShapeAt, shapeSpan, duplicateShapeSpan, pasteShapeSpan, loopShapeSpan, drawShapeStroke, moveShapePoints,
} from './src/shape.mjs';

const shape = (s) => parseShapePoints(s);
const text = (points) => serializeShapePoints(points);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} vs ${b}`);

test('a split point leaves the drawing as it was, curves included', () => {
  const curved = shape('0,0,3 1,1');
  const split = splitShapeAt(curved, 0.3);
  assert.equal(split.length, 3);
  for (let i = 0; i <= 20; i++) close(sampleShape(split, i / 20), sampleShape(curved, i / 20), `at ${i / 20}`);
  assert.equal(splitShapeAt(curved, 1).length, 2, 'no point added where one already sits');
});

test('a span is its stretch of the shape over 0..1', () => {
  assert.equal(text(shapeSpan(shape('0,0 1,1'), 0.25, 0.75)), '0,0.25 1,0.75');
  assert.equal(text(shapeSpan(shape('0,0 0.5,1 1,0'), 0.25, 0.75)), '0,0.5 0.5,1 1,0.5');
  // A step on the span's start begins it on the step's far side.
  assert.equal(text(shapeSpan(shape('0,1 0.5,1 0.5,0 1,0'), 0.5, 1)), '0,0 1,0');
});

test('duplicating a span plays it twice and inserts its time', () => {
  const { points, grow } = duplicateShapeSpan(shape('0,0 0.5,1 1,0'), 0, 0.5);
  assert.equal(grow, 1.5);
  // The rise, the rise again (a step back down between), then the fall - all over 1.5 of the old period.
  for (const [x, y] of [[0, 0], [1 / 6, 0.5], [1 / 3 + 1e-4, 3e-4], [0.5, 0.5], [2 / 3 - 1e-4, 1 - 3e-4], [5 / 6, 0.5], [1, 0]]) {
    close(sampleShape(points, x), y, `at ${x}`);
  }
  assert.equal(points[points.length - 1].x, 1);
});

test('a paste replaces what was under it and steps back out', () => {
  const clip = shapeSpan(shape('0,0 1,1'), 0, 1); // a rise
  const { points, placed } = pasteShapeSpan(shape('0,0.5 1,0.5'), clip, 0.25, 0.5);
  close(sampleShape(points, 0.1), 0.5);
  close(sampleShape(points, 0.5), 0.5, 'halfway up the rise');
  close(sampleShape(points, 0.7), 0.9);
  close(sampleShape(points, 0.9), 0.5, 'back out');
  assert.deepEqual(placed.map((i) => points[i].x), [0.25, 0.75]);
});

test('a paste past the end is cut short there', () => {
  const clip = shapeSpan(shape('0,0 1,1'), 0, 1);
  const { points } = pasteShapeSpan(shape('0,0.5 1,0.5'), clip, 0.75, 0.5);
  close(sampleShape(points, 1), 0.5, 'half the rise fits');
  assert.equal(points[points.length - 1].x, 1);
});

test('looping a span crops the shape to it', () => {
  const { points, original } = loopShapeSpan(shape('0,0 0.5,1 1,0'), 0.25, 0.75);
  assert.equal(text(points), '0,0.5 0.5,1 1,0.5');
  assert.equal(original, null, 'ends already meet: nothing faded');
});

test('a loop whose ends differ is faded to their midpoint over its first and last sixteenth', () => {
  const { points, original } = loopShapeSpan(shape('0,0 1,1'), 0, 1);
  close(points[0].y, 0.5);
  close(points[points.length - 1].y, 0.5);
  close(sampleShape(points, 1 / 16), 1 / 16, 'the fade ends on the drawing');
  close(sampleShape(points, 0.5), 0.5, 'the middle untouched');
  close(sampleShape(points, 15 / 16), 15 / 16);
  assert.ok(original, 'the drawing before the fade, for the editor to show');
  close(original[0].y, 0);
  const plain = loopShapeSpan(shape('0,0 1,1'), 0, 1, { seam: false });
  assert.equal(text(plain.points), '0,0 1,1', 'asked not to: the jump stays');
});

test('a pencil stroke replaces the points under it, thinned', () => {
  const stroke = Array.from({ length: 51 }, (_, i) => ({ x: 0.25 + i / 100, y: 0.8 }));
  const out = drawShapeStroke(shape('0,0 0.5,1 1,0'), stroke);
  close(sampleShape(out, 0.5), 0.8, 'the peak is drawn over');
  close(sampleShape(out, 0.1), 0.2, 'outside the stroke, unchanged');
  assert.ok(out.length <= 7, `a flat line is two points, plus the steps in and out - got ${text(out)}`);
});

test('a pencil click adds one point; at an end it moves the end', () => {
  assert.equal(text(drawShapeStroke(shape('0,0 1,0'), [{ x: 0.5, y: 1 }])), '0,0 0.5,1 1,0');
  assert.equal(text(drawShapeStroke(shape('0,0 1,0'), [{ x: 0, y: 1 }])), '0,1 1,0');
});

test('points moved together keep their shape and stop at the neighbors left behind', () => {
  const pts = shape('0,0 0.2,0.2 0.4,0.6 0.6,0.2 1,0');
  const moved = moveShapePoints(pts, [1, 2], 0.5, 0.1);
  assert.equal(text(moved), '0,0 0.4,0.3 0.6,0.7 0.6,0.2 1,0', 'held at the next point, x and y together');
  const up = moveShapePoints(pts, [1, 2], 0, 0.9);
  close(up[2].y, 1, 'the highest stops at the top');
  close(up[1].y, 0.6, '...and the rest by as much');
  const ends = moveShapePoints(pts, [0, 4], 0.3, 0.5);
  assert.deepEqual(ends.map((p) => p.x), pts.map((p) => p.x), 'ends keep their x');
});

test('simplify drops the points that barely change the line, and keeps the ones that do', async () => {
  const { simplifyShapeSpan } = await import('./src/shape.mjs');
  const wobbly = shape('0,0 0.1,0.101 0.2,0.199 0.3,0.302 0.4,0.4 0.5,1 0.6,0.6 1,0.2');
  const out = simplifyShapeSpan(wobbly, 0, 1);
  assert.equal(text(out), '0,0 0.4,0.4 0.5,1 0.6,0.6 1,0.2', 'the near-straight run is one segment; the peak stays');
  const part = simplifyShapeSpan(wobbly, 0.5, 1);
  assert.equal(part.length, wobbly.length, 'outside the span nothing is touched, and nothing inside it was spare');
  const curved = shape('0,0,4 0.5,0.5 1,1');
  assert.equal(simplifyShapeSpan(curved, 0, 1).length, 3, 'a curve is not a straight line: its point stays');
});

test('smoothing rounds a shape off around its loop and leaves 0 alone', async () => {
  const { smoothShape } = await import('./src/shape.mjs');
  const sq = shape('0,1 0.5,1 0.5,0 1,0');
  assert.equal(text(smoothShape(sq, 0)), text(sq));
  const soft = smoothShape(sq, 0.5);
  assert.ok(Math.abs(sampleShape(soft, 0.5) - 0.5) < 0.02, 'the step is halfway at the step');
  assert.ok(Math.abs(sampleShape(soft, 0) - 0.5) < 0.02, '...and so is the wrap');
  assert.ok(sampleShape(soft, 0.25) > 0.95 && sampleShape(soft, 0.75) < 0.05, 'the plateaus survive a moderate smooth');
  assert.ok(soft.length < 80, `written back as few points - got ${soft.length}`);
});
