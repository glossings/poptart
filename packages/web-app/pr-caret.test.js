'use strict';

// The piano roll's caret (public/client.js): the cell a press declares as the insertion point, what
// pasting does with it, and the matching rule for duplicate - neither is folded into the loop.
//
// The problem it answers: a paste with no declared position can only put the material back where it
// came from, which is the head of the roll as often as not - there was no way to say "here". The
// arrangement solved this with a cursor set by any press; this is the same idea on the roll's axis,
// and both the note clipboard and the bend curve's read it.
//
// Like auto-lane.test.js the functions are lifted out of the shipped client.js rather than copied,
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

/** prPaste and prCopy over a fake panel; everything they call that isn't the point is stubbed. */
function harness({ notes = [], caret = null, clipboard = null, regionSpan = null } = {}) {
  const prState = { notes: notes.map((n) => ({ ...n })), caret, sel: new Set(), start: 0, len: 16, grid: 16, regionSpan };
  const wrote = [];
  const pianorollMod = require('../pattern-core/src/pianoroll.mjs');
  const env = {
    prState,
    prLoopEnd: () => prState.start + prState.len,
    prClampToLoop: (cell) => Math.min(prState.start + prState.len - 1, Math.max(prState.start, cell)),
    pianorollMod, // for the real prResolveOverlaps, below - pasting onto a note is one of the ways the overlap rule runs
    prScrollTo: () => {},
    writePianorollCall: () => wrote.push(prState.notes.map((n) => `${n.midi}@${n.start}`).join(' ')),
    drawPianoroll: () => {},
    logLine: () => {},
  };
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(env),
    `let prClipboard = ${JSON.stringify(clipboard)};\n${grab('prCopy')}\n${grab('prPaste')}\n${grab('prDuplicate')}\n${grab('prResolveOverlaps')}\n${grab('prTimeRegion')}\nreturn { prCopy, prPaste, prDuplicate, prResolveOverlaps, clip: () => prClipboard };`);
  return { fns: build(...Object.values(env)), prState, wrote };
}

/** A clipboard as prCopy leaves it: the notes and the region they were taken from - their own extent unless one is given. */
function clipOf(notes, at = Math.min(...notes.map((n) => n.start)), w = Math.max(...notes.map((n) => n.start + n.len)) - at) {
  return { notes, at, w };
}

const at = (notes) => notes.map((n) => n.start).sort((a, b) => a - b);

test('a paste lands at the caret, carrying the clipboard there as a block', () => {
  // The timing BETWEEN the notes is what a copied phrase is; only where it starts moves.
  const { fns, prState } = harness({
    caret: 8,
    clipboard: clipOf([{ midi: 60, start: 4, len: 1, vel: 1, prob: 1 }, { midi: 64, start: 6, len: 1, vel: 1, prob: 1 }]),
  });
  fns.prPaste();
  assert.deepEqual(at(prState.notes), [8, 10], 'the earliest note landed on the caret; the gap survived');
});

test('with no caret a paste goes back to the cells it was copied from', () => {
  // Which is what this always did, and is still the right answer when nobody has said otherwise.
  const { fns, prState } = harness({
    caret: null,
    clipboard: clipOf([{ midi: 60, start: 4, len: 1, vel: 1, prob: 1 }, { midi: 64, start: 6, len: 1, vel: 1, prob: 1 }]),
  });
  fns.prPaste();
  assert.deepEqual(at(prState.notes), [4, 6]);
});

test('a caret past the loop pastes out there rather than folding onto the last cell', () => {
  // Out there the notes are drawn but do not sound, exactly as any note drawn past the loop is -
  // and opening the loop up to them brings them in.
  const { fns, prState } = harness({ caret: 40, clipboard: clipOf([{ midi: 60, start: 0, len: 1, vel: 1, prob: 1 }]) });
  fns.prPaste();
  assert.deepEqual(at(prState.notes), [40]);
});

test('a caret before the roll pastes at negative cells, which the window may still open onto', () => {
  const { fns, prState } = harness({ caret: -4, clipboard: clipOf([{ midi: 60, start: 2, len: 1, vel: 1, prob: 1 }]) });
  fns.prPaste();
  assert.deepEqual(at(prState.notes), [-4]);
});

test('pasting the same clipboard twice at two carets leaves two copies', () => {
  const { fns, prState } = harness({ caret: 0, clipboard: clipOf([{ midi: 60, start: 0, len: 1, vel: 1, prob: 1 }]) });
  fns.prPaste();
  prState.caret = 12;
  fns.prPaste();
  assert.deepEqual(at(prState.notes), [0, 12], 'the caret is where a paste goes, every time');
});

test('an empty clipboard pastes nothing at all', () => {
  const { fns, prState, wrote } = harness({ caret: 8, clipboard: null });
  fns.prPaste();
  assert.equal(prState.notes.length, 0);
  assert.equal(wrote.length, 0, 'and costs the buffer no write');
});

test('copy strips the hidden flag, so a buried note comes back visible', () => {
  const { fns } = harness({});
  fns.prCopy([{ midi: 60, start: 0, len: 1, vel: 1, prob: 1, hidden: true }]);
  assert.equal(fns.clip().notes[0].hidden, false);
});

// ---------------------------------------------------------------------------------------------
// The region the notes were taken from. A bar marqueed with one note on its second beat is a bar,
// not a beat: the copy, the paste and the duplicate all carry the marked span's width, so the
// note lands on the second beat of the bar it is put in - not hard against the caret, and not
// one note-length after itself.
// ---------------------------------------------------------------------------------------------

test('copy remembers the marked region, not just the notes\' own extent', () => {
  const { fns, prState } = harness({ notes: [{ midi: 60, start: 4, len: 1, vel: 1, prob: 1 }], regionSpan: [0, 16] });
  prState.sel = new Set(prState.notes);
  fns.prCopy([...prState.sel]);
  assert.deepEqual([fns.clip().at, fns.clip().w], [0, 16]);
});

test('with nothing marked, the copied region is the notes\' own extent', () => {
  const { fns, prState } = harness({ notes: [{ midi: 60, start: 4, len: 2, vel: 1, prob: 1 }, { midi: 64, start: 7, len: 1, vel: 1, prob: 1 }] });
  prState.sel = new Set(prState.notes);
  fns.prCopy([...prState.sel]);
  assert.deepEqual([fns.clip().at, fns.clip().w], [4, 4]);
});

test('a paste puts the REGION\'s start on the caret, so a note keeps its place in the bar', () => {
  const { fns, prState } = harness({ caret: 16, clipboard: clipOf([{ midi: 60, start: 4, len: 1, vel: 1, prob: 1 }], 0, 16) });
  fns.prPaste();
  assert.deepEqual(at(prState.notes), [20], 'second beat of the next bar, not the next bar\'s first cell');
  assert.deepEqual(prState.regionSpan, [16, 32], 'and the pasted bar is the marked region now');
});

test('duplicate with a marked region repeats it one region later, and the mark walks with it', () => {
  const { fns, prState } = harness({ notes: [{ midi: 60, start: 4, len: 1, vel: 1, prob: 1 }], regionSpan: [0, 16] });
  prState.sel = new Set(prState.notes);
  fns.prDuplicate();
  assert.deepEqual(at(prState.notes), [4, 20], 'the copy is a bar later, not a note-length later');
  assert.deepEqual(prState.regionSpan, [16, 32]);
  fns.prDuplicate();
  assert.deepEqual(at(prState.notes), [4, 20, 36], 'pressing again lays the next bar down');
});

test('duplicate with a marked region and nothing selected changes nothing', () => {
  const { fns, prState, wrote } = harness({ regionSpan: [0, 16] });
  fns.prDuplicate();
  assert.equal(prState.notes.length, 0);
  assert.equal(wrote.length, 0);
});

test('duplicate carries on past the loop instead of stacking on its last cell', () => {
  // Clamping the copies into the window put every one of them on the last cell when the selection
  // was near it, which is a stack rather than a duplicate.
  const { fns, prState } = harness({ notes: [{ midi: 60, start: 12, len: 2, vel: 1, prob: 1 }] });
  prState.sel = new Set(prState.notes);
  fns.prDuplicate();
  assert.deepEqual(at(prState.notes), [12, 14], 'the copy sits a phrase later, past the loop\'s end');
  fns.prDuplicate();
  assert.deepEqual(at(prState.notes), [12, 14, 16], 'and again, rather than piling up');
});

test('duplicate keeps the spacing inside a multi-note selection', () => {
  const { fns, prState } = harness({
    notes: [{ midi: 60, start: 0, len: 1, vel: 1, prob: 1 }, { midi: 64, start: 3, len: 1, vel: 1, prob: 1 }],
  });
  prState.sel = new Set(prState.notes);
  fns.prDuplicate();
  assert.deepEqual(at(prState.notes), [0, 3, 4, 7], 'the pair repeated one phrase-width later');
});

test('pasting onto a note clips it, with the tail in reserve while the paste stays selected', () => {
  // The pasted notes are the selection, so what they cover waits - the paste can still be nudged
  // off. Deselecting is what settles it.
  const { fns, prState } = harness({
    notes: [{ midi: 60, start: 0, len: 8, full: 8, vel: 1, prob: 1 }],
    caret: 4,
    clipboard: clipOf([{ midi: 60, start: 0, len: 1, vel: 1, prob: 1 }]),
  });
  fns.prPaste();
  const long = prState.notes.find((n) => n.start === 0);
  assert.equal(long.len, 4, 'cut at the pasted note\'s onset');
  assert.equal(long.full, 8, 'the tail waits behind it while the pasted note is selected');
  prState.sel.clear(); // clicked off
  fns.prResolveOverlaps();
  assert.equal(long.full, 4, 'and now the tail is gone for good');
});

test('pasting square on top of a note buries it until the paste is deselected', () => {
  const { fns, prState } = harness({
    notes: [{ midi: 60, start: 4, len: 4, full: 4, vel: 1, prob: 1 }],
    caret: 4,
    clipboard: clipOf([{ midi: 60, start: 0, len: 1, vel: 1, prob: 1 }]),
  });
  fns.prPaste();
  assert.equal(prState.notes.length, 2, 'the one underneath is hidden, not gone');
  assert.equal(prState.notes.filter((n) => !n.hidden).length, 1);
  prState.sel.clear();
  fns.prResolveOverlaps();
  assert.equal(prState.notes.length, 1, 'deselected: the one underneath is deleted');
  assert.equal(prState.notes[0].len, 1);
});
