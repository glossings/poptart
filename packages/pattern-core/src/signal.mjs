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
import { parseNoteValue, degreeToMidi } from './notes.mjs';
import { parseShapePoints, sampleShape } from './shape.mjs';

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

    // Track-building metadata, threaded through by .s()/.fx()/.param() etc. Every control
    // method returns a NEW Sig (same sample/stepsForCycle) with this metadata carried forward -
    // see _clone().
    this.instrument = opts.instrument ?? null;
    this.fxChain = opts.fxChain ?? [];
    this.paramSignals = opts.paramSignals ?? {}; // name -> Sig
    this.paramSlots = opts.paramSlots ?? {}; // name -> slot index (0 = instrument, 1..n = fx)
    this.channel = opts.channel ?? {}; // track-level channel strip: 'gain'/'pan' -> Sig
    // Sampler config, present only for s("pack") patterns: { index, begin, end, loop, speed,
    // stretch, fit, slice }, each a Sig (sampled per event onset) or absent for its default.
    this.sampler = opts.sampler ?? null;
  }

  _clone(overrides) {
    return new Sig(this.sample, {
      stepsForCycle: this.stepsForCycle,
      lfoIR: this.lfoIR,
      envIR: this.envIR,
      instrument: this.instrument,
      fxChain: this.fxChain,
      paramSignals: this.paramSignals,
      paramSlots: this.paramSlots,
      channel: this.channel,
      sampler: this.sampler,
      ...overrides,
    });
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
      {
        stepsForCycle: mappedStepsForCycle,
        instrument: this.instrument,
        fxChain: this.fxChain,
        paramSignals: this.paramSignals,
        paramSlots: this.paramSlots,
        channel: this.channel,
        sampler: this.sampler,
      },
    );
  }

  /** `n("0 2 3").scale("F minor")` - converts scale-degree values into absolute MIDI notes. */
  scale(scaleName) {
    return this.mapValue((degree) => degreeToMidi(Number(degree), scaleName));
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
      return this.mapValue((v) => min + v * (max - min));
    }
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, min: toBound(min), max: toBound(max) });
    if (this.envIR) return withEnvIR({ ...this.envIR, min: toBound(min), max: toBound(max) });
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

  /** Sets which plugin (by id, from native-engine's scanned plugin list) is this track's instrument. */
  s(pluginId) {
    return this._clone({ instrument: pluginId });
  }

  /** Appends an effect plugin to this track's chain, after the instrument and any prior .fx() calls. */
  fx(pluginId) {
    return this._clone({ fxChain: [...this.fxChain, pluginId] });
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
      {
        stepsForCycle,
        instrument: this.instrument,
        fxChain: this.fxChain,
        paramSignals: this.paramSignals,
        paramSlots: this.paramSlots,
        channel: this.channel,
        sampler: this.sampler,
      },
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
    return new Sig(sample, {
      stepsForCycle,
      instrument: transformed.instrument,
      fxChain: transformed.fxChain,
      paramSignals: transformed.paramSignals,
      paramSlots: transformed.paramSlots,
      channel: transformed.channel,
      sampler: transformed.sampler,
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

    return new Sig(sample, {
      stepsForCycle,
      instrument: this.instrument,
      fxChain: this.fxChain,
      paramSignals: this.paramSignals,
      paramSlots: this.paramSlots,
      channel: this.channel,
      sampler: this.sampler,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sampler config - only meaningful on s("pack") patterns. Every setter accepts a number, a
  // mini string, or any Sig; the value is sampled at each event's onset, so patterns and LFOs
  // all work: s("bd").i("0 3").speed(sine(0.2).range(0.5, 2)).
  // -------------------------------------------------------------------------------------------

  _samplerOpt(method, key, sig) {
    if (!this.sampler) {
      throw new Error(`[signal] .${method}() only applies to a sampler pattern - start with s("pack")`);
    }
    return this._clone({ sampler: { ...this.sampler, [key]: sig } });
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

/** Generic mini-notation signal of raw string/number values (used internally, and by .param("x", "1 2 3")). */
export function mini(str) {
  const ast = parseMini(str);
  const valueFn = (v) => (Number.isNaN(Number(v)) ? v : Number(v));
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn) });
}

/** Scale-degree control - degrees are plain numbers until `.scale(...)` turns them into MIDI notes. */
export function n(value) {
  if (typeof value === 'number') return new Sig(() => value, { stepsForCycle: () => [{ start: 0, end: 1, value }] });
  const ast = parseMini(String(value));
  const valueFn = (v) => Number(v);
  return new Sig(miniStepSampler(ast, valueFn), { stepsForCycle: miniStepsForCycle(ast, valueFn) });
}

/**
 * Sampler pattern - values are sample-pack names (folders under the samples directory), one
 * event per step: `s("bd hh bd hh")`. Configure with .i()/.begin()/.end()/.loop()/.speed()/
 * .stretch()/.fit()/.slice(); route through effects with .fx()/.param() as usual.
 */
export function s(value) {
  const ast = parseMini(String(value));
  return new Sig(miniStepSampler(ast), { stepsForCycle: miniStepsForCycle(ast), sampler: {} });
}

/** Explicit-note control - numbers pass through as MIDI, strings may be note names ("f4") or numbers. */
export function note(value) {
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
