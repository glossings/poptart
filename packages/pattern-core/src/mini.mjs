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
//   "bd(3,8)"      euclidean rhythm: 3 pulses over 8 steps (optionally "(3,8,2)" with rotation)
//   "<a b>:x"      field suffix on a group: distributes onto every atom inside, so
//                  "<18 16>:3" is exactly "<18:3 16:3>" (pairs with .as("n:clip") etc.)
//   "a?"  "a?0.3"  degrade: drop this event with 50% (bare) or the given probability. The coin
//                  flip is deterministic per cycle+onset (see rng), so the scheduler and the
//                  editor's highlighter agree and a bar replays identically.
//   "a | b | c"    random choice: pick one of the `|`-separated alternatives each cycle (uniform,
//                  deterministic per cycle). Works at top level and inside "[...]", so
//                  "<0 1 [2 | 3]>" alternates 0, 1, then a coin-flip between 2 and 3.
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

const SINGLE_CHAR_TOKENS = new Set(['[', ']', '<', '>', '(', ')', ',', '*', '/', '!', '@', '~', '|', '?']);
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

function parseSequence(tokens, stopTypes) {
  const items = [];
  while (tokens.length > 0 && !stopTypes.has(tokens[0].type) && tokens[0].type !== ',' && tokens[0].type !== '|') {
    const { element, rest } = parseElement(tokens);
    pushElement(items, element);
    tokens = rest;
  }
  return { node: { type: 'seq', items }, rest: tokens };
}

// Reads one or more sequences separated by `,` (stack: play simultaneously) and/or `|` (random
// choice: pick one per cycle), up to `stopType` (']' inside a group, or null at top level). This
// is the shared entry for "[...]" and the whole pattern, so both get stacks and choices. When the
// two mix, `,` binds tighter: "[a, b | c]" is a coin-flip between the stack "[a, b]" and "c".
function parseLayers(tokens, stopType) {
  const stop = stopType ? new Set([stopType]) : new Set();
  const seqs = [];
  const seps = []; // separator token before each seq after the first
  let firstBarPos = 0; // char offset of the first `|`, the choice node's decorrelating seed
  let r = parseSequence(tokens, stop);
  seqs.push(r.node);
  tokens = r.rest;
  while (tokens[0]?.type === ',' || tokens[0]?.type === '|') {
    if (tokens[0].type === '|' && !firstBarPos) firstBarPos = tokens[0].start + 1;
    seps.push(tokens[0].type);
    tokens = tokens.slice(1);
    r = parseSequence(tokens, stop);
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
  return { node, rest: rest.slice(1) };
}

function parseAngle(tokens) {
  // tokens[0] is '<'
  tokens = tokens.slice(1);
  const items = [];
  while (tokens.length > 0 && tokens[0].type !== '>') {
    const { element, rest } = parseElement(tokens);
    pushElement(items, element);
    tokens = rest;
  }
  if (tokens[0]?.type !== '>') throw new Error('[mini] expected closing ">"');
  tokens = tokens.slice(1);
  return { node: { type: 'alt', items }, rest: tokens };
}

function parseElement(tokens) {
  let node;
  let rest = tokens;

  const t = rest[0];
  if (!t) throw new Error('[mini] unexpected end of pattern');

  if (t.type === '~') {
    node = { type: 'atom', value: null, loc: [t.start, t.end] };
    rest = rest.slice(1);
  } else if (t.type === '[') {
    ({ node, rest } = parseGroup(rest));
  } else if (t.type === '<') {
    ({ node, rest } = parseAngle(rest));
  } else if (t.type === 'atom') {
    node = { type: 'atom', value: t.text, loc: [t.start, t.end] };
    rest = rest.slice(1);
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
      const amountTok = rest[1];
      let amount;
      if (amountTok?.type === 'atom' && !Number.isNaN(Number(amountTok.text))) {
        amount = Number(amountTok.text);
        rest = rest.slice(2);
      } else if (amountTok?.type === '<') {
        // Alternation rate, e.g. "a*<2 3>" - one rate value per cycle. The general
        // pattern-valued case ("a*[2 3]", rate changing *within* a cycle) still isn't
        // supported; resolveRate() rejects it with a clear error.
        const parsed = parseAngle(rest.slice(1));
        amount = parsed.node;
        rest = parsed.rest;
      } else {
        throw new Error(`[mini] "${op.type}" must be followed by a number or an alternation like <2 3>`);
      }
      node = { type: op.type === '*' ? 'fast' : 'slow', item: node, amount };
      continue;
    }

    if (op.type === 'suffix') {
      node = appendFieldSuffix(node, op.text);
      rest = rest.slice(1);
      continue;
    }

    if (op.type === '!') {
      const amountTok = rest[1];
      const amount = amountTok && amountTok.type === 'atom' && !Number.isNaN(Number(amountTok.text)) ? Number(amountTok.text) : 2;
      reps *= amount;
      weight *= amount;
      rest = rest.slice(amountTok && !Number.isNaN(Number(amountTok?.text)) ? 2 : 1);
      continue;
    }

    if (op.type === '@') {
      const amountTok = rest[1];
      if (!amountTok || Number.isNaN(Number(amountTok.text))) {
        throw new Error('[mini] "@" must be followed by a number');
      }
      weight *= Number(amountTok.text);
      rest = rest.slice(2);
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
      continue;
    }

    if (op.type === '(') {
      const args = [];
      rest = rest.slice(1);
      while (rest[0]?.type !== ')') {
        if (rest[0]?.type === ',') {
          rest = rest.slice(1);
          continue;
        }
        if (rest[0]?.type !== 'atom') throw new Error('[mini] expected number inside "(...)"');
        args.push(Number(rest[0].text));
        rest = rest.slice(1);
      }
      rest = rest.slice(1); // consume ')'
      const [pulses, steps, rotation = 0] = args;
      if (pulses === undefined || steps === undefined) {
        throw new Error('[mini] euclid "(...)" needs at least (pulses,steps)');
      }
      node = { type: 'euclid', item: node, pulses, steps, rotation };
      continue;
    }

    break;
  }

  return { element: { weight, reps, node }, rest };
}

// Distributes a group field suffix onto every atom inside the node, so "<18 16>:3" parses as
// "<18:3 16:3>". Rests pass through; ties ("_") never survive parsing as atoms, so every atom
// here is a real value.
function appendFieldSuffix(node, suffix) {
  if (node.type === 'atom') {
    return node.value == null ? node : { ...node, value: node.value + suffix };
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
// AST -> flat per-cycle steps
// ---------------------------------------------------------------------------------------------

function astToSteps(node, cycle) {
  switch (node.type) {
    case 'atom':
      return node.value == null ? [] : [{ start: 0, end: 1, value: node.value, loc: node.loc }];

    case 'seq':
      return seqToSteps(node.items, cycle);

    case 'stack':
      return node.items.flatMap((item) => astToSteps(item.node, cycle));

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
      for (const s of astToSteps(pick.node, innerCycle)) {
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
        for (const s of astToSteps(node.item, innerCycle)) {
          out.push({ ...s, start: (i + s.start) / n, end: (i + s.end) / n });
        }
      }
      return out;
    }

    case 'slow': {
      const n = Math.max(1, Math.round(resolveRate(node.amount, cycle)));
      const innerCycle = Math.floor(cycle / n);
      const phase = ((cycle % n) + n) % n;
      const innerSteps = astToSteps(node.item, innerCycle);
      return clipAndRescale(innerSteps, phase / n, (phase + 1) / n);
    }

    case 'euclid': {
      if (node.item.type !== 'atom' || node.item.value == null) {
        throw new Error('[mini] euclid "(...)" is only supported on a plain atom for now');
      }
      const hits = rotateArray(bjorklund(node.pulses, node.steps), node.rotation ?? 0);
      const out = [];
      for (let i = 0; i < hits.length; i++) {
        if (hits[i]) out.push({ start: i / hits.length, end: (i + 1) / hits.length, value: node.item.value, loc: node.item.loc });
      }
      return out;
    }

    case 'degrade':
      // Drop each onset with probability `prob`, deterministically per cycle+onset (see rng).
      // A dropped step becomes a rest (value null) so surrounding steps keep their timing.
      return astToSteps(node.item, cycle).map((s) =>
        s.value != null && rng(cycle + s.start, node.seed + 1) < node.prob ? { ...s, value: null } : s,
      );

    case 'choice': {
      // One alternative per cycle, chosen by the same deterministic hash. The pick sees the outer
      // cycle unchanged (so a "<...>" inside a chosen chunk still steps by absolute cycle).
      if (node.items.length === 0) return [];
      const idx = Math.min(node.items.length - 1, Math.floor(rng(cycle, node.seed) * node.items.length));
      return astToSteps(node.items[idx].node, cycle);
    }

    default:
      throw new Error(`[mini] unknown node type "${node.type}"`);
  }
}

// A `*`/`/` rate is either a plain number or a pattern that must resolve to exactly one
// number for the given cycle (alternations like `<2 3>` do; anything cycle-internal like
// `[2 3]` doesn't and is rejected - honest per-cycle semantics rather than silently taking
// the first value).
function resolveRate(amount, cycle) {
  if (typeof amount === 'number') return amount;
  const steps = astToSteps(amount, cycle).filter((s) => s.value != null);
  const value = Number(steps[0]?.value);
  if (steps.length !== 1 || Number.isNaN(value)) {
    throw new Error('[mini] a pattern-valued rate must produce exactly one number per cycle (e.g. "a*<2 3>")');
  }
  return value;
}

function seqToSteps(items, cycle) {
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
    for (const s of astToSteps(el.node, cycle)) {
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
