// Custom modulator shapes for lfo() - the textual format, its parser/serializer, and a sampler
// using SuperCollider's curve semantics, shared verbatim between Node and the browser (the
// editor UI draws with sampleShape, the engine plays the same segments natively via IEnvGen).
//
// Format: space-separated breakpoints `x,y[,c]`, e.g. "0,0 0.25,1,-3 1,0".
//   x - phase within one period, 0..1, ascending (duplicate x = a vertical step)
//   y - level, 0..1 (rescaled by .range() like any LFO)
//   c - optional curvature of the segment LEAVING this point (SC convention: 0 = linear,
//       negative = fast-then-slow, positive = slow-then-fast); omitted when 0.

// Is this string DRAWN DATA (a breakpoint list) rather than something to read? The editor folds
// an lfo()'s first argument out of the way because a hand-drawn shape is a wall of numbers nobody
// reads - but the same position now also takes a shape NAME and a pattern of them, which are the
// code, and folding those would hide the only interesting part of the call. Same question, and the
// same answer, as looksLikeNoteString does for pianoroll().
export function looksLikeShapeData(str) {
  const tokens = String(str).trim().split(/\s+/);
  if (!tokens[0]) return false;
  return tokens.every((t) => /^-?\d*\.?\d+,-?\d*\.?\d+(,-?\d*\.?\d+)?$/.test(t));
}

export function parseShapePoints(str) {
  // A preset's NAME is a shape too - lfo("pluck") beside lfo("0,1,-4 1,0"), and the only readable
  // way to write a pattern of them: lfo("<pluck swell>"). Checked before parsing, since a name is
  // never a valid breakpoint list anyway.
  const preset = SHAPE_PRESETS[String(str).trim()];
  const points = String(preset ?? str)
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [x, y, c = 0] = tok.split(',').map(Number);
      if (![x, y, c].every(Number.isFinite)) throw new Error(`[shape] bad breakpoint "${tok}" (want "x,y" or "x,y,c")`);
      return { x: clamp01(x), y: clamp01(y), c };
    });
  if (points.length < 2) throw new Error('[shape] a shape needs at least 2 breakpoints');
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[i - 1].x) throw new Error('[shape] breakpoints must be in ascending x order');
  }
  // Pin the endpoints so the shape covers the full period.
  points[0] = { ...points[0], x: 0 };
  points[points.length - 1] = { ...points[points.length - 1], x: 1 };
  return points;
}

export function serializeShapePoints(points) {
  const fmt = (v) => String(Math.round(v * 1000) / 1000);
  return points.map((p) => (p.c ? `${fmt(p.x)},${fmt(p.y)},${fmt(p.c)}` : `${fmt(p.x)},${fmt(p.y)}`)).join(' ');
}

/** One segment's interpolation - SuperCollider's numeric-curve formula. */
export function curveInterp(y1, y2, pos, c) {
  if (Math.abs(c) < 0.001) return y1 + (y2 - y1) * pos;
  return y1 + (y2 - y1) * ((1 - Math.exp(pos * c)) / (1 - Math.exp(c)));
}

/** Value of the shape at phase 0..1. Duplicate-x points read as a vertical step. */
export function sampleShape(points, phase) {
  const p = clamp01(phase);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (p >= a.x && (p < b.x || (i === points.length - 2 && p <= b.x))) {
      const span = b.x - a.x;
      if (span <= 0) continue; // zero-width step: fall through to the segment after it
      return curveInterp(a.y, b.y, (p - a.x) / span, a.c ?? 0);
    }
  }
  return points[points.length - 1].y;
}

// A looping shape wraps from its last breakpoint straight back to its first, and a grain plays
// its window from one to the other - so where the two ENDS sit relative to each other is the one
// thing about a shape that can click. Ends at the same level are a seam nobody hears, and keeping
// them there by hand is fiddly anywhere but the floor and the ceiling, so the editor treats them
// as one: ends that meet move together, and an end dragged near the other's level catches on it.
//
// Ends that DON'T meet are left alone, because plenty of shapes mean it: a saw's jump is the saw,
// a pluck starts high and dies away, and an envelope-mode shape never wraps at all. Nothing is
// ever pulled together behind your back - you bring an end to the other once, and from then on
// they are a pair.

/** Whether a shape's first and last breakpoints sit at the same level (to the precision it is written at). */
export function shapeEndsMeet(points) {
  return points.length >= 2 && Math.abs(points[0].y - points[points.length - 1].y) < 1e-3;
}

/**
 * The shape with one END breakpoint (index 0 or the last) moved to level `y`. `linked` carries the
 * other end along; otherwise `snap` is how close (in y) the level has to come to the other end's
 * to catch on it, 0 for never. Returns new points - the ones passed in are not touched.
 */
export function moveShapeEnd(points, index, y, { linked = false, snap = 0 } = {}) {
  const other = index === 0 ? points.length - 1 : 0;
  const level = clamp01(y);
  const out = points.map((p) => ({ ...p }));
  if (linked) {
    out[index].y = level;
    out[other].y = level;
  } else {
    out[index].y = snap > 0 && Math.abs(level - points[other].y) <= snap ? points[other].y : level;
  }
  return out;
}

// The shape editor's span verbs: a stretch of the period, `a` to `b` in the shape's own 0..1, cut
// out exactly - a curved segment split at a span's edge is two curves that draw the same line (a
// stretch of an exponential is the same exponential, its curvature scaled by the stretch's share).
// Every function returns new points; the ones passed in are never touched.

const EPS = 1e-9;
const near = (p, x) => Math.abs(p.x - x) < EPS;

/** The shape with a breakpoint at `x` - unchanged where one already sits there. */
export function splitShapeAt(points, x) {
  const out = points.map((p) => ({ ...p }));
  if (out.some((p) => near(p, x))) return out;
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (x > a.x && x < b.x) {
      const u = (x - a.x) / (b.x - a.x);
      const c = a.c ?? 0;
      a.c = c * u;
      out.splice(i + 1, 0, { x, y: curveInterp(a.y, b.y, u, c), c: c * (1 - u) });
      break;
    }
  }
  return out;
}

// The shape cut at both edges, with where the span starts (the LAST point at `a`, so a step there
// starts the span on its far side) and ends (the FIRST point at `b`).
function cutSpan(points, a, b) {
  const cut = splitShapeAt(splitShapeAt(points, a), b);
  let ia = 0;
  for (let i = 0; i < cut.length; i++) if (near(cut[i], a)) ia = i;
  const ib = cut.findIndex((p) => near(p, b));
  return { cut, ia, ib };
}

/** The breakpoints from `a` to `b`, x laid out over 0..1 of the span. */
export function shapeSpan(points, a, b) {
  const { cut, ia, ib } = cutSpan(points, a, b);
  const span = cut.slice(ia, ib + 1).map((p) => ({ ...p, x: (p.x - a) / (b - a) }));
  span[0].x = 0;
  span[span.length - 1].x = 1;
  return span;
}

/**
 * The span `a`..`b` played twice, the copy right after it and everything later moved along: time is
 * inserted, so the period is `1 + (b - a)` of what it was. `{ points, grow }` - the new shape, back
 * in 0..1, and that factor, by which a take's length grows.
 */
export function duplicateShapeSpan(points, a, b) {
  const w = b - a;
  const { cut, ia, ib } = cutSpan(points, a, b);
  const span = cut.slice(ia, ib + 1);
  const grow = 1 + w;
  const out = [
    ...cut.slice(0, ia),
    ...span,
    ...span.map((p) => ({ ...p, x: p.x + w })),
    ...cut.slice(ib + 1).map((p) => ({ ...p, x: p.x + w })),
  ].map((p) => ({ ...p, x: p.x / grow }));
  out[out.length - 1].x = 1;
  return { points: out, grow };
}

/**
 * `clip` (points over 0..1, as shapeSpan gives them) written over the shape from `at`, `width` long
 * (cut short at the period's end). What was there is replaced; the shape steps into the clip and
 * back out of it. `{ points, placed }` - the new shape, and the indices the clip landed on.
 */
export function pasteShapeSpan(points, clip, at, width) {
  const b = Math.min(1, at + width);
  if (!(b - at > EPS)) return { points: points.map((p) => ({ ...p })), placed: [] };
  const part = b < at + width ? shapeSpan(clip, 0, (b - at) / width) : clip;
  const span = part.map((p) => ({ ...p, x: at + p.x * (b - at) }));
  const cut = splitShapeAt(splitShapeAt(points, at), b);
  const ia = cut.findIndex((p) => near(p, at));
  let ib = cut.length - 1;
  for (let i = cut.length - 1; i >= 0; i--) if (near(cut[i], b)) { ib = i; break; }
  const before = at <= EPS ? [] : cut.slice(0, ia + 1);
  const after = b >= 1 - EPS ? [] : cut.slice(ib);
  const out = [...before, ...span, ...after];
  out[0].x = 0;
  out[out.length - 1].x = 1;
  return { points: out, placed: span.map((_, i) => before.length + i) };
}

/**
 * The span `a`..`b` alone, as the whole period. With `seam` the two ends are brought to the level
 * halfway between them, faded in over the first and out over the last `fade` of the loop, so the
 * wrap is not a jump. `{ points, original }` - the new shape, and (when ends were faded) the shape
 * as it was before the fade, for drawing what the fade changed.
 */
export function loopShapeSpan(points, a, b, { seam = true, fade = 1 / 16 } = {}) {
  let out = shapeSpan(points, a, b);
  const y0 = out[0].y;
  const y1 = out[out.length - 1].y;
  if (!seam || Math.abs(y0 - y1) < 1e-3) return { points: out, original: null };
  out = splitShapeAt(splitShapeAt(out, fade), 1 - fade);
  const original = out.map((p) => ({ ...p }));
  const mid = (y0 + y1) / 2;
  for (const p of out) {
    const w = p.x < fade ? 1 - p.x / fade : p.x > 1 - fade ? 1 - (1 - p.x) / fade : 0;
    p.y += (mid - p.y) * w;
  }
  return { points: out, original };
}

/**
 * A pencil stroke drawn over the shape: `stroke` is the `{x, y}` it passed through, in x order. The
 * points under it are replaced by the stroke, thinned to the ones that change its line by more than
 * `tolerance`; the shape steps into the stroke and back out of it.
 */
export function drawShapeStroke(points, stroke, tolerance = 0.006) {
  const a = stroke[0].x;
  const b = stroke[stroke.length - 1].x;
  if (b - a <= EPS) {
    // A click: one point where it landed.
    const out = points.map((p) => ({ ...p }));
    const p = { x: a, y: clamp01(stroke[0].y), c: 0 };
    if (a <= EPS || a >= 1 - EPS) out[a <= EPS ? 0 : out.length - 1].y = p.y;
    else {
      const at = out.findIndex((q) => q.x > a);
      out.splice(at, 0, p);
    }
    return out;
  }
  const line = thin(stroke, tolerance).map((p) => ({ x: p.x, y: clamp01(p.y), c: 0 }));
  const cut = splitShapeAt(splitShapeAt(points, a), b);
  const ia = cut.findIndex((p) => near(p, a));
  let ib = cut.length - 1;
  for (let i = cut.length - 1; i >= 0; i--) if (near(cut[i], b)) { ib = i; break; }
  const out = [...(a <= EPS ? [] : cut.slice(0, ia + 1)), ...line, ...(b >= 1 - EPS ? [] : cut.slice(ib))];
  out[0].x = 0;
  out[out.length - 1].x = 1;
  return out;
}

// Ramer-Douglas-Peucker: the fewest points that stay within `tol` of the line drawn.
function thin(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const t = b.x === a.x ? 0 : (p.x - a.x) / (b.x - a.x);
    const d = Math.abs(p.y - (a.y + (b.y - a.y) * t));
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [a, b];
  return [...thin(pts.slice(0, at + 1), tol).slice(0, -1), ...thin(pts.slice(at), tol)];
}

/**
 * The points at `indices` moved together by `dx`, `dy`: held inside 0..1 as a group, so the drawing
 * keeps its shape, and never past a neighbor that isn't moving with them. The two ends keep their x.
 */
export function moveShapePoints(points, indices, dx, dy) {
  const sel = new Set(indices);
  const last = points.length - 1;
  const moves = (i) => sel.has(i) && i > 0 && i < last;
  let lo = -Infinity;
  let hi = Infinity;
  let ylo = -Infinity;
  let yhi = Infinity;
  for (const i of sel) {
    const p = points[i];
    ylo = Math.max(ylo, -p.y);
    yhi = Math.min(yhi, 1 - p.y);
    if (!moves(i)) continue;
    if (!moves(i - 1)) lo = Math.max(lo, points[i - 1].x - p.x);
    if (!moves(i + 1)) hi = Math.min(hi, points[i + 1].x - p.x);
  }
  const mx = Math.min(hi, Math.max(lo, dx));
  const my = Math.min(yhi, Math.max(ylo, dy));
  return points.map((p, i) => (sel.has(i) ? { ...p, x: moves(i) ? p.x + mx : p.x, y: p.y + my } : { ...p }));
}

// Automation breakpoints - the same `x,y[,c]` text as a shape, but x is an ABSOLUTE bar (cycle)
// rather than a phase: "0,0 16,0 20,1,-2 32,0.3" holds 0 until bar 16, curves up to 1 by bar 20,
// falls to 0.3 by bar 32. One pass over the arrangement, no period. Neither axis is clamped - x
// runs as long as the song, and y is the literal value handed to whatever control reads it (a
// normalized param wants 0..1, but auto() is an ordinary signal and can be scaled like one).
export function parseAutoPoints(str) {
  return parseBreakpoints(str, 'auto', 'bar', 'an automation');
}

/**
 * The shared breakpoint reader behind parseAutoPoints and parseBendPoints - the same `x,y[,c]`
 * text, differing only in what x MEANS and therefore in what a bad one should say. `tag` is the
 * bracketed source in the message, `axis` the name of the x axis, `what` the thing being read.
 */
function parseBreakpoints(str, tag, axis, what) {
  const points = String(str)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      // The fields are checked for being non-empty before they are converted, because Number("")
      // is 0: a half-typed "16," would otherwise read as a breakpoint pulling the lane down to
      // zero, which on a wet lane is the effect vanishing while you are still typing the value.
      const parts = tok.split(',');
      if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p.trim())) {
        throw new Error(`[${tag}] bad breakpoint "${tok}" (want "${axis},value" or "${axis},value,c")`);
      }
      const [x, y, c = 0] = parts.map(Number);
      if (![x, y, c].every(Number.isFinite)) throw new Error(`[${tag}] bad breakpoint "${tok}" (want "${axis},value" or "${axis},value,c")`);
      return { x, y, c };
    });
  if (points.length < 1) throw new Error(`[${tag}] ${what} needs at least 1 breakpoint`);
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[i - 1].x) throw new Error(`[${tag}] breakpoints must be in ascending ${axis} order`);
  }
  return points;
}

export function serializeAutoPoints(points) {
  // Finer rounding than a shape's: x is in bars, where 3 decimals can't write a 16th (0.0625).
  const fmt = (v) => String(Math.round(v * 1e6) / 1e6);
  return points.map((p) => (p.c ? `${fmt(p.x)},${fmt(p.y)},${fmt(p.c)}` : `${fmt(p.x)},${fmt(p.y)}`)).join(' ');
}

/**
 * Value of an automation at an absolute bar. Outside the breakpoints it HOLDS the nearest end -
 * the lane before its first point sits at that point's level, and the last level stands for the
 * rest of the song (an automation is a setting over time, and a setting keeps its value until
 * something moves it). Duplicate-x points read as a vertical step, like a shape's.
 */
export function sampleAutoPoints(points, bar) {
  if (bar <= points[0].x) return points[0].y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (bar >= a.x && bar < b.x) {
      const span = b.x - a.x;
      if (span <= 0) continue; // zero-width step: fall through to the segment after it
      return curveInterp(a.y, b.y, (bar - a.x) / span, a.c ?? 0);
    }
  }
  return points[points.length - 1].y;
}

// Pitch-bend breakpoints - a roll's drawn bend curve (see the `bend` option on pianoroll()).
// The same `x,y[,c]` text again, with x an absolute CELL of the roll it was drawn on and y a
// number of SEMITONES, positive up. Cells rather than bars because a roll is written on cells:
// the curve turns where the notes do, and it loops with them over the roll's own `len`.
//
// Neither axis is clamped here. Semitones are an absolute musical distance, which is what lets
// one curve mean the same thing to a sampler (it repitches) and to a MIDI synth (it is encoded
// against that plugin's bend range - see Sig#bend). Clipping belongs where the limit is, not in
// the drawing.
export function parseBendPoints(str) {
  return parseBreakpoints(str, 'bend', 'cell', 'a bend curve');
}

export function serializeBendPoints(points) {
  return serializeAutoPoints(points);
}

/**
 * Semitones at an absolute cell. Holds the nearest end outside the breakpoints, exactly as an
 * automation does - a bend drawn over the middle of a roll leaves the cells either side of it
 * sitting at the value the curve starts and finishes on, rather than snapping to centre.
 */
export function sampleBendPoints(points, cell) {
  return sampleAutoPoints(points, cell);
}

/** A curve that bends nothing: no points at all, or every point flat at zero with no curvature. */
export function bendIsFlat(points) {
  return !points || points.length === 0 || points.every((p) => Math.abs(p.y) < 1e-9);
}

export const SHAPE_PRESETS = {
  triangle: '0,0 0.5,1 1,0',
  saw: '0,0 1,1',
  isaw: '0,1 1,0',
  square: '0,1 0.5,1 0.5,0 1,0',
  sine: '0,0.5,-1.6 0.25,1,1.6 0.5,0.5,-1.6 0.75,0,1.6 1,0.5',
  pluck: '0,1,-4 1,0',
  swell: '0,0,2 0.7,1 1,0',
  stairs: '0,1 0.25,1 0.25,0.667 0.5,0.667 0.5,0.333 0.75,0.333 0.75,0 1,0',
};

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
