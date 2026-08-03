// Bridges a Sig (see signal.mjs) to an "engine" - any object implementing the interface used
// below (createTrack/loadInstrument/loadEffect/noteOn/noteOff/noteOnSlot (optional)/noteOffSlot
// (optional)/playSample/setParam/setParamLFO/clearParamLFO/anchorParamLFO (optional)/setParamEnv/
// clearParamEnv/setParamCC/clearParamCC/setMidiNotes/clearMidiNotes/getTime, and - all optional -
// setInputSource/clearInputSource/injectAudio/clearAudioInject/injectMidi/clearMidiInject for the
// midi()/audio() source + injector routing).
// This class is engine-agnostic by design: anything implementing that interface works
// unchanged - the OSC engine talking to SuperCollider (see @poptart/osc-engine) is the one in
// use. Two independent mechanisms run side by side, matching the two ways a Sig can carry
// time-varying information:
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

import { sampleBound, LOOP_MODES, loopModeAt, channelAt, soundingEnd } from './signal.mjs';
import { scalePitchClasses } from './notes.mjs';

const DEFAULT_LOOKAHEAD_SEC = 0.15;
const POLL_INTERVAL_MS = 30;

// Free-running Tier-2 LFOs execute on the audio device's sample clock, which ticks at a
// slightly different rate than the wall clock the note grid is scheduled against (tens of ppm
// - milliseconds of skew per minute). Left alone they audibly drift out of the groove over a
// long session, so the scheduler re-anchors each one's phase to the transport clock this
// often, via a timestamped bundle (engine.anchorParamLFO). Each correction is only the skew
// accumulated since the last anchor - microseconds - so it's inaudible; the target phase is
// the same wall-clock formula sampleLfoIR uses, so Tier-1 and Tier-2 samplings of one signal
// agree too. Note-gated shapes (retrigger/envelope lfo() modes) and rand keep their own time.
const LFO_ANCHOR_INTERVAL_SEC = 4;

// MIDI noteOffs are pulled this much earlier than the step grid says. Back-to-back events on
// the same pitch (legato lines, clip N on every-Nth-step patterns) put one event's noteOff and
// the next's noteOn at the exact same target time; they travel as separate OSC messages whose
// engine-side execution order is jitter-dependent, and off-after-on silences the new voice at
// birth. A few ms of daylight makes the ordering deterministic and is inaudible as a release.
const NOTE_OFF_EARLY_SEC = 0.005;

// Track-level channel-strip controls (Sig#gain/#pan) ride the same setParam/setParamLFO/
// setParamEnv engine calls as plugin parameters, addressed with this pseudo-slot instead of a
// chain index - the engine maps them onto the track's own output stage rather than a VST param.
const CHANNEL_SLOT = -1;
const CHANNEL_DEFAULTS = { gain: 1, pan: 0, out: 1, dry: 1 }; // out = stereo pair (Sig#o), 1-based; dry = direct-output level (Sig#dry)
// Engine call that tears down each kind of Tier-2 modulator (persistent engine-side synth).
const MODULATOR_CLEARS = { lfo: 'clearParamLFO', env: 'clearParamEnv', cc: 'clearParamCC' };

// Chain size, mirroring the engine (slot 0 = instrument, 1..MAX_CHAIN_SLOTS-1 = effects).
const MAX_CHAIN_SLOTS = 8;

// ---------------------------------------------------------------------------------------------
// Sig#log() - one console line per event a flagged pattern fires.
// ---------------------------------------------------------------------------------------------

// Where those lines go. The default is this process's console (all a standalone host has);
// web-app replaces it with a sink that ships them to the browser instead, so they land in the
// editor's own console and in devtools rather than in the server's stdout (see server.js).
// eslint-disable-next-line no-console
let eventLogger = (line) => console.log(line);

/** @param {(line: string) => void | null} fn - null restores the plain console sink. */
export function setEventLogger(fn) {
  // eslint-disable-next-line no-console
  eventLogger = typeof fn === 'function' ? fn : (line) => console.log(line);
}

// Numbers a human is going to read off a moving log: enough precision to see a fit rate is 1.006
// rather than 1, no float dust.
const num = (v, digits = 4) =>
  typeof v === 'number' && Number.isFinite(v) ? String(Number(v.toFixed(digits))) : String(v);
const cyc = (v) => v.toFixed(3);

/**
 * One sampler event, as read by a human hunting silence. `cfg` is what the pattern asked for
 * (see _sampleConfigAt); `info` is what the engine resolved it to (see OscEngine#playSample) -
 * the fit rate and the window's length in seconds live only there, since they depend on the
 * sample file. An engine that reports nothing back just logs the requested config.
 *
 * The last field is the point of the whole thing: `dur=<audio>c/<event>c` is how much audio the
 * begin..end window holds against how long the event is. `gap=` means the window ran out early
 * and the rest of the event is silence; `cut` means the opposite - the window outlasts the event
 * and gets gated off at its end.
 */
function formatSampleEvent(pack, cfg, info, eventCycles) {
  // Resolved values where the engine reported them, the pattern's request (and the engine-side
  // defaults it would apply) otherwise - an engine that returns nothing still logs a full line,
  // just without the fields only it can know.
  const res = info && !info.skipped ? info : {};
  const idx = res.index ?? cfg.index ?? 0;
  const begin = res.begin ?? cfg.begin ?? 0;
  const end = res.end ?? cfg.end ?? 1;
  const speed = res.speed ?? cfg.speed ?? 1;
  const loop = res.loop ?? cfg.loop ?? 0;
  const stretch = res.stretch ?? cfg.stretch ?? 1;
  const bits = [`s=${pack}`, `i=${num(idx)}`, `begin=${num(begin)}`, `end=${num(end)}`, `speed=${num(speed)}`];
  if (loop) {
    // Which region it loops round and how it turns over - the modes are half of what a loop
    // sounds like, so a bare "loop" would leave the line ambiguous. Named rather than numbered
    // here: the engine reports names, and a mode number in a log line says nothing on its own.
    const mode = (key) => {
      const v = res[key] ?? cfg[key];
      if (v == null) return LOOP_MODES[key][0];
      return typeof v === 'string' ? v : LOOP_MODES[key][loopModeAt(key, v)];
    };
    const dir = mode('loopDir');
    bits.push(`loop=${mode('loopWrap')}${dir === 'pingpong' ? '+pingpong' : ''}`);
  }
  if (stretch !== 1) bits.push(`stretch=${num(stretch)}`);
  if (cfg.vel !== undefined) bits.push(`vel=${num(cfg.vel)}`);
  if (cfg.note !== undefined) bits.push(`note=${num(cfg.note)}`);
  if (cfg.slice !== undefined) bits.push(`slice=${num(cfg.slice)}`);
  for (const [key, dflt] of [['attack', 0], ['decay', 0], ['sustain', 1], ['release', 0]]) {
    if (cfg[key] !== undefined && cfg[key] !== dflt) bits.push(`${key}=${num(cfg[key])}`);
  }
  if (info?.skipped) {
    bits.push(`SILENT (${info.skipped})`);
    return bits.join(' ');
  }
  if (res.durSec !== undefined && cfg.secPerCycle > 0) {
    const audioCycles = res.durSec / cfg.secPerCycle;
    bits.push(`dur=${num(audioCycles, 3)}c/${num(eventCycles, 3)}c`);
    if (res.cut) bits.push('cut');
    else if (!loop && audioCycles < eventCycles - 1e-4) bits.push(`gap=${num(eventCycles - audioCycles, 3)}c`);
  }
  return bits.join(' ');
}

/** One synth note event. Params/LFOs/fx aren't here - they're streams, not per-event values. */
function formatNoteEvent(midiNote, vel) {
  return `note=${midiNote} vel=${num(vel)}${vel <= 0 ? ' SILENT (vel 0)' : ''}`;
}

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
  constructor(getTime, { cps = 0.5, paused = false } = {}) {
    this.getTime = getTime;
    this.cps = cps;
    this._baseSec = getTime();
    this._baseCycle = 0;
    this._paused = paused;
    this._tempoSig = null;
    this._tempoTimer = null;
    // Fired after every effective tempo change (with the new cps). The host uses it to mirror
    // the tempo out to listeners beyond the schedulers - e.g. web-app forwards it to the
    // engine so VST-internal synced LFOs/delays follow setbpm (see server.js).
    this.onCpsChange = null;
  }

  cycleAt(sec) {
    if (this._paused) return this._baseCycle;
    return this._baseCycle + (sec - this._baseSec) * this.cps;
  }

  secAt(cycle) {
    return this._baseSec + (cycle - this._baseCycle) / this.cps;
  }

  get paused() {
    return this._paused;
  }

  /** Freeze the clock and rewind to cycle 0. Tempo (cps) survives; only position resets. */
  stop() {
    this._paused = true;
    this._baseCycle = 0;
    this._baseSec = this.getTime();
  }

  /** Un-freeze: the clock advances again from wherever it sits (cycle 0 after stop()). */
  start() {
    if (!this._paused) return;
    this._baseSec = this.getTime();
    this._paused = false;
  }

  setCps(cps) {
    if (!(cps > 0) || !Number.isFinite(cps)) return; // ignore junk (a tempo signal mid-rest, 0, NaN)
    if (cps === this.cps) return;
    const now = this.getTime();
    this._baseCycle = this.cycleAt(now);
    this._baseSec = now;
    this.cps = cps;
    if (typeof this.onCpsChange === 'function') this.onCpsChange(cps);
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
    return { cps: this.cps, baseSec: this._baseSec, baseCycle: this._baseCycle, paused: this._paused };
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
    // Channel controls set by the previous pattern, so a re-eval that drops one snaps it back to
    // its default. Seeded with every known control (not []) because the engine track outlives this
    // Scheduler: a label removed and re-added (or muted then unmuted) gets a fresh Scheduler on a
    // synth still holding the old pattern's gain/pan/dry/out, so the first setPattern must reset any
    // control the new pattern doesn't set - e.g. a track that had .bsend() (dry=0) coming back must
    // return to dry=1. Same reasoning as clearing all trailing fx slots rather than diffing.
    this._prevChannelNames = Object.keys(CHANNEL_DEFAULTS);
    this._prevAudioInjectSlots = new Set(); // fx slots the previous pattern audio-injected, for teardown
    this._prevMidiInjectSlots = new Set(); // fx slots the previous pattern MIDI-injected (named sources)
    this._prevInputSource = null; // live head input (midi()/audio() source) the previous pattern held
    this._busRouted = false; // track output currently diverted to a named bus (see Sig#bus)
    this._appliedStates = new Map(); // "slot:pluginId" -> state string already sent (see setPattern)
  }

  /** Every control signal the pattern carries: plugin params by slot, channel strip as slot -1. */
  _controlEntries(sig) {
    return [
      ...Object.entries(sig.paramSignals).map(([name, s]) => ({ slot: sig.paramSlots[name], name, sig: s })),
      ...Object.entries(sig.channel).map(([name, s]) => ({ slot: CHANNEL_SLOT, name, sig: s })),
    ];
  }

  // Records a state as already live in the plugin, without sending it. Auto-pin captures a state
  // *from* a plugin and writes it into the code; when that code is next evaluated the `{ state }`
  // argument looks new to setPattern, which would send it straight back and make the plugin
  // reload a state it already has. Only a just-captured state may be marked this way - anything
  // the user typed, pasted, or loaded from a URL still has to be sent.
  markStateApplied(slot, pluginId, state) {
    if (pluginId == null) return;
    this._appliedStates.set(`${slot}:${pluginId}`, state);
  }

  setPattern(sig) {
    this.pattern = sig;
    this.engine.createTrack(this.trackId);

    if (sig.instrument) {
      this.engine.loadInstrument(this.trackId, sig.instrument);
    }
    sig.fxChain.forEach((pluginId, i) => this.engine.loadEffect(this.trackId, pluginId, i + 1));

    // An .fx(...) removed from the code must actually stop sounding (and release its plugin):
    // empty every slot past the new chain's end. All trailing slots are cleared, not a diff
    // against this Scheduler's previous pattern, because the engine-side track outlives the
    // Scheduler - a label removed and later re-added gets a fresh Scheduler on the same track,
    // stale plugins and all. Emptying an already-empty slot is a no-op engine-side. The
    // applied-state cache for a vacated slot goes too: the closed plugin lost its state, so a
    // re-added `{ state }` must be re-sent even if the string is unchanged.
    if (typeof this.engine.unloadEffect === 'function') {
      for (let slot = sig.fxChain.length + 1; slot < MAX_CHAIN_SLOTS; slot++) {
        this.engine.unloadEffect(this.trackId, slot);
        for (const key of this._appliedStates.keys()) {
          if (key.startsWith(`${slot}:`)) this._appliedStates.delete(key);
        }
      }
    }

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

    // A channel control the new pattern dropped (`.gain(...)` deleted mid-session, or `.bsend()`
    // removed - which drops dry) snaps back to its default. Schedule the reset at the lookahead
    // horizon, NOT at getTime(): the last poll before this eval already queued the OLD value at
    // nowSec+lookahead, so a reset sent at "now" gets overwritten ~150ms later by that stale
    // in-flight value - for dry=0 that leaves the track silent forever. Matching the poll horizon
    // (and being sent afterwards) makes the reset land at/after the stale value and win.
    const resetSec = this.engine.getTime() + DEFAULT_LOOKAHEAD_SEC;
    for (const name of this._prevChannelNames) {
      if (!(name in sig.channel)) {
        this.engine.setParam(this.trackId, CHANNEL_SLOT, name, CHANNEL_DEFAULTS[name] ?? 0, resetSec);
      }
    }
    this._prevChannelNames = Object.keys(sig.channel);

    // Live head input from the midi()/audio() source builders (Sig#inputSource): play a named
    // MIDI source on this track's instrument, or feed a named audio source into the chain input.
    // The engine resolves the name to a track or a device. Dropped on re-eval when it's gone.
    if (typeof this.engine.setInputSource === 'function') {
      const src = sig.inputSource;
      if (src) {
        const pcs = src.scale ? scalePitchClasses(src.scale) : null;
        this.engine.setInputSource(this.trackId, src.io, src.name, src.channel ?? 0, pcs);
      } else if (this._prevInputSource) {
        this.engine.clearInputSource(this.trackId);
      }
      this._prevInputSource = sig.inputSource ?? null;
    }

    // Output-to-bus sends (Sig#bus): feed this track's output to one or more named buses (summing
    // with any other track on the same name), read back elsewhere via audio("name"). Replaced
    // wholesale each eval and torn down when the pattern drops .bus() - the engine track outlives
    // the Scheduler, so a stale send would keep feeding a bus the pattern no longer mentions. The
    // dry level travels separately as the 'dry' channel control above.
    if (typeof this.engine.setBusSends === 'function') {
      const sends = sig.busSends ?? [];
      if (sends.length > 0) {
        this.engine.setBusSends(this.trackId, sends);
      } else if (this._busRouted) {
        this.engine.clearBusSends(this.trackId);
      }
      this._busRouted = sends.length > 0;
    }

    // Audio injected into a plugin's aux/sidechain input (Sig#audio, injector form): wire each
    // { slot, name } and tear down any slot the new pattern dropped. `name` is a track or a
    // hardware audio input; the engine routes the audio and orders any source track ahead of this.
    if (typeof this.engine.injectAudio === 'function') {
      const nextSlots = new Set();
      for (const inj of sig.audioInjects ?? []) {
        nextSlots.add(inj.slot);
        this.engine.injectAudio(this.trackId, inj.slot, inj.name, inj.gain ?? 1);
      }
      for (const slot of this._prevAudioInjectSlots) {
        if (!nextSlots.has(slot)) this.engine.clearAudioInject(this.trackId, slot);
      }
      this._prevAudioInjectSlots = nextSlots;
    }

    // MIDI injected into a plugin from a named source (Sig#midi injector): another track's notes
    // or a MIDI device fanned into the plugin. Torn down for any slot the new pattern dropped.
    if (typeof this.engine.injectMidi === 'function') {
      const nextSlots = new Set();
      for (const inj of sig.midiInjects ?? []) {
        nextSlots.add(inj.slot);
        this.engine.injectMidi(this.trackId, inj.slot, inj.name, inj.note);
      }
      for (const slot of this._prevMidiInjectSlots) {
        if (!nextSlots.has(slot)) this.engine.clearMidiInject(this.trackId, slot);
      }
      this._prevMidiInjectSlots = nextSlots;
    }

    // Tier-2 modulators are persistent engine-side synths mapped onto the VST parameter - they
    // outlive the pattern that created them, so a re-eval must explicitly clear any that the new
    // pattern no longer carries (or whose kind changed, e.g. env -> LFO, or dropped to a Tier-1
    // polled signal, which a leftover bus mapping would fight with).
    const nextModulators = new Map();
    for (const c of this._controlEntries(sig)) {
      const kind = c.sig.lfoIR ? 'lfo' : c.sig.envIR ? 'env' : c.sig.ccIR ? 'cc' : null;
      if (kind) nextModulators.set(`${c.slot} ${c.name}`, { ...c, kind });
    }
    for (const [key, prev] of this._activeModulators) {
      if (nextModulators.get(key)?.kind === prev.kind) continue; // survives - updated in place below
      this.engine[MODULATOR_CLEARS[prev.kind]](this.trackId, prev.slot, prev.name);
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
    // Bus sends also outlive the tick loop - drop them so a stopped/muted track stops feeding its
    // buses (and releases them). setPattern re-establishes them on the next eval.
    if (this._busRouted && typeof this.engine.clearBusSends === 'function') {
      this.engine.clearBusSends(this.trackId);
      this._busRouted = false;
    }
    // Tier-2 modulators run as persistent engine-side synths, independent of the tick loop. Muting
    // or removing the track must clear them or a leftover LFO/env keeps modulating the param after
    // unmute - the fresh Scheduler an unmute creates never saw them and so can't clear them itself.
    // setPattern re-establishes any the pattern still carries on the next eval.
    for (const m of this._activeModulators.values()) {
      this.engine[MODULATOR_CLEARS[m.kind]](this.trackId, m.slot, m.name);
    }
    this._activeModulators = new Map();
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
      this._anchorLFOs(nowSec);
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
        // Only trigger onsets newly entering the lookahead window - each tick advances
        // `fromCycle` to the previous tick's `toCycle`, so this never double-fires.
        if (stepStartCycle < fromCycle || stepStartCycle >= toCycle) continue;

        const onsetSec = this.transport.secAt(stepStartCycle);
        // How long it rings: the step's own width times its clip channel. This is where clip is
        // applied - it's a key on the event like any other (see soundingEnd), so the noteOff simply
        // lands later, possibly cycles later, with nothing about the pattern's structure changed.
        const stepEndCycle = cycle + this._soundingEnd(step, onsetSec, stepStartCycle);
        const offsetSec = this.transport.secAt(stepEndCycle);

        // Velocity is one note channel now, read uniformly for both track kinds (see _velAt): the
        // merged step.vel wins, else the channel is sampled at the onset, else it's unset.
        const velocity = this._velAt(step, onsetSec, stepStartCycle);
        if (this.pattern.sampler) {
          const cfg = this._sampleConfigAt(step, onsetSec, stepStartCycle);
          if (velocity !== undefined) cfg.vel = velocity; // scales the sample's gain; unset = engine default
          let pack = String(step.value);
          // Strudel shorthand: s("bd:4") = s("bd").i(4). An explicit .i() wins over the suffix.
          const m = /^(.+):(-?\d+)$/.exec(pack);
          if (m) {
            pack = m[1];
            if (cfg.index === undefined) cfg.index = Number(m[2]);
          }
          // The engine reports back what it resolved the config down to (fit -> rate, slice ->
          // window, and the window's length in seconds) - that's what .log() prints, since none
          // of it can be known here: it depends on the sample file's own length.
          const info = this.engine.playSample(this.trackId, pack, cfg, onsetSec, offsetSec);
          if (this.pattern.logging) {
            this._logEvent(stepStartCycle, stepEndCycle, formatSampleEvent(pack, cfg, info, stepEndCycle - stepStartCycle));
          }
        } else {
          const midiNote = Math.round(step.value);
          const vel = velocity ?? 1.0; // unset velocity on a synth note is full
          if (this.pattern.logging) {
            this._logEvent(stepStartCycle, stepEndCycle, formatNoteEvent(midiNote, vel));
          }
          if (vel <= 0) continue;
          this.engine.noteOn(this.trackId, midiNote, Math.min(1, vel), onsetSec);
          this.engine.noteOff(this.trackId, midiNote, Math.max(onsetSec + 0.001, offsetSec - NOTE_OFF_EARLY_SEC));
        }
      }
    }
  }

  // One .log() line: which track, the event's onset and end as absolute cycle positions (so it
  // lines up with the transport and with the other tracks), then the event itself.
  _logEvent(fromCycle, toCycle, body) {
    eventLogger(`[${this.trackId}] ${cyc(fromCycle)} -> ${cyc(toCycle)}  ${body}`);
  }

  // The velocity of one note event, read uniformly (all-signals model): the value merged onto the
  // step by a discrete vel channel wins (step.vel, from .vel("1 0.5")/.as("note:vel")/pianoroll);
  // otherwise a continuous vel channel (vel(sine)/vel(0.6)) is sampled at the onset; otherwise it's
  // unset (undefined) and the caller supplies the default (full on a synth, engine default gain on a
  // sampler). Maps to MIDI velocity or sample gain depending on the track kind - one read either way.
  _velAt(step, onsetSec, onsetCycle) {
    return channelAt('vel', step, this.pattern.noteChannels, onsetSec, this.transport.cps, onsetCycle);
  }

  // Where this event stops sounding, in cycle-relative coordinates (see soundingEnd): the step's own
  // width times its clip channel. Read in transport time, so a continuous clip lines up with the
  // clock the note is actually played against.
  _soundingEnd(step, onsetSec, onsetCycle) {
    return soundingEnd(step, this.pattern.noteChannels, onsetSec, this.transport.cps, onsetCycle);
  }

  // Sampler config signals evaluated at one event's onset. `fit: 'auto'` passes through as-is
  // (the engine resolves it against the sample's length); everything else becomes a number or
  // stays undefined for the engine's default.
  //
  // A value merged onto the step wins over sampling the channel - exactly as step.vel does in
  // _velAt. That's what a `,`-stacked control needs: `.speed("1.1,0.9")` fans one hit out into two
  // events that sound TOGETHER, so there is no onset time at which sampling the channel could tell
  // them apart; each event carries the layer that made it (step.cfg, see crossMerge). Channels
  // with no step grid of their own (a plain number, an LFO) stamp nothing and are sampled here.
  _sampleConfigAt(step, onsetSec, onsetCycle) {
    const cfg = { secPerCycle: 1 / this.transport.cps };
    const at = (sig) => {
      const v = sig.sample(onsetSec, this.transport.cps, onsetCycle);
      return typeof v === 'number' ? v : v == null ? undefined : Number(v);
    };
    const src = this.pattern.sampler;
    const merged = step.cfg;
    // vel is not here - it's a note channel (see _velAt), read the same way as on a synth track.
    for (const key of ['index', 'begin', 'end', 'loop', 'loopWrap', 'loopDir', 'speed', 'flip', 'stretch',
      'slice', 'note', 'attack', 'decay', 'sustain', 'release']) {
      if (merged && merged[key] !== undefined) {
        cfg[key] = merged[key];
      } else if (src[key]) {
        const v = at(src[key]);
        if (v !== undefined && !Number.isNaN(v)) cfg[key] = v;
      }
    }
    // .loopwrap()/.loopdir() carry mode NUMBERS rather than amounts, so whatever the channel
    // produced picks a mode by rounding and wrapping (see loopModeAt) - that's what lets a
    // continuous signal drive them. Done here so the engine and the .log() line agree.
    for (const key of ['loopWrap', 'loopDir']) {
      if (cfg[key] !== undefined) cfg[key] = loopModeAt(key, cfg[key]);
    }
    if (src.fit === 'auto') {
      cfg.fit = 'auto';
    } else if (merged && merged.fit !== undefined) {
      cfg.fit = merged.fit;
    } else if (src.fit) {
      const v = at(src.fit);
      if (v !== undefined && !Number.isNaN(v)) cfg.fit = v;
    }
    return cfg;
  }

  // Pins every free-running LFO's phase to the transport clock (see LFO_ANCHOR_INTERVAL_SEC).
  // Anchors are sent lookahead-ahead like note events, so the engine applies them at the exact
  // target time; one sent while the engine is still setting the modulator up is dropped there
  // and the next periodic one locks it. Engines without anchorParamLFO just stay free-running.
  _anchorLFOs(nowSec) {
    if (typeof this.engine.anchorParamLFO !== 'function') return;
    for (const m of this._activeModulators.values()) {
      const ir = m.sig.lfoIR;
      if (!ir || ir.shape === 'rand' || ir.shape === 'perlin') continue; // noise shapes have no phase to anchor
      if (ir.shape === 'custom' && ir.mode != null && ir.mode !== 'free') continue; // note-gated
      if (m.anchoredAtSec != null && nowSec - m.anchoredAtSec < LFO_ANCHOR_INTERVAL_SEC) continue;
      const targetSec = nowSec + DEFAULT_LOOKAHEAD_SEC;
      const total = targetSec * ir.rateHz + (ir.phaseCycles ?? 0); // sampleLfoIR's phase formula
      this.engine.anchorParamLFO(this.trackId, m.slot, m.name, ((total % 1) + 1) % 1, targetSec);
      m.anchoredAtSec = nowSec;
    }
  }

  _pollGenericParams(nowSec) {
    // Sample each signal at the time the value will actually be applied (the engine schedules
    // setParam in a timestamped bundle at applySec) - sampling at nowSec instead would put
    // every polled control a constant lookahead (150ms) behind the note grid.
    const applySec = nowSec + DEFAULT_LOOKAHEAD_SEC;
    const applyCycle = this.transport.cycleAt(applySec);
    for (const c of this._controlEntries(this.pattern)) {
      if (c.sig.lfoIR || c.sig.envIR || c.sig.ccIR) continue; // native Tier 2 already owns this, set once in setPattern()
      const value = c.sig.sample(applySec, this.transport.cps, applyCycle);
      if (typeof value === 'number') {
        this.engine.setParam(this.trackId, c.slot, c.name, value, applySec);
      }
    }
  }
}
