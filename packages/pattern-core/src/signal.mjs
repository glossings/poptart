// The one unifying primitive: a Signal is a function of time. A note sequence from mini-
// notation and an LFO like `sine({rate:0.3})` are the same kind of thing here - the only
// difference is whether it has known step boundaries (so the scheduler can trigger exact
// note-on/off edges instead of just sampling) or not (a smooth signal, sampled continuously).
//
// This replaces an earlier draft that tried to reuse Strudel's Pattern/Hap classes directly -
// that meant reconciling two different "continuous vs discrete" models and dragging in
// @strudel/core's whole object system for what is conceptually just "a value that changes
// over time, sometimes with edges." Everything below is plain data + closures.

import { parseMini, getStepsForCycle, warpSteps, stepLocs } from './mini.mjs';
import { parseNoteValue, degreeToMidi, parseScaleName, quantizeToScale } from './notes.mjs';
import { parseShapePoints, sampleShape } from './shape.mjs';
import { parsePianoRoll, normalizePianoRollSteps } from './pianoroll.mjs';
import { latestCC, registerMidiDevice } from './midi.mjs';
import { macroValue, assertMacroIndex } from './macros.mjs';
import { Frac } from './frac.mjs';

/**
 * @typedef {Object} Step
 * @property {number} start  - fraction of a cycle, 0..1
 * @property {number} end    - fraction of a cycle, 0..1
 * @property {*} value       - null means "rest" (gate off)
 */

export class Sig {
  /**
   * @param {(tSeconds: number, cps: number, cyclePos?: number) => *} sampleFn - `cyclePos` is
   *   the transport's cycle position at tSeconds. Callers that have a Transport pass it so
   *   cycle-based signals stay phase-correct across tempo changes (setbpm); when omitted it
   *   defaults to `tSeconds * cps` (exact for a constant tempo).
   * @param {object} [opts]
   * @param {(ast: any, cycle: number) => Step[] | null} [opts.stepsForCycle] - present only for
   *   patterns with known step boundaries (mini-notation-derived). Lets the scheduler compute
   *   exact onset/offset times instead of polling.
   */
  constructor(sampleFn, opts = {}) {
    this.sample = sampleFn;
    this.stepsForCycle = opts.stepsForCycle ?? null;
    this.lfoIR = opts.lfoIR ?? null; // present only for the sine/saw/tri/square builders below
    this.envIR = opts.envIR ?? null; // present only for the env() builder below
    this.ccIR = opts.ccIR ?? null; // present only for midicc() signals (see midicc below)
    // Reads this signal as one EVENT - value plus the highlight spans of the atom that produced
    // it - at an exact cycle position (see readEvent). Present ONLY on signals whose value varies
    // WITHIN a cycle (choose/irand): their stepsForCycle can only report the phase-0 draw, so as a
    // control they must be read per onset rather than imposing that grid. Everything else is read
    // off the step covering the position, where value and spans already travel together.
    this.eventAt = opts.eventAt ?? null;

    // Track-building metadata, threaded through by .synth()/.fx()/.param() etc. Every control
    // method returns a NEW Sig (same sample/stepsForCycle) with this metadata carried forward -
    // see _clone().
    this.instrument = opts.instrument ?? null;
    this.fxChain = opts.fxChain ?? [];
    this.paramSignals = opts.paramSignals ?? {}; // name -> Sig
    this.paramSlots = opts.paramSlots ?? {}; // name -> slot index (0 = instrument, 1..n = fx)
    // MIDI injected into a specific plugin in the chain (see Sig#midi, the injector form): each
    // { slot, name, note } routes another track's notes (or a MIDI device) into the plugin at
    // `slot` (1..n = fx). The engine fans a track source's notes to the plugin, or wires a device.
    // Drives MIDI-keyed effects: a sidechain ducker off a rhythm, an arp/vocoder fed a note line.
    this.midiInjects = opts.midiInjects ?? [];
    // Audio injected into a specific plugin's auxiliary (sidechain) input (see Sig#audio, the
    // injector form): each { slot, name, gain } feeds another track's output, or a hardware audio
    // input, into the plugin at `slot` - so an audio-keyed ducker/compressor responds to it.
    this.audioInjects = opts.audioInjects ?? [];
    // Live input feeding this track's HEAD (see the midi()/audio() source builders): { io, name,
    // channel? }. io 'midi' plays the named source's notes on this track's instrument (a MIDI
    // device, or another track's notes); io 'audio' feeds the named source's audio into the chain
    // input (a hardware input, or another track's output). null for an ordinary pattern track.
    this.inputSource = opts.inputSource ?? null;
    // Output-to-bus sends (see Sig#bus): each { name, amount } sends `amount` of this track's
    // output to a named audio bus. A track may feed several buses at once, and any number of tracks
    // sharing a name sum into that bus; read the sum with the audio("name") head source on another
    // track. Independent of the dry path (Sig#dry, a channel control) - a bus send doesn't change
    // how much still reaches the track's own output pair.
    this.busSends = opts.busSends ?? [];
    this.channel = opts.channel ?? {}; // track-level channel strip: 'gain'/'pan'/'out'/'dry' -> Sig
    // Persistent per-onset note channels (the "bundle" of the all-signals model): 'vel' and 'clip',
    // each a Sig. Unlike a track channel these are sampled at each note ONSET, not streamed. Held
    // separately from the step grid so they survive a later pitch swap - "<0 1>".as("vel").note("f3")
    // re-merges the velocity onto note("f3")'s fresh trigger (see _noteLike / applyNoteChannels).
    // A discrete (step) channel also cross-merges into the grid, subdividing + retriggering the
    // events it overlaps and carrying its value as step.vel; a continuous one (vel(sine)/vel(0.6))
    // has no grid, so it's sampled at each onset by the scheduler instead.
    this.noteChannels = opts.noteChannels ?? {}; // 'vel'|'clip' -> Sig
    // Captured plugin state per chain slot (0 = instrument, 1.. = fx), from synth/fx's second
    // argument: { [slot]: "<opaque state string>" }. Applied by the scheduler after load.
    this.slotStates = opts.slotStates ?? {};
    // Sampler config, present only for s("pack") patterns: { index, begin, end, loop, speed,
    // stretch, fit, slice, attack, decay, sustain, release }, each a Sig (sampled per event
    // onset) or absent for its default.
    // Patterned values also merge their step grid into the pattern's (see _samplerOpt).
    this.sampler = opts.sampler ?? null;
    // Live MIDI note routing, from midikeys(): { device, channel (null = all) }. The scheduler
    // hands this to the engine, which plays the device's note stream on this track directly.
    this.midiNotes = opts.midiNotes ?? null;
    // Live computer-keyboard routing, from keyboard()/tap(): { kind: 'keyboard'|'tap' }. Unlike
    // midiNotes this can't be routed engine-side (the keys are in the browser) - the server
    // reports the track as a keyboard target after eval and the browser POSTs its key edges to
    // /api/keyNote, which drives engine.noteOn/noteOff. Schedules no notes of its own.
    this.keyboardRoute = opts.keyboardRoute ?? null;
    // Whether this signal's values are absolute MIDI notes ('note'), scale degrees ('degree'),
    // or neither/unknown (null). Only .scale() reads it: on a note pattern it quantizes each
    // value to the nearest scale tone, on a degree pattern it maps degrees to MIDI. Set by the
    // n()/note()/synth() builders and threaded through arithmetic/track metadata so
    // note("c4 e4").add(12).scale(...) still knows it's holding notes.
    this.pitchKind = opts.pitchKind ?? null;
    // Debug flag from Sig#log(): the scheduler prints one line per event this pattern fires.
    // Metadata like everything above, so it survives the rest of the chain (.log() can go
    // anywhere in it) - see _meta().
    this.logging = opts.logging ?? false;
  }

  _clone(overrides) {
    return new Sig(this.sample, {
      stepsForCycle: this.stepsForCycle,
      lfoIR: this.lfoIR,
      envIR: this.envIR,
      ccIR: this.ccIR,
      eventAt: this.eventAt,
      ...this._meta(),
      ...overrides,
    });
  }

  /** Track-building metadata carried onto every derived Sig (chain, params, channel, sampler). */
  _meta() {
    return {
      instrument: this.instrument,
      fxChain: this.fxChain,
      paramSignals: this.paramSignals,
      paramSlots: this.paramSlots,
      midiInjects: this.midiInjects,
      audioInjects: this.audioInjects,
      inputSource: this.inputSource,
      busSends: this.busSends,
      channel: this.channel,
      noteChannels: this.noteChannels,
      sampler: this.sampler,
      slotStates: this.slotStates,
      midiNotes: this.midiNotes,
      keyboardRoute: this.keyboardRoute,
      pitchKind: this.pitchKind,
      logging: this.logging,
    };
  }

  /** Maps this signal's values through `fn`; rests (null) pass through untouched. */
  mapValue(fn) {
    const mappedStepsForCycle = this.stepsForCycle
      ? (cycle) => this.stepsForCycle(cycle).map((s) => (s.value == null ? s : { ...s, value: fn(s.value) }))
      : null;
    return new Sig(
      (t, cps, pos) => {
        const v = this.sample(t, cps, pos);
        return v == null ? null : fn(v);
      },
      { stepsForCycle: mappedStepsForCycle, eventAt: mapEventAt(this, fn), ...this._meta() },
    );
  }

  /**
   * Applies a scale, in one of two ways depending on what the pattern already holds:
   *   - degree pattern (`n("0 2 3").scale("F minor")`) - reads the numbers as scale degrees and
   *     converts them to absolute MIDI notes (0 = the root, 1 = the next scale tone, ...).
   *   - note pattern (`note("c4 e4 f#4").scale("F minor")`) - quantizes each already-absolute
   *     note to the nearest tone in the scale, bending out-of-key notes into it. This is the
   *     same snap the engine does to live midikeys() notes, so pattern and live notes agree.
   * The kind comes from which builder made the values (n() -> degree, note()/synth() -> note),
   * carried through any arithmetic in between; an unmarked signal (a bare mini string) is read
   * as degrees, the historical default.
   *
   * On a sampler pattern the note/degree values live in the `.n()`/`.note()` repitch signal (the
   * pattern's own values are pack names), so scale maps that instead: s("pluck").n("0 2 4").scale(...)
   * quantizes-or-converts by that signal's kind exactly as above. On a live midikeys() route it
   * also tags the route with the scale so incoming live notes are quantized engine-side (see the
   * scheduler's setMidiNotes call and the engine's midiRoute).
   */
  scale(scaleName) {
    parseScaleName(scaleName); // validate now - a live-keys-only chain never samples, so a bad name would otherwise stay silent
    const mapFor = (kind) =>
      kind === 'note'
        ? (v) => quantizeToScale(Number(v), scaleName)
        : (v) => degreeToMidi(Number(v), scaleName);
    let out;
    if (this.sampler) {
      if (!this.sampler.note) {
        throw new Error('[signal] .scale() on a sampler needs degrees or notes first - e.g. s("pluck").n("0 2 4").scale("F minor")');
      }
      const map = mapFor(this.sampler.note.pitchKind);
      const mapped = this.sampler.note.mapValue(map);
      // The repitch note also rides on each event (step.cfg.note, see crossMerge) - that merged
      // copy is what the scheduler reads, so it has to be mapped too or .scale() would quantize
      // the channel and leave the events playing their raw degrees.
      const base = this.stepsForCycle;
      const stepsForCycle = base
        ? (cycle) =>
            base(cycle).map((s) =>
              s.cfg && s.cfg.note !== undefined ? { ...s, cfg: { ...s.cfg, note: Number(map(s.cfg.note)) } } : s,
            )
        : base;
      out = this._clone({ sampler: { ...this.sampler, note: mapped }, stepsForCycle });
    } else {
      out = this.mapValue(mapFor(this.pitchKind));
    }
    if (this.midiNotes) out = out._clone({ midiNotes: { ...this.midiNotes, scale: scaleName } });
    // A midi() source: quantize its live notes to the scale engine-side, like a midikeys() route.
    if (this.inputSource?.io === 'midi') out = out._clone({ inputSource: { ...this.inputSource, scale: scaleName } });
    // A keyboard()/tap() route carrying a fixed pitch (from .note()/.n()): map that pitch too, so
    // tap().n("0").scale("F minor") strikes the scale's root rather than a bare degree 0.
    if (this.keyboardRoute?.note) {
      const nSig = this.keyboardRoute.note;
      out = out._clone({ keyboardRoute: { ...this.keyboardRoute, note: nSig.mapValue(mapFor(nSig.pitchKind)) } });
    }
    out.pitchKind = 'note'; // the result now holds absolute MIDI notes, whichever way we got here
    return out;
  }

  /**
   * Rescales a 0..1-ish signal (LFO/env builders) into [min,max] - shorthand for
   * `.mul(max - min).add(min)`. Bounds may themselves be signals (a mini string, a Sig, ...):
   * `lfo().range("200 300", 4000)` sweeps 200..4000 in the first half of the cycle and
   * 300..4000 in the second. Signal bounds on a Tier-2 modulator (LFO/env) stay symbolic:
   * the bound signals ride along in the IR and the scheduler polls just them, updating the
   * running native modulator's lo/hi in place - so even env() and note-synced lfo() shapes,
   * whose values only exist engine-side, take signal bounds.
   */
  range(min, max) {
    if (typeof min === 'number' && typeof max === 'number') {
      if (this.lfoIR) return withLfoIR({ ...this.lfoIR, min, max });
      if (this.envIR) return withEnvIR({ ...this.envIR, min, max });
      if (this.ccIR) return withCcIR({ ...this.ccIR, min, max });
      return this.mapValue((v) => min + v * (max - min));
    }
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, min: toBound(min), max: toBound(max) });
    if (this.envIR) return withEnvIR({ ...this.envIR, min: toBound(min), max: toBound(max) });
    if (this.ccIR) return withCcIR({ ...this.ccIR, min: toBound(min), max: toBound(max) });
    const minSig = toSignal(min);
    return this.mul(toSignal(max).sub(minSig)).add(minSig);
  }

  /**
   * Speeds playback up: `.fast(2)` fits two cycles of the pattern into every cycle; `.fast(1/2)`
   * (= `.slow(2)`) stretches it over two. A NEGATIVE factor plays the pattern in reverse -
   * `.fast(-1)` is reverse playback at normal speed, `.fast(-2)` reversed double-time. The step
   * grid, ties/ringing tails, and per-event controls attached BEFORE the .fast() (.vel(), sampler
   * .i()/.speed()/...) all warp together, so their values stay aligned with their events;
   * track-level params and channel modulators (.param(sine(...)), .gain(env())...) stay in real
   * time. On an LFO builder it multiplies the rate instead - sine(2).fast(2) runs at 4 Hz - use
   * .rate() to set an LFO's rate absolutely.
   */
  fast(factor) {
    // A PATTERNED factor - a mini string or any step Sig - lets the rate vary across the cycle,
    // mirroring mini-notation's "a*[2 3]": each rate step is a window in which the whole pattern
    // plays sped by that window's rate (only onsets landing inside the window sound). A plain
    // number (or numeric-valued factor) keeps the exact fast path below.
    //
    // Every signal kind counts as patterned except a constant: a Sig with no grid of its own (an
    // LFO, a macro knob, `rand()`) is read once per cycle (.hold()) and drives the rate like any
    // other pattern, and a constant-valued Sig - Signal(2), or the mini("2", …) the editor's
    // location transpile makes of a `"2"` literal - takes the exact numeric path below.
    const factorSig = factor instanceof Sig ? factor : null;
    if (typeof factor === 'string' || (factorSig && factorSig.constVal === undefined)) {
      return this._fastPatterned(factorSig && !factorSig.stepsForCycle ? factorSig.hold() : toSignal(factor));
    }
    const f = Number(factorSig ? factorSig.constVal : factor);
    if (!Number.isFinite(f) || f === 0) {
      throw new Error('[signal] .fast() takes a nonzero factor, e.g. .fast(2) - negative plays in reverse');
    }
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, rateHz: this.lfoIR.rateHz * f });
    if (this.envIR) {
      throw new Error("[signal] .fast() on an env() isn't supported - envelope times are set in its options");
    }
    if (f === 1) return this;
    // Result time P reads source time P*f, for the continuous sample and the step grid alike.
    // The tiny negative-direction nudge keeps an onset-time sample (how the scheduler reads
    // .vel()/sampler configs) inside its own source step: reversed, an onset maps exactly onto
    // its source step's exclusive END boundary, which would otherwise read the neighbour.
    const srcTime = (x) => x * f - (f < 0 ? 1e-6 : 0);
    const warp = (sig) =>
      sig instanceof Sig
        ? new Sig((t, cps, pos) => sig.sample(srcTime(t), cps, pos == null ? undefined : srcTime(pos)), {
            stepsForCycle: warpSteps(sig.stepsForCycle, f),
            ...sig._meta(),
          })
        : sig;
    const out = warp(this);
    if (this.sampler) {
      out.sampler = Object.fromEntries(Object.entries(this.sampler).map(([k, v]) => [k, warp(v)]));
    }
    out.noteChannels = Object.fromEntries(Object.entries(this.noteChannels).map(([k, v]) => [k, warp(v)]));
    return out;
  }

  /** `.slow(4)` spreads the pattern over 4 cycles - the inverse of .fast(). Negative reverses too. */
  slow(factor) {
    // Patterned factor: slow by a pattern is fast by its reciprocal, per window (.slow("2 3") =
    // .fast("0.5 0.333...")). mapValue keeps the factor's step grid, inverting each rate value.
    // Same "what counts as patterned" rule as .fast() above.
    const factorSig = factor instanceof Sig ? factor : null;
    if (typeof factor === 'string' || (factorSig && factorSig.constVal === undefined)) {
      const rate = factorSig && !factorSig.stepsForCycle ? factorSig.hold() : toSignal(factor);
      return this.fast(rate.mapValue((v) => 1 / Number(v)));
    }
    const f = Number(factorSig ? factorSig.constVal : factor);
    if (!Number.isFinite(f) || f === 0) {
      throw new Error('[signal] .slow() takes a nonzero factor, e.g. .slow(2) - negative plays in reverse');
    }
    return this.fast(1 / f);
  }

  // Patterned .fast() (see fast()): warps the step grid by a rate that varies across the cycle.
  // Only meaningful on a step pattern; the factor's own step grid supplies the windows. velocity
  // and sampler-config sub-signals warp alongside so their per-onset values stay aligned.
  _fastPatterned(factorSig) {
    if (this.lfoIR || this.envIR || !this.stepsForCycle) {
      throw new Error('[signal] a patterned .fast()/.slow() factor needs a step pattern, e.g. n("0 1 2").fast("2 3")');
    }
    // A factor that never yields a usable rate (a non-numeric token like "x", or a constant 0) is
    // a user error, flagged now at eval time rather than silently producing an empty grid - same
    // guard the numeric path applies. Check the first couple of cycles so an alternation whose
    // first pick is a rest ("<~ 2>") isn't misjudged.
    const usable = [0, 1].some((c) => factorWindows(factorSig, c).some((w) => Number.isFinite(w.rate) && w.rate !== 0));
    if (!usable) {
      throw new Error('[signal] .fast()/.slow() takes a nonzero factor or a numeric rate pattern, e.g. .fast(2) or .fast("2 3")');
    }
    const patWarp = (sig) => {
      if (!(sig instanceof Sig) || !sig.stepsForCycle) return sig; // constants/LFOs stay real-time
      const swc = warpStepsWindowed(sig.stepsForCycle, factorSig);
      return new Sig((t, cps, pos) => sampleViaSteps(swc, t, cps, pos), { stepsForCycle: swc, ...sig._meta() });
    };
    const out = patWarp(this);
    if (this.sampler) out.sampler = Object.fromEntries(Object.entries(this.sampler).map(([k, v]) => [k, patWarp(v)]));
    out.noteChannels = Object.fromEntries(Object.entries(this.noteChannels).map(([k, v]) => [k, patWarp(v)]));
    return out;
  }

  /** Sets an LFO's rate in Hz, absolutely (unlike .fast(), which multiplies the current rate). */
  rate(rateHz) {
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, rateHz });
    throw new Error('[signal] .rate() only applies to LFO signals - on a pattern use .fast()/.slow()');
  }
  phase(phaseCycles) {
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, phaseCycles });
    throw new Error('.phase() on a non-LFO signal is not supported yet');
  }

  /**
   * Sets which plugin (by id, from native-engine's scanned plugin list) is this track's
   * instrument. `config.state` (an opaque captured-state string - use the "pin" button in the
   * editor's track panel to write it into the code) restores the plugin's full saved state on
   * load, Ableton-style, so a shared/reloaded session sounds identical.
   */
  synth(pluginId, config) {
    return this._clone({
      instrument: pluginId,
      ...(config?.state ? { slotStates: { ...this.slotStates, 0: config.state } } : {}),
    });
  }

  /**
   * Appends an effect plugin to this track's chain, after the instrument and any prior .fx()
   * calls. Takes the same optional `{ state }` second argument as synth().
   */
  fx(pluginId, config) {
    const slot = this.fxChain.length + 1; // this fx's chain slot (0 = instrument)
    return this._clone({
      fxChain: [...this.fxChain, pluginId],
      ...(config?.state ? { slotStates: { ...this.slotStates, [slot]: config.state } } : {}),
    });
  }

  /**
   * Channel strip: the track's output gain (1 = unity, applied after the whole plugin chain).
   * Accepts numbers, mini strings, or any signal - `.gain(env())` is a per-note VCA,
   * `.gain("1 0.5 1 0.5")` a stepped tremolo.
   *
   * Chainable: `.gain(a).gain(b)` multiplies (overall gain = a*b), so a base level and a
   * modulator compose - `.gain(0.5).gain(env())`. Multiplying a plain number onto a Tier-2
   * gain modulator (LFO/env/cc) stays symbolic (scales its bounds), so it keeps the native
   * fast path; two signal gains multiply into one polled (Tier-1) signal.
   */
  gain(value) {
    const incoming = toSignal(value);
    const combined = this.channel.gain ? multiplyGain(this.channel.gain, incoming) : incoming;
    return this._clone({ channel: { ...this.channel, gain: combined } });
  }

  /** Channel strip: stereo pan, -1 (left) .. 1 (right), 0 = center. Signals welcome: `.pan(sine(0.2).range(-1, 1))`. */
  pan(value) {
    return this._clone({ channel: { ...this.channel, pan: toSignal(value) } });
  }

  /**
   * Channel strip: which stereo output pair the track plays to - .o(1) sends to output
   * channels 1/2 (the default), .o(2) to 3/4, and so on. Pairs past the device's last one wrap
   * around, so .o(2) on a stereo interface is channels 1/2 again. Takes the same value kinds
   * as .gain()/.pan(): `.o("1 2")` alternates pairs each half-cycle.
   */
  o(value) {
    return this._clone({ channel: { ...this.channel, out: toSignal(value) } });
  }

  /**
   * Sends `amount` of this track's output to a named audio bus, so several tracks can be summed and
   * processed together: give any number of tracks the same bus name and their outputs mix into it,
   * then read the sum on another track with the audio("name") head source and run it through one
   * chain -
   *
   *   kick:  s("bd*4").bus("drums")
   *   snare: s("~ sn").bus("drums")
   *   drums: audio("drums").fx("Saturn 2")   // the summed kick+snare, distorted once, to master
   *
   * A track may call .bus() more than once to feed several buses at once (e.g. a reverb bus and a
   * delay bus). This is an aux *send* - it doesn't touch the dry signal still going to the track's
   * own output pair; control that independently with .dry() (or use .bsend() to send and mute the
   * dry in one call). `amount` defaults to 1. The bus is created on first use and freed when
   * nothing references it; reading a bus that no track feeds is silence.
   */
  bus(name, amount = 1) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('[signal] .bus() takes a bus name, e.g. .bus("drums")');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error('[signal] .bus() amount must be a number (a send level), e.g. .bus("reverb", 0.3)');
    }
    return this._clone({ busSends: [...this.busSends, { name: name.trim(), amount }] });
  }

  /**
   * How much of the dry signal still reaches this track's own output pair, sampled per onset like
   * .gain()/.pan(). Defaults to 1 (untouched). Independent of .bus() sends, so .dry(0) mutes the
   * direct output while any bus sends keep carrying the signal - the basis of .bsend().
   */
  dry(value) {
    return this._clone({ channel: { ...this.channel, dry: toSignal(value) } });
  }

  /**
   * Bus send with the dry killed: `.bsend("reverb")` is exactly `.bus("reverb").dry(0)` - route the
   * track entirely into the bus and stop it playing directly. `amount` scales the send (default 1).
   */
  bsend(name, amount = 1) {
    return this.bus(name, amount).dry(0);
  }

  /**
   * Per-note velocity, sampled at each onset. On synth tracks it becomes MIDI velocity (0..1);
   * on sampler tracks it scales the sample's volume linearly. A patterned vel also gives the
   * track structure: events are split on vel's step grid (a `~` drops the event), each fresh
   * vel step retriggers, and each event is gated to its step - so s("long").vel("1 1 ~ 1")
   * plays three quarter-cycle hits that stop ringing at their step ends (Ableton Sampler
   * "gate" mode), instead of one full-length sample.
   */
  vel(value) {
    const sig = toSignal(value);
    // Velocity is a note channel (see Sig#noteChannels): a discrete/patterned vel cross-merges onto
    // the note steps, subdividing + retriggering the events it overlaps and carrying its value as
    // step.vel (right-winning any upstream per-step vel from .as("note:vel")/pianoroll); a
    // continuous vel (vel(sine)/vel(0.6)) has no grid, so crossMerge no-ops and the scheduler
    // samples the channel at each onset instead. Synth and sampler tracks carry it identically -
    // the walker reads step.vel / the channel uniformly, mapping it to MIDI velocity or sample gain.
    const stepsForCycle = crossMerge(this.stepsForCycle, sig, stampField('vel'));
    return this._clone({ noteChannels: { ...this.noteChannels, vel: sig }, stepsForCycle });
  }

  /**
   * Multiplies each event's duration, sampled per onset: `.clip(2)` makes every note ring for
   * twice its step width; `.clip("<1 4 1>*4")` reads the control at each event (structure
   * stays with the pattern, unlike .vel()). Same knob as the `clip` field in
   * .as("note:vel:clip") - the noteOff just lands later (possibly in a following cycle), like
   * a mini-notation tie's ringing tail. Non-positive or missing control values fall back to 1.
   */
  clip(value) {
    if (!this.stepsForCycle) {
      throw new Error('[signal] .clip() needs a step pattern, e.g. n("0 3 5").clip(2)');
    }
    const sig = toSignal(value);
    // clip is a note channel (see Sig#noteChannels) so it survives a later pitch swap. Unlike vel it
    // doesn't carry a merged value - it stretches each event's END (its ringing duration) - so it's
    // applied by applyClip rather than crossMerge.
    const stepsForCycle = applyClip(this.stepsForCycle, sig);
    return this._clone({ noteChannels: { ...this.noteChannels, clip: sig }, stepsForCycle });
  }

  /**
   * Sets any named parameter (by its real VST parameter name - see the params panel /
   * autocomplete in the editor), targeting whatever's last in the chain right now.
   */
  param(name, value) {
    const slotIndex = this.fxChain.length; // 0 = instrument, 1..n = effects, in call order
    const sig = toSignal(value);
    return this._clone({
      paramSignals: { ...this.paramSignals, [name]: sig },
      paramSlots: { ...this.paramSlots, [name]: slotIndex },
    });
  }

  /**
   * Injects MIDI into the plugin last added to the chain, alongside (and independent of) the
   * track's own notes. Two argument forms:
   *
   *   bass: note("c2*8").synth("Serum 2").fx("Kickstart").midi("kick")   // ducked by kick's rhythm
   *   lead: synth("Serum 2").fx("Arp").midi("KeyStep")                    // hardware keys drive the arp
   *
   * `source` is another track's label or a MIDI device, resolved track-first (a connected device
   * is matched case-insensitively by substring); prefix "track:"/"dev:" to force one. A track
   * source replays its notes into the plugin - a melodic track passes its pitch through, a drum
   * track fires a fixed note (default MIDI 60 / c5; `{ note }` overrides) on each hit, which is
   * what a ducker wants. Like .param() it targets whatever plugin is last in the chain, so put
   * .midi() right after the .fx(...) it should drive. As a *source* at the head of a track, the
   * bare midi("...") builder plays that input on the track's own instrument instead - see midi().
   */
  midi(source, opts = {}) {
    const slot = this.fxChain.length; // 0 = instrument, 1..n = fx, in call order (last one)
    if (slot < 1) {
      throw new Error('[signal] .midi() injects into an effect - put it after an .fx(...), e.g. .fx("Kickstart").midi("kick")');
    }
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('[signal] .midi() takes a source name - a track label or a MIDI device, e.g. .midi("kick")');
    }
    const note = Math.round(opts.note ?? DEFAULT_TRIG_NOTE);
    return this._clone({ midiInjects: [...this.midiInjects, { slot, name: source.trim(), note }] });
  }

  /**
   * Injects audio into the plugin last added to the chain, as that plugin's auxiliary (sidechain)
   * input - so an audio-keyed ducker or compressor responds to the source:
   *
   *   bass: note("c2*8").synth("Serum 2").fx("Pro-C 2").audio("kick")   // Pro-C's sidechain = kick
   *   kick: s("bd*4")
   *
   * `source` is another track's label, or a hardware audio input (resolved track-first, same as
   * .midi(); prefix "track:"/"dev:" to force). `{ gain }` scales the amount sent (default 1). Put
   * .audio() right after the .fx(...) whose sidechain input it should feed - it needs an effect,
   * since the instrument has no audio input. The engine routes the cross-track audio and orders
   * the source ahead of this track so the send lands the same block. As a *source* at the head of
   * a track, the bare audio("...") builder feeds that input through the chain - see audio().
   */
  audio(source, opts = {}) {
    const slot = this.fxChain.length; // last plugin in the chain (0 = instrument)
    if (slot < 1) {
      throw new Error('[signal] .audio() feeds an effect\'s aux input - put it after an .fx(...), e.g. .fx("Pro-C 2").audio("kick")');
    }
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('[signal] .audio() takes a source name (track or audio input), e.g. .audio("kick")');
    }
    return this._clone({ audioInjects: [...this.audioInjects, { slot, name: source.trim(), gain: opts.gain ?? 1 }] });
  }

  // -------------------------------------------------------------------------------------------
  // Arithmetic / comparison operators. Structure comes from the left: `mini("0 3 5").add(12)`
  // keeps "0 3 5"'s step grid. The right side may be a number, a mini string, or another Sig.
  // -------------------------------------------------------------------------------------------

  _assertSampleable(op) {
    if (this.envIR) {
      throw new Error(
        `[signal] .${op}() on an envelope isn't supported - an envelope's value only exists inside the engine. Shape it with .range()/env({curve}) instead`,
      );
    }
  }

  _unop(op, fn) {
    this._assertSampleable(op);
    return this.mapValue((v) => fn(Number(v)));
  }

  /**
   * `linear: true` marks ops where a plain-number operand can be applied to a Tier-2 LFO/env
   * symbolically (rewriting min/max), keeping it a native, sample-accurate modulator instead of
   * demoting it to polled JS sampling.
   */
  _binop(op, other, fn, linear) {
    // A CONTROL operand - one of the top-level sampler builders, `speed("-1")`/`begin(0.5)`/… -
    // names a CHANNEL rather than a value stream, so the operation lands on that channel instead
    // of on this pattern's own values: `x.mul(speed("-1"))` lands on the speed channel and leaves
    // the notes alone. This is what lets a combinator reach into a pattern it was handed
    // (`.when(c, x => x.add(flip(1)))`), the same way `x.add(note(3))` reaches into pitch.
    if (other instanceof Sig && other.ctl) return this._ctlBinop(other.ctl, other, fn);
    // On a sampler pattern the values are PACK NAMES, so plain arithmetic can only sensibly mean
    // the repitch note (24 = "c2" = as recorded): `s("rave").add(7)` is seven semitones up, the
    // same thing `s("rave").add(note(7))` says. Without this the pack name coerces to NaN.
    if (this.sampler) return this._ctlBinop('note', other, fn);
    if (typeof other === 'number' && linear) {
      // Bounds may be signals (see range()) - map those through fn instead of applying it directly.
      const mapBound = (b) => (typeof b === 'number' ? fn(b, other) : b.mapValue((v) => fn(Number(v), other)));
      if (this.lfoIR) return withLfoIR({ ...this.lfoIR, min: mapBound(this.lfoIR.min), max: mapBound(this.lfoIR.max) });
      if (this.envIR) return withEnvIR({ ...this.envIR, min: mapBound(this.envIR.min), max: mapBound(this.envIR.max) });
      if (this.ccIR) return withCcIR({ ...this.ccIR, min: mapBound(this.ccIR.min), max: mapBound(this.ccIR.max) });
    }
    this._assertSampleable(op);
    const otherSig = toSignal(other);
    // Steps only know cycle positions (not seconds), so for step values the right side is
    // sampled in cycle-time (t=cyclePos, cps=1) - exact for mini/constant operands, approximate
    // for an LFO operand inside a note pattern. The continuous sample() path below stays in
    // real time, so param-signal math is always exact.
    const stepsForCycle = this.stepsForCycle
      ? (cycle) => {
          const otherSteps = otherSig.stepsForCycle ? otherSig.stepsForCycle(cycle) : null;
          const out = [];
          for (const s of this.stepsForCycle(cycle)) {
            if (s.value == null) {
              out.push(s);
              continue;
            }
            const mid = (s.start + s.end) / 2;
            // A `,`-stack on the right is several values sounding AT ONCE, so it fans each event
            // out into one event per layer instead of collapsing to whichever layer sample() picks:
            // `.add(note("0,7"))` keeps the note and sounds its fifth alongside it, `.add("-0.3,0.3")`
            // detunes two ways at once. Layers cross-product with the left's own stack, so a chord
            // plus a stacked offset gives every combination - which is what "both at the same time"
            // means either side of the operator.
            const layers = otherSteps ? coveringSteps(otherSteps, mid) : [];
            if (layers.length > 1) {
              for (const b of layers) {
                out.push({ ...s, value: fn(Number(s.value), Number(b.value)), locs: [...stepLocs(s), ...stepLocs(b)] });
              }
              continue;
            }
            const b = otherSig.sample(cycle + mid, 1);
            if (b == null) {
              out.push({ ...s, value: null });
              continue;
            }
            // Union the highlight spans of both operands, so `n("0 1").add("7 0")` lights the
            // live atom in each literal - the value that sounds genuinely propagated from both.
            const locs = layers.length === 1 ? [...stepLocs(s), ...stepLocs(layers[0])] : stepLocs(s);
            out.push({ ...s, value: fn(Number(s.value), Number(b)), locs });
          }
          return out;
        }
      : null;
    // A left operand with no honest grid (choose/irand) keeps its per-onset reader through the
    // arithmetic, so `.begin(irand(16).div(16))` still draws at every event rather than freezing
    // the cycle's first draw - and the step grid the highlighter reads agrees with what plays.
    // The right operand's reader is folded in there but can't create one: when the LEFT has a real
    // grid that structure is honest and must survive (n("0 1").add(irand(12)) keeps its two steps).
    // One event in, one event out here - a per-onset reader has no grid to fan a stacked operand
    // out into, so `,`-stacking only multiplies events on the step path above.
    const eventAt = this.eventAt
      ? (cyclePos) => {
          const a = readEvent(this, cyclePos);
          if (a.value == null) return { value: null, locs: a.locs };
          const b = readEvent(otherSig, cyclePos);
          if (b.value == null) return { value: null, locs: [...a.locs, ...b.locs] };
          return { value: fn(Number(a.value), Number(b.value)), locs: [...a.locs, ...b.locs] };
        }
      : null;
    return new Sig(
      (t, cps, pos) => {
        const a = this.sample(t, cps, pos);
        if (a == null) return null;
        const b = otherSig.sample(t, cps, pos);
        return b == null ? null : fn(Number(a), Number(b));
      },
      { stepsForCycle, eventAt, ...this._meta() },
    );
  }

  /**
   * Arithmetic aimed at one sampler CHANNEL rather than at the pattern's values (see _binop and
   * the control builders below). The channel's current signal is the left operand; where it isn't
   * set yet the channel's resting default stands in - 1 for speed/stretch, 0 for begin, 24 for the
   * repitch note - so `x.mul(speed("-1"))` on a pattern with no explicit speed is 1 * -1, and
   * `s("rave").add(7)` is "as recorded, seven semitones up". With the channel unset the OPERAND
   * supplies the step structure (via mapValue), so `x.mul(speed("1 -1"))` subdivides exactly as
   * `.speed("1 -1")` does.
   */
  _ctlBinop(ctl, other, fn) {
    const spec = SAMPLER_CONTROLS[ctl];
    if (!this.sampler) {
      throw new Error(`[signal] ${ctl}() only applies to a sampler pattern - start with s("pack")`);
    }
    // fit() with no argument carries no number to combine with - it just sets the channel.
    if (other instanceof Sig && other.ctlAuto) return this._samplerOpt(ctl, spec.key, 'auto');
    const otherSig = bareSig(toSignal(other));
    const current = this.sampler[spec.key];
    const combined =
      current instanceof Sig
        ? bareSig(current)._binop(ctl, otherSig, fn, false)
        : otherSig.mapValue((v) => fn(spec.unset, Number(v)));
    // The repitch channel keeps its note/degree kind, so a later .scale() still reads it right.
    if (spec.key === 'note') combined.pitchKind = current?.pitchKind ?? otherSig.pitchKind ?? 'note';
    return this._samplerOpt(ctl, spec.key, combined);
  }

  add(x) { return this._binop('add', x, (a, b) => a + b, true); }
  sub(x) { return this._binop('sub', x, (a, b) => a - b, true); }
  mul(x) { return this._binop('mul', x, (a, b) => a * b, true); }
  div(x) { return this._binop('div', x, (a, b) => a / b, true); }
  mod(x) { return this._binop('mod', x, (a, b) => ((a % b) + b) % b, false); }
  round() { return this._unop('round', Math.round); }
  abs() { return this._unop('abs', Math.abs); }
  floor() { return this._unop('floor', Math.floor); }
  ceil() { return this._unop('ceil', Math.ceil); }
  /** Bounds each value into [lo, hi]. Both bounds take patterns/signals, like every other control. */
  clamp(lo, hi) {
    return this._binop('clamp', lo, (a, b) => Math.max(a, b), false)._binop('clamp', hi, (a, b) => Math.min(a, b), false);
  }

  gte(x) { return this._binop('gte', x, (a, b) => (a >= b ? 1 : 0), false); }
  gt(x) { return this._binop('gt', x, (a, b) => (a > b ? 1 : 0), false); }
  lte(x) { return this._binop('lte', x, (a, b) => (a <= b ? 1 : 0), false); }
  lt(x) { return this._binop('lt', x, (a, b) => (a < b ? 1 : 0), false); }
  eq(x) { return this._binop('eq', x, (a, b) => (a === b ? 1 : 0), false); }
  neq(x) { return this._binop('neq', x, (a, b) => (a !== b ? 1 : 0), false); }

  /**
   * `n("0 1 2 3").when("1 0", x => x.add(12))` - applies `fn` to this pattern wherever `cond` is
   * truthy (nonzero). Where cond is falsy (including rests) the original pattern plays.
   *
   * The condition is READ BY THE INCOMING EVENTS: it is sampled at the onsets the pattern
   * already has, and never contributes triggers of its own, whether or not it has a grid.
   * So the events decide how finely it can change -
   *
   *   s("breaks:197").fit().seg(8).when(rand().gte(0.5), x => x.flip(1))  // eight coins a bar
   *   s("breaks:197").fit().when(rand().gte(0.5), x => x.flip(1))         // one a bar
   *   s("bd").when("1 0 1 0", x => x.mul(speed(-1)))                      // ONE hit, decided once
   *
   * (Structure the callback adds is still structure - `x => x.ply(4)` retriggers as it says.)
   *
   * Per-onset controls the callback set switch WITH the condition - sampler config and velocity -
   * so `.when(rand().gte(0.7), x => x.add(flip(1)))` reverses only the bars the condition
   * picks. Everything the callback did that can't be turned on and off per event stays
   * unconditional: the chain (.synth()/.fx()), the streamed channel strip (.gain()/.pan()) and
   * .param() signals, whose "off" state would be an unknown value to revert to rather than an
   * absent one. Put those inside the pattern you pass in, not inside the callback.
   */
  when(cond, fn) {
    const condSig = toSignal(cond);
    const transformed = fn(this);
    if (!(transformed instanceof Sig)) throw new Error('[signal] .when() callback must return a pattern');
    const truthy = (v) => v != null && Number(v) !== 0;

    const sample = (t, cps, pos) => (truthy(condSig.sample(t, cps, pos)) ? transformed : this).sample(t, cps, pos);

    // Where the condition is READ, in cycle time: at the incoming events, always. The pattern
    // arriving from OUTSIDE the .when() owns the structure, and the condition is sampled on its
    // onsets even when the condition has a grid of its own - nothing written inside a .when() can
    // introduce a trigger the pattern didn't already have. So .seg(8).when(rand().gte(0.5), ...)
    // reads a fresh coin per eighth because the eighths are there to read it on, and
    // s("bd").when("1 0 1 0", ...) is still ONE hit, deciding once, rather than four.
    //
    // Spans run onset to onset (with a filler from 0 to the first), and neighbours that agree -
    // same truthiness, same condition atom - merge rather than split, so a callback that lengthens
    // events (.slow(2)) isn't chopped back up at boundaries where nothing changed. The atom read at
    // each onset rides along on the span, so the "<0 1>" currently choosing lights up in the editor
    // alongside the notes it gates.
    const locKey = (locs) => locs.map((l) => (Array.isArray(l) ? l.join(':') : String(l))).join('|');
    const condStepsAt = (cycle) => {
      const own = this.stepsForCycle ? this.stepsForCycle(cycle) : null;
      // Real onsets only: a rest is not an event, and a continuation ("_", "@") is the same event
      // still sounding, so neither is an instant at which the condition gets to change its mind.
      const onsets = [
        ...new Set([0, ...(own ?? []).filter((s) => s.value != null && !s.cont).map((s) => s.start)]),
      ]
        .filter((x) => x >= 0 && x < 1)
        .sort((a, b) => a - b);
      const out = [];
      for (let k = 0; k < onsets.length; k++) {
        const start = onsets[k];
        const end = onsets[k + 1] ?? 1;
        const ev = readEvent(condSig, cycle + start);
        const key = locKey(ev.locs);
        const prev = out[out.length - 1];
        if (prev && truthy(prev.value) === truthy(ev.value) && prev.key === key) {
          prev.end = end;
          continue;
        }
        out.push({ start, end, value: ev.value, key, ...(ev.locs.length ? { locs: ev.locs } : {}) });
      }
      return out;
    };

    // The condition read in CYCLE time, exactly the way the step grid below reads it: the per-onset
    // controls have to flip on the same events the notes do, and an LFO/rand condition sampled in
    // real seconds (as sample() above does) would disagree with the grid it just gated.
    const condAtCycle = (cyclePos) => {
      const cycle = Math.floor(cyclePos);
      const phase = cyclePos - cycle;
      const c = fillCondGaps(condStepsAt(cycle)).find((x) => phase >= x.start && phase < x.end);
      return c ? c.value : null;
    };

    const stepsForCycle = this.stepsForCycle
      ? (cycle) => {
          const out = [];
          for (const c of fillCondGaps(condStepsAt(cycle))) {
            const branch = truthy(c.value) ? transformed : this;
            if (!branch.stepsForCycle) continue;
            // The condition atom currently selecting here (a "<0 1>" pick) lights up alongside the
            // note it gates - its span rode in on the cond step (empty for a synthesized gap fill).
            const condLocs = stepLocs(c);
            for (const s of branch.stepsForCycle(cycle)) {
              const start = Math.max(s.start, c.start);
              const end = Math.min(s.end, c.end);
              if (start < end) {
                const locs = condLocs.length ? [...stepLocs(s), ...condLocs] : undefined;
                out.push({ ...s, start, end, ...(locs ? { locs } : {}) });
              }
            }
          }
          return out;
        }
      : null;

    // Track metadata comes from the transformed side - fn may have added an .fx()/.param(); those
    // apply unconditionally. The controls the scheduler reads PER ONSET are the exception: they
    // switch with the condition (see condSwitchMap), because "off" there is simply an absent
    // value, which every reader already resolves to the right default.
    const switched = (before, after, skip) => condSwitchMap(before, after, condAtCycle, truthy, skip);
    return new Sig(sample, {
      stepsForCycle,
      ...transformed._meta(),
      // clip is left out: it has already been baked into both grids (applyClip), so switching the
      // channel too would stretch a re-merged grid twice.
      noteChannels: switched(this.noteChannels, transformed.noteChannels, CLIP_ONLY),
      // Only when the callback's result is still a sampler pattern - a callback that swapped the
      // track for a synth one has no channels to switch, and must not be handed a sampler back.
      ...(transformed.sampler ? { sampler: switched(this.sampler, transformed.sampler) } : {}),
    });
  }

  /** Envelope curve (see env()): negative = exponential-ish scoop, 0 = linear, positive = bulge. */
  curve(c) {
    if (this.envIR) return withEnvIR({ ...this.envIR, curve: c });
    throw new Error('[signal] .curve() only applies to env() signals');
  }

  /**
   * Sample-and-hold: `rand(4).hold("1*8")` samples this signal at each truthy onset of the
   * trigger pattern and holds the value until the next one - the stepped-random ("sandy") use
   * case, but synced to any rhythm you like. Works on any sampleable signal.
   *
   * Naked `.hold()` (no argument) discretizes the signal against its OWN structure: if it already
   * has a step grid (a pattern), it re-samples the value at each of its onsets; if it's a bare
   * continuous signal (rand()/sine()/a cc), it takes one value per cycle at the cycle boundary -
   * the universal "freeze this continuous thing into strudel-cycle updates" operator.
   */
  hold(trig) {
    this._assertSampleable('hold');
    const truthy = (v) => v != null && Number(v) !== 0;
    let trigSig;
    if (trig === undefined) {
      // Naked: trigger on this signal's own onsets (every non-rest step), or once per cycle when it
      // has no structure of its own. The trigger's values are all 1 so every onset counts (a "0"
      // step is still an onset here - we're borrowing timing, not gating on the held value).
      const base = this.stepsForCycle;
      trigSig = new Sig(() => 1, {
        stepsForCycle: base
          ? (cycle) => base(cycle).filter((s) => s.value != null && !s.cont).map((s) => ({ start: s.start, end: s.end, value: 1, loc: s.loc }))
          : (cycle) => [{ start: 0, end: 1, value: 1 }],
      });
    } else {
      trigSig = toSignal(trig);
      if (!trigSig.stepsForCycle) {
        throw new Error('[signal] .hold() needs a step pattern of triggers, e.g. .hold("1*8") - or call it bare, .hold(), to freeze one value per cycle');
      }
    }

    // Most recent trigger onset at or before cyclePos (bounded lookback for sparse patterns).
    const lastOnset = (cyclePos) => {
      const from = Math.floor(cyclePos);
      for (let cycle = from; cycle >= from - 16; cycle--) {
        const onsets = trigSig
          .stepsForCycle(cycle)
          .filter((s) => truthy(s.value))
          .map((s) => cycle + s.start)
          .filter((p) => p <= cyclePos + 1e-9);
        if (onsets.length) return Math.max(...onsets);
      }
      return null;
    };

    const sample = (t, cps, pos) => {
      const cyclePos = pos ?? t * cps;
      const onset = lastOnset(cyclePos);
      if (onset == null) return this.sample(t, cps, pos);
      // Convert the onset cycle back to seconds using the current cps - exact for constant
      // tempo, a close approximation for a recent onset under a tempo signal.
      return this.sample(t - (cyclePos - onset) / cps, cps, onset);
    };

    // Steps span trigger-to-trigger; values read in cycle-time (cps=1) - same caveat as _binop for
    // real-seconds sources like LFOs; the sample() path above is always exact. Reading through
    // readEvent (rather than a bare sample) brings the source atom's highlight spans along, so a
    // held pattern lights the value it froze alongside the trigger that froze it.
    const stepsForCycle = (cycle) => {
      const steps = trigSig
        .stepsForCycle(cycle)
        .filter((s) => truthy(s.value))
        .sort((a, b) => a.start - b.start);
      return steps.map((s, i) => {
        const ev = readEvent(this, cycle + s.start);
        const locs = [...ev.locs, ...stepLocs(s)];
        return {
          start: s.start,
          end: steps[i + 1]?.start ?? 1,
          value: ev.value,
          ...(locs.length ? { locs } : {}),
          loc: s.loc,
        };
      });
    };

    return new Sig(sample, { stepsForCycle, ...this._meta() });
  }

  /**
   * `.seg(8)` - re-reads this pattern on an even grid of n steps per cycle, Strudel's
   * `segment`/`seg`. Each step is a fresh event holding whatever this pattern is worth at that
   * instant, so it's the operator that gives a *structureless* signal structure: `rand().seg(8)`
   * is eighth-note stepped random, `s("breaks:19").fit().begin(irand(8).seg(8).div(8))` fires
   * eight random slice starts per bar, and `s("breaks:19").fit().seg(16)` chops the break itself
   * into sixteen retriggers. On a pattern that already has steps it re-quantizes onto the grid
   * (each grid point takes the value sounding there; anything falling between grid points is
   * skipped) - `n("0 1 2 3").seg(2)` plays "0 2".
   *
   * `n` may be patterned: `.seg("<8 16>")` alternates bar by bar, and `.seg("4 8")` reads as the
   * windowed rate `"1*[4 8]"` does - a 4-per-cycle grid across the first half, 8-per-cycle across
   * the second. Any signal works, not just a step pattern: a gridless one (`macro1.range(2, 16)`,
   * `irand(8)`) is read once per cycle. Sample-and-hold against an arbitrary rhythm rather than an
   * even grid is `.hold()`, which this is the evenly-spaced shorthand for.
   */
  seg(n) {
    this._assertSampleable('seg');
    return this.hold(segTrigger(n));
  }

  /** Strudel spells `.seg()` both ways; so do we. */
  segment(n) {
    return this.seg(n);
  }

  /**
   * Loops a band of cycles forever: `.rib(14, 2)` plays cycles 14 and 15 over and over (Strudel's
   * `ribbon`). A query for cycle position `c` is remapped to `time + ((c - time) mod length)` -
   * exact via Frac, so a moment reached two different ways samples identically (deterministic
   * randoms stay put). Handy for freezing a good couple of bars, or looping a short window of a
   * deterministic random signal - `irand(8).rib(0, 2)` is a repeating 2-cycle random melody.
   *
   * Both arguments may be signals/patterns, sampled at the OUTER (pre-remap) cycle position so the
   * band can move: `.rib("<0 8>", 2)` loops cycles 0-1 for a while, then jumps to loop 8-9. An
   * ill-defined band (non-finite start or non-positive length) falls through as the identity, so a
   * resting/zero patterned length just plays straight rather than dividing by zero.
   *
   * A FRACTIONAL length loops a sub-cycle window: `.rib(14, 0.5)` plays the first half of cycle 14
   * twice per measure. The grid is remapped phase-aware (not floored to a whole source cycle) so the
   * notes the scheduler triggers stay in lock-step with sample()'s continuous remap.
   *
   * Every control set BEFORE the .rib() loops with it - sampler config, vel/clip, gain/pan/dry,
   * .param() signals - so `.begin(irand(16).div(16)).rib(29, 1)` freezes cycle 29's random begins
   * into a repeating bar. Controls chained after the .rib() stay outside the loop and keep
   * evolving. Native engine-side modulators (lfo()/env()/cc()) can't be remapped and run free.
   */
  rib(time, length) {
    const timeSig = toSignal(time);
    const lenSig = toSignal(length);
    // Constant args get validated up front with a helpful error; patterned args can't be checked
    // statically (they're guarded per-query in remap instead).
    if (
      timeSig.constVal !== undefined &&
      lenSig.constVal !== undefined &&
      (!Number.isFinite(timeSig.constVal) || !(lenSig.constVal > 0))
    ) {
      throw new Error('[signal] .rib(time, length) takes a start cycle and a positive length in cycles, e.g. .rib(14, 2)');
    }
    // Remap an absolute cycle position into the loop band [t0, t0+len). t0/len are sampled at the
    // outer position c so patterned args shift the band over time. Frac keeps whole-cycle bands
    // landing exactly on integer cycles (no float drift into the neighbour).
    const remap = (c) => {
      const t0 = Number(timeSig.sample(c, 1, c));
      const len = Number(lenSig.sample(c, 1, c));
      if (!Number.isFinite(t0) || !(len > 0)) return c; // ill-defined band -> identity (play straight)
      return Frac.fromNumber(c).sub(t0).mod(len).add(t0).toNumber();
    };
    // The grid is built phase-aware (remapGrid): each output cycle is walked in sub-windows split at
    // the loop-band wraps, so a fractional band loops within the cycle exactly as sample() does. For
    // a whole-cycle band this collapses to one window = one source cycle (the old fast path).
    let stepsForCycle = this.stepsForCycle
      ? (cycle) => remapGrid(cycle, this.stepsForCycle, timeSig, lenSig)
      : null;
    // rib re-times WHICH cycle sounds, so it affects the MIDI notes: a patterned time/length is
    // combined into the trigger (crossMerge) so its edges retrigger and its live atom lights
    // alongside the note (highlighting). A constant arg has no step structure, so crossMerge no-ops
    // it - only a patterned band changes anything. A resting arg passes the note through rather than
    // dropping it (crossMerge drops on a control rest), matching remap's play-straight fallback.
    if (stepsForCycle) {
      stepsForCycle = ribMergeArg(stepsForCycle, timeSig);
      stepsForCycle = ribMergeArg(stepsForCycle, lenSig);
    }
    const sample = (t, cps, pos) => {
      const c = pos ?? t * cps;
      const rc = remap(c);
      return this.sample(rc / cps, cps, rc);
    };
    // rib re-times WHICH cycle sounds, and the scheduler samples sampler config, note channels,
    // the channel strip and generic params at OUTPUT positions - so every carried control signal
    // must loop with the notes, or .begin(irand(16)).rib(29, 1) would keep drawing fresh begins
    // while the note grid repeats. Constants are position-independent, and engine-side IR signals
    // (native LFO/env/CC) run on the server's clock where a cycle remap can't reach - both pass
    // through untouched. Controls chained AFTER the .rib() stay outside the loop as before.
    const remapSig = (sig) => {
      if (!(sig instanceof Sig) || sig.constVal !== undefined || sig.lfoIR || sig.envIR || sig.ccIR) return sig;
      return new Sig(
        (t, cps, pos) => {
          const c = pos ?? t * cps;
          const rc = remap(c);
          return sig.sample(rc / cps, cps, rc);
        },
        {
          ...(sig.stepsForCycle ? { stepsForCycle: (cycle) => remapGrid(cycle, sig.stepsForCycle, timeSig, lenSig) } : {}),
          ...(sig.eventAt ? { eventAt: (cyclePos) => sig.eventAt(remap(cyclePos)) } : {}),
        },
      );
    };
    const remapObj = (obj) => obj && Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, remapSig(v)]));
    return new Sig(sample, {
      stepsForCycle,
      ...this._meta(),
      sampler: remapObj(this.sampler),
      noteChannels: remapObj(this.noteChannels),
      channel: remapObj(this.channel),
      paramSignals: remapObj(this.paramSignals),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Randomised / structural combinators (Strudel ports). Each rebuilds the step grid and routes
  // sample() through it (sampleViaSteps), so the two stay in lock-step; randomness is a
  // deterministic hash of cycle+onset (rng2), so re-queries and the highlighter always agree.
  // -------------------------------------------------------------------------------------------

  /**
   * Randomly drops notes: `.degrade(0.3)` silences each event with 30% probability (default
   * 0.5, Strudel's `.degradeBy`). The choice is deterministic per cycle+onset, so the scheduler
   * and the editor's highlighter agree and a bar replays the same each time it comes round. The
   * mini-notation `?` postfix (`"4?0.3"`) is the same operation written inside a pattern string.
   * Independent .degrade()s decorrelate on their own (each takes its own build-time seed, like
   * choose()/irand()); pass `seed` only to pin a particular one - two .degrade()s given the same
   * explicit seed deliberately drop the same events, which is how you gate two patterns together.
   */
  degrade(prob = 0.5, seed = null) {
    if (!this.stepsForCycle) {
      throw new Error('[signal] .degrade() needs a step pattern, e.g. n("0 1 2 3").degrade(0.3)');
    }
    // The probability is a control like any other and may be patterned - `.degrade("<0 0.4>")`
    // thins every other bar - read at each event's own onset. A resting/non-numeric probability
    // drops nothing.
    const probSig = toSignal(prob);
    // An explicit seed keeps its historical hash (seed + 1, so the default 0 isn't the bare 0);
    // omitted, it comes off the shared counter, out of reach of anything hand-written.
    const hashSeed = seed == null ? nextAutoSeed() : Number(seed) + 1;
    const base = this.stepsForCycle;
    const stepsForCycle = (cycle) =>
      base(cycle).map((s) => {
        if (s.value == null) return s;
        const p = Number(probSig.sample(cycle + (s.start + s.end) / 2, 1));
        return Number.isFinite(p) && rngAtPos(cycle, s.start, hashSeed) < p ? { ...s, value: null } : s;
      });
    return new Sig((t, cps, pos) => sampleViaSteps(stepsForCycle, t, cps, pos), { stepsForCycle, ...this._meta() });
  }

  /**
   * Subdivides each event into `reps` retriggers (Strudel's `ply`). The optional second argument
   * `(x, n) => signal` transforms the value on each repetition - `n` is the repetition index
   * (0..reps-1) and `x` is this whole signal - so `n("0 2").ply(3, (x, n) => x.add(n * 12))`
   * plays each degree three times, climbing an octave per hit. Omit it for a plain retrigger
   * (`s("bd").ply(2)`). The transform is sampled at the original event's onset.
   *
   * `reps` may itself be patterned - `.ply("<2 4>")`, `.ply("2 4")` - and is read at each source
   * event's onset, so the count can change through the cycle or bar by bar.
   */
  ply(reps, fn) {
    if (!this.stepsForCycle) {
      throw new Error('[signal] .ply() needs a step pattern, e.g. n("0 2").ply(3)');
    }
    // `reps` is a control like any other, so it may be patterned: it's read at each source event's
    // ONSET, which makes `.ply("<2 4>")` alternate bar by bar and `.ply("2 4")` ply the two halves
    // differently. A resting or non-numeric count means "don't subdivide" (1) rather than dropping
    // the event. Variants are built lazily now that the count isn't known up front.
    const repsSig = toSignal(reps);
    const variants = new Map();
    const variantAt = (i) => {
      if (!variants.has(i)) variants.set(i, fn ? toSignal(fn(this, i)) : this);
      return variants.get(i);
    };
    const base = this.stepsForCycle;
    const stepsForCycle = (cycle) => {
      const out = [];
      for (const s of base(cycle)) {
        if (s.value == null || s.cont) { out.push(s); continue; } // rests/ties don't subdivide
        const mid = cycle + (s.start + s.end) / 2; // read the count + the transform at the source onset
        const ev = readEvent(repsSig, mid);
        const rounded = Math.round(Number(ev.value));
        const count = Number.isFinite(rounded) ? Math.max(1, rounded) : 1;
        const w = (s.end - s.start) / count;
        // The count's own atom lights with the notes it multiplied (the live pick of a "<2 4>").
        const locs = ev.locs.length ? [...stepLocs(s), ...ev.locs] : null;
        for (let i = 0; i < count; i++) {
          const v = variantAt(i).sample(mid, 1);
          out.push({
            ...s,
            start: s.start + i * w,
            end: s.start + (i + 1) * w,
            value: v == null ? null : v,
            ...(locs ? { locs } : {}),
          });
        }
      }
      return out;
    };
    return new Sig((t, cps, pos) => sampleViaSteps(stepsForCycle, t, cps, pos), { stepsForCycle, ...this._meta() });
  }

  /**
   * Overlays `reps` delayed copies of the pattern, each offset a further `time` cycles (like a
   * tape echo): `.echo(3, 1/8)` plays the dry hit plus two repeats an eighth-cycle apart. The
   * optional `(x, n) => signal` transforms copy `n` (`n = 0` is the dry copy), so
   * `.echo(4, 1/8, (x, n) => x.gain(Math.pow(0.6, n)))` fades the tail. Copies ring across cycle
   * boundaries, reported as `cont` tails in the following cycle like a held note (so the
   * scheduler triggers each onset exactly once).
   */
  echo(reps, time = 0.25, fn) {
    if (!this.stepsForCycle) {
      throw new Error('[signal] .echo() needs a step pattern, e.g. s("bd").echo(3, 1/8)');
    }
    // Both arguments may be patterned. Unlike ply's per-event count these are read once per OUTPUT
    // cycle (at its start): the copy layout has to hold still across a cycle for the tails spilling
    // in from the previous one to line up, so `.echo("<2 4>", 1/8)` changes bar by bar rather than
    // event by event. Variants are built lazily, since the count isn't known up front.
    const repsSig = toSignal(reps);
    const timeSig = toSignal(time);
    const countAt = (cycle) => {
      const v = Math.round(Number(repsSig.sample(cycle, 1, cycle)));
      return Number.isFinite(v) ? Math.max(1, v) : 1;
    };
    const dtAt = (cycle) => {
      const v = Number(timeSig.sample(cycle, 1, cycle));
      return Number.isFinite(v) ? v : 0;
    };
    const variants = new Map();
    const variantAt = (i) => {
      if (!variants.has(i)) variants.set(i, fn ? toSignal(fn(this, i)) : this);
      return variants.get(i);
    };
    const base = this.stepsForCycle;
    const stepsForCycle = (cycle) => {
      const out = [];
      const count = countAt(cycle);
      const dt = dtAt(cycle);
      for (let n = 0; n < count; n++) {
        const shift = n * dt;
        // Copies land `shift` cycles later, so this cycle's events can originate up to a cycle
        // either side of (cycle - shift). Each source cycle's steps are distinct - no double count.
        const anchor = Math.floor(cycle - shift);
        for (let src = anchor - 1; src <= anchor + 1; src++) {
          for (const s of base(src)) {
            if (s.value == null || s.cont) continue;
            const start = src + s.start + shift - cycle;
            const end = src + s.end + shift - cycle;
            if (end <= 0 || start >= 1) continue;
            const v = variantAt(n).sample(src + (s.start + s.end) / 2, 1);
            const value = v == null ? null : v;
            // Onset before this cycle -> a ringing tail, not a fresh trigger (cont), same as a tie.
            if (start < 0) out.push({ ...s, start: 0, end, value, cont: true });
            else out.push({ ...s, start, end, value });
          }
        }
      }
      return out.sort((a, b) => a.start - b.start);
    };
    return new Sig((t, cps, pos) => sampleViaSteps(stepsForCycle, t, cps, pos), { stepsForCycle, ...this._meta() });
  }

  /**
   * Arpeggiates chords: the notes sounding SIMULTANEOUSLY become a sequence, picked out by an
   * index pattern. `0` is the chord's lowest note, `1` the next up, and so on; an index past the
   * top wraps back to the bottom an OCTAVE higher, and a negative one wraps off the top an octave
   * down. On a C-E-G triad that makes 0=c, 1=e, 2=g, 3=c+12, 4=e+12, -1=g-12, -2=e-12 - so
   * `note("[c3,e3,g3]").arp("0 1 2 3")` climbs the triad and lands on the octave.
   *
   * The index pattern is SQUEEZED into each chord's own span, mini-notation's "[...]" applied to a
   * whole signal: one full pass fits each chord however long the chord is, so `.arp("0 1 2")`
   * triplets a whole-cycle chord and puts three notes in each half of
   * `note("[c3,e3,g3] [f3,a3,c4]")`. Anything that makes a signal works as the index - a mini
   * string, `irand(3)` (a random chord tone per chord), an alternation like `"<0 1> 2"` (which
   * advances chord by chord, since each chord sees the next of the squeezed pattern's cycles) -
   * and a rest (`~`) leaves its slot silent.
   *
   * The chord at any moment is simply everything RINGING then, so the arpeggio is always one note
   * at a time (only the index pattern can stack it: `.arp("0 1 [2,3]")`). It re-reads at every
   * onset: a new note joining restarts the pass with the fuller chord, and notes of unequal length
   * - a drawn pianoroll() chord, a triad struck over a held pedal - are one chord, not several
   * overlapping arpeggios. A lone note is a chord of one, so each index is an octave
   * transposition of it (`note("c3 e3").arp("0 1")` plays each note, then its octave). The pass
   * runs until the next onset or until the chord dies away, and a chord still ringing at the
   * cycle line ("<[c3,e3,g3]@2>") picks the arpeggio up again in the next cycle.
   *
   * Octaves are MIDI octaves (+12), so on a DEGREE pattern apply `.scale()` first -
   * `n("[0,2,4]").scale("F minor").arp("0 1 2 3")` - or the wrap lands 12 scale steps up.
   */
  arp(indices) {
    if (!this.stepsForCycle) {
      throw new Error('[signal] .arp() needs a step pattern, e.g. note("[c3,e3,g3]").arp("0 1 2 3")');
    }
    if (this.sampler) {
      throw new Error('[signal] .arp() reads the pattern\'s own notes - arpeggiate before .s(), e.g. note("[c3,e3,g3]").arp("0 1 2").s("pluck")');
    }
    const idxSig = toSignal(indices);
    const base = this.stepsForCycle;
    const stepsForCycle = (cycle) => {
      const out = [];
      for (const seg of chordSegments(base(cycle))) {
        const span = seg.end - seg.start;
        // The chord's tones, low to high - the ladder the indices climb. Values are already MIDI
        // numbers on a note()/n() pattern; a bare mini string ("[c3,e3,g3]".arp(...)) still holds
        // note-name strings, so parse the same way the note() builder would.
        const tones = seg.members
          .map((m) => ({ midi: parseNoteValue(m.value), step: m }))
          .sort((a, b) => a.midi - b.midi);
        for (const idx of squeezeSteps(idxSig, cycle, seg.start, span)) {
          if (idx.value == null) continue; // a rest in the index pattern = a gap in the arpeggio
          const i = Math.round(Number(idx.value));
          if (!Number.isFinite(i)) continue;
          const len = tones.length;
          const tone = tones[((i % len) + len) % len];
          const start = seg.start + idx.start * span;
          const end = seg.start + Math.min(1, idx.end) * span; // a tie past the arp pattern's own cycle stops at the chord's end
          if (end <= start) continue;
          // Each arp note is a fresh attack even when the chord it came from was a held tail
          // (cont) - only a tie WITHIN the index pattern ("0 _ 1") stays a continuation.
          const step = { ...tone.step, start, end, value: tone.midi + 12 * Math.floor(i / len), cont: idx.cont || undefined };
          // Light the chord tone that sounded and the index that chose it, as crossMerge does.
          const locs = [...stepLocs(tone.step), ...stepLocs(idx)];
          if (locs.length) step.locs = locs;
          out.push(step);
        }
      }
      return out.sort((a, b) => a.start - b.start);
    };
    return new Sig((t, cps, pos) => sampleViaSteps(stepsForCycle, t, cps, pos), { stepsForCycle, ...this._meta() });
  }

  // -------------------------------------------------------------------------------------------
  // Sampler config - only meaningful on s("pack") patterns. Every setter accepts a number, a
  // mini string, or any Sig; the value is sampled at each event's onset, so patterns and LFOs
  // all work: s("bd").i("0 3").speed(sine(0.2).range(0.5, 2)). A patterned value also gives
  // structure, subdividing the events it overlaps - s("breaks2").slice("0 1 2 3") retriggers
  // on each slice step.
  // -------------------------------------------------------------------------------------------

  _samplerOpt(method, key, sig) {
    if (!this.sampler) {
      throw new Error(`[signal] .${method}() only applies to a sampler pattern - start with s("pack")`);
    }
    // Patterned values mix their structure into the event grid like .vel()/.note() do, so
    // s("breaks2").slice("0 1 2 3") plays four quarter-cycle events, not one, and a `,`-stacked
    // value plays its layers at once - `.speed("1.1,0.9")` is two hits, detuned apart. Each event
    // carries the layer's own value (stampCfg), which is what the scheduler reads back. 'auto'
    // (fit) and plain-number Sigs have no stepsForCycle, so crossMerge leaves the grid alone.
    const stepsForCycle = sig instanceof Sig ? crossMerge(this.stepsForCycle, sig, stampCfg(key)) : this.stepsForCycle;
    return this._clone({ sampler: { ...this.sampler, [key]: sig }, stepsForCycle });
  }

  /** Which sample of the pack to play, 0-based (wraps past the end). Strudel calls this `n`. */
  i(v) { return this._samplerOpt('i', 'index', toSignal(v)); }
  /** Playback start position within the sample, 0..1. */
  begin(v) { return this._samplerOpt('begin', 'begin', toSignal(v)); }
  /** Playback end position within the sample, 0..1. */
  end(v) { return this._samplerOpt('end', 'end', toSignal(v)); }
  /**
   * Loop the sample for the event's duration instead of playing it as a one-shot. Truthy/falsy and
   * patternable like any channel - and `.loop(0)` is also how a negative .speed() opts out of its
   * default backwards loop. HOW it loops is .loopwrap() (which region) and .loopdir() (how it
   * turns over), each its own channel:
   *
   *   s("breaks:35").fit().begin(0.9).loop()                     // ...0.9 -> 1 -> 0 -> 1 -> 0
   *   s("breaks:35").fit().slice(3).loop().loopwrap(1)           // just that slice
   *   s("breaks:35").fit().begin(0.4).loop().loopdir(1)          // 0.4 -> 1 -> 0.4 -> 1 ...
   */
  loop(v = 1, opts) {
    if (opts !== undefined) {
      throw new Error('[signal] .loop()\'s wrap/dir options are their own controls now - .loop().loopwrap(1).loopdir(1)');
    }
    return this._samplerOpt('loop', 'loop', toSignal(v));
  }
  /**
   * Which region a .loop() runs round, as a mode number (bare `.loopwrap()` means 1):
   *
   *   0 "file" (default) - the loop is the whole FILE and .begin() is only where it enters, so
   *                        .begin(0.9).loop() runs out the end and carries on from 0 instead of
   *                        repeating that last tenth over and over.
   *   1 "window"         - loop the .begin()..end() region itself. What a .slice() wants.
   *
   * A channel like any other, so it takes patterns and continuous signals: the value is rounded to
   * the nearest integer and wrapped into the mode count, so .loopwrap(rand().range(0, 2)) picks a
   * real mode per event rather than falling off the end (see LOOP_MODES).
   */
  loopwrap(v = 1) { return this._samplerOpt('loopwrap', 'loopWrap', toSignal(v)); }
  /**
   * How a .loop() turns over at the edge of its region, as a mode number (bare `.loopdir()` is 1):
   *
   *   0 "forward" (default) - reaching the far edge jumps back to the near one.
   *   1 "pingpong"          - reaching the far edge turns round, so it bounces back and forth.
   *
   * Rounds and wraps exactly like .loopwrap(), so any signal drives it: .loopdir(irand(2)).
   */
  loopdir(v = 1) { return this._samplerOpt('loopdir', 'loopDir', toSignal(v)); }
  /**
   * Playback rate (repitches) - the speed the playhead leaves .begin() at. Positive runs up to
   * .end(), 0 plays nothing, negative walks backwards out of .begin(), which wraps round to .end() - so a
   * negative speed loops by default and `.speed(-1)` plays the sample backwards from the end,
   * repeating for the event. `.loop(0)` opts out (one backwards pass). To reverse the region as a
   * single pass that lands on the beat, use .flip().
   */
  speed(v) { return this._samplerOpt('speed', 'speed', toSignal(v)); }
  /**
   * Play the window backwards INTO the beat: over 0.5 it reverses .speed() over the .begin()..
   * .end() region and delays the voice so it finishes on .begin() exactly at the step's end - a
   * flipped snare sweeps into the next hit (`s("sd").flip("<1 0>*2")`). Unlike .speed(-1) it is
   * one pass, not a backwards loop, and its timing is anchored to the step rather than the onset.
   * A switch, not a rate, so any 0..1 signal drives it: .flip(rand()).
   */
  flip(v = 1) { return this._samplerOpt('flip', 'flip', toSignal(v)); }
  /** Timestretch factor (2 = twice as long at the same pitch). Granular, so best on rhythmic material. */
  stretch(v) { return this._samplerOpt('stretch', 'stretch', toSignal(v)); }
  /**
   * Repitch so the whole sample lasts exactly `measures` cycles at the current tempo -
   * `.fit()` with no argument picks the nearest power of 2 of its natural length (2.4 measures
   * -> 2, 3.6 -> 4). The rate is set from the full file regardless of .begin()/.end()/.slice(),
   * so those select a window within the fitted sample without changing its pitch.
   */
  fit(measures = 'auto') {
    return this._samplerOpt('fit', 'fit', measures === 'auto' ? 'auto' : toSignal(measures));
  }
  /** Play the nth detected transient slice (wraps past the last one). Needs a WAV sample. */
  slice(v) { return this._samplerOpt('slice', 'slice', toSignal(v)); }

  // ADSR amplitude envelope over the voice. attack/decay/release scale the played duration:
  // .attack(0.5) fades in over half the note, .attack(2) ramps over 2x the note (never reaching
  // full before it ends). Attack->decay->sustain run across playback; once the note's duration
  // ends the envelope releases from wherever it is. sustain is a 0..1 level. All default to 0
  // (sustain 1), which floors to the tiny declick the sampler used before, so unset ADSR is
  // unchanged.
  /** Attack time as a multiple of the played duration - the fade-in from silence toward full. */
  attack(v) { return this._samplerOpt('attack', 'attack', toSignal(v)); }
  /** Decay time as a multiple of the played duration - the fall from the attack peak to the sustain level. */
  decay(v) { return this._samplerOpt('decay', 'decay', toSignal(v)); }
  /** Sustain level, 0..1 - the held level after decay (a level, not a duration). */
  sustain(v) { return this._samplerOpt('sustain', 'sustain', toSignal(v)); }
  /** Release time as a multiple of the played duration - the fade-out once the note's duration ends. */
  release(v) { return this._samplerOpt('release', 'release', toSignal(v)); }
  /** Set all four ADSR controls at once: .adsr(attack, decay, sustain, release). */
  adsr(a, d, s, r) {
    let out = this;
    if (a !== undefined) out = out.attack(a);
    if (d !== undefined) out = out.decay(d);
    if (s !== undefined) out = out.sustain(s);
    if (r !== undefined) out = out.release(r);
    return out;
  }

  /**
   * Note pattern for this track - works before or after .synth(): note("c3 e3").synth("X")
   * and synth("X").note("c3 e3") are equivalent (on a synth track this replaces the track's
   * note events, keeping the chain/params/channel metadata).
   *
   * On a sampler pattern it repitches instead: 24 ("c2") plays the sample as recorded, 36 an
   * octave up. Takes note names, numbers, mini strings, or any Sig, sampled per onset. A
   * patterned note also gives structure - each fresh note step retriggers the sample, gated
   * to its step - so s("pluck").note("45 52 _ 57") plays a melodic line from one sample.
   */
  note(value) {
    return this._noteLike(note(value));
  }

  /**
   * Scale-degree pattern for this track - n()'s builder semantics as a method, so it too works
   * before or after .synth(), and on samplers: s("pluck").n("0 2 4").scale("F minor") repitches
   * by degree exactly like a synth melody (degrees are plain numbers until .scale()).
   */
  n(value) {
    return this._noteLike(n(value));
  }

  /**
   * Destructures multi-field tokens into separate note/velocity/duration controls, Strudel-style:
   * `"<36:1:4 ~ 47:0.5:3 ~>*8".as("note:vel:clip")`. Each token's fields are split on ":" and
   * read in the order the spec names them. Fields: `note` (MIDI number or note name), `n`
   * (scale degree - map it with .scale() afterwards), `vel` (0..1 velocity for that one
   * event), `clip` (duration as a multiple of the token's own step width - at *8, clip 3 rings
   * for three eighth-slots). Missing/empty fields keep their defaults (vel 1, clip 1). This is
   * the form the editor's midi-record writes in place of a kb()/midikeys()/keyboard() call.
   *
   * Each field is set onto the SAME channel the equivalent method would use - `note`/`n` become
   * the pitch value stream, `vel` a velocity signal (as if by .vel()), `clip` a duration scale
   * (as if by .clip()) - so any of them can be overridden afterwards: `"<0 1 0.5>".as("vel")`
   * carries the velocities and a later .note("f3") (or .s("rave")) supplies the pitch/sound while
   * the velocities ride along. A spec with no pitch field - `.as("vel:clip")` - is the note-less
   * form a tap() recording writes: every present token fires the default note (C2, like a
   * note-less synth("X")) at its velocity/clip, until a later .note()/.n() sets the pitch. Rests
   * (`~`) stay rests throughout.
   */
  as(spec) {
    const fields = String(spec).split(':').map((f) => f.trim().toLowerCase());
    const KNOWN = ['note', 'n', 'vel', 'clip'];
    for (const f of fields) {
      if (!KNOWN.includes(f)) {
        throw new Error(`[signal] .as(): unknown field "${f}" - fields are note, n, vel, clip (e.g. .as("note:vel:clip"))`);
      }
    }
    if (!this.stepsForCycle) {
      throw new Error('[signal] .as() needs a step pattern, e.g. "<36:1:4 ~>*8".as("note:vel:clip")');
    }
    // Pull field `f` out of each "a:b:c" token as its own sub-signal, keeping this pattern's step
    // grid so every field's values line up with the same onsets. A token missing that field (or
    // rests) yields null there - a gate-off for the pitch stream, "use the default" for vel/clip.
    const fieldSig = (f, coerce) => {
      const i = fields.indexOf(f);
      return this.mapValue((raw) => {
        const p = String(raw).split(':')[i];
        return p === undefined || p === '' ? null : coerce(p);
      });
    };
    // The value stream is the pitch tokens (note = absolute MIDI, n = scale degree). With no pitch
    // field every present token fires the default note, so a vel/clip-only spec still triggers
    // (and a later .note()/.n() can replace this placeholder pitch).
    let out;
    if (fields.includes('note')) out = withPitchKind(fieldSig('note', parseNoteValue), 'note');
    else if (fields.includes('n')) out = withPitchKind(fieldSig('n', (p) => Number(p)), 'degree');
    else out = withPitchKind(this.mapValue(() => DEFAULT_SYNTH_NOTE), 'note');
    // vel becomes a note channel (same one .vel() sets), sampled per onset - not cross-merged here
    // because .as()'s vel shares the note grid (no subdivision to do) and a token missing its vel
    // field must default to 1 at the walker, not drop the note. clip stretches each event's duration
    // (same channel .clip() sets). Both survive a later .note()/.n()/.s() (they ride in noteChannels
    // and re-merge onto the new trigger), which is what lets .as("vel").note("f3") work.
    if (fields.includes('vel')) out = out._clone({ noteChannels: { ...out.noteChannels, vel: fieldSig('vel', (p) => Number(p)) } });
    if (fields.includes('clip')) out = out.clip(fieldSig('clip', (p) => Number(p)));
    return out;
  }

  /**
   * Play this pattern's notes with a sample pack as the sound - the method form of s(). Whatever
   * pitch this pattern carries (from note()/n()/.as("note")) becomes the sampler's repitch note
   * and the value stream becomes the pack name, so `note("c e g").s("rave")` plays the rave sample
   * as a three-note line and `"<0 1 0.5>".as("vel").note("f3").s("rave")` keeps the velocities.
   * Configure it with .i()/.begin()/.speed()/etc. exactly like the s("...") builder.
   */
  s(pack) {
    if (typeof pack !== 'string' || !pack.trim()) {
      throw new Error('[signal] .s() takes a sample pack name, e.g. note("c e g").s("rave")');
    }
    const name = pack.trim();
    // This pattern's values are the pitch: keep them as the sampler's repitch note and swap the
    // value stream for the constant pack name over the same grid. An existing sampler keeps its
    // note (re-.s()-ing just changes the pack).
    const noteSig = this.sampler?.note ?? this;
    const sampler = { ...(this.sampler ?? {}), note: noteSig };
    // Velocity carries through untouched: it's a note channel now (Sig#noteChannels), read the same
    // way on synth and sampler tracks, so a vel set while this was a synth track (.vel()/.as("vel"))
    // needs no relocation - the walker maps step.vel / the channel to sample gain on the sampler
    // path exactly as it maps it to MIDI velocity on the synth path.
    return this.mapValue(() => name)._clone({ sampler });
  }

  /**
   * Prints every event this track fires to the editor's console (and devtools with it - see the
   * scheduler's setEventLogger). A debugging aid for "why is this silent / why does it drop
   * out": each line carries the onset and end of the event in cycles plus the
   * config the engine actually resolved, so a sampler line shows the begin/end window, the rate
   * .fit()/.speed()/.note() worked out to, and how much audio that window holds against how long
   * the event is - a window shorter than its event is a hole in the sound.
   *
   *   tops: s("breaks:35").fit().begin("<0 0.75>").log()
   *   [tops] 1.000 -> 2.000  s breaks i=35 begin=0.75 end=1 speed=1.006 audio=0.50c/1.00c gap=0.50c
   *
   * Anywhere in the chain does the same thing - it's a flag on the track, not a step in the
   * pattern. Remove it to stop logging; it costs nothing when it isn't there.
   */
  log(on = true) {
    return this._clone({ logging: !!on });
  }

  _noteLike(sig) {
    // A live keyboard()/tap() route schedules no notes of its own - the keys are the trigger. So
    // .note()/.n() here just set the fixed pitch a key strikes (tap()'s pad note, or the base
    // pitch), stored on the route for the browser to play; the track stays unscheduled (this
    // Sig keeps its null step grid) instead of turning into a pattern that also fires every cycle.
    if (this.keyboardRoute) {
      return this._clone({ keyboardRoute: { ...this.keyboardRoute, note: sig } });
    }
    if (this.sampler) {
      const stepsForCycle = crossMerge(this.stepsForCycle, sig, stampCfg('note'));
      return this._clone({ sampler: { ...this.sampler, note: sig }, stepsForCycle });
    }
    // Synth track: the note signal becomes the pattern itself; everything chained so far
    // (instrument, fx, params, channel strip...) carries over. A live source keeps its own
    // midiNotes (synth("X").note(kb(1)) - the chain's meta would otherwise null it out).
    // pitchKind follows the note signal, not the track: whether these are notes or degrees is a
    // property of the values just supplied, so a later .scale() reads them the right way even on
    // a synth("X") track (which is note-kind by default from its C2 placeholder).
    //
    // The note pattern's grid becomes the track's trigger, but any note channels attached earlier
    // (`.as("vel").note(...)`, `.clip(2).n(...)`) must re-merge onto it - the whole point of holding
    // them separately from the grid (see Sig#noteChannels). In the ordinary pitch-first order
    // noteChannels is empty here and this is a plain grid swap.
    const stepsForCycle = applyNoteChannels(sig.stepsForCycle, this.noteChannels);
    return sig._clone({ ...this._meta(), stepsForCycle, midiNotes: sig.midiNotes ?? this.midiNotes, pitchKind: sig.pitchKind });
  }
}

/**
 * The signal type itself, as userland sees it. Two uses:
 *
 *   Signal(1)                       // constant signal (also takes a mini string or a Sig)
 *   Signal.prototype.co = function (num) {   // extend the language, Strudel's
 *     return this.o(num).gain(...);          // Pattern.prototype idiom - every pattern,
 *   };                                       // LFO, and mini string picks the method up
 *
 * It's a plain callable (no `new` needed) sharing `Sig`'s prototype, so `instanceof Signal`
 * holds for every signal and prototype extensions land on all of them. A bare number stays a
 * continuous constant (no step grid - the right thing for controls); use n()/note()/mini() when
 * the constant should have a whole-cycle step (a trigger).
 */
export function Signal(value) {
  return toSignal(value);
}
Signal.prototype = Sig.prototype; // one shared prototype: extending Signal extends every Sig

// Warps a step grid by a rate that varies across the cycle (patterned .fast()/.slow()). The rate
// pattern's own steps become windows: within window [start,end) at `rate`, the whole pattern is
// laid over the cycle sped by `rate` (via the constant-rate warpSteps) and only onsets falling in
// the window are kept - the same windowed semantics as mini-notation's "a*[2 3]". `cont` tails
// (ties/echoes/reverse spill) overlapping the window carry through. A resting or non-numeric rate
// step is a silent window.
const WARP_WIN_EPS = 1e-9;
function warpStepsWindowed(baseStepsForCycle, factorSig) {
  return (cycle) => {
    const out = [];
    for (const w of factorWindows(factorSig, cycle)) {
      if (!Number.isFinite(w.rate) || w.rate === 0) continue;
      // The rate atom driving this window (the "-1"/"1" of .fast("-1 1")) lights up with the notes
      // it warps - union its span onto each step falling in the window.
      const tag = (s) => (w.locs && w.locs.length ? { ...s, locs: [...stepLocs(s), ...w.locs] } : s);
      for (const s of warpSteps(baseStepsForCycle, w.rate)(cycle)) {
        if (s.cont) {
          if (s.start < w.end - WARP_WIN_EPS && s.end > w.start + WARP_WIN_EPS) out.push(tag(s));
        } else if (s.start >= w.start - WARP_WIN_EPS && s.start < w.end - WARP_WIN_EPS) {
          out.push(tag(s));
        }
      }
    }
    return out.sort((a, b) => a.start - b.start);
  };
}

// The rate windows a factor signal supplies for a cycle: one window per step of a step pattern
// (["2 3"] -> two half-cycle windows), or a single full-cycle window for a whole-cycle/constant
// factor (a number, "<2 3>", or a continuous signal sampled at the cycle midpoint).
function factorWindows(factorSig, cycle) {
  if (factorSig.stepsForCycle) {
    return factorSig
      .stepsForCycle(cycle)
      .filter((s) => s.value != null && !s.cont)
      .map((s) => ({ start: s.start, end: s.end, rate: Number(s.value), locs: stepLocs(s) }));
  }
  return [{ start: 0, end: 1, rate: Number(factorSig.sample(cycle + 0.5, 1)), locs: [] }];
}

// Every step of `steps` sounding at cycle-phase `phase` (fraction of a cycle) - one for an ordinary
// sequence, several for a `,`-stack, none over a rest. _binop reads the right operand this way so a
// stacked operand fans the event out per layer (and so both operands' highlight spans survive the
// merge); with a single layer it is just "the step sounding here", the last covering match, matching
// mini.mjs's sampleStepAt.
function coveringSteps(steps, phase) {
  return steps.filter((s) => s.value != null && phase >= s.start && phase < s.end);
}

// Reads a signal as one event at an exact cycle position: `{ value, locs }`, the value together
// with the highlight spans of the source atom that produced it. Keeping the two on one read is
// what makes highlighting follow the audio automatically - whoever samples a control gets the
// spans of the atom that actually sounded, with no per-builder wiring. A signal that varies
// within the cycle supplies its own reader (Sig#eventAt); anything else resolves through the step
// covering that position (last covering step wins, as sampleViaSteps does), or is sampled bare.
function readEvent(sig, cyclePos) {
  if (sig.eventAt) return sig.eventAt(cyclePos);
  if (sig.stepsForCycle) {
    const cycle = Math.floor(cyclePos);
    const phase = cyclePos - cycle;
    let found = null;
    for (const s of sig.stepsForCycle(cycle)) {
      if (s.value != null && phase >= s.start && phase < s.end) found = s;
    }
    return { value: found ? found.value : null, locs: found ? stepLocs(found) : [] };
  }
  return { value: sig.sample(cyclePos, 1, cyclePos), locs: [] };
}

// Carries a per-onset reader (Sig#eventAt) through a value mapping, so a signal with no honest
// grid stays readable per event after .mapValue()/note()/n() have transformed it. Null - the
// common case - when the source has no reader of its own to carry.
function mapEventAt(sig, fn) {
  if (!sig.eventAt) return null;
  return (cyclePos) => {
    const ev = sig.eventAt(cyclePos);
    return ev.value == null ? ev : { value: fn(ev.value), locs: ev.locs };
  };
}

// The even trigger grid behind Sig#seg: one whole-cycle pulse sped up by n - literally how mini's
// "1*8" is built - so a patterned n inherits .fast()'s per-window semantics for free. The pulse is
// rebuilt without source spans: mini('1') is synthesized here, not written by the user, and its
// atom's [0,1] span would otherwise light the first character of their document.
function segTrigger(n) {
  const sig = n instanceof Sig ? n : null;
  const factor = sig && sig.constVal !== undefined ? sig.constVal : n;
  if (typeof factor === 'number' && !(factor > 0)) {
    throw new Error('[signal] .seg(n) takes a positive number of steps per cycle, e.g. .seg(8) or .seg("<8 16>")');
  }
  const pulse = mini('1').fast(factor);
  return new Sig(() => 1, {
    stepsForCycle: (cycle) => pulse.stepsForCycle(cycle).map((s) => ({ start: s.start, end: s.end, value: 1 })),
  });
}

const CHORD_EPS = 1e-9;

// Cuts one cycle's steps into the successive chords an arpeggiator sees (Sig#arp): a segment per
// ONSET, holding the notes sounding at that instant, low to high. Every note that has begun and
// not yet ended counts, so a chord is whatever is ringing together - a "[c,e,g]" stack, a drawn
// pianoroll() chord whose notes are all DIFFERENT lengths, a triad struck over a held pedal note.
// Segmenting by onset rather than by identical spans is what keeps the arpeggio monophonic:
// ragged note lengths would otherwise read as several one-note chords, each running its own pass
// of the index pattern on top of the others.
//
// A segment runs until the next onset, or until its own notes have all died away, whichever comes
// first - and never past the cycle end, since a chord ringing on is reported again next cycle (as
// `cont` tails) and picks the arpeggio up there.
function chordSegments(steps) {
  const sounding = steps.filter((s) => s.value != null);
  const onsets = [];
  for (const start of sounding.map((s) => s.start).sort((a, b) => a - b)) {
    if (!onsets.length || start - onsets[onsets.length - 1] > CHORD_EPS) onsets.push(start);
  }
  const segments = [];
  for (let i = 0; i < onsets.length; i++) {
    const at = onsets[i];
    const members = sounding.filter((s) => s.start <= at + CHORD_EPS && s.end > at + CHORD_EPS);
    if (!members.length) continue;
    const ringsTo = Math.max(...members.map((s) => s.end));
    const end = Math.min(onsets[i + 1] ?? Infinity, ringsTo, 1);
    if (end - at <= CHORD_EPS) continue;
    segments.push({ start: at, end, members });
  }
  return segments;
}

// One full pass of `sig` compressed into the span [start, start+span) of `cycle` - mini-notation's
// "[...]" applied to a signal, in the signal's OWN step coordinates (0..1 across the span; the
// caller rescales). Which of the signal's cycles plays follows the span's position on the grid it
// tiles, so a half-cycle chord steps through two of them per cycle and an alternation inside the
// pattern advances chord by chord. A signal with no honest grid - a number, an LFO, or a
// within-cycle one like irand()/choose() - has no pass to squeeze, so it contributes one value,
// read (with its highlight spans) at the span's onset.
function squeezeSteps(sig, cycle, start, span) {
  const from = cycle + start;
  if (!sig.stepsForCycle || sig.eventAt) {
    const ev = readEvent(sig, from);
    return [{ start: 0, end: 1, value: ev.value, locs: ev.locs }];
  }
  return sig.stepsForCycle(Math.floor(from / span + CHORD_EPS));
}

// The bundle trigger cross-product (Step 2 of the all-signals rewrite). Cross-products a base
// trigger grid with a control pattern's grid: each overlap becomes one event and control rests
// drop events, so a patterned control (.vel()/.note()/sampler config) subdivides the events it
// overlaps. An overlap is a fresh onset (`cont` falsy) whenever EITHER side starts a fresh
// (non-`cont`) step there, and only stays a tie (`cont`) when BOTH sides are continuing - a change
// on either merged channel retriggers.
//
// With `stamp` given it also MERGES the control's value onto each overlap (right-wins: `{ ...s }`
// copies any value the base carried there, then the stamp overwrites it), so the merged step is a
// real bundle - e.g. a note step that also carries its own `vel`, or a sample event that carries its
// own `speed`. Stamping is what makes a `,`-STACKED control sound: the cross-product already fans
// one event out per layer, and the stamp gives each of those events its own layer's value instead of
// leaving the scheduler to re-sample the channel and get the same value for all of them.
// A control with no step structure (a plain number or a continuous LFO) has nothing to
// cross-product, so the base grid passes through untouched and that channel is instead sampled
// continuously at each onset.
// Stamps a merged control's value onto the event it landed on, coerced to a number - a non-numeric
// control value (a pack name, a junk token) leaves the field unset so the reader falls back to its
// default. `vel` sits directly on the step (see Sig#noteChannels); sampler config values go under
// `cfg`, keyed by their Sig#sampler key, which is where the scheduler reads them per event.
function stampField(name) {
  return (step, value) => {
    const v = Number(value);
    if (!Number.isNaN(v)) step[name] = v;
  };
}
function stampCfg(key) {
  return (step, value) => {
    const v = Number(value);
    if (!Number.isNaN(v)) step.cfg = { ...step.cfg, [key]: v };
  };
}

// Everything about a merged step that the scheduler can actually hear: when it sounds, what it
// plays, and every per-event channel merged onto it.
function stepKey(s) {
  const cfg = s.cfg
    ? Object.keys(s.cfg)
        .sort()
        .map((k) => `${k}=${s.cfg[k]}`)
        .join(',')
    : '';
  return `${s.start}|${s.end}|${s.value}|${s.cont ? 1 : 0}|${s.vel ?? ''}|${cfg}`;
}

// Collapses the duplicates a RE-merge of an already-merged channel produces. Setting a stacked
// control twice - `s("x").n("0,7").add(12)`, where .add() rebuilds the whole note channel and hands
// it back to crossMerge - crosses the channel's layers against a grid that already carries them, so
// each event comes back once per old layer with the same new value. Two events that agree on
// timing, value and every stamped channel are indistinguishable, so the extras go; the atoms they
// lit move onto the survivor. Base steps that were ALREADY identical before the merge are left
// alone - `s("bd,bd")` really is two hits, and stacking a control on it must not thin it out.
function collapseRestamped(steps, keys, baseKeys) {
  const first = new Map(); // step identity -> { idx, baseKey } of the first step to claim it
  const keep = [];
  let dropped = false;
  for (let i = 0; i < steps.length; i++) {
    const seen = first.get(keys[i]);
    if (!seen) {
      first.set(keys[i], { idx: i, baseKey: baseKeys[i] });
      keep.push(true);
      continue;
    }
    if (seen.baseKey === baseKeys[i]) {
      keep.push(true);
      continue;
    }
    const survivor = steps[seen.idx];
    const locs = [...stepLocs(survivor), ...stepLocs(steps[i])];
    if (locs.length) survivor.locs = locs;
    keep.push(false);
    dropped = true;
  }
  return dropped ? steps.filter((_, i) => keep[i]) : steps;
}

function crossMerge(baseStepsForCycle, ctlSig, stamp = null) {
  if (!baseStepsForCycle || !ctlSig.stepsForCycle) return baseStepsForCycle;
  // A control that varies within the cycle (choose/irand) has no honest grid to cross-product -
  // its stepsForCycle is only the phase-0 draw - so the base keeps its own structure and the
  // control is read at each onset instead, exactly as a continuous control is. Both the merged
  // value and the lit atom then come from the same read, and so match what the scheduler plays.
  if (ctlSig.eventAt) {
    return (cycle) => {
      const out = [];
      for (const s of baseStepsForCycle(cycle)) {
        if (s.value == null) continue;
        const ev = readEvent(ctlSig, cycle + s.start);
        if (ev.value == null) continue; // a rest in the control drops the event, as below
        const step = { ...s };
        const locs = [...stepLocs(s), ...ev.locs];
        if (locs.length) step.locs = locs;
        if (stamp) stamp(step, ev.value);
        out.push(step);
      }
      return out;
    };
  }
  return (cycle) => {
    const ctlSteps = ctlSig.stepsForCycle(cycle).filter((c) => c.value != null);
    const out = [];
    const keys = []; // out[i]'s identity, for the collapse below
    const baseKeys = [];
    for (const s of baseStepsForCycle(cycle)) {
      if (s.value == null) continue;
      const baseKey = stepKey(s);
      for (const c of ctlSteps) {
        const start = Math.max(s.start, c.start);
        const end = Math.min(s.end, c.end);
        if (start >= end) continue;
        const cont = (start > s.start || s.cont) && (start > c.start || c.cont);
        const step = { ...s, start, end, cont: cont || undefined };
        // Union both sides' highlight spans so the control's live atom lights alongside the note's:
        // note("c e g").vel("1 0.5 0.2") lights each velocity with its note, and s("x").note("0 2")
        // lights the repitch degrees. Same union _binop/.when() do for their operands.
        const locs = [...stepLocs(s), ...stepLocs(c)];
        if (locs.length) step.locs = locs;
        if (stamp) stamp(step, c.value);
        out.push(step);
        keys.push(stepKey(step));
        baseKeys.push(baseKey);
      }
    }
    return collapseRestamped(out, keys, baseKeys);
  };
}

// Phase-aware grid for rib(): builds output cycle N by walking it in sub-windows split at the loop
// band's wraps. Within a window the source advances 1:1 with output (a plain shift, no floor), so a
// fractional band (len < 1) loops several times inside one output cycle and an offset band that
// straddles a source-cycle boundary is followed across it - the note grid the scheduler reads then
// matches sample()'s continuous remap exactly. A wrap back to the band start is a fresh onset (the
// loop restarts the pattern); a note clipped by a non-wrap boundary is a continuation. t0/len are
// sampled per window at its start, so patterned whole-cycle args behave as before.
function remapGrid(N, srcStepsFor, timeSig, lenSig) {
  const out = [];
  const end = N + 1;
  // Collect the source steps over [srcStart, srcStart+spanLen), mapped into output phase starting at
  // outBase. `restart` marks the window as beginning at a loop wrap (its leftmost partial is fresh).
  const collect = (aOut, spanLen, srcStart, restart) => {
    const s0 = srcStart;
    const s1 = srcStart + spanLen;
    const outBase = aOut - N;
    const firstCyc = Math.floor(s0 + 1e-9);
    const lastCyc = Math.floor(s1 - 1e-9);
    for (let cyc = firstCyc; cyc <= lastCyc; cyc++) {
      for (const st of srcStepsFor(cyc)) {
        const absStart = cyc + st.start;
        const absEnd = cyc + st.end;
        const cs = Math.max(absStart, s0);
        const ce = Math.min(absEnd, s1);
        if (cs >= ce - 1e-12) continue;
        const clippedLeft = cs > absStart + 1e-12;
        // A step clipped on the left was already sounding -> a tie, unless this window is a loop
        // restart (the pattern jumped back to t0, so it re-strikes). A step that genuinely begins
        // inside the window keeps its own cont.
        const cont = clippedLeft ? !restart && true : st.cont || false;
        out.push({ ...st, start: outBase + (cs - s0), end: outBase + (ce - s0), cont: cont || undefined });
      }
    }
  };
  let c = N;
  let guard = 0;
  while (c < end - 1e-9 && guard++ < 4096) {
    const t0 = Number(timeSig.sample(c, 1, c));
    const len = Number(lenSig.sample(c, 1, c));
    if (!Number.isFinite(t0) || !(len > 0)) {
      collect(c, end - c, c, false); // ill-defined band -> identity for the rest of the cycle
      break;
    }
    const off = Frac.fromNumber(c).sub(t0).mod(len).toNumber(); // position within the band, in [0, len)
    const rc = t0 + off; // source position at c
    const winLen = Math.min(len - off, end - c); // until the band wraps or the output cycle ends
    collect(c, winLen, rc, off < 1e-9); // off==0 -> this window opens at the band start (a wrap)
    c += winLen;
  }
  return out.sort((a, b) => a.start - b.start);
}

// Folds a patterned rib() argument (time/length) into the note grid: the arg's step edges combine
// into the trigger and its atom spans light with the note (via crossMerge, channel-less so no value
// merges - only structure + loc union). Unlike a note channel, a resting arg must NOT drop the note
// (crossMerge drops events a control rest covers), so a cycle where the arg has no atoms passes the
// base grid straight through - matching rib()'s ill-defined-band-plays-straight fallback. A constant
// arg (no stepsForCycle) is returned untouched, so plain .rib(0, 2) keeps its exact old behaviour.
function ribMergeArg(baseStepsForCycle, argSig) {
  if (!argSig.stepsForCycle) return baseStepsForCycle;
  const merged = crossMerge(baseStepsForCycle, argSig);
  return (cycle) => {
    const hasAtoms = argSig.stepsForCycle(cycle).some((s) => s.value != null);
    return hasAtoms ? merged(cycle) : baseStepsForCycle(cycle);
  };
}

// Stretches each event's ringing duration by the clip factor (see Sig#clip): sampled per event at
// its midpoint in cycle-time (cps=1), same convention as _binop's patterned operands. A non-positive
// or missing factor falls back to 1. Factored out of Sig#clip so pitch-setting can re-apply it (see
// applyNoteChannels).
function applyClip(baseStepsForCycle, sig) {
  return (cycle) =>
    baseStepsForCycle(cycle).map((s) => {
      if (s.value == null) return s;
      const raw = Number(sig.sample(cycle + (s.start + s.end) / 2, 1));
      const clip = raw > 0 && !Number.isNaN(raw) ? raw : 1;
      return { ...s, end: s.start + (s.end - s.start) * clip };
    });
}

// Re-merges the persistent note channels (vel, clip) onto a freshly (re)established trigger grid.
// Called by the pitch-setting builders (_noteLike) so a channel attached BEFORE the pitch survives
// the grid being replaced - "<0 1 0.5>".as("vel").note("f3") keeps its velocities. In the ordinary
// order (pitch first, then .vel()/.clip()) the channels are already merged in and noteChannels is
// empty at pitch-set time, so this is a no-op. vel before clip, matching .as()'s field order.
function applyNoteChannels(baseStepsForCycle, noteChannels) {
  let out = baseStepsForCycle;
  if (noteChannels.vel) out = crossMerge(out, noteChannels.vel, stampField('vel'));
  if (noteChannels.clip) out = applyClip(out, noteChannels.clip);
  return out;
}

const CLIP_ONLY = new Set(['clip']);

// The enum controls (Sig#loopwrap, Sig#loopdir), by sampler key: the mode names in order, so the
// index IS the number the control carries. They're ordinary patternable channels - the point of
// numbering them rather than naming them - so a value can arrive from anywhere a signal can:
// mini strings, LFOs, rand(). loopModeAt turns whatever arrives into one of these.
export const LOOP_MODES = {
  loopWrap: ['file', 'window'],
  loopDir: ['forward', 'pingpong'],
};

/**
 * The mode index a raw control value selects: rounded to the nearest integer and wrapped into the
 * mode count, so 0.3 -> 0, 0.7 -> 1, and 2 -> 0 again on a two-mode control. That's what makes a
 * continuous source usable directly - .loopdir(rand().range(0, 2)) is an even coin flip per event,
 * with no clamping pile-up at either end. Junk (a rest, NaN) falls back to mode 0, the default.
 */
export function loopModeAt(key, value) {
  const n = LOOP_MODES[key].length;
  const i = Math.round(Number(value));
  return Number.isFinite(i) ? ((i % n) + n) % n : 0;
}

// Merges two maps of per-onset control signals (Sig#sampler, Sig#noteChannels) across a .when():
// where the two sides differ, the key becomes ONE signal that follows the condition - the
// callback's version where it's truthy, the original where it isn't. A side that doesn't have the
// key rests (null) there, which every reader of these already treats as "unset" and resolves to the
// engine/scheduler default. Keys in `skip`, and any non-signal value (fit's 'auto'), can't be
// switched, so the callback's version stands as it always did.
function condSwitchMap(before, after, condAt, truthy, skip = new Set()) {
  const out = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const off = before?.[key] ?? null;
    const on = after?.[key] ?? null;
    const switchable =
      off !== on && !skip.has(key) && (off === null || off instanceof Sig) && (on === null || on instanceof Sig);
    if (!switchable) {
      const kept = on ?? off;
      if (kept != null) out[key] = kept;
      continue;
    }
    out[key] = new Sig((t, cps, pos) => {
      const branch = truthy(condAt(pos ?? t * cps)) ? on : off;
      return branch ? branch.sample(t, cps, pos) : null;
    });
  }
  return out;
}

// Rests/gaps in a condition pattern count as falsy regions, not holes - without this, a cond
// like "1 ~" would silence the second half of the cycle instead of playing the original.
function fillCondGaps(steps) {
  const sorted = [...steps].sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start > pos) out.push({ start: pos, end: s.start, value: 0 });
    out.push(s);
    pos = Math.max(pos, s.end);
  }
  if (pos < 1) out.push({ start: pos, end: 1, value: 0 });
  return out;
}

// Chainable .gain() multiplies factors together (see Sig#gain). The engine drives one Sig per
// track-gain control, so factors must fold into a single Sig - and a Tier-2 modulator (LFO/env/
// cc) must survive the fold, since demoting it would lose the native fast path (and env() can't
// be sampled in JS at all). A plain-number factor folds into a modulator's bounds symbolically;
// two native modulators can't share one gain control, so that's a clear error rather than a
// silent demotion.
function multiplyGain(a, b) {
  const ac = a.constVal;
  const bc = b.constVal;
  const aMod = a.lfoIR || a.envIR || a.ccIR;
  const bMod = b.lfoIR || b.envIR || b.ccIR;
  if (ac != null && bc != null) return toSignal(ac * bc); // constant * constant
  if (aMod && bc != null) return a.mul(bc); // modulator * scalar -> rewrite bounds (either order)
  if (bMod && ac != null) return b.mul(ac);
  if (aMod && bMod) {
    throw new Error(
      "[signal] .gain(): can't multiply two native modulators (LFO/env/cc) on one track's gain - combine them in a single expression instead, e.g. .gain(env().range(0.2, 1).mul(sine(2).range(0.5, 1)))",
    );
  }
  if (a.envIR || b.envIR) {
    throw new Error("[signal] .gain(): an env() gain can only be multiplied by a constant here - shape it with .range() first, or fold the other factor into a single expression");
  }
  return productGain(a, b); // generic product (Tier-1 polled) - mini strings, LFOs sampled in JS, etc.
}

// The product of two gain factors, where a *resting* factor (null - e.g. a cc/mini before its
// first value) contributes unity rather than poisoning the whole product to null. Plain
// `.mul()` propagates null (right for note patterns: a rest is a gate-off), but for a channel
// gain built from independent factors a resting one just isn't attenuating yet - so a hard
// `.gain(0)` still mutes even while a `.gain(1 - cc(...))` fader hasn't been touched. Only when
// *every* factor rests does the product rest (hold the current gain).
function productGain(a, b) {
  return new Sig((t, cps, pos) => {
    const av = a.sample(t, cps, pos);
    const bv = b.sample(t, cps, pos);
    if (av == null && bv == null) return null;
    return (av == null ? 1 : Number(av)) * (bv == null ? 1 : Number(bv));
  });
}

// Tags a freshly-built Sig as note- or degree-valued (see Sig#pitchKind / Sig#scale). The
// builders own the Sig they pass in here, so mutating it in place is safe - same pattern as
// toSignal tagging constVal below.
function withPitchKind(sig, kind) {
  sig.pitchKind = kind;
  return sig;
}

function toSignal(value) {
  if (value instanceof Sig) return value;
  if (typeof value === 'number') {
    // Tag plain-number constants so combinators (multiplyGain) can fold them into a Tier-2
    // modulator's bounds symbolically instead of demoting it to a generic product.
    const s = new Sig(() => value);
    s.constVal = value;
    return s;
  }
  if (typeof value === 'string') return mini(value);
  if (typeof value === 'function') {
    throw new Error('[signal] a midicc()/midikeys() device is a function - call it first: cc(12, 1), kb(1)');
  }
  throw new Error(`[signal] don't know how to turn ${JSON.stringify(value)} into a signal`);
}

// An LFO/env IR bound (min/max): a plain number stays a number (the fully-static fast path);
// anything else becomes a Sig the scheduler polls (see Scheduler#_sendModulator).
function toBound(value) {
  return typeof value === 'number' ? value : toSignal(value);
}

/** Samples an IR bound at a point in time; null while a signal bound is resting. */
export function sampleBound(bound, t, cps, pos) {
  if (typeof bound === 'number') return bound;
  const v = bound.sample(t, cps, pos);
  return typeof v === 'number' && !Number.isNaN(v) ? v : v == null ? null : Number(v);
}

// ---------------------------------------------------------------------------------------------
// mini-notation-backed signals: n(), note(), and the generic mini() used by .param()/.fx() when
// given a plain string.
// ---------------------------------------------------------------------------------------------

function miniStepSampler(ast, valueFn) {
  return (tSeconds, cps, pos) => {
    const cyclePos = pos ?? tSeconds * cps;
    const cycle = Math.floor(cyclePos);
    const phase = cyclePos - cycle;
    const steps = getStepsForCycle(ast, cycle);
    const step = steps.find((s) => phase >= s.start && phase < s.end);
    if (!step || step.value == null) return null;
    return valueFn ? valueFn(step.value) : step.value;
  };
}

function miniStepsForCycle(ast, valueFn) {
  return (cycle) =>
    getStepsForCycle(ast, cycle).map((s) => (s.value == null ? s : { ...s, value: valueFn ? valueFn(s.value) : s.value }));
}

// The builders below accept a number, a mini string, or an existing Sig (so transformed
// patterns compose: note("45 73".sub(24)) === note("45 73").sub(24)). Anything else is a
// user mistake - fail here, at eval time, with a message that says which builder.
function assertBuilderInput(builder, value) {
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Sig) return;
  throw new Error(`[signal] ${builder}(...) takes a number, a mini-notation string, or a signal - got ${Object.prototype.toString.call(value)}`);
}

/**
 * Generic mini-notation signal of raw string/number values (used internally, and by
 * .param("x", "1 2 3")). `offset` shifts every atom's source span by that many characters, so the
 * emitted steps' spans resolve against the document rather than the bare string - the editor's
 * playback highlighter needs this, and the eval-time location transpile supplies it by rewriting a
 * pattern literal "…" into mini("…", offset) (see pattern-core/locations.mjs). Omit it everywhere
 * else; the builders that take a Sig (n/note/s) thread these spans through unchanged.
 */
export function mini(str, offset = 0) {
  assertBuilderInput('mini', str);
  if (str instanceof Sig) return str;
  const ast = parseMini(String(str), offset);
  const valueFn = (v) => (Number.isNaN(Number(v)) ? v : Number(v));
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn) });
}

/** Scale-degree control - degrees are plain numbers until `.scale(...)` turns them into MIDI notes. */
export function n(value) {
  assertBuilderInput('n', value);
  if (value instanceof Sig) return withPitchKind(value.mapValue((v) => Number(v)), 'degree');
  if (typeof value === 'number') return new Sig(() => value, { stepsForCycle: () => [{ start: 0, end: 1, value }], pitchKind: 'degree' });
  const ast = parseMini(String(value));
  const valueFn = (v) => Number(v);
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn), pitchKind: 'degree' });
}

/**
 * Sampler pattern - values are sample-pack names (folders under the samples directory), one
 * event per step: `s("bd hh bd hh")`. A `:n` suffix picks the pack's nth file, strudel-style:
 * `s("bd:4")` = `s("bd").i(4)` (an explicit .i() overrides the suffix). Configure with
 * .i()/.begin()/.end()/.loop()/.speed()/.flip()/.stretch()/.fit()/.slice()/.attack()/.decay()/
 * .sustain()/.release() (or .adsr()); route through effects with .fx()/.param() as usual.
 */
export function s(value) {
  assertBuilderInput('s', value);
  if (value instanceof Sig) return value._clone({ sampler: {} });
  const ast = parseMini(String(value));
  return new Sig(miniStepSampler(ast), { stepsForCycle: miniStepsForCycle(ast), sampler: {} });
}

// ---------------------------------------------------------------------------------------------
// Sampler controls as top-level builders (Strudel's "control patterns")
// ---------------------------------------------------------------------------------------------

// What a note-less synth("X") plays: C2 (MIDI 24 in this package's c5 = 60 convention), one
// whole-cycle note per cycle - the same note at which a sample plays back at native speed.
const DEFAULT_SYNTH_NOTE = 24;

// Every sampler channel, by the name of the method that sets it: which key it lives under in
// Sig#sampler, and what it's worth when nobody has set it - the value a combinator has to combine
// AGAINST. These are the engine's own defaults (see osc-engine's playSample), written down here
// because `x.mul(speed("-1"))` has to know that an unset speed means 1.
const SAMPLER_CONTROLS = {
  i: { key: 'index', unset: 0 },
  begin: { key: 'begin', unset: 0 },
  end: { key: 'end', unset: 1 },
  loop: { key: 'loop', unset: 0 },
  loopwrap: { key: 'loopWrap', unset: 0 },
  loopdir: { key: 'loopDir', unset: 0 },
  speed: { key: 'speed', unset: 1 },
  flip: { key: 'flip', unset: 0 },
  stretch: { key: 'stretch', unset: 1 },
  fit: { key: 'fit', unset: 1 },
  slice: { key: 'slice', unset: 0 },
  attack: { key: 'attack', unset: 0 },
  decay: { key: 'decay', unset: 0 },
  sustain: { key: 'sustain', unset: 1 },
  release: { key: 'release', unset: 0 },
  note: { key: 'note', unset: DEFAULT_SYNTH_NOTE }, // reached by bare arithmetic, not a builder
};

// A signal's VALUES with no track metadata and no control tag attached - what a channel signal is.
// Combining controls goes through this so a merge can't drag an instrument/sampler along with it,
// and so a control operand's own tag can't re-route the merge back into itself. pitchKind is a
// property of the values (note vs degree), not of the track, so it stays.
function bareSig(sig) {
  const out = new Sig(sig.sample, {
    stepsForCycle: sig.stepsForCycle,
    eventAt: sig.eventAt,
    lfoIR: sig.lfoIR,
    envIR: sig.envIR,
    ccIR: sig.ccIR,
    pitchKind: sig.pitchKind,
  });
  if (sig.constVal !== undefined) out.constVal = sig.constVal;
  return out;
}

/**
 * The sampler config methods, also available as TOP-LEVEL builders - Strudel's control patterns.
 * `speed("-1")` isn't a pattern whose values are -1; it's the *speed channel* carrying -1. On its
 * own that's just the longer way to write `s("bd").speed("-1")`, but as an OPERAND it lets a
 * combinator reach into one channel of a pattern it was handed, exactly as `x.add(note(3))`
 * reaches into pitch:
 *
 *   tops: s("breaks:19").fit()
 *     .when(rand().gte(0.7), x => x.add(flip(1)))       // ~30% of bars play backwards
 *     .when(rand().gte(0.5), x => x.ply("4"))
 *
 * The channel's current value is the left operand (its resting default where it isn't set yet -
 * see SAMPLER_CONTROLS), so `.mul(speed("-1"))` flips whatever speed is in force rather than
 * replacing it, and it composes with `.fit()` the way an explicit `.speed()` does. Values take
 * anything a signal takes: numbers, mini strings, LFOs, `choose()`/`irand()`.
 *
 * Using one on a non-sampler pattern is an error (there's no channel to aim at) - the same message
 * the method form gives.
 */
function samplerControl(name) {
  return (value, opts) => {
    // .loop()'s old options object is gone: wrap/dir are their own controls now, and both forms
    // of those work as operands like any other channel. Saying so beats accepting the object and
    // quietly dropping it.
    if (name === 'loop' && opts !== undefined) {
      throw new Error('[signal] loop()\'s wrap/dir options are their own controls now - loopwrap(1) / loopdir(1)');
    }
    // fit() alone means "nearest power of two", which is a mode rather than a number - flag it so
    // a combinator sets the channel instead of trying to do arithmetic with it.
    if (name === 'fit' && value === undefined) {
      const auto = new Sig(() => null);
      auto.ctl = name;
      auto.ctlAuto = true;
      return auto;
    }
    const out = bareSig(toSignal(value === undefined ? 1 : value));
    out.ctl = name;
    return out;
  };
}

/** Which sample of the pack to play, 0-based - the top-level form of `.i()`. */
export const i = samplerControl('i');
/** Playback start position within the sample, 0..1 - the top-level form of `.begin()`. */
export const begin = samplerControl('begin');
/** Playback end position within the sample, 0..1 - the top-level form of `.end()`. */
export const end = samplerControl('end');
/** Loop the sample for the event instead of one-shot - the top-level form of `.loop()`. */
export const loop = samplerControl('loop');
/** Which region a loop runs round: 0 = the whole file, 1 = the begin..end window. Top-level `.loopwrap()`. */
export const loopwrap = samplerControl('loopwrap');
/** How a loop turns over: 0 = jump back, 1 = pingpong. Top-level `.loopdir()`. */
export const loopdir = samplerControl('loopdir');
/** Playback rate off begin(); negative wraps backwards round the region - the top-level form of `.speed()`. */
export const speed = samplerControl('speed');
/** Reverse the window into the beat (over 0.5 = on) - the top-level form of `.flip()`. */
export const flip = samplerControl('flip');
/** Granular timestretch factor - the top-level form of `.stretch()`. */
export const stretch = samplerControl('stretch');
/** Repitch the sample to last this many cycles - the top-level form of `.fit()`. */
export const fit = samplerControl('fit');
/** Play the nth detected transient slice - the top-level form of `.slice()`. */
export const slice = samplerControl('slice');
/** Attack, as a multiple of the played duration - the top-level form of `.attack()`. */
export const attack = samplerControl('attack');
/** Decay, as a multiple of the played duration - the top-level form of `.decay()`. */
export const decay = samplerControl('decay');
/** Sustain level, 0..1 - the top-level form of `.sustain()`. */
export const sustain = samplerControl('sustain');
/** Release, as a multiple of the played duration - the top-level form of `.release()`. */
export const release = samplerControl('release');

/** Every top-level sampler control, by name - what the host puts in userland scope. */
export const SAMPLER_CONTROL_NAMES = Object.keys(SAMPLER_CONTROLS).filter((k) => k !== 'note');

// Build-time seeds for the randomised builders (choose/irand/.degrade()). Independent calls must
// draw independently, so each takes the next seed off ONE shared counter. A counter per builder
// would hand the first choose() and the first irand() the same seed, and since both read the same
// uniform hash at the same position they'd be perfectly correlated - .begin(irand(16).div(16))
// would decide .speed(choose("1","-1")).
//
// The counter only climbs, so the host must reset it before each evaluation (resetRandomSeeds):
// otherwise re-evaluating the same document re-seeds every random stream, and stop-then-play
// silently plays a different take. Seeds are therefore positional - the Nth randomised call in
// the buffer - which is what makes a document sound the same every time it's played.
//
// They start high so they can't collide with a seed a human passes explicitly (.degrade(0.3, 3)):
// those are a separate, stable namespace living down at 0, 1, 2…
const AUTO_SEED_BASE = 100000;
let randomSeedCounter = 0;
const nextAutoSeed = () => AUTO_SEED_BASE + ++randomSeedCounter;

/**
 * Rewind the build-time seed counter, so evaluating the same source builds the same random
 * streams. The host calls this once at the start of an evaluation, before any block is built.
 */
export function resetRandomSeeds() {
  randomSeedCounter = 0;
}

/**
 * `choose("0", "3", "5")` - a signal that randomly picks one of its options (uniform by
 * default). Options are anything toSignal accepts (mini strings, numbers, other signals), and
 * a `[option, weight]` pair biases the draw: `choose(["0", 3], ["3", 1], ["5", 1])` picks "0"
 * three times as often as the others. Like irand() the draw is a deterministic hash of the
 * cycle position (stable across re-queries and re-triggers within a take): as a pattern it
 * picks once per cycle, so a chosen option that is itself a pattern plays in full for that
 * cycle (mini `|` is the in-string form); sampled by an outside pattern's structure
 * (`.speed(choose(1, -1))` under a 16-step grid) it draws fresh at every onset. Drops in
 * anywhere a signal goes - `n(choose("0", "3", "7"))`, `s(choose("bd", "hh"))`.
 */
export function choose(...options) {
  if (options.length === 0) throw new Error('[signal] choose() needs at least one option');
  const entries = options.map((o) => {
    const [val, weight] = Array.isArray(o) ? [o[0], Number(o[1] ?? 1)] : [o, 1];
    return { sig: toSignal(val), weight: weight > 0 ? weight : 0 };
  });
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (!(total > 0)) throw new Error('[signal] choose() needs at least one positive weight');
  const seed = nextAutoSeed();
  // Keyed on the exact cycle position like irand()'s valueAt: at an integer cycle
  // (stepsForCycle) rngAtPos(cycle, 0, seed) === rng2(cycle, seed), so the per-cycle pattern
  // pick is unchanged, while sampling at an onset mid-cycle draws independently per position.
  const pick = (cyclePos) => {
    const cycle = Math.floor(cyclePos);
    let r = rngAtPos(cycle, cyclePos - cycle, seed) * total;
    for (const e of entries) {
      r -= e.weight;
      if (r < 0) return e;
    }
    return entries[entries.length - 1];
  };
  const stepsForCycle = (cycle) => {
    const e = pick(cycle);
    if (e.sig.stepsForCycle) return e.sig.stepsForCycle(cycle);
    const v = e.sig.sample(cycle + 0.5, 1); // a constant/continuous option becomes one whole-cycle step
    return v == null ? [] : [{ start: 0, end: 1, value: v }];
  };
  const sample = (t, cps, pos) => pick(pos ?? t * cps).sig.sample(t, cps, pos);
  // The draw varies within the cycle, so as a control this is read per onset (see readEvent):
  // the option drawn at that exact position supplies both the value and its spans, which is what
  // lets `.speed(choose("1", "-1"))` light the option each hit actually plays. Reading through
  // readEvent means a chosen option that is itself a mini pattern reports the atom sounding
  // there, and a nested choose() resolves the same way.
  return new Sig(sample, { stepsForCycle, eventAt: (cyclePos) => readEvent(pick(cyclePos).sig, cyclePos) });
}

/**
 * `irand(8)` - a deterministic random integer in 0..n-1, one value per cycle. Like choose() the
 * draw is a hash of the cycle position (via rngAtPos), so it's stable across re-queries and replays
 * identically each time a cycle comes round, and the editor's highlighter agrees with playback -
 * the "sampled by the outside pattern, deterministic in time" contract. Drops in wherever a signal
 * goes: `n(irand(8)).scale("F minor")` walks a random scale each cycle; sample it per note with
 * arithmetic (`n("0 0 0 0").add(irand(12))`) for a fresh draw at every onset; loop a fixed band with
 * `.rib(0, 4)`. Each independent irand() call draws independently.
 *
 * The bound may be PATTERNED, and a bound that subdivides the cycle gives the result that
 * structure: `irand("8!8")` is eight draws in 0..7 per cycle, each its own event, so
 * `.begin(irand("8!8").div(8))` retriggers a sampler eight times a bar (`.seg(8)` is the same
 * thing said the other way round). A bound that stays whole-cycle - a number, `"8"`, `"<8 16>"` -
 * imposes no grid and keeps the per-onset contract above, just with a bound that moves.
 */
export function irand(n) {
  const seed = nextAutoSeed();
  const nSig = typeof n === 'string' || n instanceof Sig ? toSignal(n) : null;
  // A usable bound: a positive integer count of outcomes. Non-numeric (or resting) reads as a rest
  // rather than a NaN draw; 0/negative clamps to 1, the historical behaviour for numbers.
  const bound = (v) => {
    if (v == null) return null;
    const c = Math.round(Number(v));
    return Number.isFinite(c) ? Math.max(1, c) : null;
  };
  if (!nSig && bound(n) == null) {
    throw new Error('[signal] irand(n) takes a positive integer, a mini-notation string, or a signal - e.g. irand(8), irand("8!8")');
  }
  // Keyed on the exact cycle position (integer cycle + Frac-snapped phase) so two float paths to the
  // same moment - or a rib()/hold() remap onto it - draw the identical integer.
  const drawAt = (cyclePos, count) => {
    const cycle = Math.floor(cyclePos);
    return Math.floor(rngAtPos(cycle, cyclePos - cycle, seed) * count);
  };

  // Does the bound genuinely subdivide the cycle, or is it one value per cycle? Only the former has
  // a grid worth handing on; a whole-cycle bound must NOT impose one, or `.vel(irand("<8 16>"))`
  // would freeze the bar's first draw where `.vel(irand(8))` draws per note. Probed over two cycles
  // so an alternation isn't judged on one pick (the same probe _fastPatterned validates a rate by).
  const grid = nSig?.stepsForCycle ?? null;
  const subdivides =
    grid &&
    [0, 1].some((c) => {
      const steps = grid(c);
      return steps.length > 1 || steps.some((s) => s.start > 0 || s.end < 1);
    });

  if (subdivides) {
    // Each bound step becomes one event, drawn at that step's onset. The bound's own atom rides
    // along (`{ ...s }` keeps its spans), so the "8" that shaped a draw lights when it sounds.
    const stepsForCycle = (cycle) =>
      grid(cycle).map((s) => {
        const count = bound(s.value);
        return count == null ? { ...s, value: null } : { ...s, value: drawAt(cycle + s.start, count) };
      });
    return new Sig((t, cps, pos) => sampleViaSteps(stepsForCycle, t, cps, pos), { stepsForCycle });
  }

  // Varies within the cycle like choose(), so as a control it is drawn per onset rather than
  // holding the cycle's first draw: .vel(irand(2)) is a fresh coin at every note. A plain-number
  // bound has no source atom to light (irand is written as code, not mini notation); a patterned
  // one lends the spans of whichever atom set the bound there.
  const eventAt = (cyclePos) => {
    if (!nSig) return { value: drawAt(cyclePos, bound(n)), locs: [] };
    const ev = readEvent(nSig, cyclePos);
    const count = bound(ev.value);
    return { value: count == null ? null : drawAt(cyclePos, count), locs: ev.locs };
  };
  const stepsForCycle = (cycle) => {
    const ev = eventAt(cycle);
    return [{ start: 0, end: 1, value: ev.value, ...(ev.locs.length ? { locs: ev.locs } : {}) }];
  };
  return new Sig((t, cps, pos) => eventAt(pos ?? t * cps).value, { stepsForCycle, eventAt });
}

// The pitch a .midi() injection fires for a note-less (drum) source, when no { note } is given:
// middle C (c5 = 60 here). A MIDI-triggered ducker (Kickstart, LFOTool) ignores the note, so any
// fixed pitch works; a melodic source passes its own pitch through instead.
const DEFAULT_TRIG_NOTE = 60;

/**
 * Pattern starting from the instrument: synth("Serum 2") plays a default C2 every cycle until
 * notes are given - add them before or after (`n("0 2 3").scale("F minor").synth("Serum 2")`
 * and `synth("Serum 2").n("0 2 3").scale("F minor")` are equivalent). Takes the same optional
 * `{ state }` second argument as Sig#synth.
 */
export function synth(pluginId, config) {
  return note(DEFAULT_SYNTH_NOTE).synth(pluginId, config);
}

/** Explicit-note control - numbers pass through as MIDI, strings may be note names ("f4") or numbers. */
export function note(value) {
  assertBuilderInput('note', value);
  if (value instanceof Sig) return withPitchKind(value.mapValue((v) => parseNoteValue(v)), 'note');
  if (typeof value === 'number') return new Sig(() => value, { stepsForCycle: () => [{ start: 0, end: 1, value }], pitchKind: 'note' });
  const ast = parseMini(String(value));
  const valueFn = (v) => parseNoteValue(v);
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn), pitchKind: 'note' });
}

/**
 * A note pattern drawn on an interactive piano roll: `pianoroll("60,0,4 64,0,4", { grid: 16, len:
 * 16 })`. Clicking the `pianoroll` name in the editor opens the roll - draw, erase, resize, set
 * per-note velocity/probability, and drag the loop length - and every change is serialized straight
 * back into the string (see pianoroll.mjs for the format) and re-evaluated, the code staying the
 * single source of truth exactly like lfo()'s shape editor.
 *
 * Two independent dimensions: `grid` is the granularity - cells per cycle, so grid 16 is a 1/16
 * grid (this is the `*grid` multiplier of the equivalent mini-notation). `len` is the loop length
 * measured in cells (grid-th notes), so `{ grid: 16, len: 3 }` is a three-1/16-note loop. Notes
 * live in cells 0..len-1; the loop repeats every `len` cells, exactly like `<…len cells…>*grid`.
 * `grid` may also be given as a bare number shorthand, `pianoroll(str, 32)` (len then defaults to a
 * full cycle). Each note carries its own velocity and probability (a note with prob < 1 fires that
 * fraction of the time, like a `?` degrade), and overlapping notes play as chords. Holds absolute
 * MIDI notes, so it chains with .synth()/.scale()/.add()/etc. just like note().
 *
 * A bare `pianoroll()` (or `pianoroll("")`) is a valid empty roll - silence - so typing the call to
 * open the editor and drawing into it never has to pass through an error state.
 */
export function pianoroll(str = '', opts = {}) {
  if (typeof str !== 'string') {
    throw new Error('[signal] pianoroll(...) takes a note string from the piano roll editor, e.g. pianoroll("60,0,4 64,0,4")');
  }
  const grid = normalizePianoRollSteps(typeof opts === 'number' ? opts : (opts.grid ?? opts.steps));
  const len = Math.max(1, Math.round(opts.len ?? grid));
  const notes = parsePianoRoll(str);
  // Index onsets by their loop cell. Playback walks absolute cells m = cycle*grid + j; the cell
  // sounding is (m mod len), so a len-cell loop threads seamlessly across cycles - identical to
  // `<len cells>*grid`. dur is the note's length in cycles; _prob/_seed drive the per-onset random
  // gate (the same rng2 the `?` degrade uses, keyed on the absolute cell so each loop pass is
  // independent yet a given pass replays identically).
  const byStart = new Map();
  notes.forEach((nt, i) => {
    if (nt.start >= len) return; // outside the loop window - never sounds
    const list = byStart.get(nt.start) ?? [];
    list.push({ value: nt.midi, vel: nt.vel, dur: nt.len / grid, prob: nt.prob, seed: i + 1 });
    byStart.set(nt.start, list);
  });
  const stepsForCycle = (cycle) => {
    const out = [];
    for (let j = 0; j < grid; j++) {
      const m = cycle * grid + j;
      const onsets = byStart.get(((m % len) + len) % len);
      if (!onsets) continue;
      const start = j / grid;
      for (const o of onsets) {
        if (o.prob < 1 && !(rng2(m, o.seed) < o.prob)) continue;
        out.push({ start, end: start + o.dur, value: o.value, vel: o.vel });
      }
    }
    return out;
  };
  const sample = (t, cps, pos) => sampleViaSteps(stepsForCycle, t, cps, pos);
  return new Sig(sample, { stepsForCycle, pitchKind: 'note' });
}

// ---------------------------------------------------------------------------------------------
// Continuous LFO builders - sine/saw/tri/square. These carry symbolic `lfoIR` so the scheduler
// can compile them straight into a native, sample-accurate oscillator (see ARCHITECTURE.md,
// "Tier 2") instead of sampling them from JS at all.
// ---------------------------------------------------------------------------------------------

// Deterministic hash noise for perlin()'s JS-side sampling, so Tier-1 values are reproducible.
// The Tier-2 native version uses scsynth's own noise UGen, so JS values and engine values
// differ - both are random, only the rate/range contract is shared.
// Deterministic 0..1 hash of a noise-grid index, keyed on the signal's build-time seed so two
// independent perlin() calls draw different noise (see shapeSignal). The seed enters
// through its own irrational multiplier rather than as an offset on `i`, which would only shift
// one stream along the other's timeline - "decorrelated" has to mean uncorrelated, not delayed.
// Seed 0 (the default) reproduces the original single-stream hash exactly.
function hash01(i, seed = 0) {
  const s = Math.sin(i * 127.1 + seed * 78.233 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// Deterministic 0..1 hash of two numbers - the shared RNG behind the randomised combinators
// (.degrade()/choose()) and, mirrored by the same formula in mini.mjs, the `?`/`|` mini-notation
// operators. It must stay deterministic per (cycle, seed): the scheduler and the editor's
// highlighter query stepsForCycle independently, so a coin flip has to land the same way both
// times, and a given bar has to replay identically each cycle it comes round.
function rng2(a, b) {
  const s = Math.sin(a * 12.9898 + b * 78.233 + 43.123) * 43758.5453;
  return s - Math.floor(s);
}

// Deterministic draw keyed on an absolute cycle position. `cycle` is the exact integer cycle;
// `phase` is the in-cycle position, which we snap to its exact rational before hashing so a
// moment reached by two different float paths (or after a future rib/hold remap) draws
// identically - the guarantee behind "the same time is never differentiated from itself". For a
// position that is already a clean rational this is a no-op, so existing patterns are unchanged.
// Mirrored verbatim in mini.mjs (rngAtPos) - the browser highlighter must land the same draws.
function rngAtPos(cycle, phase, seed) {
  return rng2(cycle + Frac.fromNumber(phase).toNumber(), seed);
}

// Samples a step-list-backed signal at a point in time by locating the step covering that phase -
// keeps a derived pattern's continuous sample() in agreement with its stepsForCycle. The
// randomised/structural combinators below (.degrade()/.ply()/.echo()) build their step grid first
// and sample through it, so the two views can never disagree. Last covering step wins, so
// overlapping copies (.echo()) read as the most recent onset.
function sampleViaSteps(stepsForCycleFn, t, cps, pos) {
  const cyclePos = pos ?? t * cps;
  const cycle = Math.floor(cyclePos);
  const phase = cyclePos - cycle;
  let found = null;
  for (const s of stepsForCycleFn(cycle)) {
    if (s.value != null && phase >= s.start && phase < s.end) found = s;
  }
  return found ? found.value : null;
}

function sampleLfoIR(ir, tSeconds, cps, pos) {
  const total = tSeconds * ir.rateHz + ir.phaseCycles;
  const phase = ((total % 1) + 1) % 1;
  let unipolar;
  switch (ir.shape) {
    case 'saw':
    case 'ramp':
      unipolar = phase;
      break;
    case 'tri':
      unipolar = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      break;
    case 'square':
      unipolar = phase < 0.5 ? 1 : 0;
      break;
    case 'rand': {
      // True uniform noise: an INDEPENDENT draw at every position, off the same rngAtPos hash
      // choose()/irand()/.degrade()/mini's `?` draw from - so every read is its own coin and two
      // reads a step apart are uncorrelated. That's what makes .seg(8) eight real flips a bar
      // rather than eight points along one curve. Smoothed drift is perlin(); freezing a value
      // across a span is .seg()/.hold(). Position is snapped to its exact rational inside
      // rngAtPos, so two float paths to the same moment (a rib()/hold() remap, the highlighter
      // re-querying) draw identically - deterministic, not merely repeatable.
      const i = Math.floor(total);
      unipolar = rngAtPos(i, total - i, ir.seed ?? 0);
      break;
    }
    case 'perlin': {
      // Fractal value noise (fBm): smoothstep-interpolated hash noise summed over a few octaves,
      // each double the frequency and half the amplitude. This is the SMOOTH one - where rand()
      // draws afresh at every position, perlin drifts, one new target per period per octave.
      // Deterministic in `total` and the seed, so JS and any highlighter agree.
      const seed = ir.seed ?? 0;
      let sum = 0;
      let amp = 1;
      let norm = 0;
      let freq = 1;
      for (let oct = 0; oct < 4; oct++) {
        const x = total * freq + oct * 17.13; // offset per octave so they decorrelate
        const i = Math.floor(x);
        const u = x - i;
        const su = u * u * (3 - 2 * u);
        sum += amp * (hash01(i, seed) * (1 - su) + hash01(i + 1, seed) * su);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      unipolar = sum / norm;
      break;
    }
    case 'custom':
      // lfo() shapes: only free mode has a JS-side value - retrigger/envelope depend on note
      // gates only the engine sees, so (like env()) they just hold the shape's start level.
      unipolar = ir.mode === 'free' || ir.mode == null ? sampleShape(ir.points, phase) : ir.points[0].y;
      break;
    case 'sine':
    default:
      unipolar = 0.5 + 0.5 * Math.sin(phase * 2 * Math.PI);
  }
  // Bounds may be signals (see range()); a resting bound holds the range's floor of 0.
  const lo = sampleBound(ir.min, tSeconds, cps, pos) ?? 0;
  const hi = sampleBound(ir.max, tSeconds, cps, pos) ?? 1;
  return lo + unipolar * (hi - lo);
}

function withLfoIR(ir) {
  return new Sig((t, cps, pos) => sampleLfoIR(ir, t, cps, pos), { lfoIR: ir });
}

const NOISE_SHAPES = new Set(['rand', 'perlin']);

function shapeSignal(shape) {
  return (opts = {}) => {
    const o = typeof opts === 'number' ? { rate: opts } : opts;
    const { rate = 1, phase = 0 } = o;
    const ir = { shape, rateHz: rate, phaseCycles: phase, min: 0, max: 1 };
    // The noise shapes are the only ones with a stream to decorrelate, and they take a build-time
    // seed off the SAME shared counter choose()/irand()/.degrade() draw from - so independent
    // rand() calls are independent noise, positionally seeded, and re-evaluating the document
    // replays the identical take (see nextAutoSeed / resetRandomSeeds). Deterministic shapes take
    // no seed, so they can't shift that counter out from under the random builders.
    if (NOISE_SHAPES.has(shape)) ir.seed = o.seed == null ? nextAutoSeed() : Number(o.seed) + 1;
    return withLfoIR(ir);
  };
}

/** `sine({ rate: 0.3 }).range(200, 5000)` - also callable as `sine(0.3)` (rate shorthand). */
export const sine = shapeSignal('sine');
export const saw = shapeSignal('saw');
export const tri = shapeSignal('tri');
export const square = shapeSignal('square');
export const ramp = shapeSignal('ramp'); // rising 0->1 each period (alias shape of saw)
/**
 * Uniform random, 0..1 - an independent draw at every position it is read at, the same hash
 * choose()/irand()/.degrade() draw from. Every event that samples it gets its own coin, so
 * `s("breaks").seg(8).when(rand().gte(0.5), x => x.flip(1))` is eight flips a bar, not one; hold a
 * value across a span with `.seg(8)`/`.hold("1*8")`, and reach for perlin() when you want smooth
 * drift instead of noise.
 *
 * Every rand() is its OWN stream: two of them in a document decorrelate on their own, so
 * `.when(rand().gte(0.7), …).when(rand().gte(0.7), …)` really is two independent coins. Pass
 * `{ seed }` only to pin a particular one - two rand()s given the same explicit seed deliberately
 * move together, which is how you gate two things off one random. `{ rate }`/`{ phase }` shift the
 * stream's own timeline (`rand(0.5)` is the rate shorthand); since every position is already an
 * independent draw, they pick WHICH draws you land on rather than how fast the value changes.
 *
 * The native (engine-side) noise a `.param(rand())` runs is a different stream from this JS one -
 * only the rate and range contract is shared, as it always has been. There the rate does set the
 * pace: it steps to a new uniform value `rate` times a second.
 */
export const rand = shapeSignal('rand');
/** Fractal value noise (fBm) - smoother, organic drift. Independently seeded like rand(). */
export const perlin = shapeSignal('perlin');

const DEFAULT_LFO_SHAPE = '0,0 0.5,1 1,0'; // triangle - what a bare lfo() starts as

/**
 * `lfo("0,0 0.25,1,-3 1,0", { rate: 1, mode: 'free' }).range(200, 5000)` - a hand-drawn
 * modulator shape (see shape.mjs for the breakpoint format). In the editor, putting the cursor
 * inside an lfo(...) call opens the interactive shape editor, which writes this string.
 * Modes: 'free' (loops on its own clock), 'retrigger' (loops, phase resets on each note),
 * 'envelope' (plays once per note over 1/rate seconds, then holds its final level).
 */
export function lfo(shape, opts = {}) {
  const { rate = 1, phase = 0, mode = 'free' } = typeof opts === 'number' ? { rate: opts } : opts;
  if (!['free', 'retrigger', 'envelope'].includes(mode)) {
    throw new Error(`[signal] lfo() mode must be 'free', 'retrigger', or 'envelope' (got "${mode}")`);
  }
  const points = parseShapePoints(typeof shape === 'string' && shape.trim() ? shape : DEFAULT_LFO_SHAPE);
  return withLfoIR({ shape: 'custom', points, mode, rateHz: rate, phaseCycles: phase, min: 0, max: 1 });
}

// ---------------------------------------------------------------------------------------------
// Envelope generator - an ADSR retriggered by the track's own note on/offs. Like the LFO
// builders it's purely symbolic (`envIR`): the engine compiles it to a native EnvGen gated by
// the same sample-accurate note events driving the instrument (see "Tier 2" in ARCHITECTURE.md
// and the poptart_env SynthDef). It can't be sampled from JS - an envelope's value depends on
// note onsets, which only the engine sees - so `sample()` just holds the floor value.
// ---------------------------------------------------------------------------------------------

function withEnvIR(ir) {
  return new Sig((t, cps, pos) => sampleBound(ir.min, t, cps, pos) ?? 0, { envIR: ir });
}

/**
 * `env({ attack: 0.03, decay: 0.3, sustain: 0.2, release: 0.15, curve: -4 }).range(300, 6000)` -
 * times in seconds, sustain 0..1. `curve` shapes every segment (SuperCollider convention:
 * negative = exponential-ish scoop, 0 = linear, positive = bulge); also settable via .curve(c).
 */
export function env(opts = {}) {
  const { attack = 0.01, decay = 0.1, sustain = 0.7, release = 0.2, curve = -4 } = opts;
  return withEnvIR({ attack, decay, sustain, release, curve, min: 0, max: 1 });
}

// ---------------------------------------------------------------------------------------------
// Live MIDI input. midicc() signals are symbolic like the LFO builders (`ccIR`): assigned to a
// control they compile to a native engine-side binding (MIDI event -> control bus -> parameter,
// see setParamCC in the engine), so a hardware knob drives its parameter with no polling and no
// scheduler latency. Their JS-side sample() reads the host-fed live-value store (midi.mjs), so
// a cc signal demoted into Tier-1 (used inside arithmetic, .hold(), a signal-valued bound...)
// still works - at poll-rate latency instead of the native path's.
// ---------------------------------------------------------------------------------------------

function withCcIR(ir) {
  return new Sig(
    (t, cps, pos) => {
      const v = latestCC(ir.device, ir.cc, ir.channel);
      if (v == null) return null; // nothing received yet - rest, so the param holds its value
      const lo = sampleBound(ir.min, t, cps, pos) ?? 0;
      const hi = sampleBound(ir.max, t, cps, pos) ?? 1;
      return lo + v * (hi - lo);
    },
    { ccIR: ir },
  );
}

function assertMidiDevice(builder, device) {
  if (typeof device !== 'string' || !device.trim()) {
    throw new Error(`[signal] ${builder}(...) takes a MIDI device name, e.g. ${builder}("Midi Fighter Twister") - names match connected devices by case-insensitive substring`);
  }
}

/**
 * `const cc = midicc("Midi Fighter Twister")` - a MIDI controller as a signal source. The
 * result is a function of (ccNumber, channel): `cc(12, 1)` is the continuous 0..1 signal of
 * CC 12 on channel 1; omit the channel to aggregate all 16 (last event on any channel wins).
 * `.range(lo, hi)` rescales it (signal-valued bounds welcome, as with LFOs), and linear math
 * (.mul/.add/...) rewrites the bounds symbolically so the binding stays native.
 */
export function midicc(device) {
  assertMidiDevice('midicc', device);
  registerMidiDevice(device);
  return (cc, channel = null) => {
    if (typeof cc !== 'number' || Number.isNaN(cc)) {
      throw new Error('[signal] midicc: the device function takes (ccNumber, channel?) - e.g. cc(12, 1); channel omitted listens on all channels');
    }
    if (channel != null && !(channel >= 1 && channel <= 16)) {
      throw new Error('[signal] midicc: channel must be 1..16 (omit it to aggregate all channels)');
    }
    return withCcIR({ device, cc, channel, min: 0, max: 1 });
  };
}

/**
 * `macro(3)` - the live 0..1 value of knob 3 in the editor's Macros panel, as a continuous
 * signal. Every knob is also pre-bound in evaluated code as `macro1`..`macro8`, so the usual
 * form is `param("Filter 1 Freq", macro1.range(200, 4000))`. Tier-1: the scheduler polls the
 * knob's latest value, like any other sampled signal.
 */
export function macro(index) {
  assertMacroIndex(index);
  return new Sig(() => macroValue(index));
}

/**
 * `const kb = midikeys("Arturia KeyStep 32")` - a MIDI keyboard as a live note source. The
 * result is a function of (channel): `kb(1).synth("Serum 2")` plays Serum live from channel 1
 * (omit the channel for all 16). The full performance stream - notes with velocity, pitch
 * bend, aftertouch (channel and poly), and raw CCs (mod wheel, sustain) - is routed to the
 * track's instrument entirely engine-side, bypassing the lookahead scheduler, so latency is
 * the MIDI driver's rather than the pattern clock's. Live notes gate env() modulators and
 * retrigger note-synced lfo() shapes exactly like pattern notes do.
 */
export function midikeys(device) {
  assertMidiDevice('midikeys', device);
  registerMidiDevice(device);
  return (channel = null) => {
    if (channel != null && !(channel >= 1 && channel <= 16)) {
      throw new Error('[signal] midikeys: channel must be 1..16 (omit it to listen on all channels)');
    }
    return new Sig(() => null, { midiNotes: { device, channel } });
  };
}

/**
 * `keyboard().synth("Serum 2")` - play a track live from the computer keyboard, à la Ableton's
 * typing keyboard. The note stream comes from the *browser* (the keys can't be read engine-side
 * like a MIDI device): the home row plays the white keys, the row above the black keys, z/x shift
 * octave and c/v nudge velocity - see client.js for the exact map and the midi/normal/both mode
 * toggle. Like midikeys() it schedules no notes of its own; each key edge is routed straight to
 * the instrument, gating env()/lfo() shapes exactly like a pattern or MIDI note. Chain it with
 * .synth()/.fx()/.param()/.scale() as usual.
 */
export function keyboard() {
  return new Sig(() => null, { keyboardRoute: { kind: 'keyboard' } });
}

/**
 * `tap().synth("Serum 2")` - like keyboard(), but every key is a fixed-pitch hit: any key
 * triggers the track's default note at the current velocity (z/x octave and c/v velocity still
 * apply), turning the whole keyboard into one velocity-sensitive pad. Good for drums, stabs, and
 * one-shots where only the timing and dynamics matter.
 */
export function tap() {
  return new Sig(() => null, { keyboardRoute: { kind: 'tap' } });
}

function assertInputName(builder, name) {
  if (typeof name !== 'string' || !name.trim()) {
    const what = builder === 'audio' ? 'an audio input' : 'a MIDI device';
    throw new Error(`[signal] ${builder}(...) takes a source name - a track label or ${what}, e.g. ${builder}("kick")`);
  }
}

/**
 * Live MIDI as a track SOURCE: `midi("KeyStep 32").synth("Serum 2")` plays Serum from that input's
 * note stream. The name is a connected MIDI device (case-insensitive substring) or another track's
 * label, whose notes are re-triggered here; resolved track-first, prefix "track:"/"dev:" to force.
 * `channel` (1..16, omitted = all) narrows a hardware device to one MIDI channel. Like midikeys()
 * it schedules no notes of its own - the source's notes are routed to this track's instrument
 * engine-side, gating env()/lfo() shapes like any note. Chain .synth()/.fx()/.param()/.scale() as
 * usual. Called as a *method* after a plugin, `.midi(...)` injects into that plugin instead - see
 * Sig#midi. (For the computer keyboard use keyboard()/tap(); for a specific device, midikeys().)
 */
export function midi(name, channel = null) {
  assertInputName('midi', name);
  if (channel != null && !(channel >= 1 && channel <= 16)) {
    throw new Error('[signal] midi(): channel must be 1..16 (omit it for all channels)');
  }
  return new Sig(() => null, { inputSource: { io: 'midi', name: String(name).trim(), channel } });
}

/**
 * Live audio as a track SOURCE: `audio("Scarlett Input 1").fx("ValhallaRoom")` runs that input
 * through a reverb; `audio("drums").fx("Pro-C 2")` processes a copy of another track's output. The
 * name is a hardware audio input, a track label, or a named bus that other tracks feed with .bus()
 * (resolved track-first, then bus; prefix "track:"/"bus:"/"dev:" to force). Reading a bus sums
 * every track sending to it - the way to mix several tracks down and process them together. The
 * audio flows into the same chain input a synth/sampler would, so the whole .fx()/.param() chain
 * and channel strip apply; it schedules no notes of its own. Called as a *method* after a plugin,
 * `.audio(...)` injects into that plugin's sidechain instead - see Sig#audio.
 */
export function audio(name) {
  assertInputName('audio', name);
  return new Sig(() => null, { inputSource: { io: 'audio', name: String(name).trim() } });
}
