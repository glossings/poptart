// Bridges a Sig (see signal.mjs) to an "engine" - any object implementing the interface used
// below (createTrack/loadInstrument/loadEffect/noteOn/noteOff/playSample/setParam/setParamLFO/
// clearParamLFO/setParamEnv/clearParamEnv/setParamCC/clearParamCC/setMidiNotes/clearMidiNotes/
// getTime).
// This class is engine-agnostic by design: it's been driven by an in-process JUCE addon and is
// now driven by an OSC-based engine talking to SuperCollider (see @poptart/osc-engine) without
// any change here. Two independent mechanisms run side by side, matching the two ways a Sig can
// carry time-varying information:
//
//  - Note edges: if the top-level pattern has known step boundaries (mini-notation-derived),
//    we know exact onset/offset times ahead of playback, the same "compute deadlines slightly
//    ahead of the audio clock" lookahead model Tidal/SuperDirt use - just operating on our own
//    plain step objects instead of Strudel Haps. Sampler patterns (sig.sampler set) go through
//    the same walk but emit playSample events (config signals sampled at each onset) instead of
//    noteOn/noteOff pairs.
//  - Parameter modulation: LFO-builder signals (`.lfoIR` set) are hinted once to the engine and
//    then run entirely on its own audio thread (see ARCHITECTURE.md's "Tier 2"). Any other
//    signal assigned to a control is polled at a fixed rate instead ("Tier 1") - simple,
//    general, and fine for musical modulation rates.

import { sampleBound } from './signal.mjs';
import { scalePitchClasses } from './notes.mjs';

const DEFAULT_LOOKAHEAD_SEC = 0.15;
const POLL_INTERVAL_MS = 30;

// Track-level channel-strip controls (Sig#gain/#pan) ride the same setParam/setParamLFO/
// setParamEnv engine calls as plugin parameters, addressed with this pseudo-slot instead of a
// chain index - the engine maps them onto the track's own output stage rather than a VST param.
const CHANNEL_SLOT = -1;
const CHANNEL_DEFAULTS = { gain: 1, pan: 0 };

/**
 * The shared clock: one Transport is owned by the host (web-app server) and read by every
 * Scheduler, so all tracks agree on where in the cycle grid "now" is. Tempo changes rebase
 * (baseSec/baseCycle move to the moment of change) so cycle position is continuous - no jump,
 * no re-trigger - and seconds<->cycles conversions stay piecewise-exact.
 *
 * setBpm accepts a number or any sampleable Sig; a signal tempo is polled and applied as a
 * stream of small rebases. BPM is interpreted as 4 beats per cycle (setBpm(120) -> 0.5 cps,
 * the historical default).
 */
export class Transport {
  constructor(getTime, { cps = 0.5 } = {}) {
    this.getTime = getTime;
    this.cps = cps;
    this._baseSec = getTime();
    this._baseCycle = 0;
    this._tempoSig = null;
    this._tempoTimer = null;
  }

  cycleAt(sec) {
    return this._baseCycle + (sec - this._baseSec) * this.cps;
  }

  secAt(cycle) {
    return this._baseSec + (cycle - this._baseCycle) / this.cps;
  }

  setCps(cps) {
    if (!(cps > 0) || !Number.isFinite(cps)) return; // ignore junk (a tempo signal mid-rest, 0, NaN)
    if (cps === this.cps) return;
    const now = this.getTime();
    this._baseCycle = this.cycleAt(now);
    this._baseSec = now;
    this.cps = cps;
  }

  /** @param {number | import('./signal.mjs').Sig} bpm - beats per minute, 4 beats per cycle. */
  setBpm(bpm) {
    if (this._tempoTimer) {
      clearInterval(this._tempoTimer);
      this._tempoTimer = null;
    }
    if (typeof bpm === 'number') {
      this._tempoSig = null;
      this.setCps(bpm / 240);
      return;
    }
    if (typeof bpm?.sample !== 'function') {
      throw new Error('[transport] setbpm() takes a number or a signal (mini string / LFO / pattern)');
    }
    if (bpm.envIR) throw new Error("[transport] setbpm() can't take an env() - it has no JS-side value");
    this._tempoSig = bpm;
    const apply = () => {
      const now = this.getTime();
      const v = this._tempoSig.sample(now, this.cps, this.cycleAt(now));
      if (typeof v === 'number') this.setCps(v / 240);
    };
    apply(); // throws (to the caller, at eval time) if the signal can't be sampled at all
    this._tempoTimer = setInterval(() => {
      try {
        apply();
      } catch (err) {
        // Same lazy-throw hazard as Scheduler#_tick: never let a tempo signal's error escape
        // the timer and kill the host. Hold the current tempo and stop polling.
        clearInterval(this._tempoTimer);
        this._tempoTimer = null;
        // eslint-disable-next-line no-console
        console.error(`[transport] tempo signal threw - holding ${this.cps * 240} bpm: ${err.message ?? err}`);
      }
    }, POLL_INTERVAL_MS);
  }

  /** Plain-data view for clients that mirror the clock (the editor's playback highlighting). */
  snapshot() {
    return { cps: this.cps, baseSec: this._baseSec, baseCycle: this._baseCycle };
  }

  dispose() {
    if (this._tempoTimer) clearInterval(this._tempoTimer);
    this._tempoTimer = null;
  }
}

export class Scheduler {
  constructor(engine, { cps = 0.5, trackId = 'default', transport = null } = {}) {
    this.engine = engine;
    this.transport = transport ?? new Transport(() => engine.getTime(), { cps });
    this.trackId = trackId;
    this.pattern = null;
    this._scheduledUntilCycle = 0;
    this._timer = null;
    this._running = false;
    this._activeModulators = new Map(); // "slot name" -> { slot, name, sig, kind: 'lfo'|'env'|'cc', dynamic }
    this._midiRouted = false; // live midikeys() route currently held engine-side
    this._prevChannelNames = []; // channel controls set by the previous pattern, for default-reset
    this._appliedStates = new Map(); // "slot:pluginId" -> state string already sent (see setPattern)
  }

  /** Every control signal the pattern carries: plugin params by slot, channel strip as slot -1. */
  _controlEntries(sig) {
    return [
      ...Object.entries(sig.paramSignals).map(([name, s]) => ({ slot: sig.paramSlots[name], name, sig: s })),
      ...Object.entries(sig.channel).map(([name, s]) => ({ slot: CHANNEL_SLOT, name, sig: s })),
    ];
  }

  setPattern(sig) {
    this.pattern = sig;
    this.engine.createTrack(this.trackId);

    if (sig.instrument) {
      this.engine.loadInstrument(this.trackId, sig.instrument);
    }
    sig.fxChain.forEach((pluginId, i) => this.engine.loadEffect(this.trackId, pluginId, i + 1));

    // Live MIDI keys (midikeys(...)): the device's note stream plays this track engine-side -
    // live input never goes through the lookahead clock, so latency stays at the MIDI driver's.
    // Idempotent re-sends on re-eval; dropping the midikeys() source tears the route down.
    if (sig.midiNotes) {
      const pcs = sig.midiNotes.scale ? scalePitchClasses(sig.midiNotes.scale) : null;
      this.engine.setMidiNotes(this.trackId, sig.midiNotes.device, sig.midiNotes.channel ?? 0, pcs);
    } else if (this._midiRouted) {
      this.engine.clearMidiNotes(this.trackId);
    }
    this._midiRouted = !!sig.midiNotes;

    // Captured plugin state (synth/fx's `{ state }` argument). Sent only when the state string
    // (or the plugin occupying the slot) actually changed - a livecoding re-eval must not make
    // the plugin re-chew a megabyte state blob every keystroke. Removing the state from the
    // code deliberately resets nothing: the plugin just keeps sounding how it sounds.
    if (typeof this.engine.setPluginState === 'function') {
      const chain = [sig.instrument, ...sig.fxChain];
      for (const [slotStr, state] of Object.entries(sig.slotStates ?? {})) {
        const slot = Number(slotStr);
        const key = `${slot}:${chain[slot]}`;
        if (this._appliedStates.get(key) === state) continue;
        this._appliedStates.set(key, state);
        this.engine.setPluginState(this.trackId, slot, state);
      }
    }

    // A channel control the new pattern dropped (`.gain(...)` deleted mid-session) snaps back
    // to its default - unlike plugin params, these have an obvious neutral value.
    for (const name of this._prevChannelNames) {
      if (!(name in sig.channel)) {
        this.engine.setParam(this.trackId, CHANNEL_SLOT, name, CHANNEL_DEFAULTS[name] ?? 0, this.engine.getTime());
      }
    }
    this._prevChannelNames = Object.keys(sig.channel);

    // Tier-2 modulators are persistent engine-side synths mapped onto the VST parameter - they
    // outlive the pattern that created them, so a re-eval must explicitly clear any that the new
    // pattern no longer carries (or whose kind changed, e.g. env -> LFO, or dropped to a Tier-1
    // polled signal, which a leftover bus mapping would fight with).
    const nextModulators = new Map();
    for (const c of this._controlEntries(sig)) {
      const kind = c.sig.lfoIR ? 'lfo' : c.sig.envIR ? 'env' : c.sig.ccIR ? 'cc' : null;
      if (kind) nextModulators.set(`${c.slot} ${c.name}`, { ...c, kind });
    }
    const clears = { lfo: 'clearParamLFO', env: 'clearParamEnv', cc: 'clearParamCC' };
    for (const [key, prev] of this._activeModulators) {
      if (nextModulators.get(key)?.kind === prev.kind) continue; // survives - updated in place below
      this.engine[clears[prev.kind]](this.trackId, prev.slot, prev.name);
    }
    this._activeModulators = nextModulators;

    // Same set-once Tier-2 contract as always: the engine runs the modulator natively from here
    // on. The one exception is signal-valued .range() bounds, which _tick re-resolves and
    // re-sends (an in-place engine-side update - phase/gate state is preserved).
    const nowSec = this.engine.getTime();
    for (const m of this._activeModulators.values()) this._sendModulator(m, nowSec, true);
  }

  /**
   * Sends a Tier-2 modulator's IR with any signal-valued bounds resolved to numbers at
   * `nowSec`. After the initial send this only re-sends when a bound actually moved (the
   * engine updates the running synth's lo/hi in place, so the modulator stays native and
   * phase-continuous while its range wanders).
   */
  _sendModulator(m, nowSec, initial = false) {
    const ir = m.sig.lfoIR ?? m.sig.envIR ?? m.sig.ccIR;
    m.dynamic = typeof ir.min !== 'number' || typeof ir.max !== 'number';
    const cps = this.transport.cps;
    const pos = this.transport.cycleAt(nowSec);
    // A resting signal bound (a mini-string bound mid-`~`) holds the last sent value; on the
    // very first send there's nothing to hold, so fall back to the unipolar default.
    const lo = sampleBound(ir.min, nowSec, cps, pos) ?? (initial ? 0 : null);
    const hi = sampleBound(ir.max, nowSec, cps, pos) ?? (initial ? 1 : null);
    if (lo == null || hi == null) return;
    if (!initial && lo === m.lastLo && hi === m.lastHi) return;
    m.lastLo = lo;
    m.lastHi = hi;
    const resolved = m.dynamic ? { ...ir, min: lo, max: hi } : ir;
    if (m.kind === 'lfo') {
      this.engine.setParamLFO(this.trackId, m.slot, m.name, resolved);
    } else if (m.kind === 'env') {
      this.engine.setParamEnv(this.trackId, m.slot, m.name, resolved);
    } else {
      this.engine.setParamCC(this.trackId, m.slot, m.name, resolved);
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._scheduledUntilCycle = this.transport.cycleAt(this.engine.getTime());
    this._timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    // A live midikeys() route plays notes engine-side with no scheduler tick involved, so
    // stopping the track (mute, stop-all, label removal) must tear it down explicitly or the
    // keyboard keeps sounding. setPattern re-establishes it on the next eval.
    if (this._midiRouted) {
      this.engine.clearMidiNotes(this.trackId);
      this._midiRouted = false;
    }
  }

  _tick() {
    if (!this.pattern) return;
    try {
      const nowSec = this.engine.getTime();
      const targetCycle = this.transport.cycleAt(nowSec + DEFAULT_LOOKAHEAD_SEC);

      this._scheduleNoteEdges(this._scheduledUntilCycle, targetCycle);
      this._scheduledUntilCycle = targetCycle;

      this._pollGenericParams(nowSec);
      for (const m of this._activeModulators.values()) {
        if (m.dynamic) this._sendModulator(m, nowSec); // signal-valued .range() bounds
      }
    } catch (err) {
      // Patterns evaluate lazily, so a bad value can first throw here, inside the timer -
      // uncaught, that would take down the whole host process. Stop just this track (also
      // avoids re-throwing every 30ms) and report; other tracks keep playing.
      this.stop();
      // eslint-disable-next-line no-console
      console.error(`[scheduler] track "${this.trackId}" stopped - pattern threw during playback: ${err.message ?? err}`);
    }
  }

  _scheduleNoteEdges(fromCycle, toCycle) {
    if (!this.pattern.stepsForCycle) return; // top-level pattern has no note structure (e.g. a bare LFO)

    for (let cycle = Math.floor(fromCycle); cycle < toCycle; cycle++) {
      for (const step of this.pattern.stepsForCycle(cycle)) {
        if (step.value == null) continue; // rest
        if (step.cont) continue; // tie/hold: the sounding event's onset was in an earlier step

        const stepStartCycle = cycle + step.start;
        const stepEndCycle = cycle + step.end;
        // Only trigger onsets newly entering the lookahead window - each tick advances
        // `fromCycle` to the previous tick's `toCycle`, so this never double-fires.
        if (stepStartCycle < fromCycle || stepStartCycle >= toCycle) continue;

        const onsetSec = this.transport.secAt(stepStartCycle);
        const offsetSec = this.transport.secAt(stepEndCycle);

        if (this.pattern.sampler) {
          const cfg = this._sampleConfigAt(onsetSec, stepStartCycle);
          let pack = String(step.value);
          // Strudel shorthand: s("bd:4") = s("bd").i(4). An explicit .i() wins over the suffix.
          const m = /^(.+):(-?\d+)$/.exec(pack);
          if (m) {
            pack = m[1];
            if (cfg.index === undefined) cfg.index = Number(m[2]);
          }
          this.engine.playSample(this.trackId, pack, cfg, onsetSec, offsetSec);
        } else {
          const midiNote = Math.round(step.value);
          let velocity = 1.0;
          if (this.pattern.velSig) {
            const v = this.pattern.velSig.sample(onsetSec, this.transport.cps, stepStartCycle);
            if (typeof v === 'number' && !Number.isNaN(v)) velocity = v;
            if (velocity <= 0) continue;
          }
          this.engine.noteOn(this.trackId, midiNote, Math.min(1, velocity), onsetSec);
          this.engine.noteOff(this.trackId, midiNote, offsetSec);
        }
      }
    }
  }

  // Sampler config signals evaluated at one event's onset. `fit: 'auto'` passes through as-is
  // (the engine resolves it against the sample's length); everything else becomes a number or
  // stays undefined for the engine's default.
  _sampleConfigAt(onsetSec, onsetCycle) {
    const cfg = { secPerCycle: 1 / this.transport.cps };
    const at = (sig) => {
      const v = sig.sample(onsetSec, this.transport.cps, onsetCycle);
      return typeof v === 'number' ? v : v == null ? undefined : Number(v);
    };
    const src = this.pattern.sampler;
    for (const key of ['index', 'begin', 'end', 'loop', 'speed', 'stretch', 'slice', 'note', 'vel']) {
      if (src[key]) {
        const v = at(src[key]);
        if (v !== undefined && !Number.isNaN(v)) cfg[key] = v;
      }
    }
    if (src.fit === 'auto') {
      cfg.fit = 'auto';
    } else if (src.fit) {
      const v = at(src.fit);
      if (v !== undefined && !Number.isNaN(v)) cfg.fit = v;
    }
    return cfg;
  }

  _pollGenericParams(nowSec) {
    for (const c of this._controlEntries(this.pattern)) {
      if (c.sig.lfoIR || c.sig.envIR || c.sig.ccIR) continue; // native Tier 2 already owns this, set once in setPattern()
      const value = c.sig.sample(nowSec, this.transport.cps, this.transport.cycleAt(nowSec));
      if (typeof value === 'number') {
        this.engine.setParam(this.trackId, c.slot, c.name, value, nowSec + DEFAULT_LOOKAHEAD_SEC);
      }
    }
  }
}
