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

/**
 * @typedef {Object} Step
 * @property {number} start  - fraction of a cycle, 0..1
 * @property {number} end    - fraction of a cycle, 0..1
 * @property {*} value       - null means "rest" (gate off)
 */

export class Sig {
  /**
   * @param {(tSeconds: number, cps: number) => *} sampleFn
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
      ...overrides,
    });
  }

  /** Maps this signal's values through `fn`; rests (null) pass through untouched. */
  mapValue(fn) {
    const mappedStepsForCycle = this.stepsForCycle
      ? (cycle) => this.stepsForCycle(cycle).map((s) => (s.value == null ? s : { ...s, value: fn(s.value) }))
      : null;
    return new Sig(
      (t, cps) => {
        const v = this.sample(t, cps);
        return v == null ? null : fn(v);
      },
      {
        stepsForCycle: mappedStepsForCycle,
        instrument: this.instrument,
        fxChain: this.fxChain,
        paramSignals: this.paramSignals,
        paramSlots: this.paramSlots,
      },
    );
  }

  /** `n("0 2 3").scale("F minor")` - converts scale-degree values into absolute MIDI notes. */
  scale(scaleName) {
    return this.mapValue((degree) => degreeToMidi(Number(degree), scaleName));
  }

  /** Rescales a 0..1-ish signal (LFO/env builders) into [min,max]. Falls back to a generic mapValue for anything else. */
  range(min, max) {
    if (this.lfoIR) return withLfoIR({ ...this.lfoIR, min, max });
    if (this.envIR) return withEnvIR({ ...this.envIR, min, max });
    return this.mapValue((v) => min + v * (max - min));
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
      if (this.lfoIR) return withLfoIR({ ...this.lfoIR, min: fn(this.lfoIR.min, other), max: fn(this.lfoIR.max, other) });
      if (this.envIR) return withEnvIR({ ...this.envIR, min: fn(this.envIR.min, other), max: fn(this.envIR.max, other) });
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
      (t, cps) => {
        const a = this.sample(t, cps);
        if (a == null) return null;
        const b = otherSig.sample(t, cps);
        return b == null ? null : fn(Number(a), Number(b));
      },
      {
        stepsForCycle,
        instrument: this.instrument,
        fxChain: this.fxChain,
        paramSignals: this.paramSignals,
        paramSlots: this.paramSlots,
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

    const sample = (t, cps) => (truthy(condSig.sample(t, cps)) ? transformed : this).sample(t, cps);

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
    });
  }

  /** Envelope curve (see env()): negative = exponential-ish scoop, 0 = linear, positive = bulge. */
  curve(c) {
    if (this.envIR) return withEnvIR({ ...this.envIR, curve: c });
    throw new Error('[signal] .curve() only applies to env() signals');
  }
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

// ---------------------------------------------------------------------------------------------
// mini-notation-backed signals: n(), note(), and the generic mini() used by .param()/.fx() when
// given a plain string.
// ---------------------------------------------------------------------------------------------

function miniStepSampler(ast, valueFn) {
  return (tSeconds, cps) => {
    const cyclePos = tSeconds * cps;
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

// Deterministic hash noise for drift/sandy's JS-side sampling, so Tier-1 values are
// reproducible. The Tier-2 native versions use scsynth's own noise UGens, so JS values and
// engine values differ - both are random, only the rate/range contract is shared.
function hash01(i) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function sampleLfoIR(ir, tSeconds) {
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
    case 'sandy': // stepped random: a new value each period, held
      unipolar = hash01(Math.floor(total));
      break;
    case 'drift': {
      // slow smoothed random: smoothstep-interpolated hash noise, one target per period
      const i = Math.floor(total);
      const u = total - i;
      const su = u * u * (3 - 2 * u);
      unipolar = hash01(i) * (1 - su) + hash01(i + 1) * su;
      break;
    }
    case 'sine':
    default:
      unipolar = 0.5 + 0.5 * Math.sin(phase * 2 * Math.PI);
  }
  return ir.min + unipolar * (ir.max - ir.min);
}

function withLfoIR(ir) {
  return new Sig((t) => sampleLfoIR(ir, t), { lfoIR: ir });
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
export const drift = shapeSignal('drift'); // slow smoothed random - a wandering value
export const sandy = shapeSignal('sandy'); // stepped random - a new held value each period

// ---------------------------------------------------------------------------------------------
// Envelope generator - an ADSR retriggered by the track's own note on/offs. Like the LFO
// builders it's purely symbolic (`envIR`): the engine compiles it to a native EnvGen gated by
// the same sample-accurate note events driving the instrument (see "Tier 2" in ARCHITECTURE.md
// and the poptart_env SynthDef). It can't be sampled from JS - an envelope's value depends on
// note onsets, which only the engine sees - so `sample()` just holds the floor value.
// ---------------------------------------------------------------------------------------------

function withEnvIR(ir) {
  return new Sig(() => ir.min, { envIR: ir });
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
