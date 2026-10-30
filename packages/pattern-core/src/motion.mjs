// Recording a live control's movement: `knob(0.5).record({ cycles: 2 })`.
//
// `.record()` on a TRACK bounces its sound to a file (see Sig#record in signal.mjs). On a live
// control - a knob(), slider(), toggle(), button() or xy() drawn in the code, a midicc(), an osc()
// or a macro() - the same verb records the control's MOVEMENT and loops it:
//
//   - While the control moves, it is recorded. It stops when the hand lets go of a drawn control,
//     or when the control has not moved for a cycle (a MIDI or OSC controller has no release).
//   - The take is `cycles` long and lies on cycle boundaries: it starts at the cycle the movement
//     started in, or - for a movement longer than the take - it is the last `cycles` cycles of it,
//     ending at the cycle boundary after the hand stopped. Before the movement it holds the value
//     the control had, after it the value it was left at.
//   - It loops in step with the transport: the value recorded at cycle q plays again at every
//     cycle q + k * cycles. So the loop starts over at the cycle boundary after the movement ended.
//   - Touching the control again records a new take that replaces it. Nothing is overdubbed.
//
// A finished take is a drawn lfo() shape. The host hands it to the editor (takeMotionTakes), which
// writes it into the buffer as a `_shape("name", "...")` definition and names it in the call -
// `knob(0.5).record({ cycles: 2, take: "name" })` - so it survives a reload, opens in the shape
// editor, and the control stays in the code to be recorded again. Until the editor has written it
// the take plays from here.
//
// What is recorded is what is HEARD: the scheduler's polls read the control at the position the
// value is applied (see withLiveReads), and the take is filed at that position. Reads from
// anywhere else - a display, a highlight window - do not record.

import { Sig, warnPattern } from './signal.mjs';
import { defScope, lookupShape } from './rolls.mjs';
import { parseShapePoints, serializeShapePoints, sampleShape } from './shape.mjs';
import { evaluatingDeck, widgetGeneration, registerMotionRecord } from './widgets.mjs';

/** Cycles a take is when `.record()` on a control says none - the same as a track's recording. */
export const MOTION_DEFAULT_CYCLES = 4;

/** How long a control has to stay still, in cycles, before a take without a release ends. */
export const MOTION_IDLE_CYCLES = 1;

// How far apart two values have to be to count as a move, and how closely the stored curve follows
// the recorded one (in the shape's 0..1 units) once it is thinned out.
const MOVE_EPS = 1e-9;
const CURVE_EPS = 0.002;

// ---------------------------------------------------------------------------------------------
// Who is reading: the scheduler's polls, or anything else
// ---------------------------------------------------------------------------------------------

let liveReads = 0;

/** Runs `fn` as a poll of the controls the scheduler applies - the only reads that record. */
export function withLiveReads(fn) {
  liveReads++;
  try {
    return fn();
  } finally {
    liveReads--;
  }
}

// ---------------------------------------------------------------------------------------------
// The take: a window of recorded values, as one shape per axis
// ---------------------------------------------------------------------------------------------

const mod = (a, n) => ((a % n) + n) % n;

/**
 * The window a take covers, `{ start, end }` in cycles: `cycles` long, on cycle boundaries (on
 * multiples of `cycles` for a take shorter than one cycle), holding as much of the movement from
 * `first` to `last` as fits - all of it when it fits, else its end.
 */
export function motionWindow(first, last, cycles) {
  const unit = cycles < 1 ? cycles : 1;
  const floorTo = (x) => Math.floor(x / unit + 1e-9) * unit;
  const start = Math.max(floorTo(first), floorTo(last) + unit - cycles);
  return { start, end: start + cycles };
}

// The value of axis `dim` at position q: straight lines between the samples (the engine glides
// between polls the same way), held flat before the first and after the last.
function valueAt(samples, q, dim) {
  if (q <= samples[0][0]) return samples[0][dim + 1];
  const last = samples[samples.length - 1];
  if (q >= last[0]) return last[dim + 1];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= q) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b[0] - a[0];
  return span > 0 ? a[dim + 1] + ((b[dim + 1] - a[dim + 1]) * (q - a[0])) / span : b[dim + 1];
}

/**
 * The breakpoints `[{ x, y }]` of one axis of a take: samples `[[pos, v0, v1, ...], ...]` read over
 * the window `[start, start + cycles)`, laid out so that phase x plays at every position q with
 * q mod cycles = x * cycles - the take loops in step with the transport. `range` is `[lo, hi]`, what
 * the control's values are measured against (the shape is 0..1). A window that does not start on a
 * multiple of `cycles` wraps: the stretch from the multiple inside it to its end comes first, and
 * the jump from its last value back to its first sits where the window started.
 */
export function takePoints(samples, start, cycles, range = [0, 1], dim = 0) {
  const [lo, hi] = range;
  const norm = (v) => (hi === lo ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
  const end = start + cycles;
  const inner = samples.map((s) => s[0]).filter((q) => q > start && q < end);
  const at = (q) => norm(valueAt(samples, q, dim));
  const wrap = Math.ceil(start / cycles - 1e-9) * cycles; // the multiple of `cycles` in [start, end)
  let points;
  if (Math.abs(wrap - start) < 1e-9 || wrap >= end) {
    points = [start, ...inner, end].map((q) => ({ x: (q - start) / cycles, y: at(q) }));
    // The window's last value is the left side of its end, which a sample there would otherwise
    // overwrite with the right side (the next window's first value is not ours).
    points[points.length - 1].y = at(end - 1e-9);
  } else {
    const seam = (start - wrap + cycles) / cycles; // where the window's start lands, 0..1
    const after = [wrap, ...inner.filter((q) => q > wrap), end].map((q) => ({ x: (q - wrap) / cycles, y: at(q) }));
    after[after.length - 1] = { x: seam, y: at(end - 1e-9) };
    const before = [start, ...inner.filter((q) => q < wrap), wrap].map((q) => ({ x: seam + (q - start) / cycles, y: at(q) }));
    before[before.length - 1] = { x: 1, y: at(wrap - 1e-9) };
    points = [...after, ...before];
  }
  return thin(points.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: p.y })));
}

// Drops the breakpoints a straight line through their neighbors already draws to within
// CURVE_EPS (Ramer-Douglas-Peucker): a held control is two points, not a poll's worth of them.
function thin(points) {
  if (points.length <= 2) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a];
    const pb = points[b];
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy);
      const d = len === 0 ? Math.hypot(p.x - pa.x, p.y - pa.y) : Math.abs(dy * (p.x - pa.x) - dx * (p.y - pa.y)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > CURVE_EPS) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * One control's recorder: `observe(pos, values)` with every poll's reading (an array, one value
 * per axis), `release()` when the hand lets go. `observe` answers the finished take -
 * `{ shapes: ["x,y ...", ...], cycles, start }`, one shape per axis - on the poll that ends one.
 */
export function createMotionRecorder({ cycles = MOTION_DEFAULT_CYCLES, ranges = [[0, 1]], idle = MOTION_IDLE_CYCLES } = {}) {
  let lastPos = null;
  let lastVals = null;
  let rec = null; // { samples, first, lastMove } while recording
  let released = false;
  const r = {
    cycles,
    ranges,
    take: null, // { shapes, points, cycles, start } - the latest finished take
    get recording() {
      return !!rec;
    },
    release() {
      released = true;
    },
    observe(pos, vals) {
      if (!Number.isFinite(pos) || !Array.isArray(vals) || !vals.every(Number.isFinite)) return null;
      if (lastPos !== null && pos < lastPos - 1e-9) {
        // The clock went back (a seek, a restart): whatever was being recorded is somewhere else.
        rec = null;
        lastPos = pos;
        lastVals = vals;
        released = false;
        return null;
      }
      if (lastVals === null) {
        lastPos = pos;
        lastVals = vals;
        released = false;
        return null;
      }
      const moved = vals.some((v, i) => Math.abs(v - lastVals[i]) > MOVE_EPS);
      if (!rec) {
        if (moved) {
          // The value it had before the hand arrived, just before the first one that moved.
          rec = { samples: [[Math.min(lastPos, pos - 1e-6), ...lastVals], [pos, ...vals]], first: pos, lastMove: pos };
        }
      } else {
        const tail = rec.samples[rec.samples.length - 1];
        if (pos - tail[0] < 1e-9) rec.samples[rec.samples.length - 1] = [tail[0], ...vals];
        else rec.samples.push([pos, ...vals]);
        if (moved) rec.lastMove = pos;
        // A movement longer than the take keeps only what its window can still reach.
        const reach = Math.floor(pos) - cycles - 2;
        let drop = 0;
        while (drop < rec.samples.length - 2 && rec.samples[drop + 1][0] < reach) drop++;
        if (drop) rec.samples.splice(0, drop);
      }
      lastPos = pos;
      lastVals = vals;
      const done = rec && (released || pos - rec.lastMove >= idle);
      released = false;
      if (!done) return null;
      return finish();
    },
  };
  function finish() {
    const { start } = motionWindow(rec.first, rec.lastMove, cycles);
    const shapes = ranges.map((range, dim) => serializeShapePoints(takePoints(rec.samples, start, cycles, range, dim)));
    rec = null;
    // Played back from the text it will be stored as, so what is heard now is what a reload plays.
    r.take = { shapes, points: shapes.map((s) => parseShapePoints(s)), cycles, start };
    return r.take;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// The editor's side: finished takes, waiting to be written into the code
// ---------------------------------------------------------------------------------------------

const outbox = [];
const recorders = new Map(); // widget key (`${deck}:${at}`) -> Set of recorders listening for its release

/**
 * The takes finished since the last call, oldest first: `{ deck, at, take, axes, shapes, cycles }`.
 * `at` is where the `.record(` call that made it was when its buffer was evaluated (null for one
 * the editor did not transpile), `take` the name the call already gives it (or null), `axes` the
 * suffix of each shape's name - `['']`, or `['-x', '-y']` for a pad.
 */
export function takeMotionTakes() {
  return outbox.splice(0, outbox.length);
}

/** The hand let go of the drawn control at `at` on `deck`: a take recording from it ends now. */
export function releaseWidget(deck, at) {
  const set = recorders.get(`${deck === 'b' ? 'b' : 'a'}:${Number(at)}`);
  if (!set) return false;
  for (const r of set) r.release();
  return set.size > 0;
}

// ---------------------------------------------------------------------------------------------
// .record() on a control
// ---------------------------------------------------------------------------------------------

function numberOf(x, fallback) {
  if (typeof x === 'number') return x;
  if (x instanceof Sig) {
    if (typeof x.constVal === 'number') return x.constVal;
    try {
      const v = Number(x.sample(0, 0.5, 0));
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }
  if (typeof x === 'string' && x.trim() !== '') return Number(x);
  return fallback;
}

function textOf(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Sig && typeof x.miniText === 'string') return x.miniText;
  return null;
}

/** What a control signal records from - `{ key, range, pad }` - or null for anything else. */
export function motionSourceOf(sig) {
  if (!(sig instanceof Sig)) return null;
  if (sig.motionSource) return sig.motionSource;
  if (sig.ccIR) {
    const { min, max } = sig.ccIR;
    return { key: null, range: typeof min === 'number' && typeof max === 'number' ? [min, max] : [0, 1] };
  }
  return null;
}

const KNOWN_OPTS = new Set(['cycles', 'take']);

/**
 * `.record({ cycles, take })` on a live control: the control's signal, recording its movement and
 * playing the last take back. `at` is where the call is (the editor's transpile writes it).
 */
export function recordMotion(src, opts = {}, at = null) {
  const o = opts === undefined || opts === null ? {} : (typeof opts === 'number' || typeof opts === 'string' || opts instanceof Sig ? { cycles: opts } : opts);
  if (typeof o !== 'object' || Array.isArray(o)) {
    warnPattern('[signal] .record() on a control takes options, like .record({ cycles: 2 }) - recording 4 cycles');
  }
  const given = typeof o === 'object' && o && !Array.isArray(o) ? o : {};
  for (const k of Object.keys(given)) {
    if (!KNOWN_OPTS.has(k)) warnPattern(`[signal] .record() on a control has no option ${JSON.stringify(k)} (it has cycles, take)`);
  }
  let cycles = numberOf(given.cycles, MOTION_DEFAULT_CYCLES);
  if (!(cycles > 0) || !Number.isFinite(cycles)) {
    warnPattern(`[signal] .record() cycles is a length in cycles, more than 0 - got ${JSON.stringify(textOf(given.cycles) ?? given.cycles)}, recording ${MOTION_DEFAULT_CYCLES}`);
    cycles = MOTION_DEFAULT_CYCLES;
  }
  let takeName = given.take == null ? null : textOf(given.take);
  if (given.take != null && (takeName === null || !takeName.trim())) {
    warnPattern('[signal] .record() take is the name of the shape a take is kept in, like take: "sweep"');
    takeName = null;
  }
  const ms = motionSourceOf(src);
  const sources = ms.pad ? ms.pad : [src];
  const ranges = ms.pad ? ms.pad.map((s) => s.motionSource?.range ?? [0, 1]) : [ms.range];
  const axes = ms.pad ? ['-x', '-y'] : [''];
  const deck = evaluatingDeck();
  const scope = defScope();
  registerMotionRecord(at);
  const recorder = createMotionRecorder({ cycles, ranges });
  if (ms.key) {
    let set = recorders.get(ms.key);
    if (!set) recorders.set(ms.key, (set = new Set()));
    // One evaluation's recorders: the last one's no longer play, and a release must not reach them.
    const gen = widgetGeneration();
    for (const r of set) if (r.generation !== gen) set.delete(r);
    recorder.generation = gen;
    set.add(recorder);
  }

  const phaseOf = (pos) => mod(pos, cycles) / cycles;
  const scale = (dim, y) => ranges[dim][0] + y * (ranges[dim][1] - ranges[dim][0]);
  let warnedMissing = false;
  const stored = (dim) => {
    if (!takeName) return null;
    const points = lookupShape(`${takeName.trim()}${axes[dim]}`, scope);
    if (!points && !warnedMissing) {
      warnedMissing = true;
      warnPattern(`[signal] no shape called ${JSON.stringify(`${takeName.trim()}${axes[dim]}`)} - .record() plays the control until it records a new take`);
    }
    return points;
  };

  const readAll = (t, cps, pos) => sources.map((s) => s.sample(t, cps, pos));
  const sampleDim = (dim) => (t, cps, pos) => {
    const live = readAll(t, cps, pos);
    if (liveReads > 0) {
      const nums = live.map(Number);
      const take = recorder.observe(pos, nums);
      if (take) {
        outbox.push({ deck, at: Number.isFinite(at) ? at : null, take: takeName, axes, shapes: take.shapes, cycles });
      }
    }
    if (recorder.recording) return live[dim];
    if (recorder.take) return scale(dim, sampleShape(recorder.take.points[dim], phaseOf(pos)));
    const points = stored(dim);
    if (points) return scale(dim, sampleShape(points, phaseOf(pos)));
    return live[dim];
  };

  const sigs = sources.map((_, dim) => new Sig(sampleDim(dim)));
  for (const s of sigs) s.widgetLive = true; // a live trace in plot(), like the control itself
  const out = sigs[0];
  if (ms.pad) {
    out.x = sigs[0];
    out.y = sigs[1];
  }
  return out;
}

// The method itself. On a live control it records movement; on anything else it is the track's
// recording marker, unchanged. `_record(AT, opts)` is what the editor's transpile writes for a
// `.record(` call, so a take can find the call that made it.
const trackRecord = Sig.prototype.record;
Object.defineProperty(Sig.prototype, 'record', {
  configurable: true,
  writable: true,
  enumerable: false,
  value: function record(opts) {
    if (motionSourceOf(this)) return recordMotion(this, opts, null);
    return trackRecord.call(this, opts);
  },
});
Object.defineProperty(Sig.prototype, '_record', {
  configurable: true,
  writable: true,
  enumerable: false,
  value: function _record(at, opts) {
    if (motionSourceOf(this)) return recordMotion(this, opts, Number(at));
    return trackRecord.call(this, opts);
  },
});
