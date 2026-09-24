// Modulators, engine-side.
//
// poptart's scheduler splits modulation in two. A control assigned ONE WHOLE modulator - `.param
// ("Cutoff", lfo("swell"))` - is programmed into the engine once and runs there; a control
// assigned anything else is polled every 30 ms and ramped between polls. The first kind is what
// this file serves, and the contract is that once a modulator owns a parameter it owns it
// completely: the parameter's own value stops meaning anything until the modulator is cleared.
//
// The trick that makes every LFO shape one implementation is to RENDER the shape into an
// AudioBuffer and loop it into the parameter. A looping buffer is an audio-rate signal that
// costs nothing to run, its rate is a playback rate, and its phase is a start offset - so
// sine, saw, a drawn shape and a sampled random walk are all the same three lines, where
// building each out of oscillator nodes would be a different graph per shape and would leave
// the drawn ones with nothing to be built from at all.

/** How finely a shape is rendered. Resampled by the playback rate to any frequency. */
const SHAPE_SAMPLES = 2048;

/**
 * How many LFO cycles one rendered buffer spans.
 *
 * Most shapes repeat every cycle by definition, so one cycle of buffer is the whole shape. The
 * two RANDOM ones do not: a random modulator that played the same few values every cycle would
 * be a rhythm, not a random walk, and the loop would be plainly audible within a bar. They are
 * rendered over a long span instead, so what repeats is sixty-four cycles away - about half a
 * minute at a typical rate, by which time the pattern around it has moved on.
 *
 * This is the same trade the desktop side makes from the other direction: there the shape comes
 * from a noise UGen that never repeats at all, and the contract the two sides actually share is
 * the RATE - one new value per cycle - rather than the sequence of values.
 */
const RANDOM_CYCLES = 64;

/** The cycles one buffer of this shape spans. */
export function cyclesFor(shape) {
  return shape === 'rand' || shape === 'perlin' ? RANDOM_CYCLES : 1;
}

/** A deterministic value per step, so a seeded random LFO renders the same every time. */
function hashUnit(seed, i) {
  let h = (seed * 2654435761 + i * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Linear interpolation through a list of {x, y} breakpoints, as a drawn shape is stored. */
function readPoints(points, phase) {
  if (!points?.length) return 0;
  if (points.length === 1) return points[0].y ?? points[0][1] ?? 0;
  const xOf = (p) => (Array.isArray(p) ? p[0] : p.x);
  const yOf = (p) => (Array.isArray(p) ? p[1] : p.y);
  if (phase <= xOf(points[0])) return yOf(points[0]);
  for (let i = 1; i < points.length; i++) {
    const x0 = xOf(points[i - 1]);
    const x1 = xOf(points[i]);
    if (phase <= x1) {
      const span = x1 - x0;
      const t = span > 0 ? (phase - x0) / span : 0;
      return yOf(points[i - 1]) + (yOf(points[i]) - yOf(points[i - 1])) * t;
    }
  }
  return yOf(points[points.length - 1]);
}

/**
 * A modulator shape, as values in 0..1, spanning `cyclesFor(shape)` LFO cycles.
 *
 * EVERY SHAPE HERE HAS TO MATCH THE DESKTOP ONE, and the phase origin is the part that is easy
 * to get wrong and hard to notice: a signal read in the pattern language and the same signal
 * running in the engine have to agree, or a modulation that looks right in the editor sounds a
 * quarter cycle off. So: `sine` starts at its MIDPOINT and rises, `tri` starts at zero and peaks
 * halfway, `saw` rises, `isaw` falls, and `square` is high for the first half.
 */
export function renderShape(ir) {
  const out = new Float32Array(SHAPE_SAMPLES);
  const shape = ir?.shape ?? 'sine';
  const seed = (ir?.seed ?? 1) >>> 0;
  const cycles = cyclesFor(shape);
  for (let i = 0; i < SHAPE_SAMPLES; i++) {
    // `p` runs 0..1 across the whole buffer; `c` is the position within one LFO cycle.
    const p = i / SHAPE_SAMPLES;
    const c = cycles === 1 ? p : (p * cycles) % 1;
    let v;
    switch (shape) {
      case 'saw': v = c; break;
      case 'isaw': v = 1 - c; break;
      case 'tri': v = c < 0.5 ? c * 2 : 2 - c * 2; break;
      case 'square': v = c < 0.5 ? 1 : 0; break;
      // One fresh value per cycle, held in between - the rate the desktop side promises.
      case 'rand': v = hashUnit(seed, Math.floor(p * cycles)); break;
      case 'perlin': {
        // Fractal value noise: smoothstep-interpolated hash noise over four octaves, each twice
        // the rate and half the amplitude, offset per octave so they decorrelate. Written to
        // match the pattern language's own perlin rather than merely to sound similar.
        let sum = 0;
        let amp = 1;
        let norm = 0;
        let freq = 1;
        for (let oct = 0; oct < 4; oct++) {
          const x = p * cycles * freq + oct * 17.13;
          const i0 = Math.floor(x);
          const u = x - i0;
          const su = u * u * (3 - 2 * u);
          sum += amp * (hashUnit(seed, i0) * (1 - su) + hashUnit(seed, i0 + 1) * su);
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        v = sum / norm;
        break;
      }
      case 'custom': v = readPoints(ir.points, c); break;
      default: v = 0.5 + 0.5 * Math.sin(c * Math.PI * 2); break;   // sine, from its midpoint
    }
    out[i] = Math.min(1, Math.max(0, v));
  }
  return out;
}

/** The shape scaled into the modulator's own range, which is what drives the parameter. */
export function renderRange(ir) {
  const unit = renderShape(ir);
  const min = ir?.min ?? 0;
  const max = ir?.max ?? 1;
  const out = new Float32Array(unit.length);
  for (let i = 0; i < unit.length; i++) out[i] = min + (max - min) * unit[i];
  return out;
}

/**
 * A looping buffer source that drives an AudioParam with the rendered shape.
 *
 * The parameter's own value is zeroed: a connected signal ADDS to it, and a modulator that owns
 * a control has to be the whole value or the control's resting position shows through as an
 * offset nobody asked for.
 */
export class LfoConnection {
  constructor(ctx, target, ir) {
    this.ctx = ctx;
    this.target = target;
    this.ir = ir;
    this.node = null;
    this.buffer = null;
    this.startedAt = 0;
    this.startPhase = 0;      // in LFO cycles, 0..cycles
    this.cycles = 1;
    this.setShape(ir);
  }

  rateHz() {
    return Math.max(0.0001, this.ir?.rateHz ?? 1);
  }

  /**
   * Sets or swaps the shape. A swap on a running LFO keeps the phase the old shape had reached
   * at the moment of the swap, and lands at the time it was asked for: the scheduler sends a
   * patterned shape change a lookahead ahead, and a swap that fired now, from phase zero, would
   * be both early and a jump.
   */
  setShape(ir, atTime = null) {
    const now = this.ctx.currentTime;
    const when = Math.max(now, atTime ?? now);
    const phase = this.node ? this._phaseAt(when) : (ir?.phaseCycles ?? this.ir?.phaseCycles ?? 0);
    this.ir = { ...this.ir, ...ir };
    this.cycles = cyclesFor(this.ir?.shape ?? 'sine');
    this._render();
    this.restart(phase, when);
  }

  _render() {
    const values = renderRange(this.ir);
    const buffer = this.ctx.createBuffer(1, values.length, this.ctx.sampleRate);
    buffer.getChannelData(0).set(values);
    this.buffer = buffer;
  }

  /** How fast the buffer has to play for one of its cycles to take 1/rate seconds. */
  _playbackRate() {
    return (this.rateHz() * this.buffer.length) / (this.ctx.sampleRate * this.cycles);
  }

  /** Where this LFO's phase has reached, in cycles, at a time on the context's clock. */
  _phaseAt(time) {
    const elapsed = Math.max(0, time - this.startedAt);
    return this.startPhase + elapsed * this.rateHz();
  }

  /**
   * Re-pins a free-running LFO to the grid's phase, which the scheduler does periodically so the
   * audio clock cannot drift away from the note clock.
   *
   * A random shape is NOT anchored, and that is deliberate on both sides of poptart: there is no
   * phase in a random walk worth pinning, and pinning one would make it repeat at the anchor
   * interval - turning the one modulator whose whole job is to be unpredictable into a loop.
   */
  anchor(phase01, atTime) {
    if (this.cycles > 1) return;
    this.restart(phase01, atTime);
  }

  /**
   * (Re)starts the buffer at a phase. A buffer source cannot be restarted, so this builds a new
   * one - which is also how a phase anchor works: the scheduler re-anchors a free-running LFO
   * every few seconds so it cannot drift away from the grid, and each anchor is a fresh start at
   * the phase the grid says it should be at.
   */
  restart(phaseCycles, atTime) {
    const when = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    const previous = this.node;
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.loop = true;
    node.playbackRate.value = this._playbackRate();
    node.connect(this.target);
    const span = this.cycles;
    const phase = (((phaseCycles ?? 0) % span) + span) % span;
    node.start(when, (phase / span) * (this.buffer.length / this.ctx.sampleRate));
    this.node = node;
    this.startedAt = when;
    this.startPhase = phase;
    if (previous) {
      // The old source plays on until the new one takes over, and is unplugged only once it has
      // stopped. Unplugging it here, at the time of the call, left the parameter with NOTHING on
      // it for the whole lookahead - a hundred and fifty milliseconds at its intrinsic zero,
      // which on a filter's cutoff is a drop to twenty hertz - every time the scheduler anchored
      // the phase, which is every few seconds. An anchor that lands on the phase the LFO already
      // has, which is the normal case, must be inaudible.
      try { previous.stop(when); } catch { /* not started, or already stopped */ }
      const unplug = () => { try { previous.disconnect(); } catch { /* already detached */ } };
      previous.onended = unplug;
      // A source told to stop before it was started never fires `ended`; the timer is the
      // fallback that guarantees nothing is left hanging off the parameter.
      const timer = setTimeout(unplug, Math.max(0, when - this.ctx.currentTime) * 1000 + 250);
      timer?.unref?.(); // a node test's process need not wait for it
    }
    try { this.target.value = 0; } catch { /* a param that refuses a direct set */ }
  }

  /** An in-place range or rate change that must NOT restart the shape (see the scheduler). */
  update(ir) {
    const rateChanged = (ir.rateHz ?? this.ir.rateHz) !== this.ir.rateHz;
    const rangeChanged = (ir.min ?? this.ir.min) !== this.ir.min || (ir.max ?? this.ir.max) !== this.ir.max;
    if (!rateChanged && !rangeChanged) {
      this.ir = { ...this.ir, ...ir };
      return;
    }
    // Where the shape has reached is read BEFORE anything changes, off the rate it has actually
    // been running at. Reading it afterwards would apply a new rate retroactively to the whole
    // time the LFO has been going, which moves the shape by more the longer the set has run.
    const now = this.ctx.currentTime;
    const phase = this._phaseAt(now);
    this.ir = { ...this.ir, ...ir };
    if (rangeChanged) {
      // A new range needs a new buffer, and a new buffer needs a new source - so the phase is
      // carried across by hand rather than being lost. It counts from the phase the shape
      // STARTED at as well as the time since: counting only the elapsed time would jump the
      // shape back by its start offset every time somebody swept a range bound, and a range
      // bound is an ordinary signal the scheduler re-sends on every tick.
      this._render();
      this.restart(phase, now);
      return;
    }
    if (this.node) {
      this.startedAt = now;
      this.startPhase = ((phase % this.cycles) + this.cycles) % this.cycles;
      this.node.playbackRate.value = this._playbackRate();
    }
  }

  stop() {
    if (!this.node) return;
    try { this.node.stop(); } catch { /* never started */ }
    try { this.node.disconnect(); } catch { /* already detached */ }
    this.node = null;
  }
}

/**
 * A parameter driven by an envelope. Unlike an LFO this has no node of its own: it is a set of
 * scheduled ramps, written onto the parameter each time a note starts and released when it ends.
 */
export class EnvConnection {
  constructor(ctx, target, ir) {
    this.ctx = ctx;
    this.target = target;
    this.ir = ir;
  }

  update(ir) {
    this.ir = { ...this.ir, ...ir };
  }

  gateOn(atTime) {
    const { attack = 0.01, decay = 0.1, sustain = 0.7, min = 0, max = 1 } = this.ir;
    const t = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    const peak = max;
    const held = min + (max - min) * Math.min(1, Math.max(0, sustain));
    const p = this.target;
    try {
      p.cancelScheduledValues(t);
      p.setValueAtTime(min, t);
      p.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
      p.linearRampToValueAtTime(held, t + Math.max(0.001, attack) + Math.max(0.001, decay));
    } catch { /* a parameter already scheduled past this point */ }
  }

  gateOff(atTime) {
    const { release = 0.2, min = 0 } = this.ir;
    const t = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    try {
      this.target.cancelScheduledValues(t);
      this.target.setValueAtTime(this.target.value, t);
      this.target.linearRampToValueAtTime(min, t + Math.max(0.001, release));
    } catch { /* as above */ }
  }

  stop() {
    try { this.target.cancelScheduledValues(this.ctx.currentTime); } catch { /* nothing scheduled */ }
  }
}

/**
 * A parameter driven by a live control value - a MIDI continuous controller or an incoming OSC
 * message. A constant source rather than a scheduled value so the host can push a new value at
 * any time without knowing anything about the graph it lands in.
 */
export class FeedConnection {
  constructor(ctx, target, ir) {
    this.ctx = ctx;
    this.target = target;
    this.ir = ir;
    this.node = ctx.createConstantSource();
    this.node.offset.value = ir?.min ?? 0;
    this.node.connect(target);
    this.node.start();
    try { target.value = 0; } catch { /* as above */ }
  }

  update(ir) {
    this.ir = { ...this.ir, ...ir };
  }

  /** `unit` is the incoming value already normalized to 0..1, as poptart feeds CC and OSC. */
  feed(unit, atTime) {
    const min = this.ir?.min ?? 0;
    const max = this.ir?.max ?? 1;
    const value = min + (max - min) * Math.min(1, Math.max(0, unit));
    const t = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    try {
      this.node.offset.linearRampToValueAtTime(value, t + 0.01);
    } catch {
      this.node.offset.value = value;
    }
  }

  stop() {
    try { this.node.stop(); } catch { /* never started */ }
    try { this.node.disconnect(); } catch { /* already detached */ }
  }
}
