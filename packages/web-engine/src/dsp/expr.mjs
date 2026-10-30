// Parameter expressions: the tree a `.param()` value becomes when it combines signals in a way no
// single modulator covers - `audio("a").mul(lfo())`, two sources summed, `env().mul(lfo())`.
//
// The engine evaluates the tree once per sample. Its leaves are inputs (a modulator, a polled
// value or another track's audio, each fed into the node by the engine) and constants; its
// nodes are plain arithmetic. This module is the math, shared by the worklet that runs it and
// the tests that check it, and it has to agree with the desktop engine's version exactly:
// floored mod, 1/0 comparisons, and 0 wherever the arithmetic has no answer (a divide by zero,
// a fractional power of a negative number), since a NaN reaching a parameter silences a device.
//
//   { k: 'const', v }                       a constant
//   { k: 'in', i, rate, source? }           input i
//   { k: 'op', op, a: [x, y] }              add sub mul div mod min max pow gt gte lt lte eq neq
//   { k: 'fn', op, a: [x] }                 abs neg round floor ceil
//   { k: 'map', min, max, curve, a: [x] }   real units to a 0..1 position, 'lin' or 'log', clipped
//   { k: 'fn', op: 'env', a: [x, attack, release] }
//                                           the level of x: |x| clipped at 1, rising over `attack`
//                                           seconds and falling over `release` (see exprLag)
//   { k: 'fn', op: 'smooth', a: [x, time] } x lagged by `time` seconds both ways (see exprLag)

const exprFinite = (v) => (Number.isFinite(v) ? v : 0);

export const EXPR_BINARY = Object.freeze({
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => (b === 0 ? 0 : a / b),
  mod: (a, b) => (b === 0 ? 0 : ((a % b) + b) % b),
  min: (a, b) => (a < b ? a : b),
  max: (a, b) => (a > b ? a : b),
  pow: (a, b) => exprFinite(Math.pow(a, b)),
  gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0),
  neq: (a, b) => (a !== b ? 1 : 0),
});

export const EXPR_UNARY = Object.freeze({
  abs: Math.abs,
  neg: (a) => -a,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
});

/** Real units to a 0..1 position, as a mapping file's `lin` or `log` curve reads them. */
export function exprMapUnit(x, min, max, curve) {
  let t;
  if (curve === 'log') t = x > 0 && min > 0 && max > min ? Math.log(x / min) / Math.log(max / min) : 0;
  else t = max !== min ? (x - min) / (max - min) : 0;
  t = exprFinite(t);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ln(0.001): a lag's times (the envelope follower's attack and release, smooth()'s time) are the
// time to get within 60 dB of a new value.
const LOG001 = Math.log(0.001);

/**
 * The coefficient one sample of a lag moves by, for a time in seconds - the desktop's Lag/LagUD
 * formula, which reads its time as a 32-bit float. 0 (no lag) for a time of 0 or less.
 */
export function lagCoef(seconds, sampleRate) {
  const t = Math.fround(seconds);
  return t > 0 ? Math.exp(LOG001 / (t * sampleRate)) : 0;
}

/**
 * One exponential lag's state, as the desktop's LagUD keeps it: `step(x, up, down)` takes one
 * sample and returns the lagged value, which moves toward x by the `up` time's coefficient while
 * rising and the `down` time's while falling. It starts at its first input, so a lag put on a
 * steady value does not glide up to it from 0. Lag is LagUD with both times equal.
 */
export function exprLag(sampleRate) {
  let y = null;
  let up = NaN;
  let down = NaN;
  let cu = 0;
  let cd = 0;
  return (x, tUp, tDown) => {
    if (tUp !== up) { up = tUp; cu = lagCoef(tUp, sampleRate); }
    if (tDown !== down) { down = tDown; cd = lagCoef(tDown, sampleRate); }
    const v = Number.isFinite(x) ? Math.fround(x) : 0;
    if (y === null) y = v;
    else y = v > y ? v + cu * (y - v) : v + cd * (y - v);
    return y;
  };
}

/** An envelope follower's input: rectified and clipped at full scale (a NaN reads 0). */
export function followInput(x) {
  const v = x < 0 ? -x : x;
  return v <= 1 ? v : v > 1 ? 1 : 0;
}

/** The constants of a tree, depth first and left to right - the order compileExpr reads them in. */
export function exprConsts(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (tree.k === 'const') out.push(Number(tree.v) || 0);
  for (const child of tree.a ?? []) exprConsts(child, out);
  return out;
}

/**
 * The tree with its constants left out: two trees that differ only in their numbers have the same
 * shape, and the running node takes the new numbers in place instead of being rebuilt.
 */
export function exprShape(tree) {
  return JSON.stringify(tree, (key, value) => (key === 'v' ? undefined : value));
}

/** Every input leaf, in tree order. */
export function exprInputs(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (tree.k === 'in') out.push(tree);
  for (const child of tree.a ?? []) exprInputs(child, out);
  return out;
}

/** How many inputs a node for this tree needs: one past the highest index it reads. */
export function exprInputCount(tree) {
  return exprInputs(tree).reduce((n, leaf) => Math.max(n, (Number(leaf.i) | 0) + 1), 0);
}

/**
 * Compiles a tree into `(x) => value`, where `x[i]` is input i at this sample. `consts` is read
 * live, so writing new numbers into the same array changes the result without recompiling. A
 * lag keeps state, so the function is called once per sample, in order, at `sampleRate`.
 * Throws on a node it does not know, by name.
 */
export function compileExpr(tree, consts = exprConsts(tree), { sampleRate = 48000 } = {}) {
  let next = 0;
  // This sample's inputs side by side, where the caller has them (see renderExpr); without them
  // each side reads as the mid.
  let left = null;
  let right = null;
  // side 0 reads each input as its mid, (L + R) / 2; 1 and 2 read the left and right alone - an
  // envelope follower's input is built once per side, for its linked peak.
  const build = (node, side) => {
    switch (node?.k) {
      case 'const': {
        const at = next++;
        return () => consts[at];
      }
      case 'in': {
        const i = Number(node.i) | 0;
        if (side === 1) return (x) => (left ?? x)[i] ?? 0;
        if (side === 2) return (x) => (right ?? x)[i] ?? 0;
        return (x) => x[i] ?? 0;
      }
      case 'op': {
        const f = EXPR_BINARY[node.op];
        if (!f) throw new Error(`unknown operation "${node.op}"`);
        const a = build(node.a?.[0], side);
        const b = build(node.a?.[1], side);
        return (x) => f(a(x), b(x));
      }
      case 'fn': {
        if (node.op === 'env') {
          // The envelope follower: its input's linked peak, max(|L|, |R|) - the input built once
          // per side, every input in it reading that side alone, so an out-of-phase pair reads its
          // level and not the 0 of its mid - clipped at full scale, lagged by attack rising and
          // release falling. Both sides read the same constants.
          const from = next;
          const l = build(node.a?.[0], 1);
          next = from;
          const r = build(node.a?.[0], 2);
          const up = build(node.a?.[1], side);
          const down = build(node.a?.[2], side);
          const lag = exprLag(sampleRate);
          return (x) => {
            const vl = Math.fround(l(x));
            const vr = Math.fround(r(x));
            const v = Math.max(vl < 0 ? -vl : vl, vr < 0 ? -vr : vr);
            const tu = up(x);
            const td = down(x);
            return lag(followInput(v), tu > 0 ? tu : 0, td > 0 ? td : 0);
          };
        }
        if (node.op === 'smooth') {
          // smooth(): its input lagged by one time both ways.
          const a = build(node.a?.[0], side);
          const t = build(node.a?.[1], side);
          const lag = exprLag(sampleRate);
          return (x) => {
            const tt = t(x);
            return lag(a(x), tt > 0 ? tt : 0, tt > 0 ? tt : 0);
          };
        }
        const f = EXPR_UNARY[node.op];
        if (!f) throw new Error(`unknown function "${node.op}"`);
        const a = build(node.a?.[0], side);
        return (x) => f(a(x));
      }
      case 'map': {
        const a = build(node.a?.[0], side);
        const { min, max, curve } = node;
        return (x) => exprMapUnit(a(x), min, max, curve);
      }
      default:
        throw new Error(`unknown node ${JSON.stringify(node?.k)}`);
    }
  };
  const fn = build(tree, 0);
  return (x, l, r) => {
    left = l ?? null;
    right = r ?? null;
    return exprFinite(fn(x));
  };
}

/** Whether a tree has an envelope follower, which reads its inputs side by side. */
export function exprHasFollower(tree) {
  if (!tree || typeof tree !== 'object') return false;
  if (tree.k === 'fn' && tree.op === 'env') return true;
  return (tree.a ?? []).some(exprHasFollower);
}

/**
 * Runs a compiled expression over one block. `inputs` is the worklet's inputs (each a list of
 * channels; an unconnected one has none and reads 0), `x` a scratch array as long as the input
 * count, where an input with two channels reads as (L + R) / 2. Given `l` and `r`, two more
 * scratch arrays, each input's left and right go there too, for an envelope follower to read
 * side by side (a mono input is the same on both).
 */
export function renderExpr(fn, inputs, out, x, l = null, r = null) {
  const count = x.length;
  for (let n = 0; n < out.length; n++) {
    for (let i = 0; i < count; i++) {
      const chans = inputs[i];
      const a = chans?.[0] ? chans[0][n] : 0;
      const b = chans?.[1] ? chans[1][n] : a;
      x[i] = chans?.[1] ? Math.fround((a + b) * 0.5) : a;
      if (l) { l[i] = a; r[i] = b; }
    }
    out[n] = fn(x, l, r);
  }
}
