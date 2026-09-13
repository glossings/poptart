'use strict';

// The piano roll's length arithmetic (public/client.js): the COARSE step the plain edge drag and
// shift+arrows take - whole cells, the end landing on the grid - and the FINE one cmd adds, any
// fraction of a cell, a pixel of the view at a time. Lengths are real numbers (see pianoroll.mjs),
// and these are the two ways the editor moves one.
//
// Like pr-caret.test.js the functions are lifted out of the shipped client.js rather than copied,
// so this fails if they drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let bodyAt = -1;
  for (let i = SRC.indexOf('(', at); i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && --depth === 0) { bodyAt = SRC.indexOf('{', i); break; }
  }
  depth = 0;
  for (let i = bodyAt; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  assert.fail(`unbalanced braces in ${name}`);
  return '';
}

// eslint-disable-next-line no-new-func
const build = new Function(
  `const PR_MIN_LEN = 0.01;\n${grab('prCoarseLen')}\n${grab('prFineLen')}\n${grab('prFineStep')}\nreturn { prCoarseLen, prFineLen, prFineStep };`,
);
const { prCoarseLen, prFineLen, prFineStep } = build();

test('prCoarseLen: whole cells, the end landing on the grid', () => {
  assert.equal(prCoarseLen(2, 1), 3);
  assert.equal(prCoarseLen(2, -1), 1);
  assert.equal(prCoarseLen(2.3, 1), 3, 'a free length steps to the next whole cell');
  assert.equal(prCoarseLen(2.3, -1), 2, '...or back to the previous one');
  assert.equal(prCoarseLen(2.7, 2), 4);
  assert.equal(prCoarseLen(2.3, 0), 2.3, 'no movement, no change');
});

test('prCoarseLen: never below one cell, but a sub-cell note is not lengthened by a shorten', () => {
  assert.equal(prCoarseLen(1, -1), 1);
  assert.equal(prCoarseLen(1.5, -1), 1);
  assert.equal(prCoarseLen(0.4, -1), 0.4);
  assert.equal(prCoarseLen(0.4, 1), 1, 'and one step right puts it on the cell');
});

test('prFineLen: exact, floored at the shortest note', () => {
  assert.equal(prFineLen(2, 0.25), 2.25);
  assert.equal(prFineLen(0.3, -0.1).toFixed(6), (0.2).toFixed(6));
  assert.equal(prFineLen(0.3, -5), 0.01);
});

test('prFineStep: a pixel of the view, finer as you zoom in', () => {
  assert.equal(prFineStep({ cellW: 40 }), 0.025);
  assert.equal(prFineStep({ cellW: 10 }), 0.1);
  assert.ok(prFineStep({ cellW: 8 }) > prFineStep({ cellW: 80 }));
  assert.equal(prFineStep({ cellW: 100000 }), 0.001, 'never below what the roll writes');
});
