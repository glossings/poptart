'use strict';

// Param-expression SynthDefs (setParamExpr): one def per tree SHAPE, its constants as controls
// c0, c1, ... in walk order and its inputs read off the buses named by controls k<i> (control
// rate) and a<i> (audio rate), -1 for "nothing drives it". A port of exprSynthDef and its
// helpers in sc/poptart.scd.

const crypto = require('node:crypto');
const G = require('./graph.js');
const U = require('./ugens.js');

const { SynthDef, add, sub, mul, div, mod, min, max, pow, gt, ge, lt, le, abs, neg, round, floor, ceil, log, sum, dup } = G;
const { In, Out, K2A, A2K, DC, Select, Lag, LagUD, clip } = U;

const kids = (node) => node.a ?? [];

// A lag in the tree - the envelope follower (op 'env') or smooth() - is computed at audio rate
// whatever its inputs are, so a tree with one is an audio-rate def (hasLag).
const isLag = (node) => String(node.k) === 'fn' && ['env', 'smooth'].includes(String(node.op));
const hasLag = (node) => isLag(node) || kids(node).some(hasLag);

/** The tree's shape: what decides the SynthDef (exprShape). */
function exprShape(node) {
  switch (String(node.k)) {
    case 'const': return 'c';
    case 'in': return `i${Math.trunc(Number(node.i))}`;
    case 'map': return `map:${String(node.curve)}(${exprShape(node.a[0])})`;
    default: return `${String(node.op)}(${kids(node).map(exprShape).join(',')})`;
  }
}

/** The tree's constants in walk order, the values of c0, c1, ... (exprConsts). */
function exprConsts(node, into = []) {
  switch (String(node.k)) {
    case 'const': into.push(Number(node.v)); break;
    case 'in': break;
    case 'map':
      into.push(Number(node.min), Number(node.max));
      exprConsts(node.a[0], into);
      break;
    default: for (const a of kids(node)) exprConsts(a, into);
  }
  return into;
}

/** The tree's inputs, first appearance of each index (exprInputs). */
function exprInputs(node, into = []) {
  switch (String(node.k)) {
    case 'const': break;
    case 'in': {
      const i = Math.trunc(Number(node.i));
      if (!into.some((e) => e.i === i)) into.push({ i, source: node.source == null ? null : String(node.source), rate: node.rate == null ? null : String(node.rate), ...(Number(node.step) === 1 ? { step: true } : {}) });
      break;
    }
    default: for (const a of kids(node)) exprInputs(a, into);
  }
  return into;
}

/**
 * The rate each input is read at, by index: 'ar' where the tree says so or where `audioFed(i)`
 * says an audio driver is already on it (installExpr's rule), 'kr' otherwise.
 */
function exprRates(tree, audioFed = () => false) {
  const declared = exprInputs(tree);
  const top = declared.reduce((m, e) => Math.max(m, e.i), -1);
  return Array.from({ length: top + 1 }, (_, i) => {
    const said = declared.find((e) => e.i === i);
    return (said && said.rate === 'ar') || audioFed(i) ? 'ar' : 'kr';
  });
}

// What exprSynthDef infers when no rates are given: what the tree says.
function treeRates(tree) {
  const said = [];
  const look = (node) => {
    if (String(node.k) === 'in') {
      const i = Math.trunc(Number(node.i));
      if (i >= 0) {
        while (said.length <= i) said.push('kr');
        if (String(node.rate) === 'ar') said[i] = 'ar';
      }
    }
    kids(node).forEach(look);
  };
  look(tree);
  return said;
}

/** The SynthDef for a tree (exprSynthDef). outKind: 'device', 'plugin' or 'channel'. */
function buildExprSynthDef(defName, tree, outKind, rates, warn = () => {}) {
  const rs = rates ?? treeRates(tree);
  const audio = rs.includes('ar') || hasLag(tree);
  return new SynthDef(defName, { out: 0 }, (c, def) => {
    let n = 0;
    // null: an audio input reads as its pair's mid, (L + R) / 2. 0 or 1: inside an envelope
    // follower's input, which is walked once per side for its linked peak - that side alone.
    let chan = null;
    const kr = (name, v) => def.namedKr(name, v);
    const walk = (node) => {
      switch (String(node.k)) {
        case 'const': {
          const ctl = kr(`c${n}`, 0);
          n += 1;
          return ctl;
        }
        case 'in': {
          const i = Math.trunc(Number(node.i));
          if (rs[i] === 'ar') {
            const kb = kr(`k${i}`, -1);
            const ab = kr(`a${i}`, -1);
            const kpart = K2A.ar(Select.kr(ge(kb, 0), [0, In.kr(max(kb, 0))]));
            const on = ge(ab, 0);
            const off = DC.ar(0);
            const pair = In.ar(max(ab, 0), 2);
            return add(kpart, Select.ar(on, [off, chan == null ? mul(sum(pair), 0.5) : pair[chan]]));
          }
          const kb = kr(`k${i}`, -1);
          const kv = Select.kr(ge(kb, 0), [0, In.kr(max(kb, 0))]);
          return audio ? K2A.ar(kv) : kv;
        }
        case 'map': {
          const lo = kr(`c${n}`, 0);
          const hi = kr(`c${n + 1}`, 1);
          n += 2;
          const x = walk(node.a[0]);
          if (String(node.curve) === 'log') {
            return clip(div(log(div(max(x, 1e-30), max(lo, 1e-30))), log(div(max(hi, 1e-30), max(lo, 1e-30)))), 0, 1);
          }
          return clip(div(sub(x, lo), sub(hi, lo)), 0, 1);
        }
        case 'fn': {
          if (isLag(node)) {
            // The envelope follower: the rectified level, clipped at full scale, rising over the
            // attack time and falling over the release (LagUD). smooth(): the input lagged by one
            // time both ways (Lag). Each time is how long it takes to get within 60 dB of a new
            // value, read once per block, at control rate.
            // A follower takes its input's linked peak, max(|L|, |R|): the input is walked once
            // per side, every audio input in it reading that side alone, so an out-of-phase pair
            // reads its level and not the 0 of its mid. The constants are the same controls both
            // times. smooth() lags the input as it reads, mid and all.
            const src = node.a[0];
            const follow = String(node.op) === 'env';
            let x;
            if (follow) {
              const outer = chan;
              const from = n;
              chan = 0;
              let l = walk(src);
              n = from;
              chan = 1;
              let r = walk(src);
              chan = outer;
              if (G.rateOf(l) !== 'audio') l = K2A.ar(l);
              if (G.rateOf(r) !== 'audio') r = K2A.ar(r);
              x = max(abs(l), abs(r));
            } else {
              x = walk(src);
              if (G.rateOf(x) !== 'audio') x = K2A.ar(x);
            }
            const perBlock = (y) => (G.rateOf(y) === 'audio' ? A2K.kr(y) : y);
            if (String(node.op) === 'smooth') return Lag.ar(x, max(perBlock(walk(node.a[1])), 0));
            const atk = perBlock(walk(node.a[1]));
            const rel = perBlock(walk(node.a[2]));
            return LagUD.ar(min(x, 1), max(atk, 0), max(rel, 0));
          }
          const x = walk(node.a[0]);
          switch (String(node.op)) {
            case 'abs': return abs(x);
            case 'neg': return neg(x);
            case 'round': return round(x, 1);
            case 'floor': return floor(x);
            case 'ceil': return ceil(x);
            default:
              warn(`setParamExpr: unknown function '${node.op}' - read as its input`);
              return x;
          }
        }
        default: {
          const a = walk(node.a[0]);
          const b = walk(node.a[1]);
          // Division and modulo by zero give 0, as pattern-core's do.
          const nz = gt(abs(b), 0);
          const safe = add(b, le(abs(b), 0));
          switch (String(node.op)) {
            case 'add': return add(a, b);
            case 'sub': return sub(a, b);
            case 'mul': return mul(a, b);
            case 'div': return mul(nz, div(a, safe));
            case 'mod': return mul(nz, mod(add(mod(a, safe), safe), safe));
            case 'min': return min(a, b);
            case 'max': return max(a, b);
            case 'pow': return pow(a, b);
            case 'gt': return gt(a, b);
            case 'gte': return ge(a, b);
            case 'lt': return lt(a, b);
            case 'lte': return le(a, b);
            case 'eq': return G.BinaryOpUGen.new('==', a, b);
            case 'neq': return G.BinaryOpUGen.new('!=', a, b);
            default:
              warn(`setParamExpr: unknown operation '${node.op}' - read as 0`);
              return audio ? DC.ar(0) : DC.kr(0);
          }
        }
      }
    };
    let v = walk(tree);
    // A tree of constants alone is a number, not a signal.
    if (typeof v === 'number') v = audio ? DC.ar(v) : DC.kr(v);
    if (audio) {
      if (outKind === 'device') Out.ar(c.out, [v, v]);
      else if (outKind === 'channelAr') Out.ar(c.out, v);
      else if (outKind === 'plugin') Out.kr(c.out, clip(A2K.kr(v), 0, 1));
      else Out.kr(c.out, A2K.kr(v));
    } else if (outKind === 'device') Out.ar(c.out, dup(K2A.ar(v)));
    else if (outKind === 'plugin') Out.kr(c.out, clip(v, 0, 1));
    else Out.kr(c.out, v);
  });
}

/**
 * The def for an expression: {name, bytes, shape, consts, inputs, rates}.
 *   tree     the expression tree as setParamExpr sends it (parsed JSON)
 *   outKind  'device' (stereo audio bus), 'plugin' (control bus, clipped 0..1) or 'channel'
 *   rates    'ar'/'kr' per input index (see exprRates); left out, what the tree says
 * The name depends on the shape only, so trees that differ in numbers share a def: set c<j> to
 * consts[j], and k<i>/a<i> to the buses driving input i (-1 for none).
 */
function exprDef(tree, { outKind = 'channel', rates, warn } = {}) {
  const rs = rates ?? treeRates(tree);
  const shape = `${exprShape(tree)}|${outKind}|${rs.join(',')}`;
  const name = `poptart_expr_${crypto.createHash('sha1').update(shape).digest('hex').slice(0, 16)}`;
  const def = buildExprSynthDef(name, tree, outKind, rs, warn);
  return {
    name, bytes: def.asBytes(), def, shape, rates: rs,
    consts: exprConsts(tree), inputs: exprInputs(tree),
  };
}

module.exports = { exprDef, exprShape, exprConsts, exprInputs, exprRates, buildExprSynthDef };
