// Where in the buffer an evaluation went wrong.
//
// A block is not evaluated as it was typed. Its strings are wrapped in mini("…", OFFSET) and some
// calls renamed (locations.mjs), its top-level const/let become var, and the result runs through
// eval inside a Function. So the line and column the JavaScript engine reports are positions in
// text nobody wrote - and for a syntax error most engines report none at all. This module turns
// both back into a span of the buffer, and the error into a short message that names only things
// the player typed.
//
// How each kind is found:
//   - A syntax error: the evaluated text is parsed again with a real parser (handed in by the
//     host - acorn, in both builds), which says where it stopped. Its message is then reworded,
//     and an unbalanced bracket is reported at the bracket rather than wherever the parser gave up.
//   - A runtime error: every evaluated block carries a `//# sourceURL` naming its entry in a small
//     registry, so a stack frame inside it reads `poptart-block-ID:LINE:COL`. The entry holds the
//     edits made to the block, which map that position back to the typed one. The same lookup
//     serves an error thrown later - a callback written in the block, run while a pattern is
//     queried - and a warning given while a block's builders run.
//   - A bad mini-notation string: parseMini knows the string's buffer offset and the token it
//     stopped on, and leaves the span on the error (see mini.mjs).
//
// Everything here is plain data and string work, shared by the desktop server and the browser
// build so the two report the same thing in the same words.

import { injectLocationsMapped } from './locations.mjs';
import { maskCode } from './widget-calls.mjs';

const SOURCE_PREFIX = 'poptart-block-';
const FRAME_RE = /poptart-block-(\d+):(\d+):(\d+)/g;

/** Blocks remembered per deck and label: the evaluation playing now and a couple before it. */
const KEEP_PER_BLOCK = 3;
/** ...and in all, so a buffer of hundreds of tiny blocks does not grow this without end. */
const KEEP_TOTAL = 1024;

const sources = new Map(); // id -> entry, in registration order
let serial = 0;

/**
 * The text to evaluate for one block, registered so its errors can be traced back.
 *
 * `locBase` is the block's offset in its buffer (a prebake block has none, and is neither tagged
 * nor registered). Returns `{ body, id }`: `body` is what to hand to eval.
 */
export function blockSource(code, locBase, { miniOff = [], label = null, deck = 'a', doc = null } = {}) {
  const located = typeof locBase === 'number' ? injectLocationsMapped(code, locBase, { miniOff }) : { code, edits: [] };
  const vars = varRewrite(located.code);
  if (typeof locBase !== 'number') return { body: vars.code, id: null };
  const id = ++serial;
  const entry = {
    id,
    code,
    base: locBase,
    label,
    deck,
    doc,
    text: vars.code,
    maps: [compactEdits(located.edits, code), compactEdits(vars.edits, located.code)],
  };
  remember(entry);
  // On its own line, so a block ending in a `// comment` cannot swallow it.
  return { body: `${vars.code}\n//# sourceURL=${SOURCE_PREFIX}${id}`, id };
}

function remember(entry) {
  const same = [...sources.values()].filter((e) => e.deck === entry.deck && e.label === entry.label);
  for (const old of same.slice(0, Math.max(0, same.length - KEEP_PER_BLOCK + 1))) sources.delete(old.id);
  sources.set(entry.id, entry);
  while (sources.size > KEEP_TOTAL) sources.delete(sources.keys().next().value);
}

/** Forgets every registered block - for tests. */
export function resetBlockSources() {
  sources.clear();
}

/**
 * Top-level `const`/`let` rewritten to `var`, because a declaration inside a direct eval is scoped
 * to that eval and would be invisible to the block below. Returns the edits too.
 */
export function varRewrite(text) {
  const edits = [];
  const code = text.replace(/^([ \t]*)(const|let)(\s+)/gm, (m, indent, kw, space, at) => {
    edits.push([at + indent.length, at + indent.length + kw.length, 'var']);
    return `${indent}var${space}`;
  });
  return { code, edits };
}

// Each edit as [from, to, replacementLength, where the original text sits inside the
// replacement or -1] - all a position needs to be mapped back, without keeping the text.
function compactEdits(edits, input) {
  return edits.map(([from, to, text]) => [from, to, text.length, to > from ? text.indexOf(input.slice(from, to)) : -1]);
}

/** A position in edited text, back in the text before `edits` (compacted) were made. */
function unedit(edits, pos) {
  let delta = 0;
  for (const [from, to, len, inner] of edits) {
    const outStart = from + delta;
    if (pos < outStart) break;
    if (pos < outStart + len) {
      const k = pos - outStart;
      if (inner >= 0 && k >= inner && k < inner + (to - from)) return from + (k - inner);
      return from;
    }
    delta += len - (to - from);
  }
  return pos - delta;
}

/** A position in a registered block's evaluated text, as an offset into the block as typed. */
export function typedOffset(maps, pos) {
  let p = pos;
  for (let i = maps.length - 1; i >= 0; i--) p = unedit(maps[i], p);
  return p;
}

/** 1-based line and column of offset `at` in `text`. */
export function lineCol(text, at) {
  const before = String(text).slice(0, Math.max(0, at));
  const line = before.split('\n').length;
  return { line, col: at - (before.lastIndexOf('\n') + 1) + 1 };
}

function offsetOf(text, line, col) {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return Math.min(text.length, at + col - 1);
}

/**
 * The innermost stack frame that sits inside a registered block, as a buffer offset:
 * `{ deck, label, at, entry }`, or null when no frame is one of ours.
 */
export function locateStack(stack) {
  if (typeof stack !== 'string' || !stack.includes(SOURCE_PREFIX)) return null;
  for (const m of stack.matchAll(FRAME_RE)) {
    const entry = sources.get(Number(m[1]));
    if (!entry) continue;
    const pos = offsetOf(entry.text, Number(m[2]), Number(m[3]));
    const inBlock = Math.min(entry.code.length, typedOffset(entry.maps, pos));
    return { deck: entry.deck, label: entry.label, at: entry.base + inBlock, entry };
  }
  return null;
}

/** Runs `fn` with deep stacks, so the frame inside a block is not cut off below the library's own. */
export function withDeepStacks(fn) {
  const was = Error.stackTraceLimit;
  if (typeof was === 'number' && was < 60) Error.stackTraceLimit = 60;
  try {
    return fn();
  } finally {
    Error.stackTraceLimit = was;
  }
}

/** The stack right here, deep enough to reach the block that called in. */
function stackHere() {
  return withDeepStacks(() => new Error().stack);
}

// --------------------------------------------------------------------------------------------
// Syntax errors
// --------------------------------------------------------------------------------------------

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', locations: false };
const CLOSER = { '(': ')', '[': ']', '{': '}' };
const KEYWORDS = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'new', 'true', 'false', 'null', 'undefined', 'typeof'];

/**
 * Where the registered block `id` fails to parse, with a message: `{ from, to, text, suggest? }`
 * as offsets into the block as typed, or null when the parser finds nothing wrong (the engine and
 * the parser disagreeing - then there is no position worth showing).
 */
export function syntaxProblem(id, parse) {
  const entry = sources.get(id);
  if (!entry || typeof parse !== 'function') return null;
  let perr = null;
  try {
    parse(entry.text, PARSE_OPTIONS);
  } catch (e) {
    perr = e;
  }
  if (!perr || typeof perr.pos !== 'number') return null;
  const code = entry.code;
  const at = Math.min(code.length, typedOffset(entry.maps, perr.pos));
  const raw = String(perr.message ?? '').replace(/\s*\(\d+:\d+\)\s*$/, '');
  const span = (from, text, extra = {}) => ({ from, to: from + tokenAt(code, from).length || from + 1, text, ...extra });

  if (/^Unterminated string/.test(raw)) return span(at, 'unclosed string');
  if (/^Unterminated template/.test(raw)) return span(at, 'unclosed template string');
  if (/^Unterminated comment/.test(raw)) return span(at, 'unclosed comment');
  if (/^Unterminated regular expression/.test(raw)) return span(at, 'unclosed regular expression');

  if (/^Unexpected token/.test(raw)) {
    const bracket = bracketProblem(code);
    if (bracket) return span(bracket.at, bracket.text);
    const typo = keywordTypo(code, at);
    if (typo) return typo;
    if (!code.slice(at).trim()) return span(lastTokenStart(code), 'unexpected end of code');
    return span(at, `unexpected "${tokenAt(code, at)}"`);
  }
  let m = /^Unexpected (?:character|keyword) '(.+)'$/.exec(raw);
  if (m) return span(at, `unexpected "${m[1]}"`);
  m = /^The keyword '(.+)' is reserved$/.exec(raw);
  if (m) return span(at, `"${m[1]}" is a reserved word`);
  m = /^Identifier '(.+)' has already been declared$/.exec(raw);
  if (m) return span(at, `"${m[1]}" is declared twice`);
  return span(at, plainText(raw.charAt(0).toLowerCase() + raw.slice(1)));
}

/**
 * The first bracket that does not balance in `code` (strings and comments skipped):
 * a closer with nothing open, a closer of the wrong kind, or - when the code ends with brackets
 * still open - the innermost of them. `{ at, text }`, or null.
 */
export function bracketProblem(code) {
  const { masked } = maskCode(code);
  const open = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') open.push(i);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (!open.length) return { at: i, text: `unexpected "${ch}"` };
      const top = open.pop();
      const want = CLOSER[masked[top]];
      if (ch !== want) return { at: i, text: `missing "${want}"` };
    }
  }
  if (open.length) {
    const top = open[open.length - 1];
    return { at: top, text: `missing "${CLOSER[masked[top]]}"` };
  }
  return null;
}

// `cosnt x = 1`: the parser stops at `x`, but the mistake is the word before it.
function keywordTypo(code, at) {
  const before = code.slice(0, at);
  const m = /([A-Za-z_$][\w$]*)[ \t]+$/.exec(before);
  if (!m) return null;
  const word = m[1];
  if (KEYWORDS.includes(word)) return null;
  const suggest = nearestName(word, KEYWORDS);
  if (!suggest) return null;
  return { from: m.index, to: m.index + word.length, text: `unexpected "${word}"`, name: word, suggest };
}

function tokenAt(code, at) {
  const rest = code.slice(at);
  const m = /^(?:[A-Za-z_$][\w$]*|\d[\w.]*)/.exec(rest);
  return m ? m[0] : rest.charAt(0);
}

function lastTokenStart(code) {
  let i = code.trimEnd().length - 1;
  while (i > 0 && /[\w$]/.test(code[i - 1]) && /[\w$]/.test(code[i])) i--;
  return Math.max(0, i);
}

// --------------------------------------------------------------------------------------------
// Describing an error
// --------------------------------------------------------------------------------------------

/**
 * Notes, on an error thrown while evaluating the registered block `id`, where it came from - for
 * a syntax error, which carries no usable position of its own. Call it in the evaluator's catch.
 */
export function noteBlockFailure(err, id, parse) {
  if (!err || typeof err !== 'object' || err.poptartSpan || id == null) return err;
  const entry = sources.get(id);
  if (!entry) return err;
  const fromStack = locateStack(err.stack);
  if (err instanceof SyntaxError && !fromStack) {
    const p = syntaxProblem(id, parse);
    if (p) {
      err.poptartSpan = [entry.base + p.from, entry.base + p.to];
      err.poptartText = p.text;
      if (p.suggest) err.poptartSuggest = p.suggest;
      err.poptartDeck = entry.deck;
    }
  }
  return err;
}

/**
 * The near name to suggest for a misspelled `name`, from `candidates`, or null when none is close
 * enough to be worth saying. Close means one edit for a short name and two for a long one, with a
 * swap of two neighbors counting as one; a difference of case alone always counts.
 */
export function nearestName(name, candidates) {
  const word = String(name ?? '');
  if (word.length < 2 || !candidates) return null;
  const list = [...candidates].filter((c) => typeof c === 'string' && c && !c.startsWith('_'));
  if (list.includes(word)) return null;
  const lower = word.toLowerCase();
  const caseOnly = list.find((c) => c.toLowerCase() === lower);
  if (caseOnly) return caseOnly;
  const limit = word.length <= 4 ? 1 : 2;
  let best = null;
  let bestD = Infinity;
  for (const c of list) {
    if (Math.abs(c.length - word.length) > limit) continue;
    const d = editDistance(lower, c.toLowerCase());
    if (d < bestD || (d === bestD && best && c[0] === word[0] && best[0] !== word[0])) {
      best = c;
      bestD = d;
    }
  }
  return bestD <= limit ? best : null;
}

// Damerau-Levenshtein (optimal string alignment).
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Internal spellings the location transpile writes, and what the player wrote instead.
const INTERNAL_CALLS = { _record: 'record', _input: null, _display: null };

/**
 * An error message with the evaluator's own machinery taken out: wrapped strings read as the
 * strings they were, and renamed calls as the names typed.
 */
export function plainText(message) {
  return String(message ?? '')
    .replace(/mini\(("(?:[^"\\\n]|\\.)*"|`[^`]*`|'(?:[^'\\\n]|\\.)*'), \d+(?:, 'speech')?\)/g, '$1')
    .replace(/mini\(\.\.\.\)/g, '"…"')
    .replace(/\b_record\b/g, 'record')
    .replace(/__blockCode|__value|__defs/g, 'code');
}

/** The name and kind of call an error is about, from the engine's wording, or null. */
function namedFailure(err) {
  const msg = String(err?.message ?? '');
  let m = /^([A-Za-z_$][\w$]*) is not defined$/.exec(msg) ?? /^Can't find variable: ([A-Za-z_$][\w$]*)$/.exec(msg);
  if (m) return { name: m[1], context: 'builder', kind: 'undefined' };
  m = /^(?:(.*)\.)?([A-Za-z_$][\w$]*) is not a function/.exec(msg);
  if (m) return { name: m[2], context: m[1] !== undefined ? 'method' : 'builder', kind: 'not-function' };
  return null;
}

function identAt(text, at) {
  const m = /^[A-Za-z_$][\w$]*/.exec(String(text ?? '').slice(at));
  return m ? m[0] : '';
}

/**
 * What to say about an error from evaluating a block, and where it points.
 *
 * `source` is the whole buffer that was evaluated, `block` the block being reported
 * ({ label, start, code }), `deck` its deck, and `names` the real builder and method names to
 * suggest from: `{ builder: [...], method: [...] }`. Returns `{ message, where }`: `message` is
 * the console line, position first; `where` is `{ deck, label, from, to, line, col, text,
 * suggest }` with buffer offsets for the editor's mark, or null when no position is known.
 */
export function describeEvalError(err, { source = '', block = null, deck = 'a', names = null } = {}) {
  const label = shownLabel(block?.label);
  const named = namedFailure(err);
  let from = null;
  let to = null;
  let errDeck = deck;
  if (Array.isArray(err?.poptartSpan)) {
    [from, to] = err.poptartSpan;
    if (err.poptartDeck) errDeck = err.poptartDeck;
  } else {
    const loc = locateStack(err?.stack);
    if (loc && loc.deck === deck) {
      from = loc.at;
      const word = identAt(source, from);
      to = from + (word.length || 1);
    }
  }
  let text;
  let name = null;
  if (err?.poptartText) {
    text = err.poptartText;
  } else if (named) {
    // The name as typed, which is what the location is on: the engine's wording may carry a
    // rewritten call (`._record`) or the whole receiver expression.
    const typed = from !== null ? identAt(source, from) : '';
    name = typed && (typed === named.name || INTERNAL_CALLS[named.name] !== undefined) ? typed : named.name.replace(/^_(record)$/, '$1');
    text = named.kind === 'undefined' ? `"${name}" is not defined`
      : named.context === 'method' ? `"${name}" is not a method` : `"${name}" is not a function`;
  } else {
    text = plainText(err?.message ?? String(err));
  }
  let suggest = err?.poptartSuggest ?? null;
  if (!suggest && named && names) suggest = nearestName(name, named.context === 'method' ? names.method : names.builder);
  const tail = suggest ? ` - did you mean "${suggest}"?` : '';
  if (from === null) {
    return { message: `${label ? `${label}: ` : ''}${text}${tail}`, where: null };
  }
  const { line, col } = lineCol(source, from);
  const where = { deck: errDeck, label, from, to, line, col, text: `${text}${tail}` };
  if (suggest) where.suggest = suggest;
  return { message: `${label ? `${label}, ` : ''}line ${line}:${col} - ${text}${tail}`, where };
}

/** A block's label as the player wrote it - none for the anonymous ones (`$1`, `$:`). */
function shownLabel(label) {
  return typeof label === 'string' && label && !label.startsWith('$') ? label : null;
}

/**
 * Where a warning given right now points: the frame of the block whose builders are running, as
 * `{ deck, label, from, to, line, col }`, or null outside an evaluation.
 */
export function warningWhere(err = null) {
  if (err && Array.isArray(err.poptartSpan)) return null; // a span with no buffer to measure it in
  const loc = locateStack(err?.stack ?? stackHere());
  if (!loc || typeof loc.entry.doc !== 'string') return null;
  const word = identAt(loc.entry.doc, loc.at);
  return { deck: loc.deck, label: shownLabel(loc.label), from: loc.at, to: loc.at + (word.length || 1), ...lineCol(loc.entry.doc, loc.at) };
}

/** A warning's console line with its position in front, when it has one. */
export function withPosition(message, where) {
  if (!where) return message;
  return `${where.label ? `${where.label}, ` : ''}line ${where.line}:${where.col} - ${message}`;
}
