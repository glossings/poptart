// Splitting the editor buffer into labeled blocks (labels.mjs). The interesting cases are all
// about *where* a `name:` counts as a label: only at column 0, and only where the preceding
// lines have left us in code - text inside a `/*…*/` or a multi-line template just looks like one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitLabeledBlocks, isBareCallBlock } from './src/labels.mjs';

const labels = (src) => splitLabeledBlocks(src).map((b) => b.label);

test('labels split the buffer, anonymous ones numbered by position', () => {
  const src = ['bass: n("0 2")', '$: n("3")', 'lead: n("7")'].join('\n');
  assert.deepEqual(labels(src), ['bass', '$1', 'lead']);
});

test('mute and solo markers are stripped from the name', () => {
  const src = ['_bass: n("0")', 'Slead: n("7")', 'padS: n("1")', 'drums_: n("2")'].join('\n');
  const blocks = splitLabeledBlocks(src);
  assert.deepEqual(blocks.map((b) => [b.label, b.muted, b.soloed]), [
    ['bass', true, false],
    ['lead', false, true],
    ['pad', false, true],
    ['drums', true, false],
  ]);
});

test('continuation lines stay with their block', () => {
  const src = ['bass: n("0 2")', '  .s("sine")', 'lead: n("7")'].join('\n');
  const blocks = splitLabeledBlocks(src);
  assert.deepEqual(blocks.map((b) => b.label), ['bass', 'lead']);
  assert.match(blocks[0].code, /\.s\("sine"\)/);
});

test('a label inside a block comment is comment text, not a block', () => {
  const src = ['/*', '', '$: broken?', '', '*/', 'bass: n("0")'].join('\n');
  assert.deepEqual(labels(src), ['$1', 'bass']);
  // The whole comment stayed in one block, so nothing tried to evaluate `broken?` on its own.
  const [comment] = splitLabeledBlocks(src);
  assert.match(comment.code, /\$: broken\?/);
  assert.match(comment.code, /\*\//);
});

test('a block comment opened mid-block does not let its contents start blocks', () => {
  const src = ['bass: n("0") /*', 'lead: n("7")', '*/'].join('\n');
  assert.deepEqual(labels(src), ['bass']);
});

test('a label inside a multi-line template is template text', () => {
  const src = ['$: n(`', 'lead: 3', '`)', 'bass: n("0")'].join('\n');
  assert.deepEqual(labels(src), ['$1', 'bass']);
});

test('a template interpolation does not reopen label matching either', () => {
  // Splitting here would strand the template's closing `}`)` line in a block of its own, which
  // then fails to evaluate - so an unclosed template suppresses labels all the way to its `` ` ``.
  const src = ['$: n(`${', 'lead: 3', '}`)'].join('\n');
  assert.deepEqual(labels(src), ['$1']);
});

test('a label after a closed block comment is a normal label', () => {
  const src = ['/* setup */', 'bass: n("0")'].join('\n');
  assert.deepEqual(labels(src), ['$1', 'bass']);
});

test('an unclosed bracket does not swallow the labels below it', () => {
  // A stray `(` is a typo; hiding the rest of the patch behind it would be worse than letting
  // the broken block fail to evaluate on its own.
  const src = ['bass: n("0"', 'lead: n("7")'].join('\n');
  assert.deepEqual(labels(src), ['bass', 'lead']);
});

test('line comments never start or end a block', () => {
  const src = ['// a note', 'bass: n("0")', '// another', 'lead: n("7")'].join('\n');
  assert.deepEqual(labels(src), ['bass', 'lead']);
});

// isBareCallBlock: which blocks the host may HOIST (see web-app's server.js - a bare setscale is
// run before every pattern, so the last one in the buffer re-keys the whole buffer). Anything
// mixed in with other code must NOT qualify: hoisting it would move that code too.
test('a bare setscale call is hoistable, whatever surrounds it in whitespace and comments', () => {
  assert.ok(isBareCallBlock('setscale("F minor")', 'setscale'));
  assert.ok(isBareCallBlock('  setscale("F minor");  ', 'setscale'));
  assert.ok(isBareCallBlock('// key change\nsetscale("F minor")\n', 'setscale'));
  assert.ok(isBareCallBlock('setscale(myKey)', 'setscale'), 'the argument needn\'t be a literal');
  assert.ok(isBareCallBlock('setscale(pick(1, 2))', 'setscale'), 'nested parens close correctly');
});

test('a setscale mixed in with other code is not hoistable', () => {
  assert.ok(!isBareCallBlock('setscale("F minor"); n("0").synth("x")', 'setscale'));
  assert.ok(!isBareCallBlock('const k = setscale("F minor")', 'setscale'));
  assert.ok(!isBareCallBlock('n("0").sc()', 'setscale'));
  assert.ok(!isBareCallBlock('setscaleish("F minor")', 'setscale'));
  assert.ok(!isBareCallBlock('setscale("F minor"', 'setscale'), 'an unclosed call is a typo, not a hoist');
});

test('a labeled setscale block still reads as a bare call', () => {
  // splitLabeledBlocks blanks the label out with spaces, so the block code keeps its offsets.
  const [block] = splitLabeledBlocks('key: setscale("F minor")');
  assert.ok(isBareCallBlock(block.code, 'setscale'));
});
