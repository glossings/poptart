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
//   - Touching the control again punches in: the loop is kept, and the stretch from the grab to
//     the release is overwritten with what the hand did. Only a touch that lasts longer than the
//     loop replaces the whole take.
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
import { setWidgetValue, evaluatingDeck, widgetGeneration, builtGeneration, registerMotionRecord, registerRecordingControl, onControlRead, widgetValue, sourceCalls } from './widgets.mjs';
import { PHRASE_CYCLES } from './record.mjs';
import { onSourceFed } from './sources.mjs';
import { midiDeviceMatches } from './midi.mjs';
import { positionOnCurve, valueOnCurve } from './curves.mjs';
import { parseCells } from './widget-calls.mjs';
import { setPressClock, onButtonPress, onButtonDown, shapeEdges, takePeriod, buttonGrid, rowWithPress, rowEdges, rowCells, shapeAsRow } from './triggers.mjs';

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
 * the control's values are measured against (the shape is 0..1), along `curve` when the control
 * has one (`{ curve, curveExp }`, see curves.mjs). A window that does not start on a multiple of
 * `cycles` wraps: the stretch from the multiple inside it to its end comes first, and the jump
 * from its last value back to its first sits where the window started.
 */
export function takePoints(samples, start, cycles, range = [0, 1], dim = 0, curve = null) {
  const [lo, hi] = range;
  const norm = curve
    ? (v) => positionOnCurve({ min: lo, max: hi, ...curve }, v)
    : (v) => (hi === lo ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
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

/**
 * A punch-in: the take `existing` (breakpoints over 0..1) with the stretch of the loop touched
 * between positions `first` and `end` (in cycles, less than `cycles` apart) overwritten by what was
 * recorded in `samples`, everything else kept. The stretch may wrap the loop's end.
 */
export function punchPoints(existing, samples, first, end, cycles, range = [0, 1], dim = 0, curve = null) {
  const [lo, hi] = range;
  const norm = curve
    ? (v) => positionOnCurve({ min: lo, max: hi, ...curve }, v)
    : (v) => (hi === lo ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
  const base = Math.floor(first / cycles + 1e-9) * cycles; // the loop pass the touch began in
  const x0 = (first - base) / cycles; // where the touch starts, 0..1
  const x1 = (end - base) / cycles; // ...and ends, past 1 when it wraps
  const EPS = 1e-6;
  // The absolute position with phase x inside the touched stretch, or null outside it.
  const touchedAt = (x) => {
    for (const k of [0, 1]) {
      const xx = x + k;
      if (xx >= x0 - EPS && xx <= x1 + EPS) return base + xx * cycles;
    }
    return null;
  };
  const recorded = (x) => norm(valueAt(samples, touchedAt(x), dim));
  const kept = (x) => sampleShape(existing, Math.min(1, Math.max(0, x)));
  // The kept breakpoints as they are - two at one x are a step, and stay one - then the recorded
  // stretch, and a step at each of its edges: the kept value on one side, the recorded on the other.
  const points = existing.filter((p) => touchedAt(p.x) === null).map((p) => ({ x: p.x, y: p.y }));
  for (const s of samples) {
    const x = mod((s[0] - base) / cycles, 1);
    if (touchedAt(x) !== null) points.push({ x, y: recorded(x) });
  }
  for (const x of [0, 1]) if (touchedAt(x) !== null) points.push({ x, y: recorded(x) });
  const [e0, e1] = [x0, x1].map((x) => mod(x, 1));
  points.push({ x: Math.max(0, e0 - EPS), y: kept(e0 - EPS) }, { x: e0, y: recorded(e0) });
  points.push({ x: e1, y: recorded(e1) }, { x: Math.min(1, e1 + EPS), y: kept(e1 + EPS) });
  points.sort((a, b) => a.x - b.x); // stable: a step's two points keep their order
  return thin(points.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) })));
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
 * `existing(dim)` is the take already playing (breakpoints over 0..1), or null: a touch shorter
 * than the loop punches into it (see punchPoints) rather than replacing it.
 */
export function createMotionRecorder({ cycles = MOTION_DEFAULT_CYCLES, ranges = [[0, 1]], curves = null, idle = MOTION_IDLE_CYCLES, existing = () => null } = {}) {
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
      const byHand = released;
      released = false;
      if (!done) return null;
      // A release ends the touch where the hand left; a cycle of stillness ends it at the last move.
      return finish(byHand ? pos : rec.lastMove);
    },
  };
  function finish(end) {
    const first = rec.samples[0][0]; // the value it held just before the first move is the touch's edge
    const bases = ranges.map((_, dim) => existing(dim));
    const punch = end - first < cycles - 1e-9 && bases.every(Boolean);
    const shapes = punch
      ? ranges.map((range, dim) => serializeShapePoints(punchPoints(bases[dim], rec.samples, first, end, cycles, range, dim, curves?.[dim] ?? null)))
      : (() => {
        const { start } = motionWindow(rec.first, rec.lastMove, cycles);
        return ranges.map((range, dim) => serializeShapePoints(takePoints(rec.samples, start, cycles, range, dim, curves?.[dim] ?? null)));
      })();
    const start = punch ? Math.floor(first / cycles + 1e-9) * cycles : motionWindow(rec.first, rec.lastMove, cycles).start;
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

// What each recording control is playing this moment - its take's value, one per axis - keyed by
// the control's key, from the scheduler's polls. The editor draws the control there (see
// widget-host.mjs's frames): a knob with a take on it turns as the take plays.
const playing = new Map(); // control key -> values per axis

/** The played values of `deck`'s recording controls now: `{ [at]: [v, ...] }`. */
export function motionPlaying(deck) {
  const d = deck === 'b' ? 'b' : 'a';
  const out = {};
  for (const [key, vals] of playing) {
    if (!key.startsWith(`${d}:`) || !recordsItself(key)) continue;
    out[Number(key.slice(2))] = vals;
  }
  return out;
}

/** The hand let go of the drawn control at `at` on `deck`: a take recording from it ends now. */
export function releaseWidget(deck, at) {
  const set = recorders.get(`${deck === 'b' ? 'b' : 'a'}:${Number(at)}`);
  if (!set) return false;
  for (const r of set) r.release();
  return set.size > 0;
}

// ---------------------------------------------------------------------------------------------
// Capture: the recent movement of every drawn control, kept whether or not it records
// ---------------------------------------------------------------------------------------------
//
// The header's capture button is .record() after the fact. Every drawn control - a knob(),
// slider(), toggle(), button() or xy() - keeps the last CAPTURE_KEEP_CYCLES of how it moved, from
// the same reads a .record() records (the scheduler's polls). Capture picks the latest phrase of
// movement on each deck, the way the piano roll's capture picks the latest phrase of notes
// (record.mjs's captureWindow), and hands back one take per control that moved in it, all one
// length, for the editor to write in as `.record({ cycles, take })`.

/** How much movement each control keeps, in cycles: the longest capture plus the phrase gap, with room. */
export const CAPTURE_KEEP_CYCLES = 32;

// Moves closer together than this are one run of movement; a capture's phrases are made of runs.
const RUN_GAP = 0.25;

const history = new Map(); // control key -> { control, samples, runs, lastPos, lastVals }

function observeControl(control, pos) {
  if (control.kind === 'button') return; // kept from its presses instead (see pressHistory)
  if (liveReads <= 0 || !Number.isFinite(pos)) return;
  const vals = control.read();
  if (!vals.every(Number.isFinite)) return;
  let h = history.get(control.key);
  if (!h) {
    history.set(control.key, { control, samples: [], runs: [], lastPos: pos, lastVals: vals });
    return;
  }
  h.control = control; // the latest evaluation's: where the call is now
  if (pos < h.lastPos - 1e-9) {
    // A read a little behind the last is another track's poll of the same control; a long way
    // behind, the clock went back (a seek, a restart) and what was kept is somewhere else.
    if (h.lastPos - pos > 1) history.set(control.key, { control, samples: [], runs: [], lastPos: pos, lastVals: vals });
    return;
  }
  const moved = vals.some((v, i) => Math.abs(v - h.lastVals[i]) > MOVE_EPS);
  if (moved) {
    const tail = h.samples[h.samples.length - 1];
    // The value it held up to here, then the one it moved to.
    if (!tail || tail[0] < h.lastPos - 1e-9) h.samples.push([h.lastPos, ...h.lastVals]);
    const now = h.samples[h.samples.length - 1];
    if (pos - now[0] < 1e-9) h.samples[h.samples.length - 1] = [now[0], ...vals];
    else h.samples.push([pos, ...vals]);
    const run = h.runs[h.runs.length - 1];
    if (run && pos - run.end <= RUN_GAP) run.end = pos;
    else h.runs.push({ start: pos, end: pos });
  }
  h.lastPos = pos;
  h.lastVals = vals;
  // Forget what is out of reach, keeping the last sample before it - the value held from there.
  const reach = pos - CAPTURE_KEEP_CYCLES;
  let drop = 0;
  while (drop < h.samples.length - 1 && h.samples[drop + 1][0] < reach) drop++;
  if (drop) h.samples.splice(0, drop);
  while (h.runs.length && h.runs[0].end < reach) h.runs.shift();
}
onControlRead(observeControl);

// A button's recent presses, for capture: kept as they happen rather than from polls, for the
// reason a button's .record() is (see recordPresses) - a button that is only a rhythm,
// .struct(button()), is never polled, and a poll smears a press and can miss a tap.
const pressHistory = new Map(); // button key -> [{ on, off }], in cycles on its deck's clock

function keepPress(key, on, off) {
  let list = pressHistory.get(key);
  if (!list) pressHistory.set(key, (list = []));
  list.push({ on, off });
  while (list.length && list[0].off < off - CAPTURE_KEEP_CYCLES) list.shift();
}

// The window a capture takes: the latest phrase of movement - the runs since the last stretch of
// PHRASE_CYCLES without any - in the whole cycles that hold it, from the cycle the phrase began in
// to the one it ended in. Not a power of two, and not aligned to a multiple of its length as the
// piano roll's capture is (record.mjs's captureWindow): a take loops in step with the transport
// from whatever cycle it starts in (see takePoints), and the length is yours to change afterwards
// - the take keeps its own (see fitTake), so a longer `cycles` pads it and a shorter one cuts it.
const CAPTURE_EDGE_TOL = 1 / 32;

function motionCaptureWindow(runs, maxCycles = CAPTURE_KEEP_CYCLES) {
  const sorted = runs.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end)).sort((a, b) => a.start - b.start);
  if (!sorted.length) return null;
  let i = sorted.length - 1;
  let endBefore = -Infinity;
  const ends = [];
  for (const r of sorted) {
    ends.push(endBefore);
    endBefore = Math.max(endBefore, r.end);
  }
  while (i > 0 && sorted[i].start - ends[i] < PHRASE_CYCLES) i--;
  const phrase = sorted.slice(i);
  const first = phrase[0].start;
  const lastEnd = Math.max(...phrase.map((r) => r.end));
  const from = Math.floor(first + CAPTURE_EDGE_TOL);
  const to = Math.max(from + 1, Math.ceil(lastEnd - CAPTURE_EDGE_TOL));
  const cycles = Math.min(maxCycles, to - from);
  const start = Math.max(from, to - cycles); // longer than the cap: its end
  return { start, end: start + cycles, cycles };
}

/**
 * A take's breakpoints as a `.record({ cycles })` of `cycles` plays them: a take recorded over its
 * own length (`points.cycles`, see _shape) is padded with its last value when the call's loop is
 * longer, and cut to the loop when it is shorter - never stretched. Points without a length of
 * their own are the loop's.
 */
export function fitTake(points, cycles) {
  const own = points?.cycles;
  if (!(own > 0) || !(cycles > 0) || Math.abs(own - cycles) < 1e-9) return points;
  const k = own / cycles; // where the take's end lands in the loop, 0..1
  if (k < 1) {
    const out = points.map((p) => ({ ...p, x: p.x * k }));
    out.push({ x: 1, y: points[points.length - 1].y }); // held from the take's end to the loop's
    return out;
  }
  const out = points.filter((p) => p.x * k <= 1 + 1e-9).map((p) => ({ ...p, x: Math.min(1, p.x * k) }));
  out.push({ x: 1, y: sampleShape(points, 1 / k) }); // the loop ends partway through the take
  return out;
}

// The live sources - a MIDI CC, an OSC value, a macro knob - are not polled: a `cc(12)` in a
// parameter is bound in the engine, so nothing here reads it. Their movement is kept as it ARRIVES
// (sources.mjs), stamped with the host's time, and turned into each deck's cycles when a capture
// asks (setMotionClock). What a capture writes to is the source as WRITTEN: the transpile tags each
// `cc(12, 1)`, `osc("/x")` and `macro1` with where it is (widgets.mjs's _at), and a source that
// moved puts a take on every place that reads it.

/** How long a source's movement is kept, in seconds. */
export const CAPTURE_KEEP_SEC = 120;

// A source says nothing while it is still, and holds its value until its next message. Messages
// closer together than this are one movement, drawn as a line between them (a hardware sweep is
// a message every few milliseconds); a longer gap is a hold, then a step at the new message.
const SOURCE_HOLD_GAP_SEC = 0.25;

let clock = null; // { now: () => sec, cycleAt: (deck, sec) => cycle | null } - the host's

/**
 * The host's clock, for the sources: `now()` is its time in seconds, `cycleAt(deck, sec)` that
 * time on a deck's clock in cycles - or null while the deck is stopped, when a move is nowhere.
 */
export function setMotionClock(c) {
  clock = c;
  setPressClock(c); // a button's presses are stamped on the same clock
}

const sourceHistory = new Map(); // `${kind}:${identity}` -> { src, samples: [[sec, value]], runs: [{ start, end }], lastSec, lastVal }

// Every move of a source as a step in `fed`, one entry per value it carries.
function sourceFed(fed) {
  if (!clock) return;
  const sec = clock.now();
  if (!Number.isFinite(sec)) return;
  const entries = fed.kind === 'cc' ? [[`cc:${fed.device}|${fed.channel}|${fed.cc}`, fed.value]]
    : fed.kind === 'osc' ? fed.values.map((v, i) => [`osc:${fed.address}|${i}`, v])
      : [[`macro:${fed.index}`, fed.value]];
  for (const [key, value] of entries) sourceFedOne(key, fed, value, sec);
}
onSourceFed(sourceFed);

// One value of one source, at `sec`.
function sourceFedOne(key, fed, value, sec) {
  if (!Number.isFinite(value)) return;
  let h = sourceHistory.get(key);
  if (!h) sourceHistory.set(key, (h = { src: fed, samples: [], runs: [], lastSec: null, lastVal: null }));
  if (h.lastSec !== null && sec < h.lastSec) return; // the clock went back: nowhere to file it
  if (h.lastVal !== null && Math.abs(value - h.lastVal) <= MOVE_EPS) {
    h.lastSec = sec; // still where it was, as of now
    return;
  }
  // The value it held up to here - as of its last message, and up to just before this one after
  // a gap - then the one it moved to.
  if (h.lastVal !== null && (!h.samples.length || h.samples[h.samples.length - 1][0] < h.lastSec)) h.samples.push([h.lastSec, h.lastVal]);
  if (h.lastVal !== null && sec - h.lastSec > SOURCE_HOLD_GAP_SEC) h.samples.push([sec - 1e-3, h.lastVal]);
  const tail = h.samples[h.samples.length - 1];
  if (tail && sec - tail[0] < 1e-9) tail[1] = value;
  else h.samples.push([sec, value]);
  const run = h.runs[h.runs.length - 1];
  if (run && sec - run.end <= 0.5) run.end = sec;
  else h.runs.push({ start: sec, end: sec });
  h.lastSec = sec;
  h.lastVal = value;
  const reach = sec - CAPTURE_KEEP_SEC;
  let drop = 0;
  while (drop < h.samples.length - 1 && h.samples[drop + 1][0] < reach) drop++;
  if (drop) h.samples.splice(0, drop);
  while (h.runs.length && h.runs[0].end < reach) h.runs.shift();
}

/**
 * A device control moved by hand - in a device window, or in a plugin's own window on the desktop -
 * kept like a source's movement, for a take the capture writes as
 * `.param("Name", knob(value, min, max, { curve }).record(...))`. `p` is `{ deck, trackId, slot,
 * id, name, min, max, curve, curveExp, step, widget: 'knob' | 'toggle', value }`, with `value` in
 * the control's own units; what is kept is its position on the control's curve.
 */
export function feedParamMove(p) {
  if (!clock || !Number.isFinite(Number(p?.value))) return;
  const spec = { min: Number(p.min), max: Number(p.max), curve: p.curve ?? 'lin', curveExp: p.curveExp ?? 2 };
  const position = p.widget === 'toggle' ? (Number(p.value) >= 0.5 ? 1 : 0) : positionOnCurve(spec, Number(p.value));
  const key = `param:${p.trackId}|${p.slot}|${p.id}`;
  const h = sourceHistory.get(key);
  const src = { kind: 'param', ...p, value: Number(p.value) };
  if (h) h.src = src; // the latest units and value
  sourceFedOne(key, src, position, clock.now());
}

// Whether a source call written in the code (see widgets.mjs's _at) reads the source `h` kept.
function sourceReads(call, h) {
  const { src } = h;
  if (call.kind !== src.kind) return false;
  if (call.kind === 'macro') return call.index === src.index;
  if (call.kind === 'osc') return call.address === src.address && `osc:${src.address}|${call.index}` === h.key;
  return midiDeviceMatches(call.device, src.device) && call.cc === src.cc && (call.channel == null || call.channel === src.channel);
}

// A source's kept movement on `deck`'s clock: `{ samples: [[cycle, value]], runs }`, or null when
// none of it lands on that clock (the deck is stopped, or the moves are from before it started).
function sourceOnDeck(h, deck) {
  if (!clock?.cycleAt) return null;
  const at = (sec) => {
    const c = clock.cycleAt(deck, sec);
    return Number.isFinite(c) && c >= 0 ? c : null;
  };
  const samples = h.samples.map(([sec, v]) => [at(sec), v]).filter(([c]) => c !== null);
  const runs = h.runs.map((r) => ({ start: at(r.start), end: at(r.end) })).filter((r) => r.start !== null && r.end !== null);
  if (!samples.length || !runs.length) return null;
  const last = samples[samples.length - 1];
  if (h.lastSec !== null && at(h.lastSec) !== null && last[0] < at(h.lastSec) - 1e-9) samples.push([at(h.lastSec), h.lastVal]);
  return { samples, runs };
}

/**
 * Capture: the takes of the latest phrase of movement on each deck, as
 * `[{ deck, at, kind, axes, shapes, cycles, source }]` - `at` where the control or source is
 * written, `shapes` one drawn shape per axis, every take of a deck the same `cycles` long, and
 * `source` true for a take of a live source (`cc`, `osc`, `macro`) rather than a drawn control. A
 * control that records itself (a `.record()` on it already) is left out: it made its own take
 * when it moved.
 */
export function captureMotion() {
  const out = [];
  for (const deck of ['a', 'b']) {
    const controls = [...history.values()].filter((h) => h.control.deck === deck
      && h.runs.length
      && widgetValue(deck, h.control.at) !== undefined // still in the code
      && !recordsItself(h.control.key));
    // Each source call in the deck's code that reads a source that moved, with that movement.
    const sources = [];
    for (const call of sourceCalls(deck)) {
      for (const [key, h] of sourceHistory) {
        if (h.src.kind === 'param' || !sourceReads(call, { ...h, key })) continue;
        const on = sourceOnDeck(h, deck);
        if (on) sources.push({ call, ...on });
      }
    }
    // Each device control moved by hand on this deck (see feedParamMove).
    const params = [];
    for (const h of sourceHistory.values()) {
      if (h.src.kind !== 'param' || h.src.deck !== deck) continue;
      const on = sourceOnDeck(h, deck);
      if (on) params.push({ src: h.src, ...on });
    }
    // Each button on this deck pressed lately, its presses as its runs.
    const buttons = [];
    for (const [key, list] of pressHistory) {
      const at = Number(key.slice(2));
      if (!key.startsWith(`${deck}:`) || !list.length || widgetValue(deck, at) === undefined || recordsItself(key)) continue;
      buttons.push({ at, presses: list, runs: list.map((p) => ({ start: p.on, end: p.off })) });
    }
    if (!controls.length && !sources.length && !params.length && !buttons.length) continue;
    const win = motionCaptureWindow([...controls, ...sources, ...params, ...buttons].flatMap((x) => x.runs));
    if (!win) continue;
    const inWindow = (runs) => runs.some((r) => r.end >= win.start && r.start < win.end);
    for (const h of controls) {
      if (!inWindow(h.runs)) continue;
      const samples = [...h.samples];
      if (samples[samples.length - 1][0] < h.lastPos - 1e-9) samples.push([h.lastPos, ...h.lastVals]);
      const { control } = h;
      const shapes = control.ranges.map((range, dim) => serializeShapePoints(takePoints(samples, win.start, win.cycles, range, dim, control.curves?.[dim] ?? null)));
      out.push({ deck, at: control.at, kind: control.kind, axes: control.axes, shapes, cycles: win.cycles, source: false });
    }
    for (const b of buttons) {
      if (!inWindow(b.runs)) continue;
      // The presses in the window, as the row a .record() on the button would have written.
      const cells = buttonGrid(`${deck}:${b.at}`) * win.cycles;
      let row = null;
      for (const p of b.presses) if (p.off >= win.start && p.on < win.end) row = rowWithPress(row, p.on, { cycles: win.cycles, cells });
      out.push({ deck, at: b.at, kind: 'button', axes: [''], row, cycles: win.cycles, source: false });
    }
    for (const s of sources) {
      if (!inWindow(s.runs)) continue;
      const shapes = [serializeShapePoints(takePoints(s.samples, win.start, win.cycles, [0, 1], 0))];
      out.push({ deck, at: s.call.at, kind: s.call.kind, axes: [''], shapes, cycles: win.cycles, source: true });
    }
    for (const p of params) {
      if (!inWindow(p.runs)) continue;
      const shapes = [serializeShapePoints(takePoints(p.samples, win.start, win.cycles, [0, 1], 0))];
      const { kind, deck: _d, ...meta } = p.src;
      out.push({ deck, at: null, kind: 'param', axes: [''], shapes, cycles: win.cycles, source: 'param', ...meta });
    }
  }
  return out;
}

/** Forgets every control's and source's kept movement - for tests. */
export function clearCaptureHistory() {
  history.clear();
  pressHistory.clear();
  sourceHistory.clear();
  playing.clear();
}

// A control with a `.record()` on it in the code its deck last evaluated.
function recordsItself(key) {
  const built = builtGeneration(key.startsWith('b:') ? 'b' : 'a');
  return [...(recorders.get(key) ?? []), ...(pressRecorders.get(key) ?? [])].some((r) => r.generation === built);
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
  // A button's take is a steps() row written in place (see recordPresses); any other take is the
  // name of a shape.
  const takeRow = given.take instanceof Sig && typeof given.take.rowText === 'function' ? given.take : null;
  let takeName = given.take == null || takeRow ? null : textOf(given.take);
  if (given.take != null && !takeRow && (takeName === null || !takeName.trim())) {
    warnPattern('[signal] .record() take is the name of the shape a take is kept in, like take: "sweep"');
    takeName = null;
  }
  const ms = motionSourceOf(src);
  const sources = ms.pad ? ms.pad : [src];
  const ranges = ms.pad ? ms.pad.map((s) => s.motionSource?.range ?? [0, 1]) : [ms.range];
  const curves = ms.pad ? ms.pad.map((s) => s.motionSource?.curve ?? null) : [ms.curve ?? null];
  const axes = ms.pad ? ['-x', '-y'] : [''];
  const deck = evaluatingDeck();
  const scope = defScope();
  registerMotionRecord(at);
  if (ms.key) registerRecordingControl(Number(ms.key.slice(2)));
  // What the hand punches into: this recorder's last take, or the one the code names.
  const recorder = createMotionRecorder({ cycles, ranges, curves, existing: (dim) => recorder.take?.points[dim] ?? stored(dim) });
  if (ms.key && !ms.button) {
    let set = recorders.get(ms.key);
    if (!set) recorders.set(ms.key, (set = new Set()));
    // One evaluation's recorders: the last one's no longer play, and a release must not reach them.
    const gen = widgetGeneration();
    for (const r of set) if (r.generation !== gen) set.delete(r);
    recorder.generation = gen;
    set.add(recorder);
  }

  const phaseOf = (pos) => mod(pos, cycles) / cycles;
  const scale = (dim, y) => (curves[dim]
    ? valueOnCurve({ min: ranges[dim][0], max: ranges[dim][1], ...curves[dim] }, y)
    : ranges[dim][0] + y * (ranges[dim][1] - ranges[dim][0]));
  let warnedMissing = false;
  const fitted = new WeakMap(); // a stored take's points -> the same, fitted to this call's cycles
  const stored = (dim) => {
    if (!takeName) return null;
    const raw = lookupShape(`${takeName.trim()}${axes[dim]}`, scope);
    let points = raw;
    if (raw) {
      points = fitted.get(raw);
      if (!points) fitted.set(raw, (points = fitTake(raw, cycles)));
    }
    // Said only from a poll: a buffer's definitions are built in document order, so a probe of
    // this signal while its block is built - is the value steady? - comes before a `_shape(...)`
    // written below it, and that is not a missing shape.
    if (!points && !warnedMissing && liveReads > 0) {
      warnedMissing = true;
      warnPattern(`[signal] no shape called ${JSON.stringify(`${takeName.trim()}${axes[dim]}`)} - .record() plays the control until it records a new take`);
    }
    return points;
  };

  if (ms.button) return recordPresses(src, ms, { cycles, takeName, takeRow, deck, at, stored });
  if (takeRow) warnPattern('[signal] .record() take: steps(...) is a button\'s take - a control\'s take is the name of a shape, like take: "sweep"');
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
    if (recorder.recording) {
      if (ms.key && liveReads > 0) playing.delete(ms.key); // the hand is on it: nothing is played
      return live[dim];
    }
    const points = recorder.take ? recorder.take.points[dim] : stored(dim);
    if (!points) return live[dim];
    const v = scale(dim, sampleShape(points, phaseOf(pos)));
    if (ms.key && liveReads > 0) {
      let vals = playing.get(ms.key);
      if (!vals || vals.length !== sources.length) playing.set(ms.key, (vals = sources.map(() => null)));
      vals[dim] = v;
    }
    return v;
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

const pressRecorders = new Map(); // button key -> Set of press recorders on it

onButtonPress((key, on, off) => {
  keepPress(key, on, off);
  for (const r of pressRecorders.get(key) ?? []) {
    if (r.generation !== builtGeneration(r.deck)) continue; // its evaluation has been replaced
    const row = r.press(on);
    if (row != null) outbox.push({ deck: r.deck, at: r.at, take: r.takeName, axes: [''], row, cycles: r.cycles });
  }
});

// A press going down remembers the take it was played over - what was playing before it - so its
// count can follow on from that take rather than from one it is itself about to be part of.
onButtonDown((key) => {
  for (const r of pressRecorders.get(key) ?? []) {
    if (r.generation === builtGeneration(r.deck)) return r.state();
  }
  return null;
});

// `.record()` on a button(): its take is a row of cells, one per step of the grid its presses play
// on, over the take's whole length - `take: steps("x . . x ...")` in the call (see triggers.mjs). A
// button is not polled for it the way a knob is: a poll draws a press as a ramp between two polls
// and loses a tap between them, and a button that is only a rhythm (.struct(button())) is never
// polled at all. So each press, as it happens (triggers.mjs stamps it), switches on the cell it
// lands on, and every other cell is kept - tapping a rhythm in press by press builds it up, and
// pressing over a take adds to it. The row is the take: clicking its cells is what plays.
//
// Until the call has a row of its own the row is kept here and handed to the editor to write in;
// once it has one, a press writes into that row's cells, so it plays at once and the editor's text
// follows. A take kept as a shape (the older form) still plays, and its first new press writes it
// out as a row.
function recordPresses(src, ms, { cycles, takeName, takeRow, deck, at, stored }) {
  const key = ms.key;
  const rowAt = takeRow?.rowKey ? Number(takeRow.rowKey.slice(2)) : null;
  const cells = () => buttonGrid(key) * cycles;
  const recorder = { deck, at: Number.isFinite(at) ? at : null, takeName, cycles, generation: widgetGeneration(), row: null };
  // The row as it stands: the call's, what this recorder has written since the evaluation, or none.
  const rowNow = () => (takeRow ? takeRow.rowText() : recorder.row);
  recorder.press = (on) => {
    const was = rowNow() ?? (stored(0) ? shapeAsRow(stored(0), cells()) : null);
    const row = rowWithPress(was, on, { cycles, cells: cells() });
    if (rowAt !== null) setWidgetValue(deck, rowAt, row);
    else recorder.row = row;
    return row;
  };
  recorder.state = () => {
    const row = rowNow();
    return row != null ? { row } : { points: stored(0) };
  };
  let set = pressRecorders.get(key);
  if (!set) pressRecorders.set(key, (set = new Set()));
  for (const r of set) if (r.generation !== recorder.generation) set.delete(r);
  set.add(recorder);

  // The take's presses in [from, to): the row's cells - a drawn row's carry the spans its cells
  // light by - or an older take's shape.
  const edgesOf = (state, from, to) => {
    if (state?.row != null) return rowEdges(rowCells(state.row), cycles, from, to);
    return state?.points ? shapeEdges(state.points, cycles, from, to) : [];
  };
  const edges = (from, to) => {
    if (takeRow) {
      const on = takeRow.stepsForCycle(0).filter((st) => st.value != null).map((st) => ({ start: st.start, loc: st.loc }));
      return rowEdges(on, cycles, from, to);
    }
    return edgesOf(recorder.state(), from, to);
  };
  const sig = new Sig((t, cps, pos) => {
    const live = src.sample(t, cps, pos);
    if (Number(live) >= 0.5) {
      if (liveReads > 0) playing.delete(key);
      return live;
    }
    const phase = mod(pos, cycles) / cycles;
    let v;
    const row = rowNow();
    if (row != null) {
      // On for the length of a cell that is on.
      const cellsOn = rowCells(row);
      const n = parseCells(row).length;
      v = cellsOn.some((c) => Math.abs(c.start - Math.floor(phase * n) / n) < 1e-9) ? 1 : 0;
    } else {
      const pts = stored(0);
      if (!pts) return live;
      v = sampleShape(pts, phase);
    }
    if (liveReads > 0) playing.set(key, [v]);
    return v;
  });
  sig.widgetLive = true;
  sig.pressKey = key;
  sig.triggerEdges = edges;
  sig.triggerPeriod = takePeriod(cycles);
  // The presses of another state of the take (one a press remembers, see onButtonDown).
  sig.triggerEdgesOf = (state, from, to) => edgesOf(state, from, to);
  return sig;
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
