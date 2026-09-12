'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ls = require('./link-sync');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('sessionPhase folds any beat count into the bar, negatives included', () => {
  near(ls.sessionPhase(0), 0);
  near(ls.sessionPhase(33), 0.25);
  near(ls.sessionPhase(-3), 0.25); // Link's own example: peer B joins at -3 while A is at 33
  near(ls.sessionPhase(4.5), 0.125);
});

test('phaseDelta is the shorter way round the bar', () => {
  near(ls.phaseDelta(10.25, 33), 0); // both a quarter in
  near(ls.phaseDelta(10.0, 33), 0.25);
  near(ls.phaseDelta(10.9, 32), 0.1); // 0.1 forward, not 0.9 back
  near(ls.phaseDelta(10.1, 32), -0.1);
  near(ls.phaseDelta(10.5, 32), -0.5); // the tie folds to the half-cycle edge, either sign
});

test('sessionBeatsAt extrapolates at the report tempo, either way in time', () => {
  const report = { bpm: 120, beats: 8, atSec: 100 };
  near(ls.sessionBeatsAt(report, 101), 10);
  near(ls.sessionBeatsAt(report, 99), 6);
});

test('followStep: noise is ignored, drift is trimmed, disagreement is adopted or accepted', () => {
  assert.deepEqual(ls.followStep(0.0002, 0), { kind: 'none', shift: 0, offset: 0 });
  assert.deepEqual(ls.followStep(0.004, 0), { kind: 'trim', shift: 0.004, offset: 0 });
  assert.deepEqual(ls.followStep(0.3, 0, { mayAdopt: true }), { kind: 'adopt', shift: 0.3, offset: 0 });
  const kept = ls.followStep(0.3, 0);
  assert.equal(kept.kind, 'accept');
  assert.equal(kept.shift, 0);
  near(kept.offset, 0.3);
});

test('followStep measures against the accepted offset, and adopting clears it', () => {
  // Sitting 0.3 off the session by choice: a 0.304 measurement is a trim, not a disagreement.
  const trim = ls.followStep(0.304, 0.3);
  assert.equal(trim.kind, 'trim');
  near(trim.shift, 0.004);
  near(trim.offset, 0.3);
  // The relation wraps: -0.49 and 0.49 are 0.02 apart, not 0.98.
  const wrapped = ls.followStep(-0.49, 0.49);
  assert.equal(wrapped.kind, 'accept'); // 0.02 is past SOFT
  near(wrapped.offset, -0.49);
  const adopt = ls.followStep(0.2, 0.3, { mayAdopt: true });
  assert.equal(adopt.kind, 'adopt');
  near(adopt.shift, 0.2); // the full measured distance, so the transport lands on the bar
  assert.equal(adopt.offset, 0);
});

test('nextTimeAtPhase finds the next moment the session is at a bar phase', () => {
  const report = { bpm: 120, beats: 8, atSec: 100 }; // bar lines at 100, 102, 104, ...
  near(ls.nextTimeAtPhase(report, 0, 100.5), 102);
  near(ls.nextTimeAtPhase(report, 0, 100), 100); // already there counts
  near(ls.nextTimeAtPhase(report, 0.25, 100.6), 102.5); // a quarter in: beat 13 at 102.5
  near(ls.nextTimeAtPhase(report, 0.25, 100.4), 100.5);
  // A tempo the caller is about to push changes where the bars fall from `fromSec` on: at
  // 120 bpm the session reaches beat 9 at 100.5; at 60 bpm after that, beat 12 is 3 s later.
  near(ls.nextTimeAtPhase(report, 0, 100.65, 60, 100.5), 103.5);
  // Without a split point the push is taken to land at notBeforeSec itself.
  near(ls.nextTimeAtPhase(report, 0, 100.5, 60), 103.5);
  assert.equal(ls.nextTimeAtPhase(null, 0, 1), null);
  assert.equal(ls.nextTimeAtPhase(report, 0, 1, 0), null);
});

test('sameTempo tolerates float noise only', () => {
  assert.ok(ls.sameTempo(120, 120.0004));
  assert.ok(!ls.sameTempo(120, 120.01));
  assert.ok(!ls.sameTempo(NaN, 120));
});

test('declarationMoves: a restatement yields to the session, an edit never does', () => {
  // Nothing outside poptart owns the tempo: the buffer always drives.
  assert.equal(ls.declarationMoves(120, 120, false), true);
  assert.equal(ls.declarationMoves(null, 140, false), true);
  // A session with peers: the same declaration again is a re-eval, not a gesture.
  assert.equal(ls.declarationMoves(120, 120, true), false);
  assert.equal(ls.declarationMoves(120.0000001, 120, true), false); // float noise is the same number
  // ...but an edited number is a gesture, in either direction.
  assert.equal(ls.declarationMoves(140, 120, true), true);
  assert.equal(ls.declarationMoves(119, 120, true), true);
  // The first eval of a session has nothing to restate, and a signal tempo has no one number.
  assert.equal(ls.declarationMoves(120, null, true), true);
  assert.equal(ls.declarationMoves(null, 120, true), true);
});
