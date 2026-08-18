// Splitting the editor buffer into labeled blocks (labels.mjs). The interesting cases are all
// about *where* a `name:` counts as a label: only at column 0, and only where the preceding
// lines have left us in code - text inside a `/*…*/` or a multi-line template just looks like one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitLabeledBlocks, isBareCallBlock, codeMask } from './src/labels.mjs';

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

test('a label whose expression starts on the next line still owns it', () => {
  // `pluck:` alone is a labeled statement waiting for its statement - the indented pattern below
  // is that statement, however far down the commented-out lines push it. Splitting them apart
  // left the pluck block with no code at all (so it vanished, taking its `_`/`S` with it) and the
  // pattern in an anonymous block of its own.
  const src = ['pluck:', '  // pianoroll("a")', '  pianoroll("b")', '    .gain(1)', 'lead: n("7")'].join('\n');
  const blocks = splitLabeledBlocks(src);
  assert.deepEqual(blocks.map((b) => b.label), ['pluck', 'lead']);
  assert.match(blocks[0].code, /pianoroll\("b"\)/);
  assert.match(blocks[0].code, /\.gain\(1\)/);
  assert.equal(blocks[0].start, 0, 'the label line belongs to the block, so it greys out with it');
});

test('mute and solo markers work on a label that stands on its own line', () => {
  const src = ['_bass:', '  n("0")', 'Slead:', '  n("7")'].join('\n');
  const blocks = splitLabeledBlocks(src);
  assert.deepEqual(blocks.map((b) => [b.label, b.muted, b.soloed]), [
    ['bass', true, false],
    ['lead', false, true],
  ]);
});

test('a bare label with no body at all is not a block', () => {
  assert.deepEqual(labels(['bass: n("0")', 'lead:'].join('\n')), ['bass']);
  // ...and a label that only ever gets another label is left behind, not handed the block below.
  assert.deepEqual(labels(['pluck:', 'lead: n("7")'].join('\n')), ['lead']);
});

test('an unlabeled statement after a labeled block is still its own block', () => {
  // Only a label *waiting* for its body adopts an un-indented line; a block that already has its
  // expression leaves the next column-0 statement alone.
  const src = ['bass: n("0")', 'Signal.prototype.co = () => 1'].join('\n');
  assert.deepEqual(labels(src), ['bass', '$1']);
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

// The lexer that decides all of the above runs once over the buffer, carrying its state from line
// to line, rather than re-reading the block from the start each time (which made splitting cost
// O(lines x block size) - ruinous for a buffer holding a pinned plugin state, and it runs in the
// same event loop as the note scheduler). These two lock that in: the state really does carry
// across the line boundary, and the cost stays linear.

test('a backslash at end of line keeps a string open into the next line', () => {
  // The escaped newline means the ` and ) on line 2 are string contents, not a template opening
  // one - so `b:` on line 3 is still read as a label. Re-lexing from the start got this right by
  // construction; carrying the state has to get it right by remembering the pending escape.
  const src = ['a: n("x \\', '` )', 'b: n("0")'].join('\n');
  assert.deepEqual(labels(src), ['a', 'b']);
});

test('splitting stays linear in buffer size', () => {
  // A pinned plugin state, with the rest of the method chain below it - every one of those lines
  // used to re-lex the whole state string.
  const blob = 'QUJD'.repeat(512 * 1024); // 2 MB
  const src = [
    'lead: n("0 3 5 7")',
    `  .synth("Serum 2", { state: "${blob}" })`,
    ...Array.from({ length: 12 }, (_, i) => `  .gain(${(i % 9) / 10 + 0.1})`),
    '',
    'drums: s("bd*4")',
  ].join('\n');

  const t0 = performance.now();
  const blocks = splitLabeledBlocks(src);
  const ms = performance.now() - t0;

  assert.deepEqual(blocks.map((b) => b.label), ['lead', 'drums']);
  assert.ok(ms < 100, `splitting a ${(src.length / 1024 / 1024).toFixed(0)}MB buffer took ${ms.toFixed(0)}ms`);
});

// ---------------------------------------------------------------------------------------------
// codeMask: which characters are live code. The editor's rewriting tools (auto-pin, conf) find
// calls with regexes and must not write to a commented-out one - see the codeMask doc comment.
// ---------------------------------------------------------------------------------------------

// The offsets of every occurrence of `needle` in `src` that codeMask says is live code.
const codeHits = (src, needle) => {
  const mask = codeMask(src);
  const hits = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) if (mask[i]) hits.push(i);
  return hits;
};

test('codeMask: a commented-out call is not code, the live one below it is', () => {
  const src = [
    'lead: n("0 3")',
    '  // .synth("Serum 2", { state: "AAA" })',
    '  .synth("Serum 2", { state: "BBB" })',
  ].join('\n');
  const hits = codeHits(src, 'synth(');
  assert.equal(hits.length, 1);
  assert.ok(src.slice(hits[0]).startsWith('synth("Serum 2", { state: "BBB"'));
});

test('codeMask: block comments, including multi-line ones', () => {
  const src = ['a: n("0")', '/* .fx("Valhalla")', '   .fx("Pro-Q") */', '  .fx("Ozone")'].join('\n');
  assert.deepEqual(codeHits(src, 'fx(').map((i) => src.slice(i, i + 14)), ['fx("Ozone")']);
});

test('codeMask: text inside a string is not code either', () => {
  const src = 'a: s("bd").param("fx(1)", 2)';
  assert.deepEqual(codeHits(src, 'fx('), []);
  assert.equal(codeHits(src, 'param(').length, 1);
});

test('codeMask: a template literal is text, but its ${} interpolation is code', () => {
  const src = 'const t = `a .fx("x") ${fx(1)} b`;';
  const hits = codeHits(src, 'fx(');
  assert.equal(hits.length, 1);
  assert.equal(hits[0], src.indexOf('${fx(') + 2);
});

test('codeMask: the characters opening a comment or string are not code', () => {
  const src = 'a: n("0") // c';
  const mask = codeMask(src);
  assert.equal(mask[src.indexOf('//')], 0);
  assert.equal(mask[src.indexOf('"')], 0);
  assert.equal(mask[src.indexOf('n(')], 1);
  assert.equal(mask.length, src.length);
});

test('codeMask: an apostrophe inside a comment does not open a string', () => {
  // The lexer reads the comment first, so "don't" can't swallow the code on the next line.
  const src = ["// don't touch", 'lead: n("0").synth("Serum 2")'].join('\n');
  assert.equal(codeHits(src, 'synth(').length, 1);
});
