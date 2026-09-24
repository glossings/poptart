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
 * The shape an envelope segment follows, as the desktop's Env draws it: `t` runs 0..1 across the
 * segment and the answer is how far along its rise it is. A negative curve scoops (fast at first,
 * then easing in), a positive one bulges, and zero is a straight line.
 */
export function curveAt(curve, t) {
  const c = Number(curve) || 0;
  if (Math.abs(c) < 1e-3) return t;
  return (1 - Math.exp(c * t)) / (1 - Math.exp(c));
}

/**
 * How many straight pieces a curved segment is written as. An AudioParam has no curved ramp that
 * starts from wherever the parameter happens to be - a value curve has to be handed its first value
 * and may not overlap anything else scheduled - so a curve is a short chain of linear ramps, which
 * joins onto whatever it interrupts and is close enough to the desktop's shape to sound the same.
 */
const CURVE_STEPS = 8;

/** Writes one curved segment onto a parameter as linear ramps, and records each breakpoint. */
function writeSegment(param, points, from, to, t0, dur, curve) {
  const span = Math.max(0.001, dur);
  const steps = Math.abs(Number(curve) || 0) < 1e-3 ? 1 : CURVE_STEPS;
  for (let k = 1; k <= steps; k++) {
    const time = t0 + (span * k) / steps;
    const value = k === steps ? to : from + (to - from) * curveAt(curve, k / steps);
    param.linearRampToValueAtTime(value, time);
    points.push({ time, value });
  }
  return t0 + span;
}

/** The value a list of linear breakpoints has reached at a time: held before the first and after the last. */
function valueOnLine(points, time, fallback) {
  if (!points.length) return fallback;
  if (time <= points[0].time) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (time <= b.time) {
      const a = points[i - 1];
      const span = b.time - a.time;
      return span > 0 ? a.value + ((b.value - a.value) * (time - a.time)) / span : b.value;
    }
  }
  return points[points.length - 1].value;
}

/** The lfo() modes that are played by the track's notes rather than by their own clock. */
const NOTE_GATED = new Set(['retrigger', 'envelope']);

/**
 * What makes a re-sent LFO a DIFFERENT modulator rather than the same one moved, in the desktop's
 * terms: a new basic shape starts a new oscillator, and a drawn one is rebuilt when its mode, its
 * glide or any of its shapes changed. Rate and range are not in it - those move a running LFO in
 * place, phase and all. The seed is, here: a random shape is rendered from it, where the desktop's
 * noise has no seed to change.
 */
export function lfoSpec(ir) {
  if (ir?.shape === 'custom') {
    const shapes = Array.isArray(ir.shapes) ? ir.shapes : [ir.points ?? []];
    return `custom|${ir.mode ?? 'free'}|${Number(ir.glide) || 0}|${JSON.stringify(shapes)}`;
  }
  return `${ir?.shape ?? 'sine'}|${ir?.seed ?? ''}`;
}

/**
 * A looping buffer source that drives an AudioParam with the rendered shape.
 *
 * The parameter's own value is zeroed: a connected signal ADDS to it, and a modulator that owns
 * a control has to be the whole value or the control's resting position shows through as an
 * offset nobody asked for. When the modulator lets go, the parameter is left where the modulator
 * had it, which is what the desktop does - unmapping a bus leaves the control on the last value
 * the bus wrote.
 *
 * A drawn shape has three modes, as on the desktop. `free` loops on its own clock. `retrigger`
 * loops too, but starts again from its phase on every note. `envelope` plays once from each note
 * over one period and then holds its final level - here a buffer one sample longer than the shape,
 * whose last sample is the shape's end and is the only part that loops.
 */
export class LfoConnection {
  constructor(ctx, target, ir) {
    this.ctx = ctx;
    this.target = target;
    this.ir = { ...ir };
    this.node = null;
    this.buffer = null;
    this.values = null;
    this.startedAt = 0;
    this.startPhase = 0;      // in LFO cycles, 0..cycles
    this.cycles = 1;
    this.current = 0;         // which of the drawn shapes is playing
    this.pending = null;      // a swap waiting for the next note, in the note-gated modes
    this.glide = null;        // { node, from, at, sec } while a shape swap is gliding
    this.retiring = new Set(); // sources told to stop at a later start, still on the parameter
    this.spec = lfoSpec(this.ir);
    this._render();
    this.restart(this.ir.phaseCycles ?? 0, ctx.currentTime);
  }

  rateHz() {
    return Math.max(0.0001, this.ir?.rateHz ?? 1);
  }

  mode() {
    return this.ir?.shape === 'custom' ? this.ir.mode ?? 'free' : 'free';
  }

  /** Whether the notes play this LFO, rather than its own clock. */
  gated() {
    return NOTE_GATED.has(this.mode());
  }

  /** The breakpoints of the drawn shape that is playing. */
  _points() {
    const shapes = this.ir?.shapes;
    return (Array.isArray(shapes) && shapes[this.current]) || this.ir?.points;
  }

  _render() {
    const ir = this.ir?.shape === 'custom' ? { ...this.ir, points: this._points() } : this.ir;
    this.cycles = cyclesFor(ir?.shape ?? 'sine');
    let values = renderRange(ir);
    if (this.mode() === 'envelope') {
      // One pass, then the shape's final level for good.
      const min = ir?.min ?? 0;
      const max = ir?.max ?? 1;
      const end = Math.min(1, Math.max(0, readPoints(ir.points, 1)));
      const held = new Float32Array(values.length + 1);
      held.set(values);
      held[values.length] = min + (max - min) * end;
      values = held;
    }
    const buffer = this.ctx.createBuffer(1, values.length, this.ctx.sampleRate);
    buffer.getChannelData(0).set(values);
    this.values = values;
    this.buffer = buffer;
  }

  /** How fast the buffer has to play for one of its cycles to take 1/rate seconds. */
  _playbackRate() {
    return (this.rateHz() * SHAPE_SAMPLES) / (this.ctx.sampleRate * this.cycles);
  }

  /** Where this LFO's phase has reached, in cycles, at a time on the context's clock. */
  _phaseAt(time) {
    const elapsed = Math.max(0, time - this.startedAt);
    return this.startPhase + elapsed * this.rateHz();
  }

  /** The value the shape is putting on the parameter at a time, read off the rendered buffer. */
  _shapeAt(time) {
    const values = this.values;
    if (!values) return this.ir?.min ?? 0;
    const phase = this._phaseAt(time);
    if (this.mode() === 'envelope') {
      const pos = Math.min(1, Math.max(0, phase)) * SHAPE_SAMPLES;
      const i = Math.floor(pos);
      const a = values[Math.min(i, values.length - 1)];
      const b = values[Math.min(i + 1, values.length - 1)];
      return a + (b - a) * (pos - i);
    }
    const span = this.cycles;
    const pos = ((((phase % span) + span) % span) / span) * SHAPE_SAMPLES;
    const i = Math.floor(pos) % SHAPE_SAMPLES;
    const a = values[i];
    const b = values[(i + 1) % SHAPE_SAMPLES];
    return a + (b - a) * (pos - Math.floor(pos));
  }

  /** What is left of a swap's glide at a time: the step it started with, decaying on the desktop's -4 curve. */
  _glideAt(time) {
    const g = this.glide;
    if (!g || time < g.at) return 0;
    const t = (time - g.at) / g.sec;
    return t >= 1 ? 0 : g.from * (1 - curveAt(-4, t));
  }

  /** Everything this modulator is putting on the parameter at a time. */
  valueAt(time) {
    return this._shapeAt(time) + this._glideAt(time);
  }

  /**
   * Swaps a drawn LFO to another of its shapes - a patterned `lfo("<a b>")` stepping on. The new
   * shape starts from its BEGINNING at the time asked, as on the desktop: a shape that carried on
   * at the outgoing one's phase would be neither shape, and the scheduler counts its phase anchors
   * from the swap. In the note-gated modes the swap waits for the next note instead, so a note is
   * never cut off halfway through one shape to finish on another.
   */
  swapTo(index, atTime = null) {
    const shapes = this.ir?.shapes;
    if (!Array.isArray(shapes) || !shapes[index]) return;
    if (this.gated()) {
      this.pending = index === this.current ? null : index;
      return;
    }
    if (index === this.current) return;
    this._swap(index, Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime));
  }

  _swap(index, when) {
    const before = this.valueAt(when);
    this.current = index;
    this._render();
    this.restart(0, when);
    // The step between where the old shape was and where the new one starts, glided away over a
    // fraction of one period when the lfo() asked for it - the desktop's swap glide.
    const sec = (Number(this.ir?.glide) || 0) / this.rateHz();
    this._stopGlide(when);
    if (sec > 0) this._startGlide(before - this._shapeAt(when), when, sec);
  }

  _startGlide(from, at, sec) {
    if (!(Math.abs(from) > 1e-9)) return;
    const node = this.ctx.createConstantSource();
    const offset = node.offset;
    const points = [];
    try {
      offset.value = 0;
      offset.setValueAtTime(from, at);
      writeSegment(offset, points, from, 0, at, sec, -4);
    } catch { /* a parameter that refuses the schedule glides not at all */ }
    node.connect(this.target);
    node.start(at);
    node.stop(at + sec + 0.01);
    node.onended = () => { try { node.disconnect(); } catch { /* already detached */ } };
    this.glide = { node, from, at, sec };
  }

  _stopGlide(when) {
    const g = this.glide;
    if (!g) return;
    try { g.node.stop(when); } catch { /* already stopped */ }
    this.glide = null;
  }

  /**
   * One of the track's notes starting, at its time. A retrigger LFO starts again from its phase and
   * an envelope one from its beginning; a free one ignores it. A swap that was waiting for a note
   * lands here, just before the note, so the note gets the new shape from the top.
   */
  gate(atTime) {
    if (!this.gated()) return;
    const when = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    if (this.pending != null) {
      const index = this.pending;
      this.pending = null;
      if (index !== this.current) { this._swap(index, when); return; }
    }
    this.restart(this.mode() === 'retrigger' ? this.ir?.phaseCycles ?? 0 : 0, when);
  }

  /**
   * Re-pins a free-running LFO to the grid's phase, which the scheduler does periodically so the
   * audio clock cannot drift away from the note clock.
   *
   * A random shape is NOT anchored, and that is deliberate on both sides of poptart: there is no
   * phase in a random walk worth pinning, and pinning one would make it repeat at the anchor
   * interval - turning the one modulator whose whole job is to be unpredictable into a loop. Nor
   * is one the notes play: its phase belongs to them.
   */
  anchor(phase01, atTime) {
    if (this.cycles > 1 || this.gated()) return;
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
    if (this.mode() === 'envelope') {
      // Only the held last sample loops; the shape before it plays once.
      node.loopStart = SHAPE_SAMPLES / this.ctx.sampleRate;
      node.loopEnd = (SHAPE_SAMPLES + 1) / this.ctx.sampleRate;
    }
    node.playbackRate.value = this._playbackRate();
    node.connect(this.target);
    const span = this.cycles;
    // An envelope-mode pass is not wrapped: its end is where it stays.
    const phase = this.mode() === 'envelope'
      ? Math.min(1, Math.max(0, phaseCycles ?? 0))
      : (((phaseCycles ?? 0) % span) + span) % span;
    node.start(when, (phase / span) * (SHAPE_SAMPLES / this.ctx.sampleRate));
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
      this.retiring.add(previous);
      const unplug = () => {
        this.retiring.delete(previous);
        try { previous.disconnect(); } catch { /* already detached */ }
      };
      previous.onended = unplug;
      // A source told to stop before it was started never fires `ended`; the timer is the
      // fallback that guarantees nothing is left hanging off the parameter.
      const timer = setTimeout(unplug, Math.max(0, when - this.ctx.currentTime) * 1000 + 250);
      timer?.unref?.(); // a node test's process need not wait for it
    }
    try { this.target.value = 0; } catch { /* a param that refuses a direct set */ }
  }

  /**
   * A re-send. The scheduler re-sends every modulator after each evaluation and a range or rate
   * that is itself a signal every tick, and an unchanged or merely moved one must NOT restart:
   * that is a click on every re-evaluation. A different modulator - a new shape, seed, drawing or
   * mode - is rebuilt from the phase it asks for, as the desktop rebuilds its synth.
   */
  update(ir) {
    const next = { ...this.ir, ...ir };
    // A re-send that names its drawing without the set of shapes is one drawing, not the old set.
    if (ir.points && !ir.shapes) delete next.shapes;
    if (lfoSpec(next) !== this.spec) {
      this._rebuild(next);
      return;
    }
    const rateChanged = next.rateHz !== this.ir.rateHz;
    const rangeChanged = next.min !== this.ir.min || next.max !== this.ir.max;
    if (!rateChanged && !rangeChanged) {
      this.ir = next;
      return;
    }
    // Where the shape has reached is read BEFORE anything changes, off the rate it has actually
    // been running at. Reading it afterwards would apply a new rate retroactively to the whole
    // time the LFO has been going, which moves the shape by more the longer the set has run.
    const now = this.ctx.currentTime;
    const phase = this._phaseAt(now);
    this.ir = next;
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
      this.startPhase = this.mode() === 'envelope'
        ? Math.min(1, phase)
        : ((phase % this.cycles) + this.cycles) % this.cycles;
      this.node.playbackRate.value = this._playbackRate();
    }
  }

  _rebuild(ir) {
    const now = this.ctx.currentTime;
    this.ir = ir;
    this.spec = lfoSpec(ir);
    this.current = 0;
    this.pending = null;
    this._stopGlide(now);
    this._render();
    this.restart(ir.phaseCycles ?? 0, now);
  }

  /**
   * Takes the LFO off its parameter and leaves the parameter on the value it had reached, as the
   * desktop does when a modulator is cleared. Leaving it at the zero the connection needed would
   * drop a filter's cutoff to the bottom of its range the moment a pattern stopped modulating it.
   * Returns that value, so the caller can record it.
   */
  stop() {
    const now = this.ctx.currentTime;
    const value = this.valueAt(now);
    const sources = [this.node, this.glide?.node, ...this.retiring].filter(Boolean);
    for (const node of sources) {
      try { node.stop(); } catch { /* never started */ }
      try { node.disconnect(); } catch { /* already detached */ }
    }
    this.retiring.clear();
    this.glide = null;
    this.node = null;
    try { this.target.value = value; } catch { /* a param that refuses a direct set */ }
    return value;
  }
}

/**
 * A parameter driven by an envelope. Unlike an LFO this has no node of its own: it is a set of
 * scheduled ramps, written onto the parameter each time the gate opens and closed when it shuts.
 *
 * The desktop's poptart_env, in automation: an ADSR whose every segment follows the IR's curve,
 * gated by the track's HELD-NOTE COUNT rather than by each note - the engine opens it on the first
 * held note and closes it when the last one ends, so a chord does not release on its first note
 * off. A re-opened gate attacks from wherever the envelope is, never from the floor, which is what
 * keeps a note landing mid-release from clicking. The breakpoints written are remembered, since a
 * parameter cannot be asked where a ramp has got to ahead of time.
 */
export class EnvConnection {
  constructor(ctx, target, ir) {
    this.ctx = ctx;
    this.target = target;
    this.ir = ir;
    this.points = [];
    // The desktop's envelope rests at its floor until a gate opens it.
    const now = ctx.currentTime;
    const min = ir?.min ?? 0;
    try {
      target.cancelScheduledValues(now);
      target.setValueAtTime(min, now);
    } catch {
      try { target.value = min; } catch { /* a param that refuses a direct set */ }
    }
    this.points.push({ time: now, value: min });
  }

  update(ir) {
    this.ir = { ...this.ir, ...ir };
  }

  /** The value the envelope has reached, or will have, at a time. */
  valueAt(time) {
    return valueOnLine(this.points, time, this.ir?.min ?? 0);
  }

  /**
   * Holds the parameter where the envelope is at `t` and drops everything scheduled after it, so
   * a new segment starts from there. Returns that value.
   */
  _holdAt(t) {
    const value = this.valueAt(t);
    const p = this.target;
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(t);
    } else {
      // Without a hold, cancelling falls back to the last value SET, so the value the envelope
      // has reached is written back explicitly.
      p.cancelScheduledValues(t);
      p.setValueAtTime(value, t);
    }
    // Breakpoints already behind the clock are only needed for the one the line comes from.
    const now = this.ctx.currentTime;
    const kept = this.points.filter((pt) => pt.time < t);
    let first = 0;
    for (let i = 0; i < kept.length; i++) if (kept[i].time <= now) first = i;
    this.points = kept.slice(first);
    this.points.push({ time: t, value });
    return value;
  }

  gateOn(atTime) {
    const { attack = 0.01, decay = 0.1, sustain = 0.7, min = 0, max = 1, curve = -4 } = this.ir;
    const t = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    const held = min + (max - min) * Math.min(1, Math.max(0, sustain));
    try {
      const from = this._holdAt(t);
      const peakAt = writeSegment(this.target, this.points, from, max, t, attack, curve);
      writeSegment(this.target, this.points, max, held, peakAt, decay, curve);
    } catch { /* a parameter already scheduled past this point */ }
  }

  gateOff(atTime) {
    const { release = 0.2, min = 0, curve = -4 } = this.ir;
    const t = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    try {
      const from = this._holdAt(t);
      writeSegment(this.target, this.points, from, min, t, release, curve);
    } catch { /* as above */ }
  }

  /** Stops the envelope where it is: the parameter keeps the value it had reached, as on the desktop. */
  stop() {
    const now = this.ctx.currentTime;
    let value = this.valueAt(now);
    try { value = this._holdAt(now); } catch { /* nothing scheduled */ }
    return value;
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
    this.unit = null;          // the last value fed in, 0..1, or null before the first
    this.node = ctx.createConstantSource();
    this.node.offset.value = ir?.min ?? 0;
    this.node.connect(target);
    this.node.start();
    try { target.value = 0; } catch { /* as above */ }
  }

  /** A new range re-scales the value last fed in, so the parameter moves with the bounds. */
  update(ir) {
    const before = this.ir;
    this.ir = { ...this.ir, ...ir };
    const moved = (before?.min ?? 0) !== (this.ir.min ?? 0) || (before?.max ?? 1) !== (this.ir.max ?? 1);
    if (moved && this.unit != null) this.feed(this.unit);
  }

  /** The value this feed is putting on the parameter. */
  value() {
    const min = this.ir?.min ?? 0;
    const max = this.ir?.max ?? 1;
    return this.unit == null ? min : min + (max - min) * this.unit;
  }

  /** `unit` is the incoming value already normalized to 0..1, as poptart feeds CC and OSC. */
  feed(unit, atTime) {
    this.unit = Math.min(1, Math.max(0, Number(unit) || 0));
    const value = this.value();
    const t = Math.max(this.ctx.currentTime, atTime ?? this.ctx.currentTime);
    try {
      this.node.offset.linearRampToValueAtTime(value, t + 0.01);
    } catch {
      this.node.offset.value = value;
    }
  }

  /** Unplugs the feed and leaves the parameter on the last value it carried, as on the desktop. */
  stop() {
    const value = this.value();
    try { this.node.stop(); } catch { /* never started */ }
    try { this.node.disconnect(); } catch { /* already detached */ }
    try { this.target.value = value; } catch { /* a param that refuses a direct set */ }
    return value;
  }
}
