// A small, self-contained mini-notation parser/interpreter - deliberately NOT a dependency on
// @strudel/mini, so this package never touches Strudel's Pattern/Hap object model (see
// ARCHITECTURE.md). It supports the common, high-value subset of Tidal/Strudel mini-notation:
//
//   "0 2 3"        sequence (each token gets an equal slice of the cycle)
//   "~"            rest (no event for that slice)
//   "[a b]"        bracketed sub-sequence, occupying one slice of its parent
//   "[a,b]"        stack: layers play simultaneously, each spanning the full bracket
//   "<a b c>"      alternation: one item per cycle (cycles through on each absolute cycle)
//   "a*3"          fast: repeat 3 times within this slice ("a*<2 3>" alternates the rate per cycle)
//   "a/2"          slow: stretch over 2 cycles (only 1/2 of it shows up per cycle)
//   "a!3"          replicate: 3 separate onsets, each getting a normal-width slice
//   "a@3"          weight: one onset, 3x the width of a normal slice
//   "a _ _"        elongate: "_" extends the previous step (one onset over 3 slices - a tie,
//                  not a retrigger). Inside "<...>" it holds the previous item across cycles.
//   "1.e(3,8)"     euclidean rhythm: 3 pulses over 8 steps (optionally "1.e(3,8,2)" with rotation).
//                  Written as a "value.method(...)" postfix (euclid on sample "bd" is "bd.e(3,8)"),
//                  which keeps plain "name(...)" free for function calls and leaves room for more
//                  methods later. LEGATO: each hit sustains until the next onset (so "1.e(3,8)" is
//                  dotted-8th, dotted-8th, 8th - not three clipped gates). The value can be any
//                  node: "i(0,5).e(5,8)" (a random note that re-rolls per hit) or "[a b].e(3,8)".
//   "<a b>:x"      field suffix on a group: distributes onto every atom inside, so
//                  "<18 16>:3" is exactly "<18:3 16:3>" (pairs with .as("n:clip") etc.)
//   "a?"  "a?0.3"  degrade: drop this event with 50% (bare) or the given probability. The coin
//                  flip is deterministic per cycle+onset (see rng), so the scheduler and the
//                  editor's highlighter agree and a bar replays identically.
//   "a | b | c"    random choice: pick one of the `|`-separated alternatives each cycle (uniform,
//                  deterministic per cycle). Works at top level and inside "[...]", so
//                  "<0 1 [2 | 3]>" alternates 0, 1, then a coin-flip between 2 and 3.
//   "( ... )"      expression: a value computed per cycle from `+ - * /`, parentheses, and the
//                  functions below. `*`/`/` are arithmetic *only* inside "(...)"; everywhere else
//                  they still mean fast/slow. Put a space before a "-" ("3 - 1", not "3-1"), since
//                  "-" is also an atom character (negative literals, hyphenated names). Example:
//                  "<1 2 (3 + i(4,5))>".
//   "r r(a) r(a,b)"  random float in [0,1] / [0,a] / [a,b]. Bare "r" works as a step of its own.
//   "i(a) i(a,b)"    random integer, inclusive of both ends: i(0,12) can return 0..12.
//   "p p(a) p(a,b)"  perlin-ish drift: smoothstep value-noise that changes gradually across cycles
//                  (default wavelength 4 cycles), unlike the white-noise "r". Bare "p" is p(0,1).
//   "round/floor/ceil(x)"  rounding, e.g. "(floor(r*12))". Notes are already rounded for MIDI by
//                  the scheduler; these matter for sample indices and explicit floor-vs-round.
//                  r/i/p/round/floor/ceil are reserved names - they can't be used as atoms.
//
// All randomness is DETERMINISTIC per (cycle, source-character-offset): the scheduler and the
// editor's highlighter query getStepsForCycle independently and must agree, and a bar replays
// identically each time it comes round. So "random" means random-per-cycle-but-reproducible, and
// two `r`s in one pattern decorrelate because they sit at different character offsets.
//
// NOT supported yet (will throw a clear parse error rather than silently doing the wrong
// thing): polymeter `{a b, c d}`, dot-groups `a . b c`, cycle-internal rate patterns
// (`a*[2 3]` - only per-cycle alternation `a*<2 3>` works), and pattern-valued euclid `(...)`
// arguments.
//
// The whole interpreter works in terms of one function: getStepsForCycle(ast, cycleNumber),
// which returns this cycle's flat step list as plain objects - never anything Strudel-shaped.

export function parseMini(str) {
  const tokens = tokenize(str);
  const { node, rest } = parseLayers(tokens, /* stopType */ null);
  if (rest.length > 0) {
    throw new Error(`[mini] unexpected token "${rest[0].text}" while parsing "${str}"`);
  }
  return node;
}

/**
 * Returns this cycle's steps as `[{ start, end, value, loc, cont? }]`, fractions of a cycle.
 * `value` is `null` for rests. `loc` is the `[startChar, endChar)` range of the atom this step
 * came from, within the original pattern string - the editor uses it to highlight the atom
 * that's currently playing.
 *
 * Two extensions for held events (from "_" / "@" inside "<...>", and from "/"): a step's `end`
 * may exceed 1 (the event rings into following cycles), and those following cycles report the
 * still-sounding part as a step with `cont: true` - same value/loc, but NOT a new onset. The
 * scheduler must skip `cont` steps when triggering; samplers/highlighters treat them normally.
 */
export function getStepsForCycle(ast, cycleNumber) {
  return astToSteps(ast, cycleNumber);
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

const SINGLE_CHAR_TOKENS = new Set(['[', ']', '<', '>', '(', ')', ',', '*', '/', '!', '@', '~', '|', '?', '+']);

// Function names usable in "(...)" expressions and as bare/`name(...)` steps. Reserved: these
// never parse as plain atoms. NULLARY ones (r, p) may also appear bare, with no argument list.
const FUNCTIONS = new Set(['r', 'i', 'p', 'round', 'floor', 'ceil']);
const NULLARY = new Set(['r', 'p']);
// atoms: note names, numbers, words, sample names - anything not whitespace/punctuation above
const ATOM_RE = /^[A-Za-z0-9#.\-_:]+/;

function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (SINGLE_CHAR_TOKENS.has(ch)) {
      tokens.push({ type: ch, text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '{' || ch === '}') {
      throw new Error(`[mini] "${ch}" (polymeter) is not supported yet, in "${str}"`);
    }
    const m = ATOM_RE.exec(str.slice(i));
    if (!m) {
      throw new Error(`[mini] unexpected character "${ch}" in "${str}"`);
    }
    // ":x" pressed right up against a closing bracket is a field suffix for that whole group
    // ("<18 16>:3"), not an atom of its own - the parser distributes it onto the group's atoms.
    const prev = tokens[tokens.length - 1];
    const isSuffix = m[0][0] === ':' && prev && prev.end === i && (prev.type === '>' || prev.type === ']' || prev.type === ')');
    tokens.push({ type: isSuffix ? 'suffix' : 'atom', text: m[0], start: i, end: i + m[0].length });
    i += m[0].length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser (recursive descent) - produces our own tiny AST:
//   { type: 'seq'|'stack'|'alt'|'choice', items: [{ weight, reps, node }] }
//   { type: 'atom', value: string }
//   { type: 'fast'|'slow', item, amount }
//   { type: 'euclid', item, pulses, steps, rotation }
//   { type: 'degrade', item, prob, seed }
//   { type: 'func', name, args:[node], seed, loc, suffix? }   a function call (r/i/p/round/...),
//                                          evaluated to one value per cycle; args are themselves nodes
//   { type: 'arith', op, a, b }            binary +/-/*// combining two sub-patterns (structure from
//                                          the left operand, right sampled at each left step)
// ---------------------------------------------------------------------------------------------

// "_" (elongate/tie) never becomes an element of its own: it folds into the previous item's
// weight at parse time, so "a _ _" is exactly "a@3" - one onset, three slices wide. Inside
// "<...>" the widened weight instead holds the item across extra cycles (see the alt case).
function isTie(element) {
  return element.node.type === 'atom' && element.node.value === '_';
}

function pushElement(items, element) {
  if (isTie(element)) {
    const prev = items[items.length - 1];
    if (!prev) throw new Error('[mini] "_" must follow a step to elongate');
    prev.weight += element.weight;
    return;
  }
  items.push(element);
}

// `parseEl` is the element parser: parseElement for plain mini (the default, used by "[...]",
// "<...>", and the whole pattern), or parseArithElement inside "(...)", where a sequence step may
// be an arithmetic expression like "<12 13>*4 + 5 * i(0,5)".
function parseSequence(tokens, stopTypes, parseEl = parseElement) {
  const items = [];
  while (tokens.length > 0 && !stopTypes.has(tokens[0].type) && tokens[0].type !== ',' && tokens[0].type !== '|') {
    const { element, rest } = parseEl(tokens);
    pushElement(items, element);
    tokens = rest;
  }
  return { node: { type: 'seq', items }, rest: tokens };
}

// Reads one or more sequences separated by `,` (stack: play simultaneously) and/or `|` (random
// choice: pick one per cycle), up to `stopType` (']' inside a group, or null at top level). This
// is the shared entry for "[...]" and the whole pattern, so both get stacks and choices. When the
// two mix, `,` binds tighter: "[a, b | c]" is a coin-flip between the stack "[a, b]" and "c".
function parseLayers(tokens, stopType, parseEl = parseElement) {
  const stop = stopType ? new Set([stopType]) : new Set();
  const seqs = [];
  const seps = []; // separator token before each seq after the first
  let firstBarPos = 0; // char offset of the first `|`, the choice node's decorrelating seed
  let r = parseSequence(tokens, stop, parseEl);
  seqs.push(r.node);
  tokens = r.rest;
  while (tokens[0]?.type === ',' || tokens[0]?.type === '|') {
    if (tokens[0].type === '|' && !firstBarPos) firstBarPos = tokens[0].start + 1;
    seps.push(tokens[0].type);
    tokens = tokens.slice(1);
    r = parseSequence(tokens, stop, parseEl);
    seqs.push(r.node);
    tokens = r.rest;
  }
  return { node: buildLayers(seqs, seps, firstBarPos), rest: tokens };
}

// Folds `,`/`|`-separated sequences into a node: split the run at each `|` into choice chunks,
// each chunk's `,`-joined members become a stack (or pass through if solitary), then a multi-chunk
// run wraps in a 'choice'. A single sequence returns unwrapped, so plain "a b" is unchanged.
function buildLayers(seqs, seps, seed) {
  const toStack = (layers) =>
    layers.length === 1 ? layers[0] : { type: 'stack', items: layers.map((n) => ({ weight: 1, reps: 1, node: n })) };
  const chunks = [[seqs[0]]];
  for (let i = 0; i < seps.length; i++) {
    if (seps[i] === '|') chunks.push([seqs[i + 1]]);
    else chunks[chunks.length - 1].push(seqs[i + 1]);
  }
  if (chunks.length === 1) return toStack(chunks[0]);
  return { type: 'choice', seed, items: chunks.map((c) => ({ weight: 1, reps: 1, node: toStack(c) })) };
}

function parseGroup(tokens) {
  // tokens[0] is '['
  const { node, rest } = parseLayers(tokens.slice(1), ']');
  if (rest[0]?.type !== ']') throw new Error('[mini] expected closing "]"');
  return { node, rest: rest.slice(1), end: rest[0].end };
}

// "(...)" is a grouped sub-pattern, like "[...]", but its steps may be arithmetic expressions -
// "full mini notation" plus "+ - * /". It occupies one slot in its parent. `*`/`/` glued onto a
// value stay fast/slow (parseElement handles that); spaced, they are multiply/divide.
function parseParenGroup(tokens) {
  // tokens[0] is '('
  const { node, rest } = parseLayers(tokens.slice(1), ')', parseArithElement);
  if (rest[0]?.type !== ')') throw new Error('[mini] expected ")" to close "(...)"');
  return { node, rest: rest.slice(1), end: rest[0].end };
}

function parseAngle(tokens) {
  // tokens[0] is '<'
  const open = tokens[0];
  tokens = tokens.slice(1);
  const items = [];
  while (tokens.length > 0 && tokens[0].type !== '>') {
    const { element, rest } = parseElement(tokens);
    pushElement(items, element);
    tokens = rest;
  }
  if (tokens[0]?.type !== '>') throw new Error('[mini] expected closing ">"');
  const end = tokens[0].end;
  tokens = tokens.slice(1);
  return { node: { type: 'alt', items, loc: [open.start, end] }, rest: tokens, end };
}

// Parses one element - a base value plus its glued postfix operators. `arith` is true inside
// "(...)", where a spaced "*"/"/" is an arithmetic operator (handled by parseMulDiv) rather than
// fast/slow, so here we only consume "*"/"/" as fast/slow when they are glued to the value.
function parseElement(tokens, arith = false) {
  let node;
  let rest = tokens;
  let lastEnd = -1; // source offset just past the last consumed token - for glued-vs-spaced checks

  const t = rest[0];
  if (!t) throw new Error('[mini] unexpected end of pattern');

  if (t.type === '~') {
    node = { type: 'atom', value: null, loc: [t.start, t.end] };
    rest = rest.slice(1);
    lastEnd = t.end;
  } else if (t.type === '[') {
    const g = parseGroup(rest);
    node = g.node;
    rest = g.rest;
    lastEnd = g.end;
  } else if (t.type === '<') {
    const g = parseAngle(rest);
    node = g.node;
    rest = g.rest;
    lastEnd = g.end;
  } else if (t.type === '(') {
    // A "(" in value position opens a grouped (arithmetic) sub-pattern, e.g. "(3 + i(4,5))".
    const g = parseParenGroup(rest);
    node = g.node;
    rest = g.rest;
    lastEnd = g.end;
  } else if (t.type === 'atom' && FUNCTIONS.has(t.text)) {
    const next = rest[1];
    if (next?.type === '(' && next.start === t.end) {
      // "r(a,b)", "i(0,7)", "floor(...)": a function call standing on its own as a step.
      const c = parseCall(t.text, t.start, rest.slice(1));
      node = { type: 'func', name: t.text, args: c.args, seed: t.start, loc: [t.start, c.end] };
      rest = c.rest;
      lastEnd = c.end;
    } else if (NULLARY.has(t.text)) {
      // bare "r" / "p"
      node = { type: 'func', name: t.text, args: [], seed: t.start, loc: [t.start, t.end] };
      rest = rest.slice(1);
      lastEnd = t.end;
    } else {
      throw new Error(`[mini] "${t.text}" needs arguments, e.g. ${t.text}(0,7)`);
    }
  } else if (t.type === 'atom') {
    node = { type: 'atom', value: t.text, loc: [t.start, t.end] };
    rest = rest.slice(1);
    lastEnd = t.end;
  } else {
    throw new Error(`[mini] unexpected token "${t.text}"`);
  }

  let weight = 1;
  let reps = 1;

  // postfix operators, chainable (e.g. "a*2!3")
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const op = rest[0];
    if (!op) break;

    if (op.type === '*' || op.type === '/') {
      // Glued "*"/"/" is fast/slow. Inside an arithmetic context ("(...)"), a spaced "*"/"/" is
      // instead multiply/divide - leave it for parseMulDiv by breaking out here.
      if (arith && op.start !== lastEnd) break;
      const amountTok = rest[1];
      let amount;
      if (amountTok?.type === 'atom' && !Number.isNaN(Number(amountTok.text))) {
        amount = Number(amountTok.text);
        rest = rest.slice(2);
        lastEnd = amountTok.end;
      } else if (amountTok?.type === '<') {
        // Alternation rate, e.g. "a*<2 3>" - one rate value per cycle. The general
        // pattern-valued case ("a*[2 3]", rate changing *within* a cycle) still isn't
        // supported; resolveRate() rejects it with a clear error.
        const parsed = parseAngle(rest.slice(1));
        amount = parsed.node;
        rest = parsed.rest;
        lastEnd = parsed.end;
      } else {
        throw new Error(`[mini] "${op.type}" must be followed by a number or an alternation like <2 3>`);
      }
      node = { type: op.type === '*' ? 'fast' : 'slow', item: node, amount };
      continue;
    }

    if (op.type === 'suffix') {
      node = appendFieldSuffix(node, op.text);
      rest = rest.slice(1);
      lastEnd = op.end;
      continue;
    }

    if (op.type === '!') {
      const amountTok = rest[1];
      const amount = amountTok && amountTok.type === 'atom' && !Number.isNaN(Number(amountTok.text)) ? Number(amountTok.text) : 2;
      reps *= amount;
      weight *= amount;
      const consumed = amountTok && !Number.isNaN(Number(amountTok?.text));
      rest = rest.slice(consumed ? 2 : 1);
      lastEnd = consumed ? amountTok.end : op.end;
      continue;
    }

    if (op.type === '@') {
      const amountTok = rest[1];
      if (!amountTok || Number.isNaN(Number(amountTok.text))) {
        throw new Error('[mini] "@" must be followed by a number');
      }
      weight *= Number(amountTok.text);
      rest = rest.slice(2);
      lastEnd = amountTok.end;
      continue;
    }

    if (op.type === '?') {
      // "a?" is a 50% drop; "a?0.3" a 30% drop. The probability must sit right up against the
      // "?" (no space) to count - "a? 3" is a degrade followed by a separate step "3". The "?"'s
      // own char offset seeds the coin flip so sibling "?"s in one pattern don't flip in lockstep.
      const probTok = rest[1];
      const adjacent = probTok && probTok.type === 'atom' && probTok.start === op.end && !Number.isNaN(Number(probTok.text));
      const prob = adjacent ? Number(probTok.text) : 0.5;
      node = { type: 'degrade', item: node, prob, seed: op.start };
      rest = rest.slice(adjacent ? 2 : 1);
      lastEnd = adjacent ? probTok.end : op.end;
      continue;
    }

    // Euclid method: "value.e(pulses,steps[,rot])". The item can be ANY node - a bare atom, an
    // expression, or a group - so "i(0,5).e(5,8)" and "[a b].e(3,8)" both work. Two glued spellings
    // reach here depending on where the "." lands relative to ATOM_RE:
    //  - the ".e" swallowed into the value's own atom token ("1.e(...)", "bd.e(...)") - seen below
    //    as an atom whose text ends in ".e", immediately followed by "(";
    //  - a standalone ".e" token after a ")"/"]"/">" ("i(0,5).e(...)") - seen here as an atom token.
    // The "." keeps the marker unambiguous against a sample whose name ends in the method letters
    // (euclid on "snare" is "snare.e(3,8)", never the ambiguous "snaree(3,8)"), and leaves room for
    // ".rev"/".fast"/... later. A NON-glued "(" or ".e" is a separate element, so we break.
    if (op.type === 'atom' && /^\.[a-z]+$/.test(op.text)) {
      if (op.start !== lastEnd) break; // spaced ".e" -> not a method on this node
      const paren = rest[1];
      if (!(paren?.type === '(' && paren.start === op.end)) break; // ".e" with no "(args)" after it
      if (op.text !== '.e') throw new Error(`[mini] unknown method "${op.text}(...)" - only ".e" (euclid) exists so far`);
      const { pulses, steps, rotation, rest: r2, end } = parseEuclidArgs(rest.slice(1));
      node = { type: 'euclid', item: node, pulses, steps, rotation };
      rest = r2;
      lastEnd = end;
      continue;
    }

    if (op.type === '(') {
      if (op.start !== lastEnd) break; // spaced "(" -> a separate expression element
      const m = node.type === 'atom' && typeof node.value === 'string' ? /^(.+)\.([a-z]+)$/.exec(node.value) : null;
      if (!m) {
        throw new Error(`[mini] "(...)" after "${node.value ?? '...'}" - a value method is written value.method(...), e.g. 1.e(3,8) for euclid`);
      }
      const [, base, name] = m;
      if (name !== 'e') {
        throw new Error(`[mini] unknown method ".${name}(...)" on "${base}" - only ".e" (euclid) exists so far`);
      }
      const { pulses, steps, rotation, rest: r2, end } = parseEuclidArgs(rest);
      node = { type: 'euclid', item: { ...node, value: base }, pulses, steps, rotation };
      rest = r2;
      lastEnd = end;
      continue;
    }

    break;
  }

  return { element: { weight, reps, node }, rest, end: lastEnd };
}

// Parses a euclid argument list "(pulses,steps[,rotation])" of plain numbers. tokens[0] is "(".
function parseEuclidArgs(tokens) {
  let rest = tokens.slice(1);
  const args = [];
  while (rest[0]?.type !== ')') {
    if (rest[0]?.type === ',') {
      rest = rest.slice(1);
      continue;
    }
    if (rest[0]?.type !== 'atom' || Number.isNaN(Number(rest[0].text))) throw new Error('[mini] expected number inside euclid "(...)"');
    args.push(Number(rest[0].text));
    rest = rest.slice(1);
  }
  if (rest[0]?.type !== ')') throw new Error('[mini] expected ")" to close euclid "(...)"');
  const end = rest[0].end;
  rest = rest.slice(1); // consume ')'
  const [pulses, steps, rotation = 0] = args;
  if (pulses === undefined || steps === undefined) {
    throw new Error('[mini] euclid "(...)" needs at least (pulses,steps)');
  }
  return { pulses, steps, rotation, rest, end };
}

// Distributes a group field suffix onto every atom inside the node, so "<18 16>:3" parses as
// "<18:3 16:3>". Rests pass through; ties ("_") never survive parsing as atoms, so every atom
// here is a real value.
function appendFieldSuffix(node, suffix) {
  if (node.type === 'atom') {
    return node.value == null ? node : { ...node, value: node.value + suffix };
  }
  if (node.type === 'func') {
    return { ...node, suffix: (node.suffix ?? '') + suffix };
  }
  if (node.type === 'arith') {
    return { ...node, a: appendFieldSuffix(node.a, suffix), b: appendFieldSuffix(node.b, suffix) };
  }
  if (node.items) {
    return { ...node, items: node.items.map((it) => ({ ...it, node: appendFieldSuffix(it.node, suffix) })) };
  }
  if (node.item) {
    return { ...node, item: appendFieldSuffix(node.item, suffix) };
  }
  return node;
}

// ---------------------------------------------------------------------------------------------
// Arithmetic inside "(...)": full mini-notation whose steps can be combined with "+ - * /".
// Precedence is standard (*// over +/-), and juxtaposition (a plain space) still forms a sequence,
// binding looser than the operators - so "(1 2 + 10)" is the sequence [1, (2+10)] = [1, 12], while
// "([1 2] + 10)" is one arithmetic step [11, 12]. Operators combine *patterns*: the result takes
// the LEFT operand's step structure and samples the right operand at each left step (see the
// 'arith' case in astToSteps). "*"/"/" are arithmetic only when spaced; glued to a value they are
// fast/slow, which parseElement(arith=true) has already consumed by the time we get here.
// ---------------------------------------------------------------------------------------------

// One step of a "(...)" sequence: a mini term, or an arithmetic expression over terms. A plain term
// keeps any @/! weight it parsed; an arithmetic expression takes a normal equal-weight slot.
function parseArithElement(tokens) {
  const first = parseElement(tokens, true);
  if (!isArithOpNext(first.rest)) return first;
  const left = { node: first.element.node, start: tokens[0].start, end: first.end };
  const built = foldAdd(left, first.rest);
  return { element: { weight: 1, reps: 1, node: built.node }, rest: built.rest };
}

// Is the next token an arithmetic operator? Inside "(...)" any "*"/"/" still here is spaced (glued
// ones were eaten as fast/slow); "+" is always a token; "-" is a spaced bare token or a glued
// negative-number atom in operator position ("a -1" -> subtract 1).
function isArithOpNext(rest) {
  const t = rest[0];
  if (!t) return false;
  if (t.type === '+' || t.type === '*' || t.type === '/') return true;
  return t.type === 'atom' && (t.text === '-' || (/^-/.test(t.text) && !Number.isNaN(Number(t.text))));
}

// A single mini term as a bare node with its source span (weight/reps dropped - arithmetic
// operands are values). `start`/`end` feed the arith node's `loc` so the whole expression is what
// lights up during playback highlighting, not just its left operand.
function parseTermNode(tokens) {
  const { element, rest, end } = parseElement(tokens, true);
  return { node: element.node, rest, start: tokens[0].start, end };
}

// multiplicative := term (("*" | "/") term)*   (operators here are spaced = arithmetic)
function foldMul(left, tokens) {
  let { node, start, end } = left;
  let rest = tokens;
  while (rest[0]?.type === '*' || rest[0]?.type === '/') {
    const op = rest[0].type;
    const r = parseTermNode(rest.slice(1));
    node = { type: 'arith', op, a: node, b: r.node, loc: [start, r.end] };
    end = r.end;
    rest = r.rest;
  }
  return { node, rest, start, end };
}
function parseMulNode(tokens) {
  const t = parseTermNode(tokens);
  return foldMul({ node: t.node, start: t.start, end: t.end }, t.rest);
}

// additive := mul (("+" | "-") mul)*, seeded with an already-parsed left term (with its span).
function foldAdd(left, tokens) {
  let { node, rest, start, end } = foldMul(left, tokens);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const t = rest[0];
    if (t?.type === '+') {
      const r = parseMulNode(rest.slice(1));
      node = { type: 'arith', op: '+', a: node, b: r.node, loc: [start, r.end] };
      end = r.end;
      rest = r.rest;
    } else if (t?.type === 'atom' && t.text === '-') {
      const r = parseMulNode(rest.slice(1));
      node = { type: 'arith', op: '-', a: node, b: r.node, loc: [start, r.end] };
      end = r.end;
      rest = r.rest;
    } else if (t?.type === 'atom' && /^-/.test(t.text) && !Number.isNaN(Number(t.text))) {
      // "a -1": the "-1" glued into one atom, in operator position -> subtract its magnitude.
      const lit = { type: 'atom', value: String(-Number(t.text)), loc: [t.start, t.end] };
      node = { type: 'arith', op: '-', a: node, b: lit, loc: [start, t.end] };
      end = t.end;
      rest = rest.slice(1);
    } else {
      break;
    }
  }
  return { node, rest, start, end };
}

// Parses a full arithmetic expression from the start (used for function arguments).
function parseArithExpr(tokens) {
  const first = parseTermNode(tokens);
  return foldAdd({ node: first.node, start: first.start, end: first.end }, first.rest);
}

// Parses "(arg, arg, ...)". tokens[0] must be "(". Args are themselves arithmetic expressions.
function parseCall(name, seed, tokens) {
  let rest = tokens.slice(1);
  const args = [];
  if (rest[0]?.type !== ')') {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = parseArithExpr(rest);
      args.push(r.node);
      rest = r.rest;
      if (rest[0]?.type === ',') {
        rest = rest.slice(1);
        continue;
      }
      break;
    }
  }
  const close = rest[0];
  if (close?.type !== ')') throw new Error(`[mini] expected ")" after ${name}(...)`);
  return { args, rest: rest.slice(1), end: close.end };
}

// Reduces a node to a single number for the given cycle - the first non-rest step's value. Used
// for function arguments (i(a,b) etc.), where a scalar is expected even if the arg is a pattern.
function scalarOf(node, cycle, salt) {
  const steps = astToSteps(node, cycle, salt).filter((s) => s.value != null);
  return Number(steps[0]?.value);
}

// A [lo, hi] range from evaluated args: [] -> [0,1], [a] -> [0,a], [a,b] -> [a,b].
function rangeOf(vals) {
  if (vals.length === 0) return [0, 1];
  if (vals.length === 1) return [0, vals[0]];
  return [vals[0], vals[1]];
}

// Evaluates a function node to a number. `salt` decorrelates repeated draws (e.g. per euclid hit).
function evalFunc(node, cycle, salt) {
  const args = node.args.map((a) => scalarOf(a, cycle, salt));
  const seed = node.seed + salt;
  switch (node.name) {
    case 'r': {
      const [lo, hi] = rangeOf(args);
      return lo + (hi - lo) * rng(cycle, seed);
    }
    case 'i': {
      if (node.args.length === 0) throw new Error('[mini] "i" needs at least one argument, e.g. i(0,7)');
      const [lo, hi] = rangeOf(args);
      // inclusive of both ends: (hi - lo + 1) buckets, clamped so a rng of exactly 1 can't overflow.
      return Math.min(hi, lo + Math.floor(rng(cycle, seed) * (hi - lo + 1)));
    }
    case 'p': {
      const [lo, hi] = rangeOf(args);
      return lo + (hi - lo) * perlin1(cycle, seed);
    }
    case 'round':
    case 'floor':
    case 'ceil': {
      if (node.args.length !== 1) throw new Error(`[mini] "${node.name}" takes exactly one argument, e.g. ${node.name}(x)`);
      const x = args[0];
      return node.name === 'round' ? Math.round(x) : node.name === 'floor' ? Math.floor(x) : Math.ceil(x);
    }
    default:
      throw new Error(`[mini] unknown function "${node.name}"`);
  }
}

// Numeric value of a step list at a phase in [0,1) - the last step covering it (matches
// signal.mjs sampleViaSteps). Used to sample an arithmetic operator's right operand.
function sampleStepsAt(steps, phase) {
  let found;
  for (const s of steps) {
    if (s.value != null && phase >= s.start && phase < s.end) found = s;
  }
  return found ? Number(found.value) : NaN;
}

// Smoothstep-interpolated 1D value noise in [0,1], the "poor man's perlin" already used by the
// LFO 'rand' shape. Sampled at cycle / WAVELENGTH so the value drifts gradually (a new random
// target every WAVELENGTH cycles) instead of jumping like `r`. `seed` shifts the noise field so
// separate p()s decorrelate.
const PERLIN_WAVELENGTH = 4;
function perlin1(cycle, seed) {
  const x = cycle / PERLIN_WAVELENGTH;
  const i = Math.floor(x);
  const u = x - i;
  const su = u * u * (3 - 2 * u);
  return rng(i, seed) * (1 - su) + rng(i + 1, seed) * su;
}

// ---------------------------------------------------------------------------------------------
// AST -> flat per-cycle steps
// ---------------------------------------------------------------------------------------------

// `salt` decorrelates repeated random draws of the same node - it is 0 everywhere except under a
// euclid, which passes a distinct salt per hit so "i(0,5).e(5,8)" re-rolls each hit. It only
// affects `func` seeds; structural cycle math (alternation, fast/slow) is untouched, so an
// alternation stays one-value-per-cycle even inside a euclid.
function astToSteps(node, cycle, salt = 0) {
  switch (node.type) {
    case 'atom':
      return node.value == null ? [] : [{ start: 0, end: 1, value: node.value, loc: node.loc }];

    case 'func': {
      // One computed value spanning the whole element, like an atom but evaluated per cycle.
      const value = String(evalFunc(node, cycle, salt)) + (node.suffix ?? '');
      return [{ start: 0, end: 1, value, loc: node.loc }];
    }

    case 'arith': {
      // Combine two sub-patterns numerically: structure from the LEFT operand, the right sampled at
      // each left step's onset. Rests and non-numeric values pass the left value through unchanged.
      // Every step is re-`loc`d to the whole expression's source span, so playback highlighting
      // lights the entire "(... + ...)" (whose computed value is what actually sounds), not just the
      // left operand's token.
      const A = astToSteps(node.a, cycle, salt);
      const B = astToSteps(node.b, cycle, salt);
      const out = [];
      for (const s of A) {
        if (s.value == null) {
          out.push(s);
          continue;
        }
        const av = Number(s.value);
        const bv = sampleStepsAt(B, s.start);
        const loc = node.loc ?? s.loc;
        if (Number.isNaN(av) || Number.isNaN(bv)) {
          out.push({ ...s, loc });
          continue;
        }
        out.push({ ...s, value: String(applyArith(node.op, av, bv)), loc });
      }
      return out;
    }

    case 'seq':
      return seqToSteps(node.items, cycle, salt);

    case 'stack':
      return node.items.flatMap((item) => astToSteps(item.node, cycle, salt));

    case 'alt': {
      if (node.items.length === 0) return [];
      // "!" replicates into separate picks (retriggers each cycle); "@"/"_" weights make one
      // pick span several consecutive cycles - stretched over its span, with one onset and
      // `cont` steps for the cycles after it (so "<73 _>" holds 73 for 2 cycles, no retrigger).
      const picks = node.items.flatMap((item) => {
        const reps = item.reps || 1;
        const w = Math.max(1, Math.round((item.weight ?? 1) / reps));
        return Array.from({ length: reps }, () => ({ w, node: item.node }));
      });
      const total = picks.reduce((sum, p) => sum + p.w, 0);
      const pos = ((cycle % total) + total) % total;
      let acc = 0;
      let idx = 0;
      while (pos >= acc + picks[idx].w) {
        acc += picks[idx].w;
        idx++;
      }
      const pick = picks[idx];
      const offset = pos - acc; // which cycle of the pick's span we're in
      // The chosen item sees its own cycle count ("how many times have I been picked"), not the
      // outer cycle - Strudel's slowcat semantics. This is what makes a nested alternation like
      // "<0 2 3 <5 7>>" step 5,7,5,7 on successive picks: the inner alt is picked at outer
      // cycles 3,7,11,... which all have the same parity, so passing `cycle` through unchanged
      // would pin it to one value forever.
      const innerCycle = Math.floor(cycle / total);
      const out = [];
      for (const s of astToSteps(pick.node, innerCycle, salt)) {
        const start = s.start * pick.w - offset;
        const end = s.end * pick.w - offset;
        if (end <= 0 || start >= 1) continue;
        if (start >= 0) out.push({ ...s, start, end });
        else out.push({ ...s, start: 0, end, cont: true });
      }
      return out;
    }

    case 'fast': {
      const n = Math.max(1, Math.round(resolveRate(node.amount, cycle)));
      const out = [];
      for (let i = 0; i < n; i++) {
        const innerCycle = cycle * n + i;
        for (const s of astToSteps(node.item, innerCycle, salt)) {
          out.push({ ...s, start: (i + s.start) / n, end: (i + s.end) / n });
        }
      }
      return out;
    }

    case 'slow': {
      const n = Math.max(1, Math.round(resolveRate(node.amount, cycle)));
      const innerCycle = Math.floor(cycle / n);
      const phase = ((cycle % n) + n) % n;
      const innerSteps = astToSteps(node.item, innerCycle, salt);
      return clipAndRescale(innerSteps, phase / n, (phase + 1) / n);
    }

    case 'euclid': {
      const hits = rotateArray(bjorklund(node.pulses, node.steps), node.rotation ?? 0);
      const len = hits.length;
      const onsets = [];
      for (let i = 0; i < len; i++) if (hits[i]) onsets.push(i);
      const out = [];
      for (let k = 0; k < onsets.length; k++) {
        const i = onsets[k];
        // Legato: each hit sustains until the NEXT onset (the last to the cycle end) - so "1.e(3,8)"
        // rings as dotted-8th, dotted-8th, 8th rather than three clipped 1/8 gates. The item is
        // rendered across that whole span, with a per-hit `salt` so a random value re-rolls each hit
        // (an alternation stays per-cycle - salt only touches func seeds).
        const slotStart = i / len;
        const slotEnd = (onsets[k + 1] ?? len) / len;
        const span = slotEnd - slotStart;
        const childSalt = salt * 131 + i + 1;
        for (const s of astToSteps(node.item, cycle, childSalt)) {
          out.push({ ...s, start: slotStart + s.start * span, end: slotStart + s.end * span });
        }
      }
      return out;
    }

    case 'degrade':
      // Drop each onset with probability `prob`, deterministically per cycle+onset (see rng).
      // A dropped step becomes a rest (value null) so surrounding steps keep their timing.
      return astToSteps(node.item, cycle, salt).map((s) =>
        s.value != null && rng(cycle + s.start, node.seed + 1) < node.prob ? { ...s, value: null } : s,
      );

    case 'choice': {
      // One alternative per cycle, chosen by the same deterministic hash. The pick sees the outer
      // cycle unchanged (so a "<...>" inside a chosen chunk still steps by absolute cycle).
      if (node.items.length === 0) return [];
      const idx = Math.min(node.items.length - 1, Math.floor(rng(cycle, node.seed) * node.items.length));
      return astToSteps(node.items[idx].node, cycle, salt);
    }

    default:
      throw new Error(`[mini] unknown node type "${node.type}"`);
  }
}

function applyArith(op, a, b) {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    default:
      throw new Error(`[mini] unknown operator "${op}"`);
  }
}

// A `*`/`/` rate is either a plain number or a pattern that must resolve to exactly one
// number for the given cycle (alternations like `<2 3>` do; anything cycle-internal like
// `[2 3]` doesn't and is rejected - honest per-cycle semantics rather than silently taking
// the first value).
function resolveRate(amount, cycle) {
  if (typeof amount === 'number') return amount;
  const steps = astToSteps(amount, cycle, 0).filter((s) => s.value != null);
  const value = Number(steps[0]?.value);
  if (steps.length !== 1 || Number.isNaN(value)) {
    throw new Error('[mini] a pattern-valued rate must produce exactly one number per cycle (e.g. "a*<2 3>")');
  }
  return value;
}

function seqToSteps(items, cycle, salt = 0) {
  // Expand `!n` replicate into n separate equal-width elements (see the "0!3 1" example in
  // ARCHITECTURE.md-adjacent design notes: weight=3,reps=3 means 3 separate 1-unit-wide
  // onsets, NOT one 3-unit-wide onset - that's what plain `@3` weighting means instead).
  const expanded = items.flatMap((item) => {
    const repCount = item.reps || 1;
    const perRepWeight = (item.weight ?? 1) / repCount;
    return Array.from({ length: repCount }, () => ({ weight: perRepWeight, node: item.node }));
  });

  const totalWeight = expanded.reduce((sum, el) => sum + el.weight, 0) || 1;
  let cursor = 0;
  const out = [];
  for (const el of expanded) {
    const span = el.weight / totalWeight;
    for (const s of astToSteps(el.node, cycle, salt)) {
      out.push({ ...s, start: cursor + s.start * span, end: cursor + s.end * span });
    }
    cursor += span;
  }
  return out;
}

function clipAndRescale(steps, a, b) {
  const out = [];
  for (const s of steps) {
    if (s.end <= a || s.start >= b) continue;
    const start = Math.max(s.start, a);
    // An event's tail past `b` is kept (its rescaled end lands past 1): it genuinely rings
    // into the next cycle, whose own window then reports it as a `cont` step (onset before
    // the window). This is what makes "a/2" one 2-cycle-long note instead of two onsets.
    out.push({ ...s, start: (start - a) / (b - a), end: (s.end - a) / (b - a), cont: s.cont || start > s.start || undefined });
  }
  return out;
}

/**
 * Equally-spaced Euclidean rhythm via the floor-division method (matches the canonical
 * Bjorklund result for common cases like (3,8)/(5,8)/(4,9), but is a simpler approximation
 * that may place hits at a different rotation than Tidal's exact recursive algorithm for some
 * less common pulse/step combinations - flagged here rather than glossed over).
 */
function bjorklund(pulses, steps) {
  const hits = [];
  for (let i = 0; i < steps; i++) {
    const cur = Math.floor((i * pulses) / steps);
    const prev = Math.floor(((i - 1) * pulses) / steps);
    hits.push(cur !== prev);
  }
  return hits;
}

function rotateArray(arr, n) {
  const len = arr.length;
  const r = ((n % len) + len) % len;
  return arr.slice(r).concat(arr.slice(0, r));
}

// Deterministic 0..1 hash of two numbers, driving the `?` (degrade) and `|` (choice) operators.
// Same formula as pattern-core's signal.mjs rng2, on purpose: this file also runs in the browser
// for playback highlighting, so client and server must flip every coin identically. Determinism
// per (cycle, seed) is the whole point - stepsForCycle is queried repeatedly and a bar must play
// the same each time it comes round.
function rng(a, b) {
  const s = Math.sin(a * 12.9898 + b * 78.233 + 43.123) * 43758.5453;
  return s - Math.floor(s);
}
