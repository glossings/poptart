// The mixer's code edits (mixctl.mjs): reading a block's gain/pan trim and producing the edit
// that sets it. What these tests keep honest is the ownership rule - the mixer rewrites only a
// trailing bare-number call, never a patterned one, and appends at the end of the block's CODE
// (past comments and blank lines, before a trailing semicolon).

import test from 'node:test';
import assert from 'node:assert/strict';

import { readTrim, trimEdit, formatTrim, flagEdit, analyze, renameEdits } from './src/mixctl.mjs';
import { splitLabeledBlocks } from './src/labels.mjs';

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

test('readTrim/trimEdit: width defaults to 1, not 0 - a missing .width() is untouched, not mono', () => {
  const code = 'pad: n("0 2").synth("Serum 2")';
  assert.deepEqual(readTrim(code, 'pad', 'width'), { value: 1, patterned: false });
  const edit = trimEdit(code, 'pad', 'width', 1.8);
  assert.equal(applied(code, edit), 'pad: n("0 2").synth("Serum 2").width(1.8)');
  const set = 'pad: n("0 2").width(0.5)';
  assert.deepEqual(readTrim(set, 'pad', 'width'), { value: 0.5, patterned: false });
});

test('readTrim/trimEdit: bassmono defaults to 0 (off) and writes a frequency', () => {
  const code = 'bass: n("0").synth("Serum 2")';
  assert.deepEqual(readTrim(code, 'bass', 'bassmono'), { value: 0, patterned: false });
  assert.equal(applied(code, trimEdit(code, 'bass', 'bassmono', 120)),
    'bass: n("0").synth("Serum 2").bassmono(120)');
  const on = 'bass: n("0").bassmono(120)';
  assert.deepEqual(readTrim(on, 'bass', 'bassmono'), { value: 120, patterned: false });
  // Switching it off rewrites the same call rather than appending a second one.
  assert.equal(applied(on, trimEdit(on, 'bass', 'bassmono', 0)), 'bass: n("0").bassmono(0)');
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

// --- renameEdits: typing over a strip's name in the mixer ---

// Apply a whole edit list the way the client does - back to front, so offsets stay valid.
const appliedAll = (code, res) =>
  [...res.edits].reverse().reduce((s, e) => s.slice(0, e.from) + e.text + s.slice(e.to), code);

test('renameEdits: rewrites the label token and leaves the block alone', () => {
  const code = 'bass: n("0 2").synth("Serum 2").gain(0.5)\n\nkeys: n("0 4")';
  const res = renameEdits(code, 'bass', 'sub');
  assert.equal(res.refs, 0);
  assert.equal(appliedAll(code, res), 'sub: n("0 2").synth("Serum 2").gain(0.5)\n\nkeys: n("0 4")');
});

test('renameEdits: mute/solo markers survive, in the canonical order', () => {
  const muted = '_bass: s("bd*4")';
  assert.equal(appliedAll(muted, renameEdits(muted, 'bass', 'sub')), '_sub: s("bd*4")');
  const soloedTrailing = 'bassS: s("bd*4")';
  assert.equal(appliedAll(soloedTrailing, renameEdits(soloedTrailing, 'bass', 'sub')), 'Ssub: s("bd*4")');
});

test('renameEdits: a bare-statement block is given a label rather than refused', () => {
  const code = 's("bd*4")';
  assert.equal(appliedAll(code, renameEdits(code, '$1', 'kick')), 'kick: s("bd*4")');
});

test('renameEdits: audio()/midi() sources naming the track move with it', () => {
  const code = [
    'kick: s("bd*4")',
    'bass: n("0").synth("Serum 2").fx("Pro-C 2").audio("kick")',
    'arp: midi("track:kick").synth("Serum 2")',
    'other: audio("kicker")', // a different name, and not a prefix match either
  ].join('\n');
  const res = renameEdits(code, 'kick', 'bd');
  assert.equal(res.refs, 2);
  assert.equal(appliedAll(code, res), [
    'bd: s("bd*4")',
    'bass: n("0").synth("Serum 2").fx("Pro-C 2").audio("bd")',
    'arp: midi("track:bd").synth("Serum 2")',
    'other: audio("kicker")',
  ].join('\n'));
});

test('renameEdits: a commented-out or quoted source name is not a reference', () => {
  const code = 'kick: s("bd*4")\nbass: n("0")\n  // .audio("kick")\n  .log("audio(\'kick\')")';
  const res = renameEdits(code, 'kick', 'bd');
  assert.equal(res.refs, 0);
  assert.equal(appliedAll(code, res), code.replace('kick:', 'bd:'));
});

test('renameEdits: refuses a name that is taken, malformed, or reads as a marker', () => {
  const code = 'kick: s("bd*4")\nbass: n("0")';
  assert.match(renameEdits(code, 'kick', 'bass').error, /already/);
  assert.match(renameEdits(code, 'kick', '2bad').error, /can't be a pattern name/);
  assert.match(renameEdits(code, 'kick', 'kick drum').error, /can't be a pattern name/);
  // `Snare` parses back as a SOLOED `nare`, `bass_` as a muted `bass`, `$` as anonymous.
  assert.match(renameEdits(code, 'kick', 'Snare').error, /marker/);
  assert.match(renameEdits(code, 'kick', 'kick_').error, /marker/);
  assert.match(renameEdits(code, 'kick', '$').error, /marker/);
  assert.match(renameEdits(code, 'gone', 'x').error, /no block named/);
});

test('renameEdits: the new name is what the splitter reads back', () => {
  const code = '_Sbass: s("bd*4").audio("bass")';
  const out = appliedAll(code, renameEdits(code, 'bass', 'sub2'));
  const [block] = splitLabeledBlocks(out);
  assert.equal(block.label, 'sub2');
  assert.equal(block.muted, true);
  assert.equal(block.soloed, true);
  assert.match(out, /\.audio\("sub2"\)/);
});
