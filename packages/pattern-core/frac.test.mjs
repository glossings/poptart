// Exact rational time (frac.mjs). The headline guarantee: a moment is always the same moment,
// however its float was computed - the foundation for deterministic rand/degrade and, later, rib
// and hold. Pure arithmetic, no scheduler/engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Frac, frac } from './src/frac.mjs';

test('constructor reduces to lowest terms with a positive denominator', () => {
  assert.deepEqual([frac(2, 4).num, frac(2, 4).den], [1, 2]);
  assert.deepEqual([frac(-3, 6).num, frac(-3, 6).den], [-1, 2]);
  assert.deepEqual([frac(3, -6).num, frac(3, -6).den], [-1, 2]); // sign moves to the numerator
  assert.deepEqual([frac(0, 5).num, frac(0, 5).den], [0, 1]);
  assert.throws(() => frac(1, 0), /zero denominator/);
});

test('fromNumber recovers the exact rational a float was meant to be', () => {
  for (const [x, n, d] of [
    [1 / 3, 1, 3],
    [2 / 5, 2, 5],
    [1 / 7, 1, 7],
    [3 / 16, 3, 16],
    [1 / 105, 1, 105], // 1/(3*5*7) - a deep euclid/ply subdivision
    [-2 / 3, -2, 3],
    [5, 5, 1],
    [0, 0, 1],
  ]) {
    const f = Frac.fromNumber(x);
    assert.deepEqual([f.num, f.den], [n, d], `fromNumber(${x})`);
  }
});

test('a clean rational round-trips to the identical double (snapping is a no-op)', () => {
  for (const [n, d] of [[1, 3], [2, 5], [7, 16], [1, 105]]) {
    assert.equal(frac(n, d).toNumber(), n / d);
  }
});

test('the same moment is never differentiated from itself', () => {
  // Float crud from different arithmetic paths snaps back to one canonical rational, so anything
  // keying off the moment (rand/degrade/rib) draws identically.
  assert.ok(Frac.fromNumber(0.1 + 0.2).eq(frac(3, 10)), '0.1+0.2 -> 3/10');
  assert.ok(Frac.fromNumber(1 / 3).eq(Frac.fromNumber(2 / 3 - 1 / 3)), 'two paths to 1/3');
  assert.ok(Frac.fromNumber(0.7 - 0.4).eq(frac(3, 10)));
});

test('add / sub / mul / div, reduced', () => {
  assert.ok(frac(1, 3).add(frac(1, 6)).eq(frac(1, 2)));
  assert.ok(frac(1, 2).sub(frac(1, 3)).eq(frac(1, 6)));
  assert.ok(frac(2, 3).mul(frac(3, 4)).eq(frac(1, 2)));
  assert.ok(frac(1, 2).div(frac(1, 4)).eq(frac(2, 1)));
  assert.ok(frac(1, 3).add(2).eq(frac(7, 3)), 'accepts a plain number');
});

test('floor and mod - the periodic wrap rib()/hold() need', () => {
  assert.equal(frac(7, 3).floor(), 2);
  assert.equal(frac(-1, 3).floor(), -1);
  assert.ok(frac(7, 3).mod(1).eq(frac(1, 3)));
  assert.ok(frac(-1, 3).mod(1).eq(frac(2, 3)), 'negative wraps into [0,1)');
  assert.ok(frac(-1, 3).mod(frac(1, 2)).eq(frac(1, 6)), 'wrap against a fractional modulus');
  assert.ok(frac(5, 4).mod(frac(1, 2)).eq(frac(1, 4)));
});

test('eq / lt / key', () => {
  assert.ok(frac(2, 4).eq(frac(1, 2)));
  assert.ok(frac(1, 3).lt(frac(1, 2)));
  assert.ok(!frac(1, 2).lt(frac(1, 3)));
  assert.equal(frac(2, 6).key(), '1/3');
});
