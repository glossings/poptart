'use strict';

// MIDI clock out's tick train (poptart.scd's clockTickerStart), run on the MIDI worker's thread so
// nothing on the engine's own loop can make a tick late. The engine sends the host clock's mirror
// here as state - tempo and an anchor (beat b0 at time t0, on hrSec's clock) - and the ticker
// sends 24 ticks a beat, each stamped with the moment its beat falls on. It wakes `latency`
// before that moment, so a send already carries its stamp by the time it is due and the
// delivery jitter is the MIDI driver's.
//
// A pending locate lands on the next sixteenth (every 6th tick): stop, song position, continue,
// tick, all on that tick's stamp, so a sequencer relocates with no gap; from the very top (tick 0)
// a plain start. Ticks flow whether or not the transport runs: a stopped sequencer still wants the
// tempo, and a start then is a locate, not a restart.

/** Seconds on a clock every thread in this process reads alike. */
const hrSec = () => Number(process.hrtime.bigint()) / 1e9;

/** The index (24 per beat) of the first tick whose moment is after now + lead (beats). */
function clockNextTick(beats, lead) {
  return Math.floor(((beats + lead) * 24) + 1e-6) + 1;
}

class ClockTicker {
  /** send(bytes, atSec): one message for the destination, stamped `atSec` on hrSec's clock. */
  constructor({ send, now = hrSec, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this._send = send;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this.state = null; // { tempo (beats/s), b0, t0, running, latency }
    this.locate = false;
    this._timer = null;
    this._k = null;
  }

  beatsAt(t) {
    const s = this.state;
    return s.b0 + (t - s.t0) * s.tempo;
  }

  timeOfBeat(b) {
    const s = this.state;
    return s.t0 + (b - s.b0) / s.tempo;
  }

  /** The mirror moved (tempo, anchor, running): the next tick is worked out again. */
  setState(state) {
    const had = this.state != null;
    this.state = { ...this.state, ...state };
    if (!had || this._timer == null) return;
    // The waiting tick keeps its place (a tempo change, the periodic re-anchor): skipping one would
    // put a sequencer a tick behind for good, so one the new time makes due goes out at once. Only
    // a jump that leaves it further behind than one clock lead starts from the clock's new place,
    // rather than bursting out every tick in between.
    const k = this._k;
    const keep = k != null && this.timeOfBeat(k / 24) >= this._now() - this.state.latency;
    this._next(keep ? k : null);
  }

  /** Starts (or restarts) the train; `locate` relocates at the next sixteenth. */
  start({ locate = false } = {}) {
    if (locate) this.locate = true;
    if (this.state == null) return;
    this._next();
  }

  stop() {
    if (this._timer != null) this._clearTimer(this._timer);
    this._timer = null;
    this._k = null;
  }

  // The tick after `k` (the routine's logical time, so a late wake never skips one), or, with no
  // `k`, the first one still reachable from now - after a start or a move of the mirror.
  _next(k = null) {
    if (this._timer != null) this._clearTimer(this._timer);
    const s = this.state;
    const now = this._now();
    if (k == null) k = clockNextTick(this.beatsAt(now), s.latency * s.tempo);
    this._k = k;
    const wake = this.timeOfBeat(k / 24) - s.latency;
    this._timer = this._setTimer(() => this._fire(), Math.max(0, (wake - now) * 1000));
  }

  _fire() {
    this._timer = null;
    const s = this.state;
    const k = this._k;
    const at = this.timeOfBeat(k / 24);
    // A timer that woke early: not this tick's moment yet.
    if (at - s.latency > this._now() + 0.0005) { this._timer = this._setTimer(() => this._fire(), 1); return; }
    if (this.locate && s.running && k >= 0 && (k % 6) === 0) {
      this.locate = false;
      this._send([0xFC], at);
      if (k === 0) this._send([0xFA], at);
      else {
        const p = Math.floor(k / 6) % 16384;
        this._send([0xF2, p & 0x7F, (p >> 7) & 0x7F], at);
        this._send([0xFB], at);
      }
    }
    this._send([0xF8], at);
    this._next(k + 1);
  }
}

module.exports = { ClockTicker, clockNextTick, hrSec };
