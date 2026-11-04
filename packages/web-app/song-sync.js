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

// Platter pitch-bend (the `bend` MIDI target): a wheel turn while the deck plays bends the rate
// with how fast the wheel is turning, and the deck is back on its base rate the moment the hand
// stops - the beatmatch-correction gesture. The playhead model rides the bent rate
// (songApplyRate rebases on every change), so what a bend leaves behind is exactly the phase it
// moved - the correction sticks, synced or not, and the drift servo has nothing to undo.
//
// The wheel's speed is read as a record's: v is its revolutions a second over a 33 1/3 rpm
// platter's, so v 1 is the record's own speed. A turn slower than half that (BEND_MIN_SPEED)
// does not bend; past it the bend is 3% per v (BEND_PER_SPEED), up to 42% (BEND_MAX) - added to
// the tempo ratio, not multiplied with it (see effectiveRate). A revolution is the controller's
// own number of ticks: a binding's `ticksPerRev`, else its port's entry in JOG_TICKS_BY_DEVICE,
// else JOG_TICKS_PER_REV.
const JOG_TICKS_PER_REV = 2048;

// Known platter resolutions by MIDI input port name: the first entry whose `match` is found in
// the port name (case-insensitive) gives the ticks a revolution sends. A binding keeps the port
// name it was learned on, so a re-learn finds the same entry. Add controllers here.
const JOG_TICKS_BY_DEVICE = [
  { match: 'ddj-flx4', ticksPerRev: 720 },
];

/** Ticks per revolution for a MIDI input port name: a table match, else JOG_TICKS_PER_REV. */
function ticksPerRevForDevice(device) {
  const name = typeof device === 'string' ? device.toLowerCase() : '';
  const hit = name && JOG_TICKS_BY_DEVICE.find((d) => name.includes(d.match));
  return hit ? hit.ticksPerRev : JOG_TICKS_PER_REV;
}
const PLATTER_REV_PER_SEC = 100 / 3 / 60;
const BEND_MIN_SPEED = 0.5;
const BEND_PER_SPEED = 0.03;
const BEND_MAX = 0.42;

/** The bend (a rate offset) for a platter speed `v` (1 = record speed, signed). */
function bendForSpeed(v) {
  if (!Number.isFinite(v) || Math.abs(v) <= BEND_MIN_SPEED) return 0;
  return Math.sign(v) * Math.min(BEND_MAX, BEND_PER_SPEED * Math.abs(v));
}

/**
 * One flush of the platter: `revs` revolutions turned (signed) in the `dtSec` since the last
 * flush, and `carry`, the half of the last flush's turn held over for this one - each turn is
 * spread over two flushes, so the speed reads steadily from batches whose tick counts jitter.
 * Returns the bend and the carry for the next flush. Pure, so the flush timer's cadence is all
 * the caller owns; both are 0 once the wheel has rested a whole flush.
 */
function bendStep(carry, revs, dtSec) {
  const held = Number.isFinite(carry) ? carry : 0;
  const half = (Number.isFinite(revs) ? revs : 0) / 2;
  if (!(dtSec > 0)) return { bend: 0, carry: held + half };
  return { bend: bendForSpeed((held + half) / dtSec / PLATTER_REV_PER_SEC), carry: half };
}

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

/**
 * The playing rate: base with the momentary nudge (hold = -1 | 0 | 1) applied and the platter
 * bend added. A bend stays inside the deck's tempo range (±rangePct% around 1) - but never moves
 * a base that is already outside it (a synced deck far from its own tempo), only stops there.
 */
function effectiveRate(baseRate, nudgeHold = 0, bend = 0, rangePct = Infinity) {
  const nudged = baseRate * (1 + NUDGE_PCT * Math.sign(nudgeHold || 0));
  if (!Number.isFinite(bend) || bend === 0) return nudged;
  const r = Number.isFinite(rangePct) && rangePct > 0 ? rangePct / 100 : Infinity;
  return Math.min(Math.max(nudged, 1 + r), Math.max(Math.min(nudged, 1 - r), nudged + bend));
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

// How far past a lap point a playhead may be and still wrap at once: a 32nd of a beat.
const LOOP_WRAP_SLACK_BEATS = 1 / 32;

/**
 * Where a song deck's loop next wraps: { atSec, toSec } - the playhead position (song seconds)
 * at which to seek, and where to seek to.
 *
 * Inside the loop that is its end, back to its start. A playhead already PAST the end (a loop
 * halved after the playhead left its new first half) waits for the next lap point - the start
 * plus a whole number of loop lengths - so the jump lands in phase with the loop instead of
 * mid-beat. Within LOOP_WRAP_SLACK_BEATS after a lap point it wraps at once, landing that far
 * into the loop so the phase still holds.
 */
function loopWrap(posSec, from, to, beatSec) {
  const span = to - from;
  if (!(span > 0) || !(posSec > to)) return { atSec: to, toSec: from };
  let laps = Math.floor((posSec - from) / span);
  let past = posSec - (from + laps * span);
  if (span - past < 1e-9) { laps += 1; past = 0; } // on a lap point, to rounding
  if (past <= LOOP_WRAP_SLACK_BEATS * (beatSec > 0 ? beatSec : 0)) return { atSec: posSec, toSec: from + past };
  return { atSec: from + (laps + 1) * span, toSec: from };
}

const exported = {
  syncRate, syncOctave, effectiveRate, bendStep, bendForSpeed, snapToGrid, alignToGrid, gridPhase, servoTrim, loopWrap,
  NUDGE_PCT, JOG_TICKS_PER_REV, JOG_TICKS_BY_DEVICE, ticksPerRevForDevice, PLATTER_REV_PER_SEC, BEND_MIN_SPEED, BEND_PER_SPEED, BEND_MAX,
  RATE_MIN, RATE_MAX, SERVO_HARD_SEC, BEATS_PER_CYCLE,
};

// Shared with the browser build, which loads this file as a module of its own (see build-web.mjs)
// and finds the same functions on globalThis - the desktop server require()s it as before.
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
else globalThis.poptartSongSync = exported;
