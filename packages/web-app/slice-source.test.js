'use strict';

// Which FILE the slice editor opens on (public/client.js sliceChainSourceAt / sliceRefFrom).
//
// A pack is addressed by index, and both spellings of that index hold PATTERNS: `.i("<27 24>")`
// and `s("breaks:<27 24>")` each name two files. The reader used to accept a bare integer only, so
// every patterned index read as 0 and the panel always drew the pack's first file however the
// chain was written (reported 2026-09-04). It now collects every index the chain names, in the
// order written: the first is where the panel opens (when nothing is sounding to be more specific)
// and `[`/`]` walk the rest, since a set holds markers per sample and all of them want drawing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let labelsMod;
test.before(async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  labelsMod = await import(require('node:url').pathToFileURL(path.join(dir, 'labels.mjs')).href);
});

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// Lift `function name(...) { ... }` out of client.js, brace-matched - the trick autopin-target and
// preset-holds use, since a browser bundle can't be required.
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

const bodies = ['codeOnly', 'blockOwnCode', 'matchParen', 'sliceSourceCallAt', 'sliceIndexList', 'sliceRefFrom', 'sliceChainSourceAt']
  .map(grab)
  .join('\n\n');
// eslint-disable-next-line no-new-func
const load = new Function('labelsMod', `${bodies}\nreturn { sliceChainSourceAt, sliceRefFrom };`);

/** The source the panel would open for a one-track buffer. */
const sourceOf = (code) => load(labelsMod).sliceChainSourceAt(code, code.length - 1);

test('a plain index, either spelling', () => {
  assert.deepEqual(sourceOf('break: s("breaks").i(27).slice("0 1")'), {
    ref: 'breaks', name: 'breaks', index: 27, indices: [27],
  });
  assert.deepEqual(sourceOf('break: s("breaks:27").slice("0 1")'), {
    ref: 'breaks', name: 'breaks', index: 27, indices: [27],
  });
});

test('a patterned .i() names every file it alternates between', () => {
  const src = sourceOf('break: s("breaks").i("<27 24>").fit().slice("0 1 2 3").slices("break")');
  assert.equal(src.index, 27, 'the first it names is where the panel opens');
  assert.deepEqual(src.indices, [27, 24]);
});

test('...and so does a patterned field on the name', () => {
  const src = sourceOf('break: s("breaks:<27 24>").fit().slice("0 1")');
  assert.equal(src.ref, 'breaks', 'the pack is still the pack');
  assert.deepEqual(src.indices, [27, 24]);
});

test('an explicit .i() wins over the field on the name, as it does at emit time', () => {
  // The scheduler's dispatch only lets the "pack:n" suffix fill in an index the .i() channel left
  // unset, so a chain carrying both plays what .i() says and the panel has to draw the same file.
  const src = sourceOf('break: s("breaks:9").i("<27 24>").slice("0 1")');
  assert.deepEqual(src.indices, [27, 24]);
});

test('a chain with no index at all plays the pack\'s first file', () => {
  const src = sourceOf('break: s("breaks").slice("0 1")');
  assert.equal(src.index, 0);
  assert.deepEqual(src.indices, [0]);
});

test('a one-file source has no index to pattern', () => {
  assert.deepEqual(sourceOf('stab: se("hits/stab 01.wav").slice("0 2")'), {
    ref: 'file:hits/stab 01.wav', name: 'hits/stab 01.wav', index: 0, indices: [0],
  });
  assert.deepEqual(sourceOf('bass: sr("bass").slice("0 1")'), {
    ref: 'rec:bass', name: 'bass', index: 0, indices: [0],
  });
});

test('a named pack keeps its namespace', () => {
  const src = sourceOf('kit: sp("kit").i("<0 3>").slice("0 1")');
  assert.equal(src.ref, 'sp:kit');
  assert.deepEqual(src.indices, [0, 3]);
});

test('an .i() in a comment, or on another track, is not this chain\'s', () => {
  const src = sourceOf('other: s("drums").i(5)\n\nbreak: s("breaks").i("<27 24>").slice("0 1")');
  assert.deepEqual(src.indices, [27, 24]);
  const commented = sourceOf('break: s("breaks") // .i(9)\n  .i(3).slice("0 1")');
  assert.deepEqual(commented.indices, [3]);
});
