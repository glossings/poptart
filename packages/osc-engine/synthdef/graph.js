'use strict';

// A SynthDef builder and SCgf version 2 writer, without sclang.
//
// This is a port of sclang's own graph construction (SynthDef.sc, UGen.sc, BasicOpsUGen.sc and
// the UGen classes poptart uses, SuperCollider 3.14): controls from the def's arguments, the
// MulAdd/Sum3/Sum4/neg rewrites, dead-code elimination, constant numbering and the depth-first
// topological sort. Ported step for step, quirks included, so a def built here is the same bytes
// sclang's SynthDef.asBytes writes (synthdef-sclang.test.js holds it to that).
//
// Values in a graph: JS numbers are constants, JS arrays are multichannel arrays, UGen objects
// are signals. Strings are symbols (SendReply's command, a slot id).

let building = null; // the SynthDef under construction (UGen.buildSynthDef)

const RATE_NUMBER = { scalar: 0, control: 1, audio: 2, demand: 3 };

// --- sclang collection behavior the optimizer depends on ---------------------------------------

// An sclang Array has a capacity (a power of two); `add` grows it in place while there is room
// and otherwise returns a NEW array, leaving the receiver as it was. The optimizer discards some
// of those results, so whether an add landed changes later descendant counts.
function capFor(n) {
  let c = 1;
  while (c < n) c *= 2;
  return c;
}
function scArray(items) {
  const a = items;
  a.cap = capFor(items.length);
  return a;
}
function scAdd(coll, x) {
  if (coll == null) return scArray([x]);
  if (coll instanceof Set) {
    coll.add(x);
    return coll;
  }
  const cap = coll.cap ?? capFor(coll.length);
  if (coll.length < cap) {
    coll.push(x);
    coll.cap = cap;
    return coll;
  }
  const grown = coll.slice();
  grown.push(x);
  grown.cap = cap * 2;
  return grown;
}
function scRemove(coll, x) {
  if (coll == null) return;
  if (coll instanceof Set) {
    coll.delete(x);
    return;
  }
  const i = coll.indexOf(x);
  if (i >= 0) coll.splice(i, 1);
}
function scSize(coll) {
  if (coll == null) return 0;
  return coll instanceof Set ? coll.size : coll.length;
}

// sclang's mergeSort (insertion sort below nine elements), comparator semantics included.
function scSort(arr, fn) {
  const temp = new Array(arr.length);
  const insertion = (left, right) => {
    for (let i = left + 1; i <= right; i++) {
      const test = arr[i];
      let j = i;
      while (j > left && !fn(arr[j - 1], test)) {
        arr[j] = arr[j - 1];
        j--;
      }
      arr[j] = test;
    }
  };
  const merge = (left, mid, right) => {
    let leftEnd = mid - 1;
    let pos = left;
    const size = right - left + 1;
    while (left <= leftEnd && mid <= right) {
      if (fn(arr[left], arr[mid])) temp[pos++] = arr[left++];
      else temp[pos++] = arr[mid++];
    }
    while (left <= leftEnd) temp[pos++] = arr[left++];
    while (mid <= right) temp[pos++] = arr[mid++];
    for (let k = 0; k < size; k++, right--) arr[right] = temp[right];
  };
  const sortRange = (left, right) => {
    const size = right - left;
    if (size <= 0) return;
    if (size <= 8) {
      insertion(left, right);
      return;
    }
    const mid = (right + left) >> 1;
    sortRange(left, mid);
    sortRange(mid + 1, right);
    merge(left, mid + 1, right);
  };
  sortRange(0, arr.length - 1);
  return arr;
}

const isNum = (x) => typeof x === 'number';
const isUGen = (x) => x instanceof UGen;

// The rate of anything a UGen can take (Object:rate, SequenceableCollection:rate).
function rateOf(x) {
  if (isNum(x)) return 'scalar';
  if (isUGen(x)) return x.rate;
  if (Array.isArray(x)) {
    if (x.length === 1) return rateOf(x[0]);
    let min = null;
    for (const item of x) {
      const r = rateOf(item) ?? 'scalar';
      if (min === null || r < min) min = r;
    }
    return min;
  }
  return null;
}

// A wrapped value multichannel expansion leaves alone (sclang's Ref).
class Ref {
  constructor(value) {
    this.value = value;
  }
}

// --- UGen ---------------------------------------------------------------------------------------

class UGen {
  constructor() {
    this.synthDef = null;
    this.inputs = [];
    this.rate = 'audio';
    this._synthIndex = -1;
    this.specialIndex = 0;
    this.antecedents = null;
    this.descendants = null;
    this.widthFirstAntecedents = null;
  }

  get synthIndex() {
    return this._synthIndex;
  }
  set synthIndex(i) {
    this._synthIndex = i;
  }

  static get scName() {
    return this.name;
  }
  get name() {
    return this.constructor.scName;
  }

  static new1(rate, ...args) {
    const u = new this();
    u.rate = rate;
    u.addToSynth();
    return u.init(...args);
  }

  static multiNew(...args) {
    return this.multiNewList(args);
  }

  static multiNewList(args) {
    let size = 0;
    for (const item of args) if (Array.isArray(item)) size = Math.max(size, item.length);
    if (size === 0) return this.new1(...args);
    const results = new Array(size);
    for (let i = 0; i < size; i++) {
      const next = args.map((item) => (Array.isArray(item) ? item[i % item.length] : item));
      results[i] = this.multiNewList(next);
    }
    return results;
  }

  init(...inputs) {
    this.inputs = inputs;
    return this;
  }

  addToSynth() {
    this.synthDef = building;
    if (building) building.addUGen(this);
  }

  get source() {
    return this;
  }
  get outputIndex() {
    return 0;
  }
  numOutputs() {
    return 1;
  }
  rateNumber() {
    return RATE_NUMBER[this.rate];
  }

  collectConstants() {
    for (const input of this.inputs) if (isNum(input)) this.synthDef.addConstant(input);
  }

  writeInputSpec(w) {
    w.int32(this.synthIndex);
    w.int32(this.outputIndex);
  }
  writeOutputSpecs(w) {
    w.int8(this.rateNumber());
  }
  writeDef(w) {
    w.pstring(this.name);
    w.int8(this.rateNumber());
    w.int32(this.inputs.length);
    w.int32(this.numOutputs());
    w.int16(this.specialIndex);
    for (const input of this.inputs) {
      if (isNum(input)) {
        w.int32(-1);
        w.int32(this.synthDef.constantIndex(input));
      } else if (isUGen(input)) {
        input.writeInputSpec(w);
      } else {
        throw new Error(`${this.name}: bad input ${String(input)}`);
      }
    }
    this.writeOutputSpecs(w);
  }

  // topological sort
  initTopoSort() {
    for (const input of this.inputs) {
      if (isUGen(input)) {
        // sclang discards what `add` returns here, which only matters for a stale Array
        this.antecedents.add(input.source);
        scAdd(input.source.descendants, this);
      }
    }
    if (this.widthFirstAntecedents) {
      for (const u of this.widthFirstAntecedents) {
        this.antecedents.add(u);
        scAdd(u.descendants, this);
      }
    }
  }
  makeAvailable() {
    if (this.antecedents.size === 0) this.synthDef.available.push(this);
  }
  removeAntecedent(u) {
    this.antecedents.delete(u);
    this.makeAvailable();
  }
  schedule(outStack) {
    for (let i = this.descendants.length - 1; i >= 0; i--) this.descendants[i].removeAntecedent(this);
    outStack.push(this);
    return outStack;
  }

  optimizeGraph() {}

  performDeadCodeElimination() {
    if (scSize(this.descendants) === 0) {
      for (const a of this.inputs) {
        if (isUGen(a)) {
          scRemove(a.descendants, this);
          a.optimizeGraph();
        }
      }
      building.removeUGen(this);
      return true;
    }
    return false;
  }
}

class PureUGen extends UGen {
  optimizeGraph() {
    this.performDeadCodeElimination();
  }
}

class OutputProxy extends UGen {
  static new(rate, source, index) {
    return this.new1(rate, source, index);
  }
  addToSynth() {
    this.synthDef = building;
  }
  init(source, index) {
    this.src = source;
    this.outIndex = index;
    this.synthIndex = source.synthIndex;
    return this;
  }
  get source() {
    return this.src;
  }
  get outputIndex() {
    return this.outIndex;
  }
}

class MultiOutUGen extends UGen {
  initOutputs(n, rate) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${this.name}: numChannels must be a positive integer, got ${n}`);
    this.channels = [];
    for (let i = 0; i < n; i++) this.channels.push(OutputProxy.new(rate, this, i));
    return n === 1 ? this.channels[0] : this.channels;
  }
  numOutputs() {
    return this.channels.length;
  }
  writeOutputSpecs(w) {
    for (const c of this.channels) c.writeOutputSpecs(w);
  }
  get synthIndex() {
    return this._synthIndex;
  }
  set synthIndex(i) {
    this._synthIndex = i;
    if (this.channels) for (const c of this.channels) c.synthIndex = i;
  }
}

class PureMultiOutUGen extends MultiOutUGen {
  optimizeGraph() {
    this.performDeadCodeElimination();
  }
}

class WidthFirstUGen extends UGen {
  addToSynth() {
    this.synthDef = building;
    if (building) {
      building.addUGen(this);
      building.widthFirstUGens = scAdd(building.widthFirstUGens, this);
    }
  }
}

// UGens with no outputs (Out and friends, SendTrig and friends).
class NoOutUGen extends UGen {
  numOutputs() {
    return 0;
  }
  writeOutputSpecs() {}
}

// --- operators ----------------------------------------------------------------------------------

const UNARY = {
  neg: 0, not: 1, abs: 5, ceil: 8, floor: 9, frac: 10, sign: 11, squared: 12, cubed: 13, sqrt: 14,
  exp: 15, reciprocal: 16, midicps: 17, cpsmidi: 18, midiratio: 19, ratiomidi: 20, dbamp: 21,
  ampdb: 22, log: 25, log2: 26, log10: 27, sin: 28, cos: 29, tan: 30, tanh: 36,
};
const BINARY = {
  '+': 0, '-': 1, '*': 2, div: 3, '/': 4, mod: 5, '==': 6, '!=': 7, '<': 8, '>': 9, '<=': 10,
  '>=': 11, min: 12, max: 13, round: 19, pow: 25, absdif: 38,
};

class BasicOpUGen extends UGen {
  setOperator(op, table) {
    this.operator = op;
    this.specialIndex = table[op];
    if (this.specialIndex === undefined) throw new Error(`Operator '${op}' applied to a UGen is not supported in scsynth`);
  }
}

class UnaryOpUGen extends BasicOpUGen {
  static new(selector, a) {
    return this.multiNew('audio', selector, a);
  }
  init(op, input) {
    this.setOperator(op, UNARY);
    this.rate = rateOf(input);
    this.inputs = [input];
    return this;
  }
  optimizeGraph() {
    this.performDeadCodeElimination();
  }
}

class BinaryOpUGen extends BasicOpUGen {
  static new(selector, a, b) {
    return this.multiNew('audio', selector, a, b);
  }
  static new1(rate, selector, a, b) {
    if (selector === '*') {
      if (a === 0) return 0;
      if (b === 0) return 0;
      if (a === 1) return b;
      if (a === -1) return neg(b);
      if (b === 1) return a;
      if (b === -1) return neg(a);
    } else if (selector === '+') {
      if (a === 0) return b;
      if (b === 0) return a;
    } else if (selector === '-') {
      if (a === 0) return neg(b);
      if (b === 0) return a;
    } else if (selector === '/') {
      if (b === 1) return a;
      if (b === -1) return neg(a);
    }
    return super.new1(rate, selector, a, b);
  }
  init(op, a, b) {
    this.setOperator(op, BINARY);
    this.rate = determineRate(a, b);
    this.inputs = [a, b];
    return this;
  }

  optimizeGraph() {
    if (this.performDeadCodeElimination()) return;
    if (this.operator === '+') {
      this.optimizeAdd();
      return;
    }
    if (this.operator === '-') this.optimizeSub();
  }

  optimizeAdd() {
    let u = this.optimizeToSum3();
    if (u == null) u = this.optimizeToSum4();
    if (u == null) u = this.optimizeToMulAdd();
    if (u == null) u = this.optimizeAddNeg();
    if (u != null) {
      this.synthDef.replaceUGen(this, u);
      u.optimizeGraph();
    }
  }

  optimizeUpdateDescendants(replacement, deletedUnit) {
    const replaceFunc = (ugen) => {
      const desc = isUGen(ugen) ? ugen.descendants : null;
      const added = scAdd(desc, replacement);
      scRemove(added, this);
      scRemove(desc, deletedUnit);
    };
    for (const input of replacement.inputs) {
      replaceFunc(input);
      if (input instanceof OutputProxy) replaceFunc(input.source);
    }
  }

  optimizeAddNeg() {
    const [a, b] = this.inputs;
    if (a === b) return null;
    if (b instanceof UnaryOpUGen && b.operator === 'neg' && scSize(b.descendants) === 1) {
      building.removeUGen(b);
      const replacement = sub(a, b.inputs[0]);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, b);
      return replacement;
    }
    if (a instanceof UnaryOpUGen && a.operator === 'neg' && scSize(a.descendants) === 1) {
      building.removeUGen(a);
      const replacement = sub(b, a.inputs[0]);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, a);
      return replacement;
    }
    return null;
  }

  optimizeToMulAdd() {
    const [a, b] = this.inputs;
    if (a === b) return null;
    const tryFold = (m, other) => {
      if (m instanceof BinaryOpUGen && m.operator === '*' && scSize(m.descendants) === 1) {
        for (const [x, y] of [[m.inputs[0], m.inputs[1]], [m.inputs[1], m.inputs[0]]]) {
          if (MulAdd.canBeMulAdd(x, y, other)) {
            building.removeUGen(m);
            const replacement = MulAdd.new(x, y, other);
            replacement.descendants = this.descendants;
            this.optimizeUpdateDescendants(replacement, m);
            return replacement;
          }
        }
      }
      return null;
    };
    return tryFold(a, b) ?? tryFold(b, a);
  }

  optimizeToSum3() {
    const [a, b] = this.inputs;
    if (rateOf(a) === 'demand' || rateOf(b) === 'demand') return null;
    if (a instanceof BinaryOpUGen && a.operator === '+' && scSize(a.descendants) === 1) {
      building.removeUGen(a);
      const replacement = a === b
        ? Sum4.new(a.inputs[0], a.inputs[0], a.inputs[1], a.inputs[1])
        : Sum3.new(a.inputs[0], a.inputs[1], b);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, a);
      return replacement;
    }
    if (b instanceof BinaryOpUGen && b.operator === '+' && scSize(b.descendants) === 1) {
      building.removeUGen(b);
      const replacement = Sum3.new(b.inputs[0], b.inputs[1], a);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, b);
      return replacement;
    }
    return null;
  }

  optimizeToSum4() {
    const [a, b] = this.inputs;
    if (a === b) return null;
    if (rateOf(a) === 'demand' || rateOf(b) === 'demand') return null;
    if (a instanceof Sum3 && scSize(a.descendants) === 1) {
      building.removeUGen(a);
      const replacement = Sum4.new(a.inputs[0], a.inputs[1], a.inputs[2], b);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, a);
      return replacement;
    }
    if (b instanceof Sum3 && scSize(b.descendants) === 1) {
      building.removeUGen(b);
      const replacement = Sum4.new(b.inputs[0], b.inputs[1], b.inputs[2], a);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, b);
      return replacement;
    }
    return null;
  }

  optimizeSub() {
    const [a, b] = this.inputs;
    if (b instanceof UnaryOpUGen && b.operator === 'neg' && scSize(b.descendants) === 1) {
      building.removeUGen(b);
      const replacement = BinaryOpUGen.new('+', a, b.inputs[0]);
      replacement.descendants = this.descendants;
      this.optimizeUpdateDescendants(replacement, b);
      this.synthDef.replaceUGen(this, replacement);
      replacement.optimizeGraph();
    }
    return null;
  }
}

function determineRate(a, b) {
  const ra = rateOf(a);
  const rb = rateOf(b);
  if (ra === 'demand' || rb === 'demand') return 'demand';
  if (ra === 'audio' || rb === 'audio') return 'audio';
  if (ra === 'control' || rb === 'control') return 'control';
  return 'scalar';
}

class MulAdd extends UGen {
  static new(input, mul = 1, add = 0) {
    const args = [input, mul, add];
    return this.multiNewList([rateOf(args), ...args]);
  }
  static new1(rate, input, m, a) {
    if (m === 0) return a;
    const minus = m === -1;
    const nomul = m === 1;
    const noadd = a === 0;
    if (nomul && noadd) return input;
    if (minus && noadd) return neg(input);
    if (noadd) return mul(input, m);
    if (minus) return sub(a, input);
    if (nomul) return add(input, a);
    if (this.canBeMulAdd(input, m, a)) return super.new1(rate, input, m, a);
    if (this.canBeMulAdd(m, input, a)) return super.new1(rate, m, input, a);
    return add(mul(input, m), a);
  }
  init(input, m, a) {
    this.inputs = [input, m, a];
    this.rate = rateOf(this.inputs);
    return this;
  }
  static canBeMulAdd(input, m, a) {
    const ri = rateOf(input);
    if (ri === 'audio') return true;
    const ok = (r) => r === 'control' || r === 'scalar';
    return ri === 'control' && ok(rateOf(m)) && ok(rateOf(a));
  }
}

const byRate = (x, y) => (rateOf(x) ?? '') < (rateOf(y) ?? '');

class Sum3 extends UGen {
  static new(a, b, c) {
    return this.multiNew(null, a, b, c);
  }
  static new1(_rate, a, b, c) {
    if (c === 0) return add(a, b);
    if (b === 0) return add(a, c);
    if (a === 0) return add(b, c);
    const args = [a, b, c];
    const rate = rateOf(args);
    scSort(args, byRate);
    return UGen.new1.call(this, rate, ...args);
  }
}

class Sum4 extends UGen {
  static new(a, b, c, d) {
    return this.multiNew(null, a, b, c, d);
  }
  static new1(_rate, a, b, c, d) {
    if (a === 0) return Sum3.new1(null, b, c, d);
    if (b === 0) return Sum3.new1(null, a, c, d);
    if (c === 0) return Sum3.new1(null, a, b, d);
    if (d === 0) return Sum3.new1(null, a, b, c);
    const args = [a, b, c, d];
    const rate = rateOf(args);
    scSort(args, byRate);
    return UGen.new1.call(this, rate, ...args);
  }
}

// sclang's double-precision folding for operations on two numbers.
function foldBinary(op, a, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case 'mod': {
      if (b === 0) return 0;
      return a - b * Math.floor(a / b);
    }
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'pow': return Math.pow(a, b);
    case 'round': return b === 0 ? a : Math.floor(a / b + 0.5) * b;
    case 'absdif': return Math.abs(a - b);
    default: throw new Error(`no numeric folding for '${op}' on two numbers`);
  }
}
function foldUnary(op, a) {
  switch (op) {
    case 'neg': return -a;
    case 'abs': return Math.abs(a);
    case 'ceil': return Math.ceil(a);
    case 'floor': return Math.floor(a);
    case 'sign': return a > 0 ? 1 : a < 0 ? -1 : 0;
    case 'squared': return a * a;
    case 'sqrt': return Math.sqrt(a);
    case 'exp': return Math.exp(a);
    case 'reciprocal': return 1 / a;
    case 'midiratio': return Math.pow(2, a / 12);
    case 'log': return Math.log(a);
    case 'sin': return Math.sin(a);
    case 'cos': return Math.cos(a);
    default: throw new Error(`no numeric folding for '${op}'`);
  }
}

// `a <op> b` with sclang's dispatch: numbers fold, arrays expand element by element (wrapping),
// anything else is a BinaryOpUGen.
function binop(op, a, b) {
  const aa = Array.isArray(a);
  const ba = Array.isArray(b);
  if (aa && ba) {
    const n = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(binop(op, a[i % a.length], b[i % b.length]));
    return out;
  }
  if (aa) return a.map((x) => binop(op, x, b));
  if (ba) return b.map((x) => binop(op, a, x));
  if (isNum(a) && isNum(b)) return foldBinary(op, a, b);
  return BinaryOpUGen.new(op, a, b);
}
function unop(op, a) {
  if (Array.isArray(a)) return a.map((x) => unop(op, x));
  if (isNum(a)) return foldUnary(op, a);
  return UnaryOpUGen.new(op, a);
}

const add = (a, b) => binop('+', a, b);
const sub = (a, b) => binop('-', a, b);
const mul = (a, b) => binop('*', a, b);
const div = (a, b) => binop('/', a, b);
const mod = (a, b) => binop('mod', a, b);
const min = (a, b) => binop('min', a, b);
const max = (a, b) => binop('max', a, b);
const pow = (a, b) => binop('pow', a, b);
const round = (a, b = 1) => binop('round', a, b);
const absdif = (a, b) => binop('absdif', a, b);
const gt = (a, b) => binop('>', a, b);
const ge = (a, b) => binop('>=', a, b);
const lt = (a, b) => binop('<', a, b);
const le = (a, b) => binop('<=', a, b);
const eq = (a, b) => binop('==', a, b);
const ne = (a, b) => binop('!=', a, b);
const neg = (a) => unop('neg', a);
const abs = (a) => unop('abs', a);
const sign = (a) => unop('sign', a);
const squared = (a) => unop('squared', a);
const sqrt = (a) => unop('sqrt', a);
const exp = (a) => unop('exp', a);
const log = (a) => unop('log', a);
const sin = (a) => unop('sin', a);
const cos = (a) => unop('cos', a);
const reciprocal = (a) => unop('reciprocal', a);
const midiratio = (a) => unop('midiratio', a);
const floor = (a) => unop('floor', a);
const ceil = (a) => unop('ceil', a);

// Array:sum - folded from 0, as sclang does.
function sum(arr) {
  let s = 0;
  for (const x of arr) s = add(s, x);
  return s;
}
const dup = (x, n = 2) => Array.from({ length: n }, () => x);

// --- SynthDef -----------------------------------------------------------------------------------

class SynthDef {
  /**
   * `params` is the def's argument list as an object, in order: name -> default. A `t_` name is
   * a trigger control, `i_` scalar, `a_` audio, anything else a control-rate control - sclang's
   * rule. `fn` gets the controls by name and builds the graph.
   */
  constructor(name, params, fn) {
    this.name = String(name);
    this.controls = null;
    this.controlNames = null;
    this.allControlNames = null;
    this.controlIndex = 0;
    this.children = [];
    this.constants = new Map();
    this.maxLocalBufs = null;
    this.available = null;
    this.widthFirstUGens = null;
    this.rewriteInProgress = false;
    this.namedControls = new Map();
    // Where each VSTPlugin / PoptartDevice landed, by id (the defs' metadata in sclang).
    this.slots = { vstplugins: {}, poptartDevices: {} };
    this.build(params ?? {}, fn);
  }

  build(params, fn) {
    const saved = building;
    building = this;
    try {
      this.controlNames = null;
      this.addControlsFromParams(params);
      const args = this.buildControls();
      fn(args, this);
      this.finishBuild();
    } finally {
      building = saved;
    }
  }

  addControlName(cn) {
    this.controlNames = scAdd(this.controlNames, cn);
    this.allControlNames = scAdd(this.allControlNames, cn);
  }

  addControlsFromParams(params) {
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== 'number') throw new Error(`${this.name}: control '${name}' needs a number default`);
      const rate = name.startsWith('i_') ? 'scalar' : name.startsWith('t_') ? 'trigger' : name.startsWith('a_') ? 'audio' : 'control';
      this.addControlName({
        name, index: scSize(this.controls), rate, defaultValue: value,
        argNum: scSize(this.controlNames), lag: 0,
      });
    }
  }

  buildControls() {
    const names = this.controlNames ?? [];
    const args = {};
    const group = (rate, make) => {
      const cns = names.filter((cn) => cn.rate === rate);
      if (!cns.length) return;
      let index = this.controlIndex;
      const out = make(cns.map((cn) => cn.defaultValue));
      const ugens = Array.isArray(out) ? out : [out];
      cns.forEach((cn, i) => {
        cn.index = index;
        index += 1;
        args[cn.name] = ugens[i];
      });
    };
    group('scalar', (v) => Control.ir(v));
    group('trigger', (v) => TrigControl.kr(v));
    group('audio', (v) => AudioControl.ar(v));
    group('control', (v) => Control.kr(v));
    return args;
  }

  // \name.kr(default) inside the graph function (NamedControl): one Control per name, reused.
  // `rate` is NamedControl's: 'control' for .kr, 'scalar' for .ir (see namedIr).
  namedKr(name, value = 0, rate = 'control') {
    const key = String(name);
    const had = this.namedControls.get(key);
    if (had) {
      if (had.value !== value) throw new Error(`NamedControl: cannot have more than one set of default values in the same control (${key})`);
      if (had.rate !== rate) throw new Error(`NamedControl: cannot have more than one set of rates in the same control (${key})`);
      return had.control;
    }
    const prefix = key[1] === '_' ? key[0] : null;
    let control;
    const cn = {
      name: key, index: scSize(this.controls), defaultValue: value, argNum: scSize(this.controlNames), lag: 0,
    };
    if (prefix === 'a' || rate === 'audio') {
      cn.rate = 'audio';
      this.addControlName(cn);
      control = AudioControl.ar([value]);
    } else if (prefix === 't' || rate === 'trigger') {
      cn.rate = 'trigger';
      this.addControlName(cn);
      control = TrigControl.kr([value]);
    } else if (prefix === 'i' || rate === 'scalar') {
      cn.rate = 'scalar';
      this.addControlName(cn);
      control = Control.ir([value]);
    } else {
      cn.rate = 'control';
      this.addControlName(cn);
      control = Control.kr([value]);
    }
    this.namedControls.set(key, { value, control, rate });
    return control;
  }

  // \name.ir(default) (NamedControl.ir).
  namedIr(name, value = 0) {
    return this.namedKr(name, value, 'scalar');
  }

  addUGen(u) {
    if (!this.rewriteInProgress) {
      u.synthIndex = this.children.length;
      u.widthFirstAntecedents = this.widthFirstUGens ? scArray(this.widthFirstUGens.slice()) : null;
      this.children.push(u);
    }
  }
  removeUGen(u) {
    this.children[u.synthIndex] = null;
  }
  replaceUGen(a, b) {
    if (!isUGen(b)) throw new Error('replaceUGen assumes a UGen');
    b.widthFirstAntecedents = a.widthFirstAntecedents;
    b.descendants = a.descendants;
    b.synthIndex = a.synthIndex;
    this.children[a.synthIndex] = b;
    for (const item of this.children) {
      if (item) item.inputs.forEach((input, j) => { if (input === a) item.inputs[j] = b; });
    }
  }
  addConstant(v) {
    if (!this.constants.has(v)) this.constants.set(v, this.constants.size);
  }
  constantIndex(v) {
    const i = this.constants.get(v);
    if (i === undefined) throw new Error(`constant not found: ${v}`);
    return i;
  }

  finishBuild() {
    this.optimizeGraph();
    for (const u of this.children) u.collectConstants();
    this.topologicalSort();
    this.indexUGens();
  }

  optimizeGraph() {
    this.initTopoSort();
    this.rewriteInProgress = true;
    for (const u of this.children.slice()) u.optimizeGraph();
    this.rewriteInProgress = false;
    const oldSize = this.children.length;
    this.children = this.children.filter((u) => u !== null);
    if (oldSize !== this.children.length) this.indexUGens();
  }

  initTopoSort() {
    this.available = [];
    for (const u of this.children) {
      u.antecedents = new Set();
      u.descendants = new Set();
    }
    for (const u of this.children) u.initTopoSort();
    for (let i = this.children.length - 1; i >= 0; i--) {
      const u = this.children[i];
      u.descendants = scArray(scSort([...u.descendants], (a, b) => a.synthIndex < b.synthIndex));
      u.makeAvailable();
    }
  }

  topologicalSort() {
    this.initTopoSort();
    let out = [];
    while (this.available.length > 0) out = this.available.pop().schedule(out);
    this.children = out;
    for (const u of this.children) {
      u.antecedents = null;
      u.descendants = null;
      u.widthFirstAntecedents = null;
    }
  }

  indexUGens() {
    this.children.forEach((u, i) => { u.synthIndex = i; });
  }

  writeDef(w) {
    w.pstring(this.name);
    const consts = [...this.constants.entries()].sort((x, y) => x[1] - y[1]);
    w.int32(consts.length);
    for (const [v] of consts) w.float32(v);
    const controls = this.controls ?? [];
    w.int32(controls.length);
    for (const v of controls) w.float32(v);
    const names = (this.allControlNames ?? []).filter((cn) => cn.name != null);
    w.int32(names.length);
    for (const cn of names) {
      w.pstring(cn.name);
      w.int32(cn.index);
    }
    w.int32(this.children.length);
    for (const u of this.children) u.writeDef(w);
    w.int16(0); // variants
  }

  /** The def alone as an SCgf file, what sclang's asBytes gives. */
  asBytes() {
    return scgf([this]);
  }

  /** The def's controls, name -> {index, default}, for setting by index or checking names. */
  controlMap() {
    const out = {};
    for (const cn of this.allControlNames ?? []) out[cn.name] = { index: cn.index, default: cn.defaultValue };
    return out;
  }
}

class ByteWriter {
  constructor() {
    this.parts = [];
  }
  push(buf) {
    this.parts.push(buf);
  }
  int8(v) {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.push(b);
  }
  int16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.push(b);
  }
  int32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.push(b);
  }
  float32(v) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    this.push(b);
  }
  pstring(s) {
    const bytes = Buffer.from(String(s), 'latin1');
    if (bytes.length > 255) throw new Error(`name too long: ${s}`);
    this.push(Buffer.from([bytes.length]));
    this.push(bytes);
  }
  bytes() {
    return Buffer.concat(this.parts);
  }
}

/** An SCgf (version 2) file holding `defs`, in order. */
function scgf(defs) {
  const w = new ByteWriter();
  w.push(Buffer.from('SCgf', 'latin1'));
  w.int32(2);
  w.int16(defs.length);
  for (const d of defs) d.writeDef(w);
  return w.bytes();
}

// --- controls -----------------------------------------------------------------------------------

class Control extends MultiOutUGen {
  static kr(values) {
    return this.multiNewList(['control', ...values]);
  }
  static ir(values) {
    return this.multiNewList(['scalar', ...values]);
  }
  init(...values) {
    this.values = values;
    const sd = this.synthDef;
    if (sd) {
      this.specialIndex = scSize(sd.controls);
      sd.controls = (sd.controls ?? []).concat(values);
      const names = sd.controlNames;
      if (scSize(names) > 0) {
        const last = names[names.length - 1];
        if (last.defaultValue == null) last.defaultValue = values.length === 1 ? values[0] : values;
      }
      sd.controlIndex += values.length;
    }
    return this.initOutputs(values.length, this.rate);
  }
}
class TrigControl extends Control {}
class AudioControl extends MultiOutUGen {
  static ar(values) {
    return this.multiNewList(['audio', ...values]);
  }
  init(...values) {
    this.values = values;
    const sd = this.synthDef;
    if (sd) {
      this.specialIndex = scSize(sd.controls);
      sd.controls = (sd.controls ?? []).concat(values);
      sd.controlIndex += values.length;
    }
    return this.initOutputs(values.length, this.rate);
  }
}

module.exports = {
  UGen, PureUGen, MultiOutUGen, PureMultiOutUGen, OutputProxy, WidthFirstUGen, NoOutUGen,
  UnaryOpUGen, BinaryOpUGen, MulAdd, Sum3, Sum4, Control, TrigControl, AudioControl,
  SynthDef, Ref, scgf, rateOf, isNum, isUGen, building: () => building,
  add, sub, mul, div, mod, min, max, pow, round, absdif, gt, ge, lt, le, eq, ne,
  neg, abs, sign, squared, sqrt, exp, log, sin, cos, reciprocal, midiratio, floor, ceil,
  binop, unop, sum, dup,
};
