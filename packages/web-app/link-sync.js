'use strict';

// The pure math behind following a Link session (see server.js's link section). Link shares
// tempo and bar phase between peers on the network; the poptart-link helper (osc-engine's
// link.js) is the peer, and reports the session's (tempo, beat at a moment) to Node. This module
// turns such a report into what the shared Transport should do about it. Kept engine-free so it
// is testable like song-sync.js.
//
// One transport cycle is one Link bar: setbpm's four beats per cycle is Link's default quantum.
const QUANTUM_BEATS = 4;

// A measured phase difference under DEAD is noise (OSC transit, timer quantization) and is left
// alone. Up to SOFT it is drift between the two clocks and is trimmed silently: under one MIDI
// clock tick (1/96 of a cycle), so a tick train riding the transport never skips or doubles.
// Beyond SOFT the two clocks disagree about where the bar is, which is a decision, not a trim.
const DEAD_CYCLES = 0.0005;
const SOFT_CYCLES = 0.01;

/** Fold a cycle difference into [-0.5, 0.5]: the shorter way round the bar. */
function wrapHalf(x) {
  return x - Math.round(x);
}

/** Where in the bar a session beat count is, as a cycle fraction in [0, 1). */
function sessionPhase(beats) {
  return (((beats % QUANTUM_BEATS) + QUANTUM_BEATS) % QUANTUM_BEATS) / QUANTUM_BEATS;
}

/** The session's beat count at `sec`, extrapolated from a report {bpm, beats, atSec}. */
function sessionBeatsAt(report, sec) {
  return report.beats + (sec - report.atSec) * (report.bpm / 60);
}

/**
 * How far the transport's phase is from the session's, in cycles, the shorter way round: the
 * shift that would put the transport's bar line on the session's.
 */
function phaseDelta(cycle, beats) {
  return wrapHalf(sessionPhase(beats) - (cycle - Math.floor(cycle)));
}

/**
 * One follow step. `measured` is phaseDelta now; `offset` is the phase relation already
 * accepted (0 = on the session's bar; a DJ deck that took the grid mid-set may sit anywhere).
 * Returns what to do: shift the transport by `shift` cycles, and carry `offset` forward.
 *
 *   none   - within noise
 *   trim   - sub-tick drift, closed silently
 *   adopt  - a real disagreement and the caller allows a jump: land on the session's bar
 *   accept - a real disagreement the caller won't jump for: keep the relation we have
 */
function followStep(measured, offset, { mayAdopt = false } = {}) {
  const err = wrapHalf(measured - offset);
  if (Math.abs(err) <= DEAD_CYCLES) return { kind: 'none', shift: 0, offset };
  if (Math.abs(err) <= SOFT_CYCLES) return { kind: 'trim', shift: err, offset };
  if (mayAdopt) return { kind: 'adopt', shift: measured, offset: 0 };
  return { kind: 'accept', shift: 0, offset: wrapHalf(offset + err) };
}

/**
 * The first moment at or after `notBeforeSec` when the session sits at bar phase `phase`
 * (cycle fraction). The session is taken to run at the report's tempo up to `fromSec` (now)
 * and at `bpmAhead` after it - a song deck about to push its own tempo passes that tempo, so
 * the bar it lands on is where the session's bars will be once the push lands.
 */
function nextTimeAtPhase(report, phase, notBeforeSec, bpmAhead = report?.bpm, fromSec = notBeforeSec) {
  if (!report || !(bpmAhead > 0) || !(report.bpm > 0)) return null;
  const beats = beatsAtSplit(report, notBeforeSec, bpmAhead, fromSec);
  const want = phase * QUANTUM_BEATS;
  let target = Math.floor(beats / QUANTUM_BEATS) * QUANTUM_BEATS + want;
  if (target < beats - 1e-9) target += QUANTUM_BEATS;
  return notBeforeSec + (target - beats) / (bpmAhead / 60);
}

function beatsAtSplit(report, sec, bpmAhead, fromSec) {
  const from = Math.max(report.atSec, Math.min(fromSec, sec));
  return sessionBeatsAt(report, from) + (sec - from) * (bpmAhead / 60);
}

/**
 * Should an eval's tempo declaration move the clock? `declared` is what this eval asks for (its
 * setbpm number, or the default for a buffer that says nothing; null for a signal tempo, which
 * has no single number to restate), `previous` what the last eval asked for, and
 * `sessionOwnsTempo` whether something outside poptart is entitled to the tempo right now (a
 * Link session with peers in it).
 *
 * A restatement is not a gesture. Re-running a buffer whose setbpm has not changed - or that
 * never had one - must leave a peer's tempo alone, or every Cmd+Enter would snap the room back
 * to the code's declaration. Editing the number is a gesture and always moves the clock.
 */
function declarationMoves(declared, previous, sessionOwnsTempo) {
  if (!sessionOwnsTempo) return true;
  if (declared == null || previous == null) return true; // a signal tempo, or nothing declared yet
  return Math.abs(declared - previous) >= 1e-6;
}

function sameTempo(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
}

module.exports = {
  QUANTUM_BEATS,
  DEAD_CYCLES,
  SOFT_CYCLES,
  wrapHalf,
  sessionPhase,
  sessionBeatsAt,
  phaseDelta,
  followStep,
  nextTimeAtPhase,
  declarationMoves,
  sameTempo,
};
