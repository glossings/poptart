'use strict';

// The piano roll's waveform view (public/client.js): how long a note's audio actually lasts, and
// which axes a roll may be drawn on.
//
// The view itself is a canvas and the axes are a button, neither of which a test can hold - but
// both sit on arithmetic, and it is where a silent wrong answer would live. The length is the one
// that matters: the waveform is laid against TIME rather than scaled to the note's box, so a wrong
// length draws audio that ends somewhere it doesn't, and nothing on screen would say so. It has to
// agree with playSample's own `durSec = span * stretch / |speed|`, where speed has already taken
// the fit and the repitch. Like auto-lane.test.js, the functions are lifted out of the shipped
// client.js rather than copied, so this fails if they drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

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

const LIFTED = ['prNatCells', 'prModesFor', 'prNextMode', 'prDrawnCell', 'prNoteAt', 'prNoteFile', 'prRefreshAnyIndex']
  .map(grab).join('\n\n');

/**
 * The lifted functions over a fake panel. `duration` is the decoded file's length in seconds and
 * `cps` the transport's rate, so at 1 cycle per second a 2-second file is 2 cycles - and on a
 * 16-cell grid, 32 cells.
 */
function harness({ mode = 'note', notes = [], chain = null, grid = 16, duration = 2, cps = 1 } = {}) {
  const pianorollMod = require('../pattern-core/src/pianoroll.mjs');
  const prState = { mode, notes, chain, grid, modes: [] };
  const ctx = {
    prState,
    pianorollMod,
    prLiveNotes: (list) => list.filter((nt) => !nt.hidden),
    prNoteMode: () => !['index', 'slice'].includes(prState.mode),
    prRowOf: (nt) => (prState.mode === 'index' ? pianorollMod.noteIndex(nt)
      : prState.mode === 'slice' ? (pianorollMod.noteSlice(nt) ?? 0) : nt.midi),
    prWaveFor: () => (duration ? { duration, peaks: {} } : null),
    // playSample's own fit arithmetic, as client.js's prFitCycles does it.
    prFitCycles: (fit, dur) => {
      const measures = dur * cps;
      if (!(measures > 0)) return null;
      if (fit == null) return measures;
      if (fit === 'auto') return 2 ** Math.round(Math.log2(measures));
      return typeof fit === 'number' ? fit : null;
    },
  };
  const body = `${LIFTED}\nreturn { prNatCells, prModesFor, prNextMode, prDrawnCell, prNoteAt, prNoteFile, prRefreshAnyIndex };`;
  const keys = Object.keys(ctx);
  // eslint-disable-next-line no-new-func
  const api = new Function(...keys, body)(...keys.map((k) => ctx[k]));
  return { ...api, prState };
}

const note = (over = {}) => ({ midi: 60, index: 0, slice: null, start: 0, len: 1, vel: 1, prob: 1, nudge: 0, ...over });

// --- how long the audio lasts --------------------------------------------------------------

test('a file plays for as long as it is', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' } } });
  assert.equal(prNatCells(note()), 32, 'two seconds at one cycle a second, on a sixteen-cell grid');
});

test('fit sets the length outright', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' }, fit: 4 } });
  assert.equal(prNatCells(note()), 64, 'four cycles of a sixteen-cell grid');
});

test('an auto fit takes the nearest power of two', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' }, fit: 'auto' }, duration: 2.4 });
  assert.equal(prNatCells(note()), 32, '2.4 cycles rounds to 2');
});

test('speed divides it', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' }, speed: 2 } });
  assert.equal(prNatCells(note()), 16);
});

test('a negative speed lasts as long as a positive one', () => {
  // The file is read backwards, not for less time.
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' }, speed: -1 } });
  assert.equal(prNatCells(note()), 32);
});

test('pitch divides it too - a sampler repitches around MIDI 60', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' } } });
  assert.equal(prNatCells(note({ midi: 72 })), 16, 'an octave up is half as long');
  assert.equal(prNatCells(note({ midi: 48 })), 64, 'and an octave down is twice');
  assert.equal(prNatCells(note({ midi: 60 })), 32, 'MIDI 60 plays the file as recorded');
});

test('stretch lengthens the audio without touching the rate', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' }, stretch: 2 } });
  assert.equal(prNatCells(note()), 64);
});

test('the factors compound, exactly as the engine compounds them', () => {
  const { prNatCells } = harness({ chain: { ref: { ref: 'stems' }, fit: 4, speed: 2, stretch: 3 } });
  // 4 cycles of fit, halved by speed, tripled by stretch, an octave up halves it again.
  assert.equal(prNatCells(note({ midi: 72 })), (4 * 3 / (2 * 2)) * 16);
});

test('a length nobody can know comes back null rather than guessed', () => {
  assert.equal(harness({ chain: { ref: { ref: 'stems' } }, duration: 0 }).prNatCells(note()), null, 'still decoding');
  assert.equal(harness({ chain: { ref: { ref: 'stems' }, fit: '<2 4>' } }).prNatCells(note()), null, 'a patterned fit');
  assert.equal(harness({ chain: { ref: { ref: 'stems' }, speed: 0 } }).prNatCells(note()), null, 'a speed of zero');
});

// --- which axes a roll offers ----------------------------------------------------------------

test('a synth roll offers the keyboard and nothing else', () => {
  assert.deepEqual(harness({ notes: [note()] }).prModesFor(), ['note']);
});

test('a sampler chain offers files, but chops only where the chain chops', () => {
  const plain = harness({ notes: [note()], chain: { ref: { ref: 'breaks' }, chops: false } });
  assert.deepEqual(plain.prModesFor(), ['note', 'index']);
  const chopped = harness({ notes: [note()], chain: { ref: { ref: 'breaks' }, chops: true } });
  assert.deepEqual(chopped.prModesFor(), ['note', 'index', 'slice']);
});

test('a roll that already carries chops keeps the slice axis with no chain at all', () => {
  assert.deepEqual(harness({ notes: [note({ slice: 2 })] }).prModesFor(), ['note', 'slice']);
});

test('a roll drawn on an axis keeps it however the chain changes', () => {
  // Deleting a .slices() call should not move a drawn roll onto another ruler under you.
  const h = harness({ mode: 'slice', notes: [note()], chain: { ref: { ref: 'breaks' }, chops: false } });
  assert.ok(h.prModesFor().includes('slice'));
});

test('the button walks the axes that are actually there, and wraps', () => {
  const h = harness({ notes: [note()], chain: { ref: { ref: 'breaks' }, chops: false } });
  h.prState.modes = h.prModesFor();
  assert.equal(h.prNextMode(), 'index');
  h.prState.mode = 'index';
  h.prState.modes = h.prModesFor();
  assert.equal(h.prNextMode(), 'note', 'past the last one it wraps, skipping the axis nothing offers');
});

test('a roll with one axis has nowhere to go', () => {
  const h = harness({ notes: [note()] });
  h.prState.modes = h.prModesFor();
  assert.equal(h.prNextMode(), 'note');
});

// --- where a note sits ------------------------------------------------------------------------
// A nudged note is DRAWN off its cell now, rather than staying put with a tick beside it, so the
// position it is drawn at and the position it is hit at have to be one number. If they drift, a
// note gets picked up somewhere it isn't and nothing on screen would say why.

test('an unnudged note sits on its cell', () => {
  const { prDrawnCell } = harness();
  assert.equal(prDrawnCell(note({ start: 4 })), 4);
});

test('a nudge moves it, either way', () => {
  const { prDrawnCell } = harness();
  assert.equal(prDrawnCell(note({ start: 4, nudge: 0.25 })), 4.25);
  assert.equal(prDrawnCell(note({ start: 4, nudge: -0.25 })), 3.75);
});

test('the roll\'s swing moves it too, and the two sum', () => {
  // Swing delays the offbeats of its division; cell 1 of an 8-grid is one. The note's own nudge
  // rides on top, because they are the same offset arriving from two places.
  const h = harness({ grid: 8 });
  h.prState.swing = 0.5;
  const swung = h.prDrawnCell(note({ start: 1 }));
  assert.ok(swung > 1, 'an offbeat is delayed');
  assert.equal(h.prDrawnCell(note({ start: 1, nudge: 0.1 })), swung + 0.1);
  assert.equal(h.prDrawnCell(note({ start: 0 })), 0, 'and an onbeat is not moved at all');
});

test('committing the swing leaves every note exactly where it was drawn', () => {
  // The commit folds the swing offset into each note's own nudge and puts the knob back to 0, so
  // nothing may move on screen - that stillness is the confirmation that nothing changed.
  const pianorollMod = require('../pattern-core/src/pianoroll.mjs');
  const h = harness({ grid: 8 });
  h.prState.swing = 0.4;
  const notes = [note({ start: 1 }), note({ start: 3 }), note({ start: 4 })];
  const before = notes.map((nt) => h.prDrawnCell(nt));
  pianorollMod.commitPianoRollSwing(notes, { grid: 8, len: 8, swing: 0.4 });
  h.prState.swing = 0;
  notes.forEach((nt, i) => assert.ok(Math.abs(h.prDrawnCell(nt) - before[i]) < 1e-9, `note ${i} stayed put`));
});

test('a note is hit where it is drawn, not where it is written', () => {
  const h = harness();
  const nt = note({ start: 4, len: 2, nudge: 0.4 });
  h.prState.notes = [nt];
  assert.equal(h.prNoteAt(4.5, 60), 0, 'inside the block as drawn');
  assert.equal(h.prNoteAt(4.3, 60), null, 'in front of it - the cell it is written on, but not where it sits');
  assert.equal(h.prNoteAt(6.3, 60), 0, 'and its tail moved with it');
  assert.equal(h.prNoteAt(6.5, 60), null);
});

test('the topmost note wins, and a hidden one is never hit', () => {
  const h = harness();
  const under = note({ start: 0, len: 4 });
  const over = note({ start: 0, len: 4 });
  h.prState.notes = [under, over];
  assert.equal(h.prNoteAt(1, 60), 1, 'later in the array is on top, which is the order it draws in');
  over.hidden = true;
  assert.equal(h.prNoteAt(1, 60), 0);
});

test('a note on another row is not hit', () => {
  const h = harness();
  h.prState.notes = [note({ start: 0, len: 4, midi: 64 })];
  assert.equal(h.prNoteAt(1, 60), null);
  assert.equal(h.prNoteAt(1, 64), 0);
});

// --- which file a note plays ------------------------------------------------------------------
// The roll's index channel is all-or-nothing: a roll where no note sets one says nothing about it,
// and the chain's own .i() answers for every note. Getting this wrong draws (and opens) the wrong
// sample - silently, since one waveform looks as plausible as another.

test('with no note setting an index, the chain names the file', () => {
  const h = harness({ notes: [note(), note()], chain: { ref: { ref: 'breaks', index: 19 } } });
  h.prRefreshAnyIndex();
  assert.equal(h.prNoteFile(note()), 19);
});

test('once any note sets an index, every note answers for itself', () => {
  const h = harness({ notes: [note(), note({ index: 3 })], chain: { ref: { ref: 'breaks', index: 19 } } });
  h.prRefreshAnyIndex();
  assert.equal(h.prNoteFile(note({ index: 3 })), 3);
  assert.equal(h.prNoteFile(note()), 0, 'including the ones still on the default');
});

test('a chain that names no index falls back to the note', () => {
  const h = harness({ notes: [note()], chain: { ref: { ref: 'breaks' } } });
  h.prRefreshAnyIndex();
  assert.equal(h.prNoteFile(note({ index: 2 })), 2);
});
