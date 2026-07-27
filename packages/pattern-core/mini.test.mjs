// The mini-notation expression/random/euclid extensions. These pin down the parser-level
// behaviour that the scheduler and the editor highlighter both depend on: euclid's new "xe(a,b)"
// spelling, the "(...)" arithmetic expressions, and the r/i/p/round/floor/ceil functions - all of
// which must be DETERMINISTIC per (cycle, source-offset) so the two views can never disagree and a
// bar replays identically. Pure parser tests, no scheduler/engine boot (see the package's testing
// notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMini, getStepsForCycle } from './src/mini.mjs';

// Convenience: parse `str`, return this cycle's non-rest values in order.
function values(str, cycle = 0) {
  return getStepsForCycle(parseMini(str), cycle)
    .filter((s) => s.value != null && !s.cont)
    .map((s) => s.value);
}
// A single computed value from a top-level expression / function.
function num(str, cycle = 0) {
  const v = values(str, cycle);
  assert.equal(v.length, 1, `expected one value from "${str}", got ${JSON.stringify(v)}`);
  return Number(v[0]);
}

// ---------------------------------------------------------------------------------------------
// Euclid: xe(a,b)
// ---------------------------------------------------------------------------------------------

test('euclid: value.e(a,b) places the value on the euclidean grid', () => {
  const steps = getStepsForCycle(parseMini('1.e(3,8)'), 0).filter((s) => s.value != null);
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => s.value === '1'));
});

test('euclid: works on a named sample too (bd.e -> bd)', () => {
  const steps = getStepsForCycle(parseMini('bd.e(3,8)'), 0).filter((s) => s.value != null);
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => s.value === 'bd'));
});

test('euclid: rotation still honoured, "1.e(3,8,2)"', () => {
  const a = getStepsForCycle(parseMini('1.e(3,8)'), 0).filter((s) => s.value != null).map((s) => s.start);
  const b = getStepsForCycle(parseMini('1.e(3,8,2)'), 0).filter((s) => s.value != null).map((s) => s.start);
  assert.notDeepEqual(a, b);
  assert.equal(b.length, 3);
});

test('euclid: the old un-methoded "1(3,8)" is now a clear error', () => {
  assert.throws(() => parseMini('1(3,8)'), /value method is written/);
});

test('euclid: an unknown method is a clear error', () => {
  assert.throws(() => parseMini('bd.x(3,8)'), /unknown method/);
});

test('euclid: value can be an expression, and re-rolls per hit, "i(0,5).e(5,8)"', () => {
  let sawWithinCycleVariation = false;
  for (let c = 0; c < 20; c++) {
    const steps = getStepsForCycle(parseMini('i(0,5).e(5,8)'), c).filter((s) => s.value != null);
    assert.equal(steps.length, 5, `expected 5 hits at cycle ${c}`);
    for (const s of steps) {
      const v = Number(s.value);
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 5, `hit value out of range: ${v}`);
    }
    if (new Set(steps.map((s) => s.value)).size > 1) sawWithinCycleVariation = true;
  }
  assert.ok(sawWithinCycleVariation, 'hits should re-roll per hit, not share one value per cycle');
});

test('euclid: legato - each hit sustains to the next onset (1.e(3,8) = 3/8,3/8,2/8)', () => {
  const steps = getStepsForCycle(parseMini('1.e(3,8)'), 0).filter((s) => s.value != null);
  assert.equal(steps.length, 3);
  // onsets of bjorklund(3,8) are 0,3,6 -> legato spans [0,3/8],[3/8,6/8],[6/8,1]
  assert.deepEqual(steps.map((s) => [s.start, s.end]), [
    [0, 3 / 8],
    [3 / 8, 6 / 8],
    [6 / 8, 1],
  ]);
});

test('euclid: <a b> item stays one value per cycle (salt only touches randoms)', () => {
  const c0 = getStepsForCycle(parseMini('<a b>.e(3,8)'), 0).filter((s) => s.value != null);
  const c1 = getStepsForCycle(parseMini('<a b>.e(3,8)'), 1).filter((s) => s.value != null);
  assert.deepEqual(new Set(c0.map((s) => s.value)), new Set(['a']));
  assert.deepEqual(new Set(c1.map((s) => s.value)), new Set(['b']));
});

test('euclid: the value can be a group, "[a b].e(2,4)"', () => {
  const steps = getStepsForCycle(parseMini('[a b].e(2,4)'), 0).filter((s) => s.value != null);
  // 2 pulses over 4, each pulse holds the sub-sequence "a b"
  assert.deepEqual(steps.map((s) => s.value), ['a', 'b', 'a', 'b']);
});

test('euclid: args must be numbers', () => {
  assert.throws(() => parseMini('1.e(i(2),8)'), /expected number inside euclid/);
});

// ---------------------------------------------------------------------------------------------
// Expressions: arithmetic, precedence, spacing
// ---------------------------------------------------------------------------------------------

test('expr: precedence - * binds tighter than +', () => {
  assert.equal(num('(2 + 3 * 4)'), 14);
  assert.equal(num('(2 * 3 + 1)'), 7);
});

test('expr: parentheses override precedence', () => {
  assert.equal(num('((2 + 3) * 4)'), 20);
});

test('expr: division and left-associative subtraction', () => {
  assert.equal(num('(6 / 2)'), 3);
  assert.equal(num('(10 - 2 - 3)'), 5);
});

test('expr: subtraction works spaced ("3 - 1") and glued-right ("3 -1")', () => {
  assert.equal(num('(3 - 1)'), 2);
  assert.equal(num('(3 -1)'), 2);
});

test('expr: negative literal', () => {
  assert.equal(num('(-3 + 1)'), -2);
  assert.equal(num('(0 - 5)'), -5);
});

test('expr: an expression is one value spanning its slot', () => {
  assert.deepEqual(values('a (3 + 1) b'), ['a', '4', 'b']);
});

test('expr: a spaced "(" is a separate element, a glued one is euclid/call', () => {
  // spaced: two steps
  assert.deepEqual(values('2 (3 + 1)'), ['2', '4']);
  // glued onto a bare number without a ".method": error
  assert.throws(() => parseMini('2(3,8)'), /value method is written/);
});

// ---------------------------------------------------------------------------------------------
// Expression compose with mini-notation operators
// ---------------------------------------------------------------------------------------------

test('expr: "(...)" takes postfix mini operators - "(2 + 2)*2" is fast-2 of "4"', () => {
  assert.deepEqual(values('(2 + 2)*2'), ['4', '4']);
});

test('expr: functions usable as arguments and nested', () => {
  assert.equal(num('(floor(2.9))'), 2);
  assert.equal(num('(round(2.5))'), 3);
  assert.equal(num('(ceil(2.1))'), 3);
  assert.equal(num('(floor(10 / 3))'), 3);
});

test('* adjacency: glued "*" is fast, spaced "*" is multiply (only inside "(...)")', () => {
  assert.deepEqual(values('(2*3)'), ['2', '2', '2']); // glued -> fast 3 of "2"
  assert.deepEqual(values('(2 * 3)'), ['6']); // spaced -> multiply
  assert.deepEqual(values('(6 / 2)'), ['3']); // spaced -> divide
});

test('parens: full mini notation - sequences, juxtaposition binds looser than "+"', () => {
  assert.deepEqual(values('(1 2 3)'), ['1', '2', '3']); // plain sequence in one slot
  assert.deepEqual(values('(1 2 + 10)'), ['1', '12']); // [1, (2+10)]
  assert.deepEqual(values('([1 2] + 10)'), ['11', '12']); // one arithmetic step over a group
});

test('arith: combines patterns with structure from the left operand', () => {
  // 4 left steps (fast 4 of a plain "2") each + 10
  assert.deepEqual(values('(2*4 + 10)'), ['12', '12', '12', '12']);
});

test('headline: "(<12 13>*4 + 5 * i(0,5)) 2.e(3,8) 3" parses and lays out', () => {
  const steps = getStepsForCycle(parseMini('(<12 13>*4 + 5 * i(0,5)) 2.e(3,8) 3'), 0).filter((s) => s.value != null);
  const slot1 = steps.filter((s) => s.start < 1 / 3 - 1e-9);
  const slot2 = steps.filter((s) => s.start >= 1 / 3 - 1e-9 && s.start < 2 / 3 - 1e-9);
  const slot3 = steps.filter((s) => s.start >= 2 / 3 - 1e-9);
  // slot 1: <12 13>*4 -> [12,13,12,13], each + 5*i(0,5) (one draw per cycle, i is not under euclid)
  assert.equal(slot1.length, 4, 'first slot should have 4 arith steps');
  const v = slot1.map((s) => Number(s.value));
  assert.equal(v[0], v[2]);
  assert.equal(v[1], v[3]);
  assert.equal(v[1] - v[0], 1); // 13 vs 12
  assert.ok((v[0] - 12) % 5 === 0 && v[0] >= 12 && v[0] <= 12 + 25); // + 5*{0..5}
  // slot 2: euclid 3,8 on "2", legato -> 3 hits
  assert.equal(slot2.length, 3);
  assert.ok(slot2.every((s) => s.value === '2'));
  // slot 3: plain "3"
  assert.deepEqual(slot3.map((s) => s.value), ['3']);
});

// ---------------------------------------------------------------------------------------------
// Randomness: r / i / p - ranges, determinism, decorrelation
// ---------------------------------------------------------------------------------------------

test('r: bare r is a float in [0,1]', () => {
  for (let c = 0; c < 20; c++) {
    const v = num('r', c);
    assert.ok(v >= 0 && v < 1, `r=${v} at cycle ${c}`);
  }
});

test('r: r(a) and r(a,b) ranges', () => {
  for (let c = 0; c < 20; c++) {
    const a = num('r(10)', c);
    assert.ok(a >= 0 && a < 10);
    const b = num('r(5,7)', c);
    assert.ok(b >= 5 && b < 7);
  }
});

test('r: deterministic per cycle (same query, same value)', () => {
  assert.equal(num('r', 3), num('r', 3));
  assert.equal(num('r(2,9)', 11), num('r(2,9)', 11));
});

test('r: two rs in one pattern decorrelate (different source offsets)', () => {
  const [a, b] = values('r r', 0);
  assert.notEqual(a, b);
});

test('i: integer, inclusive of both ends', () => {
  const seen = new Set();
  for (let c = 0; c < 300; c++) {
    const v = num('i(0,3)', c);
    assert.ok(Number.isInteger(v), `i not integer: ${v}`);
    assert.ok(v >= 0 && v <= 3, `i out of range: ${v}`);
    seen.add(v);
  }
  // inclusive: the top bucket (3) must be reachable
  assert.ok(seen.has(0) && seen.has(3), `expected 0..3 inclusive, saw ${[...seen].sort()}`);
});

test('i: one-arg form i(a) spans [0,a]', () => {
  for (let c = 0; c < 50; c++) {
    const v = num('i(4)', c);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 4);
  }
});

test('p: perlin drift stays in range, is deterministic, and is not white noise', () => {
  const series = [];
  for (let c = 0; c < 40; c++) {
    const v = num('p(0,10)', c);
    assert.ok(v >= 0 && v <= 10);
    series.push(v);
  }
  assert.equal(num('p(0,10)', 7), num('p(0,10)', 7)); // deterministic
  // adjacent cycles change less, on average, than distant ones (smooth drift vs jumps)
  const adj = series.slice(1).reduce((s, v, k) => s + Math.abs(v - series[k]), 0) / (series.length - 1);
  assert.ok(adj < 5, `perlin adjacent step too large (${adj}), not drifting`);
});

// ---------------------------------------------------------------------------------------------
// Expressions inside sequences / alternation - the headline example
// ---------------------------------------------------------------------------------------------

test('expr: "<1 2 (3 + i(4,5))>" alternates, third slot is an int expression', () => {
  assert.deepEqual(values('<1 2 (3 + i(4,5))>', 0), ['1']);
  assert.deepEqual(values('<1 2 (3 + i(4,5))>', 1), ['2']);
  const third = Number(values('<1 2 (3 + i(4,5))>', 2)[0]);
  assert.ok(third === 7 || third === 8, `expected 3+{4,5}, got ${third}`);
});

// ---------------------------------------------------------------------------------------------
// Reserved names / error messages
// ---------------------------------------------------------------------------------------------

test('reserved: "round" bare needs arguments', () => {
  assert.throws(() => parseMini('round'), /needs arguments/);
});

test('reserved: "i" bare needs arguments', () => {
  assert.throws(() => parseMini('i'), /needs arguments/);
});

test('expr: unterminated paren errors clearly', () => {
  assert.throws(() => parseMini('(3 + 1'), /expected "\)"/);
});

test('highlight: an arith step is loc-ed to the whole expression span', () => {
  // "n(...)" wrapper not present here - the string is just the mini body. The expression
  // "3 + i(4,5)" spans chars 1..11 inside "(3 + i(4,5))".
  const str = '(3 + i(4,5))';
  const [step] = getStepsForCycle(parseMini(str), 0).filter((s) => s.value != null);
  assert.ok(step.loc, 'step should carry a loc for playback highlighting');
  assert.equal(str.slice(step.loc[0], step.loc[1]), '3 + i(4,5)');
});

test('highlight: a bare function step is loc-ed to the call', () => {
  const str = 'i(0,7)';
  const [step] = getStepsForCycle(parseMini(str), 0).filter((s) => s.value != null);
  assert.equal(str.slice(step.loc[0], step.loc[1]), 'i(0,7)');
});

// What the editor actually boxes for a step: its live sub-pattern spans if any, else its whole loc.
function hlText(str, cycle = 0) {
  return getStepsForCycle(parseMini(str), cycle)
    .filter((s) => s.value != null && !s.cont)
    .flatMap((s) => (s.subLocs && s.subLocs.length ? s.subLocs : [s.loc]))
    .map((l) => str.slice(l[0], l[1]));
}

test('highlight: arith with an inner "<...>" lights only the live pick', () => {
  const str = '(4 * i(1, 6) + <3 0>)';
  // cycle 0 -> the "3" of "<3 0>"; cycle 1 -> the "0". Not the whole expression.
  assert.deepEqual(hlText(str, 0), ['3']);
  assert.deepEqual(hlText(str, 1), ['0']);
});

test('highlight: arith with no selecting operand lights the whole expression', () => {
  const str = '(3 + i(4,5))';
  assert.deepEqual(hlText(str, 0), ['3 + i(4,5)']);
  // and the step still carries the whole-expression loc (unchanged), with no subLocs
  const [step] = getStepsForCycle(parseMini(str), 0).filter((s) => s.value != null);
  assert.equal(str.slice(step.loc[0], step.loc[1]), '3 + i(4,5)');
  assert.equal(step.subLocs, undefined);
});

test('highlight: both operands selecting lights both live picks', () => {
  const str = '(<4 8> + <3 0>)';
  assert.deepEqual(hlText(str, 0).sort(), ['3', '4']); // cycle 0: 4 and 3
  assert.deepEqual(hlText(str, 1).sort(), ['0', '8']); // cycle 1: 8 and 0
});

test('highlight: a sequence element inside arith lights just that element', () => {
  // "[1 2]" has two elements sharing the arith's single left slot; each half lights its own atom.
  const str = '([1 2] + 10)';
  const spans = hlText(str, 0);
  assert.deepEqual(spans, ['1', '2']);
});

test('highlight: nested arith with an inner "<...>" still lights just the pick', () => {
  // left operand is itself an arith ("<5 7> * 2"); the live pick should surface through it.
  const str = '(<5 7> * 2 + 1)';
  assert.deepEqual(hlText(str, 0), ['5']);
  assert.deepEqual(hlText(str, 1), ['7']);
});
