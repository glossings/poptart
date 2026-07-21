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

function sampleLfoIR(ir, tSeconds) {
  const phase = (((tSeconds * ir.rateHz + ir.phaseCycles) % 1) + 1) % 1;
  let unipolar;
  switch (ir.shape) {
    case 'saw':
      unipolar = phase;
      break;
    case 'tri':
      unipolar = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      break;
    case 'square':
      unipolar = phase < 0.5 ? 1 : 0;
      break;
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

/** `sine({ rate: 0.3 }).range(200, 5000)` */
export const sine = shapeSignal('sine');
export const saw = shapeSignal('saw');
export const tri = shapeSignal('tri');
export const square = shapeSignal('square');

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

/** `env({ attack: 0.03, decay: 0.3, sustain: 0.2, release: 0.15 }).range(300, 6000)` - times in seconds, sustain 0..1. */
export function env(opts = {}) {
  const { attack = 0.01, decay = 0.1, sustain = 0.7, release = 0.2 } = opts;
  return withEnvIR({ attack, decay, sustain, release, min: 0, max: 1 });
}
