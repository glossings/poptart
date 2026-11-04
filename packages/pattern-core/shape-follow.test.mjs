import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeShapeData, parseShapePoints, serializeShapePoints, sampleShape, sampleShapeTable, shapeFollows } from './src/shape.mjs';

test('a point written n is on the note, and is written back as n', () => {
  const text = '0,0.6 0.2,0.3,-2 0.4,n 1,n';
  assert.ok(looksLikeShapeData(text));
  const points = parseShapePoints(text);
  assert.deepEqual(points.map((p) => !!p.follow), [false, false, true, true]);
  assert.ok(shapeFollows(points));
  assert.ok(!shapeFollows(parseShapePoints('0,0.6 1,0.2')));
  assert.equal(serializeShapePoints(points), text);
  // Its curvature is kept beside it.
  assert.equal(serializeShapePoints(parseShapePoints('0,0.5 0.5,n,3 1,n')), '0,0.5 0.5,n,3 1,n');
});

test('a curve played against a note is two tables: the curve with the note at 0, and its share of the note', () => {
  const points = parseShapePoints('0,0.6 0.5,n,-3 1,n');
  const table = sampleShapeTable(points, 256, true);
  assert.equal(table.length, 512);
  // Whatever the note, each sample is the curve with the points on the note moved to it.
  for (const note of [0.1, 0.25, 0.4]) {
    const moved = points.map((p) => (p.follow ? { ...p, y: note } : p));
    for (const i of [0, 40, 128, 170, 255]) {
      const want = sampleShape(moved, i / 255);
      assert.ok(Math.abs(table[i] + table[256 + i] * note - want) < 1e-12, `note ${note}, sample ${i}`);
    }
  }
  // A curve that does not play against a note is the one table it always was.
  assert.deepEqual(sampleShapeTable(points, 256), Array.from({ length: 256 }, (_, i) => sampleShape(points, i / 255)));
});
