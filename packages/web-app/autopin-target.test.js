'use strict';

// Where an auto-pin capture is WRITTEN (public/client.js) - the two ways it used to miss.
//
// 1. blockForTrack. A label is a key: /api/evaluate walks the buffer in document order and calls
//    setPattern on one scheduler per key, so restating `bass:` further down overrides the first,
//    and the plugin the knob was turned in belongs to the LAST one. Taking the first aimed every
//    write at the overridden version - a `bass: foo()` above a `bass: pianoroll(...).synth(...)`
//    answered "auto-pin: no synth(...) call for track bass slot 0" and dropped the capture.
//
// 2. applyBufferEdits. The capture is two insertions - a `_preset(...)` definition at the foot of
//    the buffer, and the `.preset("name")` naming it on the chain - applied last-first so the
//    offsets hold. When the chain call ends at the very end of the buffer (a last line with no
//    newline after it) the two land on the SAME offset and only the tie-break decides. The wrong
//    way round threads the definition through the middle of the `.preset(…)` call, which is how
//    a capture came out as `_preset("bass", "ValhallaRoom", "@…").preset("bass")` with the track
//    above it untouched (reported 2026-08-27).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// labels.mjs is ESM and this file is CommonJS, so it is imported once up front. The path comes
// off the package the way param-mapping.test.js reaches scheduler.mjs.
let labelsMod;
test.before(async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  labelsMod = await import(require('node:url').pathToFileURL(path.join(dir, 'labels.mjs')).href);
});

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// Lift `function name(...) { ... }` out of client.js, brace-matched - the same trick
// preset-holds.test.js uses on server.js, since neither file can be required (one is a browser
// bundle, the other spawns an engine).
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

const bodies = ['matchParen', 'codeOnly', 'blockOwnCode', 'firstStringLiteral', 'findChainCall', 'findChainHandleAt', 'blockForTrack', 'applyBufferEdits']
  .map(grab)
  .join('\n\n');
// eslint-disable-next-line no-new-func
const load = new Function('labelsMod', 'cm', `${bodies}\nreturn { findChainCall, findChainHandleAt, blockForTrack, applyBufferEdits };`);

// The editor stands in as a plain string, since every edit here is an offset splice.
function fakeCm(text) {
  const cm = {
    value: text,
    getValue: () => cm.value,
    posFromIndex: (i) => i,
    operation: (fn) => fn(),
    replaceRange: (t, from, to) => { cm.value = cm.value.slice(0, from) + t + cm.value.slice(to); },
  };
  return cm;
}

const api = (cm = fakeCm('')) => load(labelsMod, cm);

// What createPresetForSlot hands applyBufferEdits, in the order it hands it over: the definition
// appended at the foot of the buffer (defsEdit's "no run yet" branch, blank line and all), then
// the `.preset(...)` that names it.
function captureEdits(code, closeParen, id, body) {
  const gap = '\n'.repeat(Math.max(0, 2 - /\n*$/.exec(code)[0].length));
  return [
    [code.length, code.length, `${gap}_preset(${JSON.stringify(id)}, ${body})`],
    [closeParen + 1, closeParen + 1, `.preset(${JSON.stringify(id)})`],
  ];
}

test('a track restated further down is the block a capture is written into', () => {
  const { blockForTrack, findChainCall } = api();
  const code = 'bass: foo()\nbass: pianoroll("b").synth("Serum 2")\n';
  const block = blockForTrack(code, 'bass');
  assert.ok(block, 'the label is there twice - one of them has to answer');
  assert.match(code.slice(block.start, block.end), /pianoroll/);
  // ...which is what makes the slot findable at all: the overridden block has no synth() call.
  assert.equal(findChainCall(code, block, 0).plugin, 'Serum 2');
});

test('a muted restatement does not take the track from a playing one', () => {
  const { blockForTrack } = api();
  // The bounce writes exactly this shape: the original muted, the recording below it live.
  const code = 'bass_: pianoroll("b").synth("Serum 2")\nbass: sr("bass-take")\n';
  assert.match(code.slice(...['start', 'end'].map((k) => blockForTrack(code, 'bass')[k])), /sr\("bass-take"\)/);
  // With nothing playing under that name, the muted one is still better than nothing.
  const allMuted = 'bass_: pianoroll("b").synth("Serum 2")\n';
  assert.equal(blockForTrack(allMuted, 'bass').muted, true);
});

test('the definition goes below the call that names it, even at the end of the buffer', () => {
  // No trailing newline: the .fx(...) close paren is the last character, which is exactly where
  // the definition gets appended.
  const code = 'bass: audio("kick").fx("ValhallaRoom")';
  const cm = fakeCm(code);
  const { blockForTrack, findChainCall, applyBufferEdits } = api(cm);
  const block = blockForTrack(code, 'bass');
  const call = findChainCall(code, block, 1);
  assert.equal(call.plugin, 'ValhallaRoom');
  assert.equal(call.closeParen + 1, code.length, 'this test is only about the offsets colliding');

  applyBufferEdits(captureEdits(code, call.closeParen, 'bass', '"ValhallaRoom", "@abc"'), '+autopin');
  assert.equal(cm.value, 'bass: audio("kick").fx("ValhallaRoom").preset("bass")\n\n_preset("bass", "ValhallaRoom", "@abc")');
});

test('a buffer that does end in a newline is written the same way', () => {
  const code = 'bass: audio("kick").fx("ValhallaRoom")\n';
  const cm = fakeCm(code);
  const { blockForTrack, findChainCall, applyBufferEdits } = api(cm);
  const block = blockForTrack(code, 'bass');
  const call = findChainCall(code, block, 1);
  applyBufferEdits(captureEdits(code, call.closeParen, 'bass', '"ValhallaRoom", "@abc"'), '+autopin');
  assert.equal(cm.value, 'bass: audio("kick").fx("ValhallaRoom").preset("bass")\n\n_preset("bass", "ValhallaRoom", "@abc")');
});

test('edits that do not collide are still applied last-first', () => {
  const code = 'bass: synth("Serum 2", { state: "@old" })\n\n_preset("x", "", "")';
  const cm = fakeCm(code);
  const { blockForTrack, findChainCall, applyBufferEdits } = api(cm);
  const block = blockForTrack(code, 'bass');
  const call = findChainCall(code, block, 0);
  // convertLegacyStates' three: strip the `{ state }`, file it under a name, name it on the call.
  applyBufferEdits([
    [call.afterFirstArg, call.closeParen, ''],
    [code.length, code.length, '\n_preset("bass", "Serum 2", "@abc")'],
    [call.closeParen + 1, call.closeParen + 1, '.preset("bass")'],
  ], '+legacyState');
  assert.equal(cm.value,
    'bass: synth("Serum 2").preset("bass")\n\n_preset("x", "", "")\n_preset("bass", "Serum 2", "@abc")');
});

// A group's braces hold OTHER tracks, and their chains are theirs: `drums: group({ … }).fx("X")`
// wears X in slot 1 however many synth()/fx() calls the tracks inside it have. Counting the nested
// ones is what made double-clicking the group's own `fx` open the wrong plugin's window (or none),
// and aimed a knob capture at a slot the group doesn't have.
const GROUPED = [
  'drums: group({',
  '  kick: s("mbd*4").fx("Pro-C 2")',
  '  hats: synth("Serum 2").fx("ValhallaRoom").fx("Pro-Q 3")',
  '}).fx("FilterFreak1").fx("Pro-L 2")',
].join('\n');

test("a group's chain numbers around the tracks inside its braces", () => {
  const { blockForTrack, findChainCall } = api();
  const block = blockForTrack(GROUPED, 'drums');
  assert.equal(findChainCall(GROUPED, block, 1).plugin, 'FilterFreak1');
  assert.equal(findChainCall(GROUPED, block, 2).plugin, 'Pro-L 2');
  assert.equal(findChainCall(GROUPED, block, 0), null, 'a group has no instrument slot');
  // The tracks inside still answer for their own slots.
  assert.equal(findChainCall(GROUPED, blockForTrack(GROUPED, 'hats'), 0).plugin, 'Serum 2');
  assert.equal(findChainCall(GROUPED, blockForTrack(GROUPED, 'hats'), 2).plugin, 'Pro-Q 3');
});

test("double-clicking a group's own fx opens that group's slot", () => {
  const { findChainHandleAt } = api();
  const at = (needle) => findChainHandleAt(GROUPED, GROUPED.indexOf(needle) + 1);
  assert.deepEqual(at('fx("FilterFreak1")'), { label: 'drums', slot: 1 });
  assert.deepEqual(at('fx("Pro-L 2")'), { label: 'drums', slot: 2 });
  assert.deepEqual(at('fx("Pro-C 2")'), { label: 'kick', slot: 1 });
  assert.deepEqual(at('synth("Serum 2")'), { label: 'hats', slot: 0 });
  assert.deepEqual(at('fx("Pro-Q 3")'), { label: 'hats', slot: 2 });
});
