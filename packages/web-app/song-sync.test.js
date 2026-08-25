'use strict';

// The song-deck sync math (songs phase 4): rate lock, beat snap, nudge, drift servo. Pure
// functions - the /api/song/* handlers are thin over these.

const test = require('node:test');
const assert = require('node:assert/strict');

const { syncRate, effectiveRate, snapToBeat, servoTrim, NUDGE_PCT, RATE_MIN, RATE_MAX } = require('./song-sync');

test('syncRate: master over native, clamped, null without a native tempo', () => {
  assert.equal(syncRate(128, 128), 1);
  assert.equal(syncRate(130, 125), 1.04);
  assert.equal(syncRate(1000, 100), RATE_MAX);
  assert.equal(syncRate(20, 400), RATE_MIN);
  assert.equal(syncRate(128, null), null);
  assert.equal(syncRate(NaN, 120), null);
  assert.equal(syncRate(128, 0), null);
});

test('effectiveRate: ±4% while a nudge is held, exactly the base otherwise', () => {
  assert.equal(effectiveRate(1, 0), 1);
  assert.equal(effectiveRate(1, 1), 1 + NUDGE_PCT);
  assert.equal(effectiveRate(1, -1), 1 - NUDGE_PCT);
  assert.equal(effectiveRate(1.1, 1), 1.1 * (1 + NUDGE_PCT));
});

test('snapToBeat: nearest gridpoint from the anchor, clamped to the file', () => {
  // 120 bpm -> 0.5s beats; anchor at 0.2 puts the grid at 0.2, 0.7, 1.2, ...
  assert.equal(snapToBeat(0.8, 120, 0.2), 0.7);
  assert.equal(snapToBeat(0.96, 120, 0.2), 1.2, 'rounds to the NEAREST beat, not down');
  assert.equal(snapToBeat(0.05, 120, 0.2), 0.2);
  assert.equal(snapToBeat(0, 120, 0.4), 0, 'never snaps before the top of the file');
  assert.equal(snapToBeat(9.9, 120, 0, 9.95), 9.95, 'nor past its end');
  assert.equal(snapToBeat(4.32, null, 0), 4.32, 'no bpm, no snap');
});

test('servoTrim: deadband, gentle proportional trim, hard-resync escape', () => {
  assert.equal(servoTrim(0.005), 0, 'sub-deadband error is noise');
  assert.equal(servoTrim(-0.008), 0);
  assert.equal(servoTrim(0.016), 0.002, 'err/8 in the linear region');
  assert.equal(servoTrim(-0.016), -0.002);
  assert.equal(servoTrim(0.08), 0.003, 'capped inaudibly');
  assert.equal(servoTrim(-0.08), -0.003);
  assert.equal(servoTrim(0.3), null, 'past the hard threshold: adopt, do not chase');
  assert.equal(servoTrim(NaN), 0);
});
