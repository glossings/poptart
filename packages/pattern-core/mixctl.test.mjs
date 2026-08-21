// The mixer's code edits (mixctl.mjs): reading a block's gain/pan trim and producing the edit
// that sets it. What these tests keep honest is the ownership rule - the mixer rewrites only a
// trailing bare-number call, never a patterned one, and appends at the end of the block's CODE
// (past comments and blank lines, before a trailing semicolon).

import test from 'node:test';
import assert from 'node:assert/strict';

import { readTrim, trimEdit, formatTrim, flagEdit, analyze } from './src/mixctl.mjs';

// Apply an edit the way CodeMirror would, so assertions read as the resulting buffer.
const applied = (code, edit) => code.slice(0, edit.from) + edit.text + code.slice(edit.to);

test('readTrim: no call reports the control default', () => {
  const code = 'bass: n("0 2").synth("Serum 2")';
  assert.deepEqual(readTrim(code, 'bass', 'gain'), { value: 1, patterned: false });
  assert.deepEqual(readTrim(code, 'bass', 'pan'), { value: 0, patterned: false });
});

test('readTrim: trailing literal call is the trim', () => {
  const code = 'bass: n("0 2").synth("Serum 2").gain(0.5).pan(-0.25)';
  assert.deepEqual(readTrim(code, 'bass', 'gain'), { value: 0.5, patterned: false });
  assert.deepEqual(readTrim(code, 'bass', 'pan'), { value: -0.25, patterned: false });
});

test('readTrim: the LAST call wins, and only a bare number counts as a trim', () => {
  const code = 'a: s("bd").gain(0.4).gain(env({ release: 0.3 }))';
  assert.deepEqual(readTrim(code, 'a', 'gain'), { value: 1, patterned: true });
  const code2 = 'a: s("bd").gain(env()).gain(0.4)';
  assert.deepEqual(readTrim(code2, 'a', 'gain'), { value: 0.4, patterned: false });
});

test('readTrim: unknown label is null; other blocks are not read', () => {
  const code = 'a: s("bd").gain(0.4)\n\nb: s("sn")';
  assert.equal(readTrim(code, 'c', 'gain'), null);
  assert.deepEqual(readTrim(code, 'b', 'gain'), { value: 1, patterned: false });
});

test('trimEdit: rewrites a trailing literal in place', () => {
  const code = 'bass: n("0 2").synth("Serum 2").gain(0.5)';
  const edit = trimEdit(code, 'bass', 'gain', 0.8);
  assert.equal(applied(code, edit), 'bass: n("0 2").synth("Serum 2").gain(0.8)');
});

test('trimEdit: appends when there is no call, at the end of a multi-line chain', () => {
  const code = 'keys: n("0 2 3")\n  .scale("F minor")\n  .synth("Serum 2")\n\n// outro';
  const edit = trimEdit(code, 'keys', 'gain', 0.71);
  assert.equal(
    applied(code, edit),
    'keys: n("0 2 3")\n  .scale("F minor")\n  .synth("Serum 2").gain(0.71)\n\n// outro',
  );
});

test('trimEdit: appends after a patterned call instead of rewriting it', () => {
  const code = 'a: s("bd*4").gain(env({ release: 0.2 }))';
  const edit = trimEdit(code, 'a', 'gain', 0.6);
  assert.equal(applied(code, edit), 'a: s("bd*4").gain(env({ release: 0.2 })).gain(0.6)');
});

test('trimEdit: lands before a trailing semicolon', () => {
  const code = 'a: s("bd*4");';
  const edit = trimEdit(code, 'a', 'pan', -0.3);
  assert.equal(applied(code, edit), 'a: s("bd*4").pan(-0.3);');
});

test('trimEdit: a commented-out call neither reads nor takes the write', () => {
  const code = 'a: s("bd*4")\n  // .gain(0.2)';
  assert.deepEqual(readTrim(code, 'a', 'gain'), { value: 1, patterned: false });
  const edit = trimEdit(code, 'a', 'gain', 0.9);
  assert.equal(applied(code, edit), 'a: s("bd*4").gain(0.9)\n  // .gain(0.2)');
});

test('trimEdit: a gain inside a string is not a call', () => {
  const code = 'a: s("bd").fx("Gain(dB)").gain(0.5)';
  const edit = trimEdit(code, 'a', 'gain', 0.7);
  assert.equal(applied(code, edit), 'a: s("bd").fx("Gain(dB)").gain(0.7)');
});

test('trimEdit: anonymous blocks are addressable by their $N label', () => {
  const code = 's("bd*4")\n\nb: s("sn")';
  const edit = trimEdit(code, '$1', 'gain', 0.5);
  assert.equal(applied(code, edit), 's("bd*4").gain(0.5)\n\nb: s("sn")');
});

test('formatTrim: two decimals, no float dust', () => {
  assert.equal(formatTrim(0.7071067), 0.71);
  assert.equal(formatTrim(1), 1);
  assert.equal(formatTrim(-0.30000000004), -0.3);
});

test('flagEdit: mutes and unmutes by rewriting the label marker', () => {
  const code = 'bass: s("bd*4")\n\nkeys: n("0 2")';
  assert.equal(applied(code, flagEdit(code, 'bass', { muted: true })), '_bass: s("bd*4")\n\nkeys: n("0 2")');
  const muted = '_bass: s("bd*4")';
  assert.equal(applied(muted, flagEdit(muted, 'bass', { muted: false })), 'bass: s("bd*4")');
});

test('flagEdit: solo, and mute+solo, in the canonical _S order', () => {
  const code = 'bass: s("bd*4")';
  assert.equal(applied(code, flagEdit(code, 'bass', { soloed: true })), 'Sbass: s("bd*4")');
  assert.equal(applied(code, flagEdit(code, 'bass', { muted: true, soloed: true })), '_Sbass: s("bd*4")');
  const both = '_Sbass: s("bd*4")';
  assert.equal(applied(both, flagEdit(both, 'bass', { muted: true, soloed: false })), '_bass: s("bd*4")');
});

test('flagEdit: trailing-marker spellings normalize to the canonical form', () => {
  const code = 'bass_: s("bd*4")';
  assert.equal(applied(code, flagEdit(code, 'bass', { muted: true, soloed: true })), '_Sbass: s("bd*4")');
});

test('flagEdit: a $: block takes markers; a bare-statement block cannot', () => {
  const code = '$: s("bd*4")\n\ns("sn")';
  assert.equal(applied(code, flagEdit(code, '$1', { muted: true })), '_$: s("bd*4")\n\ns("sn")');
  assert.equal(flagEdit(code, '$2', { muted: true }), null);
});

test('flagEdit: unknown label is null; a shared ctx serves several calls', () => {
  const code = 'a: s("bd").gain(0.4)\nb: s("sn")';
  assert.equal(flagEdit(code, 'zzz', { muted: true }), null);
  const ctx = analyze(code);
  assert.deepEqual(readTrim(code, 'a', 'gain', 1, ctx), { value: 0.4, patterned: false });
  assert.equal(applied(code, flagEdit(code, 'b', { muted: true }, ctx)), 'a: s("bd").gain(0.4)\n_b: s("sn")');
});
