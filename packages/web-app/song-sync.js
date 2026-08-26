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

// One transport cycle is four beats everywhere in poptart (setbpm's own convention), so a song's
// bar and the clock's cycle are the same length once its rate is locked to master.
const BEATS_PER_CYCLE = 4;

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

/**
 * The tempo ratio a sync locks a song to, relative to the CLOCK: 1 beat-matches (the song's
 * beats on the clock's beats), ½ is half-time (one song beat every two clock beats - a 70 bpm
 * song under a 140 clock plays at its own speed), 2 is double-time. 'auto' picks whichever of
 * the three brings the playing rate nearest ×1; a pinned ratio (0.5 | 1 | 2) is taken as is.
 *
 * Read it as "this song runs at <ratio> × the clock's tempo". (Until 2026-08-26 the number
 * meant the opposite - a multiplier on the song's own bpm - so ½ played a track double speed.)
 */
function syncOctave(masterBpm, nativeBpm, mult = 'auto') {
  if (mult === 0.5 || mult === 1 || mult === 2) return mult;
  if (!Number.isFinite(masterBpm) || !Number.isFinite(nativeBpm) || nativeBpm <= 0 || masterBpm <= 0) return 1;
  let best = 1;
  let bestErr = Infinity;
  for (const m of [0.5, 1, 2]) {
    const err = Math.abs(Math.log((masterBpm * m) / nativeBpm));
    if (err < bestErr - 1e-9) {
      bestErr = err;
      best = m;
    }
  }
  return best;
}

/** rate = (master × ratio) / native, clamped. Null when the song's native tempo isn't known. */
function syncRate(masterBpm, nativeBpm, mult = 'auto') {
  if (!Number.isFinite(masterBpm) || !Number.isFinite(nativeBpm) || nativeBpm <= 0 || masterBpm <= 0) return null;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, (masterBpm * syncOctave(masterBpm, nativeBpm, mult)) / nativeBpm));
}

/** The playing rate: base with the momentary nudge (hold = -1 | 0 | 1) applied. */
function effectiveRate(baseRate, nudgeHold = 0) {
  return baseRate * (1 + NUDGE_PCT * Math.sign(nudgeHold || 0));
}

/**
 * Snap a song position to its own grid (anchorSec + k * `beats` beats). With a cycle-quantized
 * start this is what makes the song's beats land ON the transport's: the start fires at a cycle
 * boundary, and the material entering at that moment is a gridpoint.
 *
 * `beats` is the resolution: 1 beat-matches, BEATS_PER_CYCLE bar-matches. A song joining a
 * running clock wants the bar - the boundary it is landing on is a whole cycle, so a
 * beat-snapped entry is in time but up to half a bar out of phrase (which is what the jog was
 * left to fix by hand).
 *
 * The result stays ON the grid: when the nearest gridpoint falls outside the file we step to the
 * first one inside it rather than clamping to the edge, because a clamped entry is exactly the
 * misalignment this function exists to prevent.
 */
function snapToGrid(posSec, bpm, anchorSec = 0, durationSec = Infinity, beats = 1) {
  if (!Number.isFinite(bpm) || bpm <= 0 || !(beats > 0)) return posSec;
  const step = (60 / bpm) * beats;
  let snapped = anchorSec + Math.round((posSec - anchorSec) / step) * step;
  if (snapped < 0) snapped += step;
  if (snapped > durationSec) snapped -= step;
  return snapped > 0 ? snapped : 0; // a file shorter than one step has no gridpoint to take
}

/**
 * The song position nearest `posSec` whose bar phase is `phase01` (0 = a downbeat, 0.25 = beat
 * two, ...). A deck joining a running clock starts on the clock's next BEAT boundary - a wait
 * of at most one beat, not a whole bar - and this picks the entry point so that the song's bar
 * phase matches the clock's at that moment: bar-aligned, without the wait. Stays inside the
 * file by stepping a whole bar, never by clamping (see snapToGrid).
 */
function alignToGrid(posSec, bpm, anchorSec = 0, durationSec = Infinity, phase01 = 0) {
  if (!Number.isFinite(bpm) || bpm <= 0) return posSec;
  const bar = (60 / bpm) * BEATS_PER_CYCLE;
  const u = (posSec - anchorSec) / bar - phase01;
  let snapped = anchorSec + (Math.round(u) + phase01) * bar;
  if (snapped < 0) snapped += bar;
  if (snapped > durationSec) snapped -= bar;
  return snapped > 0 ? snapped : 0;
}

/**
 * Where a song position sits inside its own bar, as a fraction of a cycle. This is the phase a
 * deck hands the transport when it takes the grid over (see Transport#startAt): the clock's
 * cycle boundaries become the song's bar lines, so every later start that quantizes to a cycle
 * lands on this song's downbeat. Bars are counted from the anchor - the downbeat the user cued.
 */
function gridPhase(posSec, bpm, anchorSec = 0, beats = BEATS_PER_CYCLE) {
  if (!Number.isFinite(bpm) || bpm <= 0 || !(beats > 0)) return 0;
  const bars = (posSec - anchorSec) / ((60 / bpm) * beats);
  return bars - Math.floor(bars);
}

/**
 * The drift servo's trim for one position report: err = actual - expected (song-seconds).
 * Returns the rate delta to add engine-side (Node's model keeps the untrimmed rate - the trim
 * exists precisely to make the engine converge on the model). An engine AHEAD of the model
 * (positive err) has to slow down, so the trim is the negative of the error. null means the
 * error is too big to trim: the caller should put the engine back on the model instead.
 *
 * (The sign was backwards until 2026-08-26: an engine a hair ahead was sped up, the error grew
 * exponentially to the hard threshold in ~80s, and every synced deck fell out of phase by a
 * quarter of a second at that moment - "in time, then suddenly not".)
 */
function servoTrim(errSec) {
  if (!Number.isFinite(errSec)) return 0;
  if (Math.abs(errSec) > SERVO_HARD_SEC) return null;
  if (Math.abs(errSec) < SERVO_DEAD_SEC) return 0;
  return -Math.min(SERVO_MAX, Math.max(-SERVO_MAX, errSec / SERVO_CLOSE_SEC));
}

module.exports = {
  syncRate, syncOctave, effectiveRate, snapToGrid, alignToGrid, gridPhase, servoTrim,
  NUDGE_PCT, RATE_MIN, RATE_MAX, SERVO_HARD_SEC, BEATS_PER_CYCLE,
};
