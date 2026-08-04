// Quoted atoms - "'kick 01.wav'" - are one literal value whatever they contain. They exist so
// se()/sr() can name a file whose path holds characters the tokenizer otherwise reads as
// operators, so the tests that matter are the ones showing an operator INSIDE the quotes stays
// text, and the same operator OUTSIDE them still works. Pure parser tests, no engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMini, getStepsForCycle } from './src/mini.mjs';

function values(str, cycle = 0) {
  return getStepsForCycle(parseMini(str), cycle)
    .filter((s) => s.value != null && !s.cont)
    .map((s) => s.value);
}

test('a quoted atom keeps characters that are operators outside quotes', () => {
  assert.deepEqual(values("'drums/kick.wav'"), ['drums/kick.wav']);
  assert.deepEqual(values("'kick 01.wav'"), ['kick 01.wav']);
  assert.deepEqual(values("'-lead'"), ['-lead']);
  assert.deepEqual(values("'a*2'"), ['a*2']);
});

test('quoted atoms sequence and stack like any other atom', () => {
  assert.deepEqual(values("'a/b.wav' 'c d.wav'"), ['a/b.wav', 'c d.wav']);
  assert.deepEqual(values("['x.wav' 'y.wav']"), ['x.wav', 'y.wav']);
  assert.deepEqual(values("<'x.wav' 'y.wav'>", 0), ['x.wav']);
  assert.deepEqual(values("<'x.wav' 'y.wav'>", 1), ['y.wav']);
});

test('postfix operators still apply outside the quotes', () => {
  // *2 doubles the rate, so one cycle holds two copies.
  assert.deepEqual(values("'a b.wav'*2"), ['a b.wav', 'a b.wav']);
  assert.deepEqual(values("'a.wav'!2"), ['a.wav', 'a.wav']);
  // .e(3,8) - a euclid written outside the quotes, which is the documented spelling.
  assert.equal(values("'a.wav'.e(3,8)").length, 3);
});

test('a dotted name is not split into a value method', () => {
  // Unquoted, "kick.wav(" would be read as the method ".wav" on "kick" - quoting stops that, and
  // a bare quoted name with no call after it is simply the name.
  assert.deepEqual(values("'kick.wav'"), ['kick.wav']);
  assert.deepEqual(values("'a.b.c.wav'"), ['a.b.c.wav']);
});

test("a quoted '_' is a value, not a tie", () => {
  // Unquoted, "a _" is one event two slices wide; quoted, "_" is its own value.
  assert.deepEqual(values('a _'), ['a']);
  assert.deepEqual(values("a '_'"), ['a', '_']);
});

test('rests and quoted values coexist', () => {
  assert.deepEqual(values("~ 'a/b.wav' ~"), ['a/b.wav']);
});

test('an unterminated quote is a parse error, not silent truncation', () => {
  assert.throws(() => parseMini("'a.wav"), /unterminated/);
});

test('quoting changes lexing, not the surrounding pattern', () => {
  // The same sequence with and without quotes must produce the same STRUCTURE - two steps, each
  // half a cycle - so quoting a name can never move the notes around it.
  const quoted = getStepsForCycle(parseMini("'a' 'b'"), 0);
  const bare = getStepsForCycle(parseMini('a b'), 0);
  assert.deepEqual(
    quoted.map((s) => [s.start, s.end]),
    bare.map((s) => [s.start, s.end]),
  );
});
