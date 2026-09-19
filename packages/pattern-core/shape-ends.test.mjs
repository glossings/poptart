// The shape editor's rule for a shape's two ends (see shape.mjs): ends that meet move as a pair,
// a lone end catches on the other's level, and ends that differ on purpose are left alone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseShapePoints, serializeShapePoints, shapeEndsMeet, moveShapeEnd, SHAPE_PRESETS } from './src/shape.mjs';

const ys = (points) => points.map((p) => p.y);

test('ends meet when they are level, to the precision a shape is written at', () => {
  assert.equal(shapeEndsMeet(parseShapePoints('0,0 0.5,1 1,0')), true);
  assert.equal(shapeEndsMeet(parseShapePoints('0,0.3 0.5,1 1,0.3')), true);
  assert.equal(shapeEndsMeet(parseShapePoints('0,0.3 0.5,1 1,0.3004')), true, 'a rounding error apart is level');
  assert.equal(shapeEndsMeet(parseShapePoints('0,0 1,1')), false, 'a saw');
});

test('a linked end carries the other with it, from either side', () => {
  const tri = parseShapePoints('0,0 0.5,1 1,0');
  assert.deepEqual(ys(moveShapeEnd(tri, 0, 0.37, { linked: true })), [0.37, 1, 0.37]);
  assert.deepEqual(ys(moveShapeEnd(tri, 2, 0.62, { linked: true })), [0.62, 1, 0.62]);
});

test('a pair survives being written out and read back', () => {
  const moved = moveShapeEnd(parseShapePoints('0,0 0.5,1 1,0'), 0, 0.3337, { linked: true });
  assert.equal(shapeEndsMeet(parseShapePoints(serializeShapePoints(moved))), true);
});

test('a lone end catches on the level of the other, and only within reach', () => {
  const saw = parseShapePoints('0,0.2 1,0.8');
  assert.deepEqual(ys(moveShapeEnd(saw, 1, 0.23, { snap: 0.05 })), [0.2, 0.2], 'caught');
  assert.deepEqual(ys(moveShapeEnd(saw, 1, 0.3, { snap: 0.05 })), [0.2, 0.3], 'out of reach');
  assert.deepEqual(ys(moveShapeEnd(saw, 0, 0.78, { snap: 0.05 })), [0.8, 0.8], 'either end catches');
  assert.deepEqual(ys(moveShapeEnd(saw, 1, 0.23)), [0.2, 0.23], 'no snap asked for, none given');
});

test('unlinked, the other end never moves', () => {
  const saw = parseShapePoints('0,0 1,1');
  assert.deepEqual(ys(moveShapeEnd(saw, 0, 0.5)), [0.5, 1]);
});

test('levels are clamped and the input is left alone', () => {
  const tri = parseShapePoints('0,0 0.5,1 1,0');
  assert.deepEqual(ys(moveShapeEnd(tri, 0, 1.4, { linked: true })), [1, 1, 1]);
  assert.deepEqual(ys(moveShapeEnd(tri, 0, -2, { linked: true })), [0, 1, 0]);
  assert.deepEqual(ys(tri), [0, 1, 0]);
});

test('every preset whose ends differ does so on purpose, and would not be pulled together', () => {
  // The rule is only safe if it never rewrites a shape that means its seam. Listed, so a new
  // preset with a seam is a decision someone made rather than something the editor papers over.
  const seamed = Object.keys(SHAPE_PRESETS).filter((name) => !shapeEndsMeet(parseShapePoints(name)));
  for (const name of seamed) {
    const pts = parseShapePoints(name);
    const far = pts[0].y < 0.5 ? 1 : 0; // well clear of the other end's catch
    const moved = moveShapeEnd(pts, 0, Math.abs(far - pts[pts.length - 1].y) > 0.2 ? far : 0.5, { snap: 0.02 });
    assert.equal(moved[moved.length - 1].y, pts[pts.length - 1].y, `${name}: the far end stays put`);
  }
});
