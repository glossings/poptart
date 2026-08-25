'use strict';

// The pure math behind a song deck's tempo sync (songs phase 4): the rate a synced deck should
// run at, the beat-snap for quantized starts, the nudge offsets, and the drift servo's trim
// law. server.js's /api/song/* handlers apply these; keeping them here keeps them testable
// without an engine.

// A synced song's rate never leaves this window - a wildly mismatched pairing (a 70 bpm ballad
// under a 174 clock) still plays *something* recognizable, and the clamp is visible in the
// pane's rate readout rather than silently exact.
const RATE_MIN = 0.25;
const RATE_MAX = 4;

// Momentary nudge: the classic platter push/drag, ±4% while held.
const NUDGE_PCT = 0.04;

// Drift servo: |err| below the deadband is measurement noise (the report quantizes to control
// blocks); above HARD seconds it isn't drift, it's a dropout - adopt reality instead of chasing
// it. In between, trim rate to close the error over ~8s, capped so the correction itself is
// never audible (0.3% is well under nudge).
const SERVO_DEAD_SEC = 0.015;
const SERVO_HARD_SEC = 0.25;
const SERVO_CLOSE_SEC = 8;
const SERVO_MAX = 0.003;

/** rate = master/native, clamped. Null when the song's native tempo isn't known. */
function syncRate(masterBpm, nativeBpm) {
  if (!Number.isFinite(masterBpm) || !Number.isFinite(nativeBpm) || nativeBpm <= 0 || masterBpm <= 0) return null;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, masterBpm / nativeBpm));
}

/** The playing rate: base with the momentary nudge (hold = -1 | 0 | 1) applied. */
function effectiveRate(baseRate, nudgeHold = 0) {
  return baseRate * (1 + NUDGE_PCT * Math.sign(nudgeHold || 0));
}

/**
 * Snap a song position to its own beatgrid (anchorSec + k * beat), clamped to the file. With a
 * cycle-quantized start this is what makes the song's beats land ON the transport's: the start
 * fires at a cycle boundary, and the material entering at that moment is a grid beat.
 */
function snapToBeat(posSec, bpm, anchorSec = 0, durationSec = Infinity) {
  if (!Number.isFinite(bpm) || bpm <= 0) return posSec;
  const beat = 60 / bpm;
  const snapped = anchorSec + Math.round((posSec - anchorSec) / beat) * beat;
  return Math.min(Math.max(0, snapped), durationSec);
}

/**
 * The drift servo's trim for one position report: err = actual - expected (song-seconds).
 * Returns the rate delta to add engine-side (Node's model keeps the untrimmed rate - the trim
 * exists precisely to make the engine converge on the model). null means the error is too big
 * to trim: the caller should adopt the reported position instead.
 */
function servoTrim(errSec) {
  if (!Number.isFinite(errSec)) return 0;
  if (Math.abs(errSec) > SERVO_HARD_SEC) return null;
  if (Math.abs(errSec) < SERVO_DEAD_SEC) return 0;
  return Math.min(SERVO_MAX, Math.max(-SERVO_MAX, errSec / SERVO_CLOSE_SEC));
}

module.exports = { syncRate, effectiveRate, snapToBeat, servoTrim, NUDGE_PCT, RATE_MIN, RATE_MAX, SERVO_HARD_SEC };
