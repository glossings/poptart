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
 * live, so writing new numbers into the same array changes the result without recompiling.
 * Throws on a node it does not know, by name.
 */
export function compileExpr(tree, consts = exprConsts(tree)) {
  let next = 0;
  const build = (node) => {
    switch (node?.k) {
      case 'const': {
        const at = next++;
        return () => consts[at];
      }
      case 'in': {
        const i = Number(node.i) | 0;
        return (x) => x[i] ?? 0;
      }
      case 'op': {
        const f = EXPR_BINARY[node.op];
        if (!f) throw new Error(`unknown operation "${node.op}"`);
        const a = build(node.a?.[0]);
        const b = build(node.a?.[1]);
        return (x) => f(a(x), b(x));
      }
      case 'fn': {
        const f = EXPR_UNARY[node.op];
        if (!f) throw new Error(`unknown function "${node.op}"`);
        const a = build(node.a?.[0]);
        return (x) => f(a(x));
      }
      case 'map': {
        const a = build(node.a?.[0]);
        const { min, max, curve } = node;
        return (x) => exprMapUnit(a(x), min, max, curve);
      }
      default:
        throw new Error(`unknown node ${JSON.stringify(node?.k)}`);
    }
  };
  const fn = build(tree);
  return (x) => exprFinite(fn(x));
}

/**
 * Runs a compiled expression over one block. `inputs` is the worklet's inputs (each a list of
 * channels; a mono input is its first channel, an unconnected one has none and reads 0), `x` a
 * scratch array as long as the input count.
 */
export function renderExpr(fn, inputs, out, x) {
  const count = x.length;
  for (let n = 0; n < out.length; n++) {
    for (let i = 0; i < count; i++) {
      const ch = inputs[i]?.[0];
      x[i] = ch ? ch[n] : 0;
    }
    out[n] = fn(x);
  }
}
