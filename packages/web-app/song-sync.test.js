'use strict';

// The song-deck sync math (songs phase 4): rate lock, beat snap, nudge, drift servo. Pure
// functions - the /api/song/* handlers are thin over these.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  syncRate, syncOctave, effectiveRate, snapToGrid, alignToGrid, snapToOnset, gridPhase, servoTrim,
  NUDGE_PCT, RATE_MIN, RATE_MAX, BEATS_PER_CYCLE,
} = require('./song-sync');

test('syncRate: master over native, clamped, null without a native tempo', () => {
  assert.equal(syncRate(128, 128), 1);
  assert.equal(syncRate(130, 125), 1.04);
  assert.equal(syncRate(1000, 100), RATE_MAX);
  assert.equal(syncRate(20, 400), RATE_MIN);
  assert.equal(syncRate(128, null), null);
  assert.equal(syncRate(NaN, 120), null);
  assert.equal(syncRate(128, 0), null);
});

test('syncOctave / syncRate: half- and double-time pairings lock at the nearest octave', () => {
  assert.equal(syncOctave(140, 70), 2, 'a 70 under a 140 clock counts its eighths');
  assert.equal(syncOctave(70, 140), 0.5);
  assert.equal(syncOctave(128, 126), 1);
  assert.equal(syncOctave(100, 140), 1, 'a wide but sub-octave gap still stretches (0.71)');
  assert.equal(syncOctave(140, 70, 1), 1, 'pinned');
  assert.equal(syncRate(140, 70), 1, 'so the 70 plays at its own speed');
  assert.equal(syncRate(140, 70, 1), 2, 'unless told to double');
  assert.equal(syncRate(70, 140), 1);
});

test('effectiveRate: ±4% while a nudge is held, exactly the base otherwise', () => {
  assert.equal(effectiveRate(1, 0), 1);
  assert.equal(effectiveRate(1, 1), 1 + NUDGE_PCT);
  assert.equal(effectiveRate(1, -1), 1 - NUDGE_PCT);
  assert.equal(effectiveRate(1.1, 1), 1.1 * (1 + NUDGE_PCT));
});

test('snapToGrid: nearest gridpoint from the anchor, always inside the file', () => {
  // 120 bpm -> 0.5s beats; anchor at 0.2 puts the grid at 0.2, 0.7, 1.2, ...
  assert.equal(snapToGrid(0.8, 120, 0.2), 0.7);
  assert.equal(snapToGrid(0.96, 120, 0.2), 1.2, 'rounds to the NEAREST beat, not down');
  assert.equal(snapToGrid(0.05, 120, 0.2), 0.2);
  assert.equal(snapToGrid(0, 120, 0.4), 0.4, 'steps forward onto the grid, never off it');
  assert.ok(Math.abs(snapToGrid(9.9, 120, 0, 9.95) - 9.5) < 1e-9, 'and back onto it at the end');
  assert.equal(snapToGrid(4.32, null, 0), 4.32, 'no bpm, no snap');
  assert.equal(snapToGrid(0.3, 120, 0, 0.2), 0, 'a file shorter than one step has no gridpoint');
});

test('snapToGrid: a bar resolution is what a deck joining the clock uses', () => {
  // 120 bpm, anchor 0: beats at 0.5s, bars (4 beats) at 2s.
  assert.equal(BEATS_PER_CYCLE, 4);
  assert.equal(snapToGrid(2.4, 120, 0, Infinity, BEATS_PER_CYCLE), 2, 'nearest bar line, not beat');
  assert.equal(snapToGrid(3.1, 120, 0, Infinity, BEATS_PER_CYCLE), 4);
  assert.equal(snapToGrid(2.4, 120, 0), 2.5, 'the same position beat-snapped is half a bar out');
  assert.equal(snapToGrid(9.3, 120, 1.3, Infinity, BEATS_PER_CYCLE), 9.3, 'bars run from the anchor');
});

test('alignToGrid: the nearest position with the wanted bar phase', () => {
  // 120 bpm, anchor 0: 2s bars. Phase 0.25 = beat two = 0.5s into a bar.
  assert.equal(alignToGrid(4.1, 120, 0, Infinity, 0), 4, 'downbeat: the same as a bar snap');
  assert.equal(alignToGrid(4.1, 120, 0, Infinity, 0.25), 4.5, 'beat two of the same bar');
  assert.equal(alignToGrid(3.8, 120, 0, Infinity, 0.75), 3.5, 'beat four of the bar before');
  assert.equal(alignToGrid(0.1, 120, 0, Infinity, 0.5), 1, 'never lands before the file');
  assert.equal(alignToGrid(9.9, 120, 0, 10, 0.5), 9, 'nor past its end');
  assert.equal(alignToGrid(5, null, 0, 10, 0.5), 5, 'no bpm, no grid');
});

test('snapToOnset: the nearest transient inside the window, else the hand\'s position', () => {
  const onsets = [0, 0.5, 1.02, 1.5];
  assert.equal(snapToOnset(1.0, onsets), 1.02);
  assert.equal(snapToOnset(0.53, onsets), 0.5);
  assert.equal(snapToOnset(0.75, onsets), 0.75, 'nothing within 80ms');
  assert.equal(snapToOnset(1.7, onsets), 1.7);
  assert.equal(snapToOnset(0.3, []), 0.3);
});

test('gridPhase: the bar position a grid-master song hands the transport', () => {
  // 120 bpm, anchor 0 -> a 2s bar. Entering ON a bar line is cycle phase 0.
  assert.equal(gridPhase(0, 120, 0), 0);
  assert.equal(gridPhase(8, 120, 0), 0, 'four bars in is still a downbeat');
  assert.equal(gridPhase(9, 120, 0), 0.5, 'half a bar past one');
  assert.equal(gridPhase(9.5, 120, 1.5), 0, 'phase is measured from the anchor');
  assert.ok(gridPhase(0, 120, 1.5) >= 0 && gridPhase(0, 120, 1.5) < 1, 'never negative before the anchor');
  assert.equal(gridPhase(4.2, null, 0), 0, 'no bpm, no phase to claim');
});

test('servoTrim: deadband, gentle proportional trim, hard-resync escape', () => {
  assert.equal(servoTrim(0.005), 0, 'sub-deadband error is noise');
  assert.equal(servoTrim(-0.008), 0);
  assert.equal(servoTrim(0.016), -0.002, 'engine ahead: SLOW it, -err/8 in the linear region');
  assert.equal(servoTrim(-0.016), 0.002, 'engine behind: speed it up');
  assert.equal(servoTrim(0.08), -0.003, 'capped inaudibly');
  assert.equal(servoTrim(-0.08), 0.003);
  // The loop must be negative feedback: applying the trim for a while shrinks the error.
  let err = 0.05;
  for (let i = 0; i < 40; i++) err += servoTrim(err) * 0.5; // a report every half second
  assert.ok(Math.abs(err) < 0.05, `error should shrink under the servo, got ${err}`);
  assert.equal(servoTrim(0.3), null, 'past the hard threshold: adopt, do not chase');
  assert.equal(servoTrim(NaN), 0);
});
