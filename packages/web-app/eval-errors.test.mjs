// Where an evaluation went wrong, in the buffer's terms (pattern-core's eval-errors.mjs): syntax errors placed
// by the parser, runtime errors traced back from the stack through the location transpile's edits
// and the const->var rewrite, errors thrown later from code written in a block, bad mini-notation,
// warnings, and the "did you mean" helper. Evaluated through the browser build's block evaluator,
// which the desktop's mirrors (web-evaluate.test.mjs holds the two together).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as pc from '../pattern-core/src/index.mjs';
import { createBlockEvaluator } from './public/web/block-eval.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const { BUILDERS, METHODS } = require('./public/api-docs.js');
const names = { builder: BUILDERS, method: METHODS };

/** Evaluates every block of `src` (and builds one cycle of each pattern); the first failure, described. */
function failure(src, { deck = 'a', query = true } = {}) {
  const evalBlock = createBlockEvaluator(pc, { hostBuilders: { setbpm: () => 1 }, parse: acorn.parse, deck, doc: src });
  for (const b of pc.splitLabeledBlocks(src)) {
    try {
      const v = pc.withDeepStacks(() => evalBlock(b.code, b.start, b.label));
      if (query && v instanceof pc.Sig) pc.withDeepStacks(() => v.stepsForCycle?.(0));
    } catch (err) {
      const d = pc.describeEvalError(err, { source: src, block: b, deck, names });
      return { ...d, marked: d.where ? src.slice(d.where.from, d.where.to) : null };
    }
  }
  return null;
}

test('a misspelled method: line and column in the buffer, the name marked, the near name suggested', () => {
  const f = failure('setbpm(120)\nkick: s("bd*4").fasst(2)\n');
  assert.equal(f.message, 'kick, line 2:17 - "fasst" is not a method - did you mean "fast"?');
  assert.equal(f.marked, 'fasst');
  assert.equal(f.where.suggest, 'fast');
  assert.equal(f.where.deck, 'a');
});

test('columns after wrapped strings, deep in a buffer, are the typed ones', () => {
  const pad = '// notes\n'.repeat(40);
  const src = `${pad}drums: s("bd sd").gain("0.4 0.8")\n\nlead: n("0 2 4").gain("<0.5 1>").fasst(3)`;
  const f = failure(src);
  assert.equal(f.where.line, 43);
  assert.equal(f.where.col, 34);
  assert.equal(f.marked, 'fasst');
});

test('const/let rewritten to var does not shift the column', () => {
  const f = failure('const kick = s("bd")\nconst x = kick.fasst(2)');
  assert.equal(f.message, 'line 2:16 - "fasst" is not a method - did you mean "fast"?');
});

test('an undefined name, with and without a near builder', () => {
  assert.equal(failure('a: note("c e g").fast(foo)').message, 'a, line 1:23 - "foo" is not defined');
  const f = failure('a: nte("c e g")');
  assert.equal(f.message, 'a, line 1:4 - "nte" is not defined - did you mean "note"?');
});

test('an unclosed paren is reported at the paren that is never closed', () => {
  const f = failure('// intro\n\nkick: s("bd*4")\n  .gain("0.5 1")\n  .fast(2\n\nhat: s("hh")');
  assert.equal(f.message, 'kick, line 5:8 - missing ")"');
  assert.equal(f.marked, '(');
});

test('a stray closer, a typo\'d keyword and an unclosed string', () => {
  assert.equal(failure('a: s("bd",)].fast(2)').message, 'a, line 1:12 - unexpected "]"');
  const typo = failure('cosnt x = 1\na: s("bd")');
  assert.equal(typo.message, 'line 1:1 - unexpected "cosnt" - did you mean "const"?');
  assert.equal(typo.marked, 'cosnt');
  assert.match(failure('a: s("bd).fast(2)').message, /^a, line 1:6 - unclosed string$/);
});

test('a stray comma inside a call is placed', () => {
  const f = failure('x: s("bd").gain(0.5,,)');
  assert.equal(f.where.line, 1);
  assert.equal(f.where.col, 21);
});

test('a rewritten call reads as the name typed', () => {
  const f = failure('a: s("bd").gain("0.5").record({take: "t"}).bad()');
  assert.equal(f.message, 'a, line 1:44 - "bad" is not a method');
  assert.doesNotMatch(f.message, /_record|mini\(/);
});

test('an error thrown later, from a callback written in the block, points into the block', () => {
  const f = failure('// x\na: s("bd").fmap((v) => v.nope())');
  assert.equal(f.where.line, 2);
  assert.equal(f.marked, 'nope');
});

test('bad mini-notation marks the token inside the string', () => {
  const f = failure('a: s("bd [sd").fast(2)');
  assert.equal(f.where.col, 10);
  assert.equal(f.marked, '[');
  const g = failure('\n\nb: n("0 1 ^")');
  assert.equal(g.where.line, 3);
  assert.equal(g.marked, '^');
});

test('a block with nothing to point at keeps the plain message', () => {
  const f = pc.describeEvalError(new Error('must evaluate to a pattern'), { source: 'a: 1', block: { label: 'a', start: 0 }, names });
  assert.equal(f.message, 'a: must evaluate to a pattern');
  assert.equal(f.where, null);
  const anon = pc.describeEvalError(new Error('boom'), { source: '1', block: { label: '$1', start: 0 } });
  assert.equal(anon.message, 'boom');
});

test('deck B\'s errors are deck B\'s', () => {
  const f = failure('a: s("bd").fasst(2)', { deck: 'b' });
  assert.equal(f.where.deck, 'b');
});

test('a warning given while a block runs carries the position of the call', () => {
  const heard = [];
  pc.setPatternWarn((line, where) => heard.push({ line, where }));
  try {
    const src = '// x\n\nlead: n("0 2").gain(\n  rand().fast(2))';
    const evalBlock = createBlockEvaluator(pc, { deck: 'a', doc: src });
    for (const b of pc.splitLabeledBlocks(src)) evalBlock(b.code, b.start, b.label);
  } finally {
    pc.setPatternWarn(null);
  }
  assert.equal(heard.length, 1);
  assert.deepEqual({ line: heard[0].where.line, col: heard[0].where.col, label: heard[0].where.label }, { line: 4, col: 10, label: 'lead' });
  assert.match(pc.withPosition(heard[0].line, heard[0].where), /^lead, line 4:10 - \[signal\] rand\(\) has no rate/);
});

test('nearestName: close names only, case and swapped letters count', () => {
  assert.equal(pc.nearestName('fasst', METHODS), 'fast');
  assert.equal(pc.nearestName('Fast', METHODS), 'fast');
  assert.equal(pc.nearestName('sclae', METHODS), 'scale');
  assert.equal(pc.nearestName('fast', METHODS), null); // already a name
  assert.equal(pc.nearestName('zzzzzz', METHODS), null);
  assert.equal(pc.nearestName('q', METHODS), null);
  assert.equal(pc.nearestName('_rol', ['_roll']), null); // internal names are never offered
});

test('bracketProblem and plainText', () => {
  assert.deepEqual(pc.bracketProblem('s("(").fast(2'), { at: 11, text: 'missing ")"' });
  assert.deepEqual(pc.bracketProblem('a(]'), { at: 2, text: 'missing ")"' });
  assert.equal(pc.bracketProblem('// (\nf(x)'), null);
  assert.equal(pc.plainText('mini("bd sd", 1234).x is bad, n(...)._record'), '"bd sd".x is bad, n(...).record');
});
