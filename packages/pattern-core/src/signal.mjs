// The one unifying primitive: a Signal is a function of time. A note sequence from mini-
// notation and an LFO like `sine({rate:0.3})` are the same kind of thing here - the only
// difference is whether it has known step boundaries (so the scheduler can trigger exact
// note-on/off edges instead of just sampling) or not (a smooth signal, sampled continuously).
//
// This replaces an earlier draft that tried to reuse Strudel's Pattern/Hap classes directly -
// that meant reconciling two different "continuous vs discrete" models and dragging in
// @strudel/core's whole object system for what is conceptually just "a value that changes
// over time, sometimes with edges." Everything below is plain data + closures.

import { parseMini, getStepsForCycle } from './mini.mjs';
import { parseNoteValue, degreeToMidi, parseScaleName } from './notes.mjs';
import { parseShapePoints, sampleShape } from './shape.mjs';
import { latestCC, registerMidiDevice } from './midi.mjs';
import { macroValue, assertMacroIndex } from './macros.mjs';

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

    // Track-building metadata, threaded through by .synth()/.fx()/.param() etc. Every control
    // method returns a NEW Sig (same sample/stepsForCycle) with this metadata carried forward -
    // see _clone().
    this.instrument = opts.instrument ?? null;
    this.fxChain = opts.fxChain ?? [];
    this.paramSignals = opts.paramSignals ?? {}; // name -> Sig
    this.paramSlots = opts.paramSlots ?? {}; // name -> slot index (0 = instrument, 1..n = fx)
    this.channel = opts.channel ?? {}; // track-level channel strip: 'gain'/'pan' -> Sig
    this.velSig = opts.velSig ?? null; // per-onset note velocity (see vel()); synth tracks only
    // Captured plugin state per chain slot (0 = instrument, 1.. = fx), from synth/fx's second
    // argument: { [slot]: "<opaque state string>" }. Applied by the scheduler after load.
    this.slotStates = opts.slotStates ?? {};
    // Sampler config, present only for s("pack") patterns: { index, begin, end, loop, speed,
    // stretch, fit, slice }, each a Sig (sampled per event onset) or absent for its default.
    // Patterned values also merge their step grid into the pattern's (see _samplerOpt).
    this.sampler = opts.sampler ?? null;
    // Live MIDI note routing, from midikeys(): { device, channel (null = all) }. The scheduler
    // hands this to the engine, which plays the device's note stream on this track directly.
    this.midiNotes = opts.midiNotes ?? null;
  }

  _clone(overrides) {
    return new Sig(this.sample, {
      stepsForCycle: this.stepsForCycle,
      lfoIR: this.lfoIR,
      envIR: this.envIR,
      ccIR: this.ccIR,
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
      channel: this.channel,
      velSig: this.velSig,
      sampler: this.sampler,
      slotStates: this.slotStates,
      midiNotes: this.midiNotes,
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
      { stepsForCycle: mappedStepsForCycle, ...this._meta() },
    );
  }

  /**
   * `n("0 2 3").scale("F minor")` - converts scale-degree values into absolute MIDI notes.
   * On a sampler pattern the degrees live in the `.n()`/`.note()` repitch signal (the pattern's
   * own values are pack names), so scale maps that instead: s("pluck").n("0 2 4").scale("F minor").
   * On a live midikeys() route it does double duty: any degrees in the pattern still map as
   * above, and incoming live notes are also quantized to the scale engine-side (see the
   * scheduler's setMidiNotes call and the engine's midiRoute).
   */
  scale(scaleName) {
    parseScaleName(scaleName); // validate now - a live-keys-only chain never samples, so a bad name would otherwise stay silent
    let out;
    if (this.sampler) {
      if (!this.sampler.note) {
        throw new Error('[signal] .scale() on a sampler needs degrees first - e.g. s("pluck").n("0 2 4").scale("F minor")');
      }
      const mapped = this.sampler.note.mapValue((degree) => degreeToMidi(Number(degree), scaleName));
      out = this._clone({ sampler: { ...this.sampler, note: mapped } });
    } else {
      out = this.mapValue((degree) => degreeToMidi(Number(degree), scaleName));
    }
    if (this.midiNotes) out = out._clone({ midiNotes: { ...this.midiNotes, scale: scaleName } });
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

  fast(rateHz) {
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, rateHz });
    throw new Error('.fast() on a non-LFO signal is not supported yet');
  }
  rate(rateHz) {
    return this.fast(rateHz);
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
   */
  gain(value) {
    return this._clone({ channel: { ...this.channel, gain: toSignal(value) } });
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
   * Per-note velocity, sampled at each onset. On synth tracks it becomes MIDI velocity (0..1);
   * on sampler tracks it scales the sample's volume linearly. A patterned vel also gives the
   * track structure: events are split on vel's step grid (a `~` drops the event), each fresh
   * vel step retriggers, and each event is gated to its step - so s("long").vel("1 1 ~ 1")
   * plays three quarter-cycle hits that stop ringing at their step ends (Ableton Sampler
   * "gate" mode), instead of one full-length sample.
   */
  vel(value) {
    const sig = toSignal(value);
    const stepsForCycle = intersectSteps(this.stepsForCycle, sig);
    if (this.sampler) return this._clone({ sampler: { ...this.sampler, vel: sig }, stepsForCycle });
    return this._clone({ velSig: sig, stepsForCycle });
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
    const base = this.stepsForCycle;
    const stepsForCycle = (cycle) =>
      base(cycle).map((s) => {
        if (s.value == null) return s;
        // Steps only know cycle positions, so sample the control in cycle-time at the step's
        // midpoint - same convention as _binop's patterned operands.
        const raw = Number(sig.sample(cycle + (s.start + s.end) / 2, 1));
        const clip = raw > 0 && !Number.isNaN(raw) ? raw : 1;
        return { ...s, end: s.start + (s.end - s.start) * clip };
      });
    return this._clone({ stepsForCycle });
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
      ? (cycle) =>
          this.stepsForCycle(cycle).map((s) => {
            if (s.value == null) return s;
            const b = otherSig.sample(cycle + (s.start + s.end) / 2, 1);
            return b == null ? { ...s, value: null } : { ...s, value: fn(Number(s.value), Number(b)) };
          })
      : null;
    return new Sig(
      (t, cps, pos) => {
        const a = this.sample(t, cps, pos);
        if (a == null) return null;
        const b = otherSig.sample(t, cps, pos);
        return b == null ? null : fn(Number(a), Number(b));
      },
      { stepsForCycle, ...this._meta() },
    );
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
  clamp(lo, hi) { return this._unop('clamp', (v) => Math.min(hi, Math.max(lo, v))); }

  gte(x) { return this._binop('gte', x, (a, b) => (a >= b ? 1 : 0), false); }
  gt(x) { return this._binop('gt', x, (a, b) => (a > b ? 1 : 0), false); }
  lte(x) { return this._binop('lte', x, (a, b) => (a <= b ? 1 : 0), false); }
  lt(x) { return this._binop('lt', x, (a, b) => (a < b ? 1 : 0), false); }
  eq(x) { return this._binop('eq', x, (a, b) => (a === b ? 1 : 0), false); }
  neq(x) { return this._binop('neq', x, (a, b) => (a !== b ? 1 : 0), false); }

  /**
   * `n("0 1 2 3").when("1 0".gte(1), x => x.add(12))` - applies `fn` to this pattern wherever
   * `cond` is truthy (nonzero), switching on cond's own step grid within the cycle. Where cond
   * is falsy (including rests) the original pattern plays.
   */
  when(cond, fn) {
    const condSig = toSignal(cond);
    const transformed = fn(this);
    if (!(transformed instanceof Sig)) throw new Error('[signal] .when() callback must return a pattern');
    const truthy = (v) => v != null && Number(v) !== 0;

    const sample = (t, cps, pos) => (truthy(condSig.sample(t, cps, pos)) ? transformed : this).sample(t, cps, pos);

    const stepsForCycle = this.stepsForCycle
      ? (cycle) => {
          const raw = condSig.stepsForCycle
            ? condSig.stepsForCycle(cycle)
            : [{ start: 0, end: 1, value: condSig.sample(cycle + 0.5, 1) }];
          const out = [];
          for (const c of fillCondGaps(raw)) {
            const branch = truthy(c.value) ? transformed : this;
            if (!branch.stepsForCycle) continue;
            for (const s of branch.stepsForCycle(cycle)) {
              const start = Math.max(s.start, c.start);
              const end = Math.min(s.end, c.end);
              if (start < end) out.push({ ...s, start, end });
            }
          }
          return out;
        }
      : null;

    // Track metadata comes from the transformed side - fn may have added .param()s etc.; those
    // apply unconditionally (only the note/value structure switches on cond).
    return new Sig(sample, { stepsForCycle, ...transformed._meta() });
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
   */
  hold(trig) {
    this._assertSampleable('hold');
    const trigSig = toSignal(trig);
    if (!trigSig.stepsForCycle) {
      throw new Error('[signal] .hold() needs a step pattern of triggers, e.g. .hold("1*8")');
    }
    const truthy = (v) => v != null && Number(v) !== 0;

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

    // Steps span trigger-to-trigger; values sampled in cycle-time (cps=1) - same caveat as
    // _binop for real-seconds sources like LFOs; the sample() path above is always exact.
    const stepsForCycle = (cycle) => {
      const steps = trigSig
        .stepsForCycle(cycle)
        .filter((s) => truthy(s.value))
        .sort((a, b) => a.start - b.start);
      return steps.map((s, i) => ({
        start: s.start,
        end: steps[i + 1]?.start ?? 1,
        value: this.sample(cycle + s.start, 1),
        loc: s.loc,
      }));
    };

    return new Sig(sample, { stepsForCycle, ...this._meta() });
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
    // s("breaks2").slice("0 1 2 3") plays four quarter-cycle events, not one. 'auto' (fit) and
    // plain-number Sigs have no stepsForCycle, so intersectSteps leaves the grid alone.
    const stepsForCycle = sig instanceof Sig ? intersectSteps(this.stepsForCycle, sig) : this.stepsForCycle;
    return this._clone({ sampler: { ...this.sampler, [key]: sig }, stepsForCycle });
  }

  /** Which sample of the pack to play, 0-based (wraps past the end). Strudel calls this `n`. */
  i(v) { return this._samplerOpt('i', 'index', toSignal(v)); }
  /** Playback start position within the sample, 0..1. */
  begin(v) { return this._samplerOpt('begin', 'begin', toSignal(v)); }
  /** Playback end position within the sample, 0..1. */
  end(v) { return this._samplerOpt('end', 'end', toSignal(v)); }
  /** Loop the begin..end region for the event's duration (instead of one-shot). Truthy/falsy. */
  loop(v = 1) { return this._samplerOpt('loop', 'loop', toSignal(v)); }
  /** Playback rate (repitches). Negative plays backward. */
  speed(v) { return this._samplerOpt('speed', 'speed', toSignal(v)); }
  /** Timestretch factor (2 = twice as long at the same pitch). Granular, so best on rhythmic material. */
  stretch(v) { return this._samplerOpt('stretch', 'stretch', toSignal(v)); }
  /**
   * Repitch so the played region lasts exactly `measures` cycles at the current tempo -
   * `.fit()` with no argument picks the nearest power of 2 of its natural length (2.4 measures
   * -> 2, 3.6 -> 4).
   */
  fit(measures = 'auto') {
    return this._samplerOpt('fit', 'fit', measures === 'auto' ? 'auto' : toSignal(measures));
  }
  /** Play the nth detected transient slice (wraps past the last one). Needs a WAV sample. */
  slice(v) { return this._samplerOpt('slice', 'slice', toSignal(v)); }

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
    return this._noteLike(value instanceof Sig ? value : note(value));
  }

  /**
   * Scale-degree pattern for this track - n()'s builder semantics as a method, so it too works
   * before or after .synth(), and on samplers: s("pluck").n("0 2 4").scale("F minor") repitches
   * by degree exactly like a synth melody (degrees are plain numbers until .scale()).
   */
  n(value) {
    return this._noteLike(value instanceof Sig ? value : n(value));
  }

  /**
   * Destructures multi-field tokens into note/velocity/duration, Strudel-style:
   * `"<36:1:4 ~ 47:0.5:3 ~>*8".as("note:vel:clip")`. Each token's fields are split on ":" and
   * read in the order the spec names them. Fields: `note` (MIDI number or note name), `n`
   * (scale degree - map it with .scale() afterwards), `vel` (0..1 velocity for that one
   * event), `clip` (duration as a multiple of the token's own step width - at *8, clip 3 rings
   * for three eighth-slots). Missing/empty fields keep their defaults (vel 1, clip 1). This is
   * the form the editor's midi-record writes in place of a kb()/midikeys() call.
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
    const explode = (raw) => {
      const parts = String(raw).split(':');
      const out = { value: null, vel: null, clip: 1 };
      fields.forEach((f, i) => {
        const p = parts[i];
        if (p === undefined || p === '') return;
        if (f === 'note') out.value = parseNoteValue(p);
        else if (f === 'n') out.value = Number(p);
        else if (f === 'vel') out.vel = Number(p);
        else if (f === 'clip') out.clip = Number(p);
      });
      return out;
    };
    const stepsForCycle = (cycle) =>
      this.stepsForCycle(cycle).map((s) => {
        if (s.value == null) return s;
        const e = explode(s.value);
        const clip = e.clip > 0 && !Number.isNaN(e.clip) ? e.clip : 1;
        return {
          ...s,
          value: e.value,
          // clip stretches the event past its slot; the noteOff just lands later (possibly in
          // a following cycle), same as a mini-notation tie's ringing tail.
          end: s.start + (s.end - s.start) * clip,
          ...(typeof e.vel === 'number' && !Number.isNaN(e.vel) ? { vel: e.vel } : {}),
        };
      });
    const sample = (t, cps, pos) => {
      const v = this.sample(t, cps, pos);
      return v == null ? null : explode(v).value;
    };
    return new Sig(sample, { stepsForCycle, ...this._meta() });
  }

  _noteLike(sig) {
    if (this.sampler) {
      const stepsForCycle = intersectSteps(this.stepsForCycle, sig);
      return this._clone({ sampler: { ...this.sampler, note: sig }, stepsForCycle });
    }
    // Synth track: the note signal becomes the pattern itself; everything chained so far
    // (instrument, fx, params, channel strip...) carries over. A live source keeps its own
    // midiNotes (synth("X").note(kb(1)) - the chain's meta would otherwise null it out).
    return sig._clone({ ...this._meta(), midiNotes: sig.midiNotes ?? this.midiNotes });
  }
}

// Splits a pattern's step grid on a control pattern's grid (patterned .vel()/.note()): each
// overlap becomes one event, control rests drop events, and an overlap is a new onset when
// either side starts a fresh (non-`cont`) step there - otherwise it's a tie and stays `cont`.
function intersectSteps(baseStepsForCycle, ctlSig) {
  if (!baseStepsForCycle || !ctlSig.stepsForCycle) return baseStepsForCycle;
  return (cycle) => {
    const ctlSteps = ctlSig.stepsForCycle(cycle).filter((c) => c.value != null);
    const out = [];
    for (const s of baseStepsForCycle(cycle)) {
      if (s.value == null) continue;
      for (const c of ctlSteps) {
        const start = Math.max(s.start, c.start);
        const end = Math.min(s.end, c.end);
        if (start >= end) continue;
        const cont = (start > s.start || s.cont) && (start > c.start || c.cont);
        out.push({ ...s, start, end, cont: cont || undefined });
      }
    }
    return out;
  };
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

function toSignal(value) {
  if (value instanceof Sig) return value;
  if (typeof value === 'number') return new Sig(() => value);
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

/** Generic mini-notation signal of raw string/number values (used internally, and by .param("x", "1 2 3")). */
export function mini(str) {
  assertBuilderInput('mini', str);
  if (str instanceof Sig) return str;
  const ast = parseMini(String(str));
  const valueFn = (v) => (Number.isNaN(Number(v)) ? v : Number(v));
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn) });
}

/** Scale-degree control - degrees are plain numbers until `.scale(...)` turns them into MIDI notes. */
export function n(value) {
  assertBuilderInput('n', value);
  if (value instanceof Sig) return value.mapValue((v) => Number(v));
  if (typeof value === 'number') return new Sig(() => value, { stepsForCycle: () => [{ start: 0, end: 1, value }] });
  const ast = parseMini(String(value));
  const valueFn = (v) => Number(v);
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn) });
}

/**
 * Sampler pattern - values are sample-pack names (folders under the samples directory), one
 * event per step: `s("bd hh bd hh")`. A `:n` suffix picks the pack's nth file, strudel-style:
 * `s("bd:4")` = `s("bd").i(4)` (an explicit .i() overrides the suffix). Configure with
 * .i()/.begin()/.end()/.loop()/.speed()/.stretch()/.fit()/.slice(); route through effects
 * with .fx()/.param() as usual.
 */
export function s(value) {
  assertBuilderInput('s', value);
  if (value instanceof Sig) return value._clone({ sampler: {} });
  const ast = parseMini(String(value));
  return new Sig(miniStepSampler(ast), { stepsForCycle: miniStepsForCycle(ast), sampler: {} });
}

// What a note-less synth("X") plays: C2 (MIDI 24 in this package's c5 = 60 convention), one
// whole-cycle note per cycle - the same note at which a sample plays back at native speed.
const DEFAULT_SYNTH_NOTE = 24;

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
  if (value instanceof Sig) return value.mapValue((v) => parseNoteValue(v));
  if (typeof value === 'number') return new Sig(() => value, { stepsForCycle: () => [{ start: 0, end: 1, value }] });
  const ast = parseMini(String(value));
  const valueFn = (v) => parseNoteValue(v);
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn) });
}

// ---------------------------------------------------------------------------------------------
// Continuous LFO builders - sine/saw/tri/square. These carry symbolic `lfoIR` so the scheduler
// can compile them straight into a native, sample-accurate oscillator (see ARCHITECTURE.md,
// "Tier 2") instead of sampling them from JS at all.
// ---------------------------------------------------------------------------------------------

// Deterministic hash noise for rand()'s JS-side sampling, so Tier-1 values are reproducible.
// The Tier-2 native version uses scsynth's own noise UGen, so JS values and engine values
// differ - both are random, only the rate/range contract is shared.
function hash01(i) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
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
      // continuous random: smoothstep-interpolated hash noise, one new target per period
      // (stepped random is rand().hold("1*8") - see Sig#hold)
      const i = Math.floor(total);
      const u = total - i;
      const su = u * u * (3 - 2 * u);
      unipolar = hash01(i) * (1 - su) + hash01(i + 1) * su;
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

function shapeSignal(shape) {
  return (opts = {}) => {
    const { rate = 1, phase = 0 } = typeof opts === 'number' ? { rate: opts } : opts;
    return withLfoIR({ shape, rateHz: rate, phaseCycles: phase, min: 0, max: 1 });
  };
}

/** `sine({ rate: 0.3 }).range(200, 5000)` - also callable as `sine(0.3)` (rate shorthand). */
export const sine = shapeSignal('sine');
export const saw = shapeSignal('saw');
export const tri = shapeSignal('tri');
export const square = shapeSignal('square');
export const ramp = shapeSignal('ramp'); // rising 0->1 each period (alias shape of saw)
export const rand = shapeSignal('rand'); // continuous random; step it with .hold("1*8")

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
