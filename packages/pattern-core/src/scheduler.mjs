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

import { sampleBound, CHANNEL_DEFAULTS, LOOP_MODES, loopModeAt, channelAt, soundingEnd, timeShift, endEdgeStep, warnPattern, lfoRateHz, lfoPhaseCount, lfoShapes, resolvePreset } from './signal.mjs';
import { scalePitchClasses } from './notes.mjs';
import { resolveInputChannels } from './audio-inputs.mjs';

// Resolves an input()'s channel request against the booted device's live layout (see
// audio-inputs.mjs). Done here, per eval, rather than when input() is called: the layout changes
// when the audio device is rebuilt in settings, and a pattern built before that must pick up the
// new offsets on its next eval. Returns null for every other kind of audio source (a track, a bus,
// a legacy "dev:" string), which the engine keeps handling by name.
function hwChannels(hw) {
  if (!hw) return null;
  const { chans, warning } = resolveInputChannels(hw);
  if (warning) warnPattern(warning);
  return chans;
}

const DEFAULT_LOOKAHEAD_SEC = 0.15;
// How far ahead of its onset a preset swap is APPLIED. Loading a program is not instant and not
// sample-accurate: it suspends the plugin and resets its voices, in the language, while the notes
// at that same onset arrive as timestamped bundles the audio thread plays exactly on time. A swap
// applied at the onset therefore lands on top of the note written at it - which is why that note
// used to disappear. Engine-side, notes for a slot mid-load wait for it and play a moment late
// rather than not at all (see poptart.scd's waitForLoad); this head start is what usually leaves
// nothing to wait for. Small on purpose: it is also how much earlier the OUTGOING preset
// stops sounding, and 30ms is under a 64th note at any tempo anyone plays at.
const PRESET_SWAP_LEAD_SEC = 0.03;
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

// The floor under an event pushed EARLY by .nudge()/.swing() (see pattern-core's timeShift). An
// onset enters the lookahead window at least (lookahead - one tick) ahead of its grid position, so
// that is the whole budget an early shift has to spend; the rest is margin for the trip to the
// engine. A shift past it doesn't get to move the event any further - the note plays as early as it
// can be played instead of arriving after its own timestamp, which is the difference between a
// slightly-too-small push and a note that jumps to the front of the queue. In musical terms this is
// enormous: a "rushed" feel is 5-30ms, and the budget is 100ms at any tempo.
const MAX_EARLY_SHIFT_SEC = DEFAULT_LOOKAHEAD_SEC - POLL_INTERVAL_MS / 1000 - 0.02;
// The last moment a message is worth timestamping for. Under it the audio thread would be handed a
// time it has already passed, and would play the note immediately - and possibly after one written
// behind it. Only an early shift can get near this; nothing else here schedules for "now".
const MIN_SEND_LEAD_SEC = 0.005;
// The shortest span an event may be handed to the engine as. Only a time shift can invert one (a
// late onset against an early end), and a backwards span would be taken literally.
const MIN_SOUNDING_SEC = 0.001;

// Track-level channel-strip controls (Sig#gain/#pan) ride the same setParam/setParamLFO/
// setParamEnv engine calls as plugin parameters, addressed with this pseudo-slot instead of a
// chain index - the engine maps them onto the track's own output stage rather than a VST param.
const CHANNEL_SLOT = -1;
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
    this._livePresets = new Map(); // slot -> preset name currently sounding (auto-pin writes into it)
    this._presetWarned = new Set(); // "slot name" already complained about, so a bad name says it once
    this._earlyShiftWarned = false; // an over-early nudge says so once, not once per event
    this._presetHold = new Map(); // slot -> preset the editor is holding it on (see holdPreset)
    this._stateHold = new Set(); // slots being edited by hand right now (see holdPluginState)
    this._channelHold = new Map(); // channel control -> value a mixer control is holding it at (see holdChannel)
  }

  /**
   * Holds one channel-strip control (gain/pan/width/bassmono/out/dry) at a value while a mixer
   * control is being dragged. `value` null releases it back to the pattern. Returns the reason it
   * couldn't be taken, or null.
   *
   * This is what makes the mixer's faders mixable. A fader writes `.gain(x)` into the code, and
   * the code only *sounds* once it is evaluated - so without a hold, riding a fader is silent
   * until you let go and the debounced eval lands. The engine side is already continuous (the
   * track SynthDef lags these controls, and _pollGenericParams re-sends them every tick), so all
   * a hold has to do is put the fader's value where the pattern's would have gone. Nothing else
   * stops: the notes play, every other control and every other track carry on.
   *
   * The value REPLACES the pattern's rather than scaling it. Every .gain() on a track composes
   * into one post-chain gain (see multiplyGain), so there is no separate trim factor to scale -
   * the fader's number IS the whole control, which is what it already shows.
   *
   * A control driven by a Tier-2 modulator is refused. Those don't go through the poll at all -
   * the engine runs them as a persistent synth on a control bus MAPPED onto this control, and a
   * scalar set would unmap the bus and silently kill the modulator until the next eval. The
   * caller falls back to writing the code (see the web app's mixer), which re-establishes the
   * modulator with new bounds instead of destroying it.
   */
  holdChannel(name, value) {
    if (value == null) {
      if (!this._channelHold.delete(name)) return null;
      // The poll only re-sends controls the pattern actually carries, so releasing a hold on one
      // it doesn't (a block with no .pan(), or a lease that expired without an eval behind it)
      // would leave the track pinned at the held value forever. Put it back by hand.
      if (!(name in (this.pattern?.channel ?? {}))) {
        this.engine.setParam(this.trackId, CHANNEL_SLOT, name, CHANNEL_DEFAULTS[name] ?? 0,
          this.engine.getTime() + DEFAULT_LOOKAHEAD_SEC);
      }
      return null;
    }
    if (!(name in CHANNEL_DEFAULTS)) return `"${name}" is not a channel control`;
    const sig = this.pattern?.channel?.[name];
    if (sig && (sig.lfoIR || sig.envIR || sig.ccIR)) {
      return `${name} is driven by a native modulator (env/lfo/midicc) - edit the code instead`;
    }
    this._channelHold.set(name, value);
    return null;
  }

  /**
   * Holds one chain slot on a named preset - and loads it now, so you hear what you are editing.
   * `name` null releases the slot back to its pattern.
   *
   * This is what makes editing a patterned preset possible at all. A preset is edited by turning
   * the plugin's own knobs while it is loaded, and `.preset("<a b>")` changes which one is loaded
   * every cycle - so without a hold, "pick a, turn a knob" lands the knob in whichever preset the
   * pattern happened to be on, and a and b drift together instead of apart. The editor holds the
   * slot for as long as its preset panel is open. Only this slot stops swapping: the notes, the
   * other slots and every other track carry on.
   */
  holdPreset(slot, name, { force = false } = {}) {
    if (name == null) {
      this._presetHold.delete(slot);
      return null;
    }
    this._presetHold.set(slot, name);
    // A plugin being edited by hand holds a program nothing else has yet, so loading anything over
    // it would throw that edit away (see holdPluginState). The panel still takes the slot - it is
    // the preset the knobs belong to - it just doesn't reload it here. `force` is the one thing
    // that gets through: picking a preset in the panel is a deliberate "let me hear this one", and
    // the server captures what your hands did before it asks (see its /api/presetHold route).
    if (this._stateHold.has(slot) && !force) return null;
    return this._applyPreset(slot, name, this.engine.getTime());
  }

  /**
   * Freezes (or thaws) one chain slot's plugin PROGRAM while it is being edited by hand.
   *
   * A plugin whose own window you are turning knobs in holds a sound that nothing else has yet:
   * not this pattern, not the preset store, not the buffer. Every whole-program push into that
   * slot meanwhile - a `.preset("<a b>")` swap coming round, a pinned `{ state }` re-sent by an
   * eval - overwrites what you just did with a program that is now out of date, and auto-pin's
   * capture lands a moment later and puts yours back: the slot audibly flips to the old sound for
   * a cycle and then to the new one. So while a slot is frozen, whole-program pushes are simply
   * not made. Nothing else stops: the notes play, the params modulate, the rest of the chain and
   * every other track carry on, and this slot keeps sounding exactly as your hands left it.
   *
   * Who freezes and what thaws them is the server's business (see its hand-editing section): a
   * slot taken over by hand until the code is touched again, and a capture not yet in the code.
   */
  holdPluginState(slot, on) {
    if (!on) {
      this._stateHold.delete(slot);
      return;
    }
    if (this._stateHold.has(slot)) return; // already frozen - freezing again cancels nothing new
    this._stateHold.add(slot);
    // Swaps are SENT up to a lookahead before their onset and wait engine-side, so the one due in
    // the next moment was already on its way when your hands reached the plugin. Not cancelling it
    // is the difference between "the pattern stops swapping" and "the pattern stops swapping after
    // one more swap" - which is the whole symptom, just later (see OscEngine#cancelPluginState).
    if (typeof this.engine.cancelPluginState === 'function') {
      this.engine.cancelPluginState(this.trackId, slot);
    }
    // A cancelled swap never reached the plugin, so what _appliedStates believes about this slot is
    // now a guess. Forget it: the plugin holds whatever the hands make of it from here, and the
    // first push after the freeze lifts has to be unconditional or the slot can be left sounding a
    // program the cache thinks it already loaded.
    for (const key of this._appliedStates.keys()) {
      if (key.startsWith(`${slot}:`)) this._appliedStates.delete(key);
    }
  }

  /**
   * Which named preset is loaded in a chain slot right now, or null. Auto-pin asks: a state
   * captured out of a plugin that a .preset() pattern is driving belongs in THAT preset's
   * definition, not in the slot's `{ state }` argument - where the next swap would overwrite it.
   */
  livePreset(slot) {
    // A held slot is on its preset no matter what the pattern would be playing - which is the
    // point: a knob turned while the panel holds `a` belongs to `a`.
    if (this._presetHold.has(slot)) return this._presetHold.get(slot);
    const queue = this._presetQueue(slot);
    return queue[0] && queue[0].atSec <= this.engine.getTime() ? queue[0].name : null;
  }

  // One slot's queue of scheduled swaps, with everything now in the past dropped except the one
  // still sounding. Swaps are SCHEDULED up to a lookahead ahead of the sound, so "which one is
  // playing" can't be the last one queued - for ~150ms that is the next one - and the queue has to
  // be walked rather than replaced. Pruned on BOTH sides, because the only reader is a plugin-edit
  // gesture: a set that plays for an hour and is never touched would otherwise pile up a swap per
  // cycle per slot with nothing ever taking them off.
  _presetQueue(slot) {
    const queue = this._livePresets.get(slot) ?? [];
    const nowSec = this.engine.getTime();
    while (queue.length > 1 && queue[1].atSec <= nowSec) queue.shift();
    return queue;
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

    // Captured plugin state (synth/fx's legacy `{ state }` argument - the editor writes named
    // presets now, but old patches carry these and must sound the same). Sent only when the string
    // (or the plugin occupying the slot) actually changed - a livecoding re-eval must not make
    // the plugin re-chew a megabyte state blob every keystroke. Removing the state from the
    // code deliberately resets nothing: the plugin just keeps sounding how it sounds.
    if (typeof this.engine.setPluginState === 'function') {
      const chain = [sig.instrument, ...sig.fxChain];
      for (const [slotStr, state] of Object.entries(sig.slotStates ?? {})) {
        const slot = Number(slotStr);
        // A slot a .preset(...) drives belongs to the pattern, so its pinned `{ state }` is dead
        // code - and sending it would be audible: the blob loads at eval time and the pattern
        // loads over it at the next onset, two program changes for one keystroke. Said once per
        // evaluation, because a leftover blob is megabytes of buffer that no longer does anything.
        if (slot in (sig.presetPatterns ?? {})) {
          warnPattern(`[scheduler] track "${this.trackId}" slot ${slot}: .preset(...) drives this plugin, so its pinned { state } is ignored - delete it.`);
          continue;
        }
        // Being edited by hand: the plugin holds a newer program than this string (see
        // holdPluginState). Not cached either - when the freeze lifts, the captured program is
        // what the code says, so this is a no-op then rather than a stale push now.
        if (this._stateHold.has(slot)) continue;
        const key = `${slot}:${chain[slot]}`;
        if (this._appliedStates.get(key) === state) continue;
        this._appliedStates.set(key, state);
        this.engine.setPluginState(this.trackId, slot, state);
      }
    }

    // Patterned plugin state (Sig#preset). Dropping the .preset(...) from a slot deliberately
    // resets nothing - the plugin keeps sounding how it sounds, exactly as removing a `{ state }`
    // does - but the slot stops being a preset's, so auto-pin goes back to writing `{ state }`
    // there instead of into a definition. Warnings are re-armed per eval, so a name you have just
    // fixed is not still being complained about from the last one.
    for (const slot of [...this._livePresets.keys()]) {
      if (!(slot in (sig.presetPatterns ?? {}))) this._livePresets.delete(slot);
    }
    this._presetWarned.clear();
    this._earlyShiftWarned = false;

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
        this.engine.setInputSource(this.trackId, src.io, src.name, src.channel ?? 0, pcs, hwChannels(src.hw));
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
        this.engine.injectAudio(this.trackId, inj.slot, inj.name, inj.gain ?? 1, hwChannels(inj.hw));
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
    const cps = this.transport.cps;
    // A rate written in cycles is worth a different number of Hz at every tempo, so a synced LFO
    // has to be re-sent when setbpm moves - the same in-place update a signal-valued bound gets,
    // which keeps it native and phase-continuous rather than restarting it.
    const rateHz = m.sig.lfoIR ? lfoRateHz(ir, cps) : null;
    const synced = m.sig.lfoIR != null && ir.rateHz == null;
    m.dynamic = typeof ir.min !== 'number' || typeof ir.max !== 'number' || synced;
    const pos = this.transport.cycleAt(nowSec);
    // A resting signal bound (a mini-string bound mid-`~`) holds the last sent value; on the
    // very first send there's nothing to hold, so fall back to the unipolar default.
    const lo = sampleBound(ir.min, nowSec, cps, pos) ?? (initial ? 0 : null);
    const hi = sampleBound(ir.max, nowSec, cps, pos) ?? (initial ? 1 : null);
    if (lo == null || hi == null) return;
    if (!initial && lo === m.lastLo && hi === m.lastHi && rateHz === m.lastRateHz) return;
    m.lastLo = lo;
    m.lastHi = hi;
    m.lastRateHz = rateHz;
    let resolved = m.dynamic ? { ...ir, min: lo, max: hi, ...(rateHz == null ? {} : { rateHz }) } : ir;
    if (m.kind === 'lfo' && ir.shape === 'custom') {
      // A drawn shape reaches the engine as breakpoints, and this is where its NAME becomes them
      // (see lfoShapes): the engine is deliberately ignorant of pattern-core, and by the time a
      // modulator is being sent the whole buffer has evaluated, so a `_shape(...)` written below
      // the pattern that names it is in the registry. `points` is the shape it starts on and
      // `shapes` the set compiled up front, both spelled as the engine has always read them.
      const shapes = lfoShapes(ir);
      resolved = { ...resolved, points: shapes[0], shapes };
    }
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
    // Nothing is sounding, so no slot is "on" a preset any more: a capture off one of these
    // plugins now belongs in its `{ state }` argument, not in a definition (see livePreset).
    this._livePresets.clear();
    this._presetHold.clear();
    // A stopped track's plugins are no longer playing anything to protect; the server re-asserts
    // any live hand edit on the evaluation that brings the track back (see its eval route).
    this._stateHold.clear();
    // Nothing is sounding for a mixer control to hold either. Dropped rather than released: the
    // release path would push a value at a track that is on its way out, and the server's lease
    // re-takes the hold on the Scheduler that comes back (see setChannelHold).
    this._channelHold.clear();
  }

  _tick() {
    if (!this.pattern) return;
    try {
      const nowSec = this.engine.getTime();
      const targetCycle = this.transport.cycleAt(nowSec + DEFAULT_LOOKAHEAD_SEC);

      // Preset swaps go out FIRST, before the notes of the same window. A note is handed to the
      // audio thread as a timestamped bundle the moment the engine handles its message - nothing
      // can hold it back after that - so whether it should wait for a program load is decided
      // then, from what the engine has already been told. Send the notes first and the swap is
      // still news when the note at its onset has been committed to play straight through it,
      // which is exactly the note that was being eaten (see poptart.scd's waitForLoad).
      this._schedulePresetSwaps(this._scheduledUntilCycle, targetCycle);
      this._scheduleNoteEdges(this._scheduledUntilCycle, targetCycle, nowSec);
      this._scheduleShapeSwaps(this._scheduledUntilCycle, targetCycle);
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

  // `nowSec` is the tick's own clock reading, passed in so every event of one tick is measured
  // against the same instant; it only matters to an EARLY time shift, which is the one thing here
  // that can ask to be scheduled in the past (see _timeShiftSec).
  _scheduleNoteEdges(fromCycle, toCycle, nowSec = this.engine.getTime()) {
    if (!this.pattern.stepsForCycle) return; // top-level pattern has no note structure (e.g. a bare LFO)

    for (let cycle = Math.floor(fromCycle); cycle < toCycle; cycle++) {
      for (const step of this.pattern.stepsForCycle(cycle)) {
        if (step.value == null) continue; // rest
        if (step.cont) continue; // tie/hold: the sounding event's onset was in an earlier step

        const stepStartCycle = cycle + step.start;
        // Only trigger onsets newly entering the lookahead window - each tick advances
        // `fromCycle` to the previous tick's `toCycle`, so this never double-fires. The window is
        // tested against the GRID position, never the nudged one: an event belongs to the tick its
        // written position falls in, and moving that test would either double-fire an event or drop
        // one whenever a shift carried it across a window edge.
        if (stepStartCycle < fromCycle || stepStartCycle >= toCycle) continue;

        const gridSec = this.transport.secAt(stepStartCycle);
        // How long it rings: the step's own width times its clip channel. This is where clip is
        // applied - it's a key on the event like any other (see soundingEnd), so the noteOff simply
        // lands later, possibly cycles later, with nothing about the pattern's structure changed.
        const stepEndCycle = cycle + this._soundingEnd(step, gridSec, stepStartCycle);

        // Where it actually plays: its grid position plus whatever .nudge()/.swing() move it by
        // (see timeShift), the other control read at the point of emission. Every channel above and
        // below is sampled at the GRID position, shift included - the event's musical position is
        // where it was written, and swing moves the sound, not the note.
        const shiftSec = this._timeShiftSec(step, stepStartCycle, gridSec, nowSec);
        const onsetSec = gridSec + shiftSec;
        // The END is warped too, and at ITS OWN grid position rather than the onset's - swing bends
        // the time axis, so both edges of the note follow the bend they each sit on. Translating the
        // whole event by the onset's shift instead would have a swung note ring straight through the
        // straight note that follows it: a default (clip 1) note ends exactly where the next one
        // begins, and moving only one of those two apart by a third of a slot puts one event's
        // noteOff a long way inside the next event's note - which on a repeated pitch (a swung
        // bassline on one note) silences every second note partway through. Warping both edges keeps
        // the gap between consecutive events exactly as it was written, and leaves the noteOff and
        // the next noteOn coincident, which is the case NOTE_OFF_EARLY_SEC already handles.
        const endGridSec = this.transport.secAt(stepEndCycle);
        const endStep = endEdgeStep(step, stepEndCycle - Math.floor(stepEndCycle));
        const endSec = endGridSec + this._shiftSecAt(endStep, stepEndCycle, endGridSec);
        // A note can't end before it starts - reachable only by mixing a late onset nudge with an
        // early one at the end position, but the engine would take a backwards span literally.
        const offsetSec = Math.max(onsetSec + MIN_SOUNDING_SEC, endSec);

        // Velocity is one note channel now, read uniformly for both track kinds (see _velAt): the
        // merged step.vel wins, else the channel is sampled at the onset, else it's unset.
        const velocity = this._velAt(step, gridSec, stepStartCycle);
        // .log() prints where the event is HEARD - a swung note reads at the position it plays, not
        // the one it was written at. Unshifted events skip the round trip so their positions stay
        // the exact fractions the grid produced.
        const logAt = !this.pattern.logging
          ? null
          : shiftSec === 0
            ? [stepStartCycle, stepEndCycle]
            : [this.transport.cycleAt(onsetSec), this.transport.cycleAt(offsetSec)];
        if (this.pattern.sampler) {
          const cfg = this._sampleConfigAt(step, gridSec, stepStartCycle);
          if (velocity !== undefined) cfg.vel = velocity; // scales the sample's gain; unset = engine default
          // What the engine resolves to files: a bare name is a pack (a folder), "sp:" a named
          // pack (a _pack() definition), "file:"/"rec:" one exact file (se/sr). Only the two packs
          // take the index suffix - the other two address a single file, so a ":" in one of those
          // values belongs to the name.
          const kind = this.pattern.samplerKind ?? 'pack';
          let pack = String(step.value);
          if (kind === 'pack' || kind === 'named') {
            // Strudel shorthand: s("bd:4") = s("bd").i(4). An explicit .i() wins over the suffix.
            const m = /^(.+):(-?\d+)$/.exec(pack);
            if (m) {
              pack = m[1];
              if (cfg.index === undefined) cfg.index = Number(m[2]);
            }
            if (kind === 'named') pack = `sp:${pack}`;
          } else {
            pack = `${kind === 'rec' ? 'rec' : 'file'}:${pack}`;
          }
          // The engine reports back what it resolved the config down to (fit -> rate, slice ->
          // window, and the window's length in seconds) - that's what .log() prints, since none
          // of it can be known here: it depends on the sample file's own length.
          const info = this.engine.playSample(this.trackId, pack, cfg, onsetSec, offsetSec);
          if (logAt) {
            this._logEvent(logAt[0], logAt[1], formatSampleEvent(pack, cfg, info, stepEndCycle - stepStartCycle));
          }
        } else {
          const midiNote = Math.round(step.value);
          const vel = velocity ?? 1.0; // unset velocity on a synth note is full
          if (logAt) {
            this._logEvent(logAt[0], logAt[1], formatNoteEvent(midiNote, vel));
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
  // Patterned lfo("<pluck swell>"): the engine compiles every named shape up front and holds one
  // of them; this schedules WHICH, on the shape pattern's own step grid, timestamped like a note.
  // A swap restarts the new shape from its beginning - a modulator that changed shape mid-rise and
  // carried on at the old phase would be neither shape - so the anchor clock (see _anchorLFOs) is
  // re-based to the swap as well.
  _scheduleShapeSwaps(fromCycle, toCycle) {
    if (typeof this.engine.setParamShape !== 'function') return;
    for (const m of this._activeModulators.values()) {
      const ir = m.sig.lfoIR;
      if (!ir?.shapePattern?.stepsForCycle) continue;
      for (let cycle = Math.floor(fromCycle); cycle < toCycle; cycle++) {
        for (const step of ir.shapePattern.stepsForCycle(cycle)) {
          const at = cycle + step.start;
          if (at < fromCycle || at >= toCycle) continue;
          if (step.value == null || step.cont) continue; // a rest holds the shape that is playing
          const index = ir.shapeNames.indexOf(String(step.value).trim());
          // The first step of an eval asserts the shape rather than assuming it: an unchanged
          // spec keeps the running synth, which may be holding any shape, and a scheduler that
          // assumed the first would skip the message that puts it right. The engine no-ops when
          // it already agrees.
          if (index < 0 || index === m.shapeIndex) continue;
          m.shapeIndex = index;
          const atSec = this.transport.secAt(at);
          this.engine.setParamShape(this.trackId, m.slot, m.name, index, atSec);
          // Phase restarts at the swap, so that is where the anchor's phase formula counts from -
          // in both units, since a synced rate counts the swap's cycle and a Hz one its second.
          // In the note-gated modes the engine defers the swap to the next gate and keeps its own
          // time anyway - those are never anchored (see _anchorLFOs).
          m.phaseOriginSec = atSec;
          m.phaseOriginCycle = at;
        }
      }
    }
  }

  // Patterned plugin state (Sig#preset): `.preset("<init growl>")` reads its names on their own
  // step grid and pushes each preset's captured program into the slot at that step's onset,
  // timestamped like a note. A rest holds whatever is loaded - a slot with nothing in it would be
  // a plugin reset to its defaults, which is not what a gap in a pattern has ever meant.
  //
  // Whether anything is actually sent is decided by the same _appliedStates cache the `{ state }`
  // argument uses, so a state the plugin already holds costs nothing: a re-eval that changed no
  // preset sends nothing, and neither does the eval right after auto-pin captured a state OUT of
  // the plugin (see markStateApplied) - which would otherwise make it reload what it just gave us.
  _schedulePresetSwaps(fromCycle, toCycle) {
    if (typeof this.engine.setPluginState !== 'function') return;
    for (const [slotStr, sig] of Object.entries(this.pattern.presetPatterns ?? {})) {
      if (!sig.stepsForCycle) continue; // a preset name has to come from a step grid to have an onset
      const slot = Number(slotStr);
      // Held by the editor: the panel owns this slot until it closes (see holdPreset), or its
      // plugin is being edited by hand and holds a program no swap may overwrite (see
      // holdPluginState). Nothing is queued either, so livePreset goes on naming the preset that
      // is really sounding - which is the one a knob turned now belongs to.
      if (this._presetHold.has(slot) || this._stateHold.has(slot)) continue;
      for (let cycle = Math.floor(fromCycle); cycle < toCycle; cycle++) {
        for (const step of sig.stepsForCycle(cycle)) {
          const at = cycle + step.start;
          if (at < fromCycle || at >= toCycle) continue;
          if (step.value == null || step.cont) continue;
          const name = String(step.value).trim();
          if (!name) continue;
          const atSec = this.transport.secAt(at);
          // Recorded whether or not a state is pushed: this name IS the one sounding from here,
          // so it is where a capture off that plugin belongs even if nothing has been captured
          // into it yet. That empty case is the whole authoring loop - see Sig#preset.
          const queue = this._presetQueue(slot);
          queue.push({ atSec, name });
          this._livePresets.set(slot, queue);
          // Applied a hair before the onset it belongs to, so the program is in by the time the
          // notes at that onset play (see PRESET_SWAP_LEAD_SEC). The QUEUE still carries the true
          // onset: which preset a knob you turn belongs to is a question about the music, not
          // about how long a plugin takes to swallow a program.
          const why = this._applyPreset(slot, name, atSec - PRESET_SWAP_LEAD_SEC);
          if (why && !this._presetWarned.has(`${slot} ${name}`)) {
            this._presetWarned.add(`${slot} ${name}`);
            warnPattern(`[scheduler] track "${this.trackId}" slot ${slot}: ${why}`);
          }
        }
      }
    }
  }

  // Puts one named preset into a slot at `atSec`, unless the plugin already holds exactly that
  // program (see _appliedStates) or the preset has nothing to say. Returns the reason it didn't,
  // or null - the caller decides whether that is worth a line, since the pattern's swaps come
  // round every cycle and the editor's hold happens once.
  _applyPreset(slot, name, atSec) {
    if (typeof this.engine.setPluginState !== 'function') return null;
    const plugin = [this.pattern?.instrument, ...(this.pattern?.fxChain ?? [])][slot] ?? null;
    const { state, why } = resolvePreset(name, plugin);
    if (!state) return why;
    const key = `${slot}:${plugin}`;
    if (this._appliedStates.get(key) === state) return null;
    this._appliedStates.set(key, state);
    this.engine.setPluginState(this.trackId, slot, state, atSec);
    return null;
  }

  _velAt(step, onsetSec, onsetCycle) {
    return channelAt('vel', step, this.pattern.noteChannels, onsetSec, this.transport.cps, onsetCycle);
  }

  // Where this event stops sounding, in cycle-relative coordinates (see soundingEnd): the step's own
  // width times its clip channel. Read in transport time, so a continuous clip lines up with the
  // clock the note is actually played against.
  _soundingEnd(step, onsetSec, onsetCycle) {
    return soundingEnd(step, this.pattern.noteChannels, onsetSec, this.transport.cps, onsetCycle);
  }

  // How far off its grid position this event plays, in SECONDS: what .nudge()/.swing() ask for (see
  // pattern-core's timeShift, which works in cycles) converted through the transport, so a shift
  // means the same fraction of a step whatever the tempo is doing.
  //
  // Only the early direction has a limit, and it isn't musical: the note has to reach the engine
  // before it is due (see MAX_EARLY_SHIFT_SEC). Late shifts have no ceiling at all - the timestamp
  // is simply later - which is why swing, shuffle and every traditional groove, all of which only
  // ever delay, are unaffected by any of this. A shift that would land in the past is pulled up to
  // the earliest playable moment and warned about once per track: the note plays a touch late
  // rather than jumping the queue, and the console says which track asked for the impossible.
  // The shift asked for at one grid position, in seconds and with nothing clamped - the shared half
  // of the two edges. For the onset that is the event itself, stamped values and all; for the end it
  // is a stand-in step at the end's own position, so the time channels are read THERE. That is what
  // makes an end landing on the next event's onset pick up the same shift that event will play with,
  // and what a per-step stamp can't answer for: a stamp belongs to the event it is on, so a channel
  // with a grid of its own is the only thing that can say what happens where this note stops.
  _shiftSecAt(step, atCycle, atSec) {
    const shift = timeShift(step, this.pattern.noteChannels, atSec, this.transport.cps, atCycle);
    if (!shift) return 0;
    return this.transport.secAt(atCycle + shift) - atSec;
  }

  _timeShiftSec(step, onsetCycle, onsetSec, nowSec) {
    let shiftSec = this._shiftSecAt(step, onsetCycle, onsetSec);
    if (!shiftSec) return 0;
    // The budget is a fixed number of seconds rather than "however much lead this event happened to
    // be found with": the same note must move by the same amount on every pass, or an event sitting
    // near the window's edge would be pushed a different distance each cycle and jitter.
    if (shiftSec < -MAX_EARLY_SHIFT_SEC) {
      shiftSec = -MAX_EARLY_SHIFT_SEC;
      if (!this._earlyShiftWarned) {
        this._earlyShiftWarned = true;
        warnPattern(`[scheduler] track "${this.trackId}": an early nudge asks for more than ${Math.round(MAX_EARLY_SHIFT_SEC * 1000)}ms, which is as far ahead as a note can be scheduled - playing it ${Math.round(MAX_EARLY_SHIFT_SEC * 1000)}ms early instead. Late shifts (swing, shuffle) have no such limit.`);
      }
    }
    // The absolute floor the budget above normally keeps well clear of: a timestamp in the past
    // plays immediately and out of order, which is worse than playing a hair late.
    return Math.max(shiftSec, nowSec + MIN_SEND_LEAD_SEC - onsetSec);
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
      const targetCycle = this.transport.cycleAt(targetSec);
      // sampleLfoIR's own phase count (lfoPhaseCount: cycles for a synced rate, seconds for a Hz
      // one), measured from the last shape swap where there has been one - the swap restarted the
      // shape, so counting from the grid origin would immediately drag it back to a phase it never
      // had. Both origins are carried, since which one is read depends on the rate's unit.
      const total = lfoPhaseCount(
        ir,
        m.phaseOriginSec == null ? targetSec : targetSec - m.phaseOriginSec,
        this.transport.cps,
        m.phaseOriginCycle == null ? targetCycle : targetCycle - m.phaseOriginCycle,
      );
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
      // A mixer control being dragged holds this one at the value under your finger (see
      // holdChannel); the pattern's own value is what it returns to when you let go. Read with a
      // conditional rather than `&&` so a plugin param can't come out as `false ?? sample`.
      const held = c.slot === CHANNEL_SLOT ? this._channelHold.get(c.name) : undefined;
      const value = held ?? c.sig.sample(applySec, this.transport.cps, applyCycle);
      if (typeof value === 'number') {
        this.engine.setParam(this.trackId, c.slot, c.name, value, applySec);
      }
    }
    // Held controls the pattern doesn't carry at all - a block with no .pan() still has a pan knob,
    // and grabbing it has to sound. The loop above only walks what the pattern set.
    for (const [name, value] of this._channelHold) {
      if (name in this.pattern.channel) continue; // already sent (or Tier-2, which a hold won't touch)
      this.engine.setParam(this.trackId, CHANNEL_SLOT, name, value, applySec);
    }
  }
}
