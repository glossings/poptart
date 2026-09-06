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

// Automation breakpoints - the same `x,y[,c]` text as a shape, but x is an ABSOLUTE bar (cycle)
// rather than a phase: "0,0 16,0 20,1,-2 32,0.3" holds 0 until bar 16, curves up to 1 by bar 20,
// falls to 0.3 by bar 32. One pass over the arrangement, no period. Neither axis is clamped - x
// runs as long as the song, and y is the literal value handed to whatever control reads it (a
// normalized param wants 0..1, but auto() is an ordinary signal and can be scaled like one).
export function parseAutoPoints(str) {
  const points = String(str)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const [x, y, c = 0] = tok.split(',').map(Number);
      if (![x, y, c].every(Number.isFinite)) throw new Error(`[auto] bad breakpoint "${tok}" (want "bar,value" or "bar,value,c")`);
      return { x, y, c };
    });
  if (points.length < 1) throw new Error('[auto] an automation needs at least 1 breakpoint');
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[i - 1].x) throw new Error('[auto] breakpoints must be in ascending bar order');
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

export const SHAPE_PRESETS = {
  triangle: '0,0 0.5,1 1,0',
  ramp: '0,0 1,1',
  saw: '0,1 1,0',
  square: '0,1 0.5,1 0.5,0 1,0',
  sine: '0,0.5,-1.6 0.25,1,1.6 0.5,0.5,-1.6 0.75,0,1.6 1,0.5',
  pluck: '0,1,-4 1,0',
  swell: '0,0,2 0.7,1 1,0',
  stairs: '0,1 0.25,1 0.25,0.667 0.5,0.667 0.5,0.333 0.75,0.333 0.75,0 1,0',
};

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
