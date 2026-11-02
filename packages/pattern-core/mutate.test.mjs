// A row that changes as it plays: one pass of `mutate` over steps() cells and sliders() values,
// and `deviation`, which keeps a value thrown again near the one it had.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateRow, mutateValues, rerollValue, randomValues, parseCells } from './src/index.mjs';

// A small seeded generator, so a run is the same every time.
function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A generator that hands out `draws` in order.
const scripted = (draws) => {
  let i = 0;
  return () => draws[i++ % draws.length];
};

const onOff = (text) => parseCells(text).map((c) => (c.on ? 1 : 0)).join('');

test('mutate: a cell switches when its draw is under the chance, one draw per cell in order', () => {
  // Cells 1 and 3 draw under 0.5; the rest over it.
  const { text, edits } = mutateRow('x . x x', 0.5, scripted([0.9, 0.1, 0.7, 0.2]));
  assert.equal(text, 'x x x .');
  assert.deepEqual(edits, [{ from: 2, to: 3, text: 'x' }, { from: 6, to: 7, text: '.' }]);
});

test('mutate: a cell switched on takes the nearest hit to its left, as the row was', () => {
  assert.equal(mutateRow('bd . sd .', 1, () => 0).text, '.  bd .  sd');
  assert.equal(mutateRow('. . bd .', 1, () => 0).text, 'bd bd .  bd');
  assert.equal(mutateRow('. . . .', 1, () => 0).text, 'x x x x');
  // One character a step stays one character a step.
  assert.equal(mutateRow('x..x', 1, () => 0).text, '.xx.');
});

test('mutate 0 leaves the row as it is, whatever is drawn', () => {
  const random = seeded(3);
  for (let i = 0; i < 200; i++) {
    const r = mutateRow('x . x x . . x .', 0, random);
    assert.equal(r.text, 'x . x x . . x .');
    assert.deepEqual(r.edits, []);
  }
});

test('mutate 1 turns the row into its inverse, so it alternates with it every pass', () => {
  const start = 'x . x x . . x . x x . . . x . x';
  let row = start;
  const seen = [];
  for (let pass = 0; pass < 6; pass++) {
    row = mutateRow(row, 1, Math.random).text;
    seen.push(row);
  }
  assert.equal(seen[0], '. x . . x x . x . . x x x . x .');
  for (let i = 0; i < seen.length; i++) assert.equal(seen[i], i % 2 ? start : seen[0]);
});

test('mutate 0.5 throws every cell again: after one pass each is a hit half the time, whatever it was', () => {
  const random = seeded(7);
  const n = 16;
  for (const start of ['x '.repeat(n).trim(), '. '.repeat(n).trim()]) {
    let hits = 0;
    const passes = 2000;
    for (let i = 0; i < passes; i++) hits += [...onOff(mutateRow(start, 0.5, random).text)].filter((b) => b === '1').length;
    const share = hits / (passes * n);
    assert.ok(Math.abs(share - 0.5) < 0.02, `${start.slice(0, 3)}...: ${share}`);
  }
});

test('mutate p: each cell switches with chance p, on its own', () => {
  const random = seeded(11);
  const row = 'x . x x . . x . x x . . . x . x';
  for (const p of [0.05, 0.25]) {
    let switched = 0;
    const passes = 4000;
    for (let i = 0; i < passes; i++) switched += mutateRow(row, p, random).edits.length;
    const share = switched / (passes * 16);
    assert.ok(Math.abs(share - p) < 0.01, `p ${p}: ${share}`);
  }
});

test('mutate on sliders throws a value again with chance p, inside min..max, at the places asked', () => {
  const r = mutateValues('0.2 0.5 0.8', 1, { min: 0, max: 1, decimals: 2, random: scripted([0, 0.25, 0, 0.5, 0, 0.999]) });
  assert.equal(r.text, '0.25 0.5 1');
  // The middle one landed where it was: no edit for it.
  assert.deepEqual(r.edits.map((e) => e.text), ['0.25', '1']);
  assert.equal(mutateValues('0.2 0.5 0.8', 0, { random: () => 0 }).text, '0.2 0.5 0.8');
  // A range of 10..20, written whole.
  const random = seeded(5);
  for (let i = 0; i < 100; i++) {
    for (const c of parseCells(mutateValues('12 15 18', 1, { min: 10, max: 20, decimals: 0, random }).text)) {
      const v = Number(c.token);
      assert.ok(Number.isInteger(v) && v >= 10 && v <= 20, c.token);
    }
  }
});

test('deviation: a value thrown again lands old + a bell curve with that standard deviation', () => {
  const random = seeded(21);
  const draws = Array.from({ length: 20000 }, () => rerollValue(0.5, { min: 0, max: 1, deviation: 0.1, random }));
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length);
  assert.ok(Math.abs(mean - 0.5) < 0.005, `mean ${mean}`);
  assert.ok(Math.abs(sd - 0.1) < 0.005, `sd ${sd}`);
  // A bell curve: about two thirds within one deviation, about 95% within two.
  const within = (k) => draws.filter((v) => Math.abs(v - 0.5) <= k * 0.1).length / draws.length;
  assert.ok(Math.abs(within(1) - 0.683) < 0.02, `1 sd: ${within(1)}`);
  assert.ok(Math.abs(within(2) - 0.954) < 0.01, `2 sd: ${within(2)}`);
});

test('deviation: a throw past either end is kept at it', () => {
  const random = seeded(4);
  const draws = Array.from({ length: 5000 }, () => rerollValue(0.95, { min: 0, max: 1, deviation: 0.2, random }));
  assert.ok(draws.every((v) => v >= 0 && v <= 1));
  assert.ok(draws.filter((v) => v === 1).length > 1000, 'a fair share pile up at the top');
  // A range written high to low is the same range.
  assert.ok(Array.from({ length: 500 }, () => rerollValue(5, { min: 10, max: 0, deviation: 4, random })).every((v) => v >= 0 && v <= 10));
});

test('without deviation a throw is anywhere in the range alike; with deviation 0 it stays put', () => {
  assert.equal(rerollValue(0.5, { min: 0, max: 10, random: () => 0.25 }), 2.5);
  assert.equal(rerollValue(0.5, { min: 0, max: 1, deviation: 0, random: seeded(1) }), 0.5);
  // A cell with no number to start from is thrown anywhere, deviation or not.
  assert.equal(rerollValue(NaN, { min: 0, max: 1, deviation: 0.1, random: () => 0.75 }), 0.75);
});

test('randomize with a deviation throws every value near its own, written at the places asked', () => {
  const random = seeded(9);
  const row = randomValues('0.2 0.5 0.8', 0, 1, 2, random, 0.01);
  const [a, b, c] = parseCells(row).map((x) => Number(x.token));
  assert.ok(Math.abs(a - 0.2) < 0.06 && Math.abs(b - 0.5) < 0.06 && Math.abs(c - 0.8) < 0.06, row);
  // Without one, as before: anywhere in the range.
  assert.equal(randomValues('0.2 0.5', 0, 10, 1, () => 0.5), '5 5');
});

test('mutate with deviation on sliders: rounded to the places asked and kept in range', () => {
  const random = seeded(13);
  for (let i = 0; i < 200; i++) {
    const r = mutateValues('0.2 0.5 0.9', 1, { min: 0, max: 1, decimals: 1, deviation: 0.15, random });
    for (const c of parseCells(r.text)) {
      const v = Number(c.token);
      assert.ok(v >= 0 && v <= 1, c.token);
      assert.ok(!/\.\d\d/.test(c.token), c.token);
    }
  }
});
