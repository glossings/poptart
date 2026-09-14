// The envelope panel's code edits: dragging a handle over the waveform writes plain numeric
// sampler controls onto the track's chain - `.adsr(a, d, s, r)`, `.begin(x)`, `.end(x)`, `.loop(1)`
// and the loop modes - so the code stays the one source of truth, exactly as the mixer's trims do
// (see mixctl.mjs, whose reading rules these follow). Pure string-in/edit-out: the browser applies
// the edits to CodeMirror, and the tests never need a DOM.
//
// A control's value is the LAST call in the block that sets it. The envelope stages have two
// spellings - `.attack(x)` and a position of `.adsr(a, d, s, r)` - and whichever comes later in the
// text wins, which is the order they apply in. Only a bare numeric literal is the panel's to
// rewrite; anything else (a mini string, a signal, `rand().range(...)`) is a pattern, read-only
// here. A control nobody sets is appended at the end of the block's code.

import { splitLabeledBlocks, codeMask } from './labels.mjs';

const NUM_ARG_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)\s*$/i;

/** The four envelope stages, in `.adsr()` argument order. */
export const ENVELOPE_STAGES = ['attack', 'decay', 'sustain', 'release'];

/** What each control reads as where the chain doesn't set it - the engine's own defaults. */
export const SAMPLER_CTL_DEFAULTS = {
  attack: 0,
  decay: 0,
  sustain: 1,
  release: 0,
  envscale: 1,
  begin: 0,
  end: 1,
  loop: 0,
  loopwrap: 0,
  loopdir: 0,
  speed: 1,
  stretch: 1,
};

// Controls whose bare call means 1 (`.loop()` loops) - an empty argument list is a value for these.
const BARE_IS_ONE = new Set(['loop', 'loopwrap', 'loopdir']);

// The order appended calls are written in: where the sample plays, then how it loops, then its
// envelope - the order a person reads a sampler chain in.
const APPEND_ORDER = ['begin', 'end', 'loop', 'loopwrap', 'loopdir', 'attack', 'decay', 'sustain', 'release'];

// Offsets that are the block's OWN code: masked, and outside a group's braces (those are the
// member tracks', see labels.mjs).
function ownCode(mask, block) {
  const from = block.bodyStart;
  const to = block.bodyEnd;
  return (i) => mask[i] === 1 && (from == null || i < from || i >= to);
}

// Every `.name(...)` call in the block, in text order, as { name, start, open, close }.
function callsIn(code, isCode, block, names) {
  const re = new RegExp(`\\.\\s*(${names.join('|')})\\s*\\(`, 'g');
  re.lastIndex = block.start;
  const out = [];
  let m;
  while ((m = re.exec(code)) && m.index < block.end) {
    if (!isCode(m.index)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, isCode, open);
    if (close < 0 || close >= block.end) continue;
    out.push({ name: m[1], start: m.index, open, close });
  }
  return out;
}

function matchParen(code, isCode, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (!isCode(i)) continue;
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The top-level arguments of the call whose parens are [open, close], as { from, to } spans (the
// raw text between the commas, whitespace included). An empty list has no arguments at all.
function argSpans(code, isCode, open, close) {
  const spans = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (!isCode(i)) continue;
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      spans.push({ from, to: i });
      from = i + 1;
    }
  }
  if (spans.length || code.slice(from, close).trim()) spans.push({ from, to: close });
  return spans;
}

function appendIndex(code, isCode, block) {
  let i = Math.min(block.end, code.length) - 1;
  while (i >= block.start && (!isCode(i) || /\s/.test(code[i]))) i--;
  if (i < block.start) return -1;
  return code[i] === ';' ? i : i + 1;
}

/** Block list and code mask, computed once for several reads/edits of the same buffer. */
export function analyze(code) {
  return { blocks: splitLabeledBlocks(code), mask: codeMask(code) };
}

// Where each control's value comes from, by name: the { from, to } span of its argument in the
// last call that sets it (`bare` for an empty `.loop()`), or nothing where no call does.
function locate(code, label, ctx) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label);
  if (!block) return null;
  const isCode = ownCode(mask, block);
  const names = [...Object.keys(SAMPLER_CTL_DEFAULTS), 'adsr', 'fit'];
  const found = {};
  for (const call of callsIn(code, isCode, block, names)) {
    const args = argSpans(code, isCode, call.open, call.close);
    if (call.name === 'adsr') {
      ENVELOPE_STAGES.forEach((stage, k) => {
        if (args[k]) found[stage] = { ...args[k], call };
      });
      continue;
    }
    if (call.name === 'fit') {
      found.fit = args.length ? { ...args[0], call } : { bare: true, call };
      continue;
    }
    // A bare call: a value of 1 for the loop switches; for the rest an empty argument is undefined,
    // which is no value at all - the control reads as unset, the call left alone.
    if (!args.length) {
      if (BARE_IS_ONE.has(call.name)) found[call.name] = { bare: true, from: call.open + 1, to: call.close, call };
      continue;
    }
    found[call.name] = { ...args[0], call };
  }
  return { block, isCode, found };
}

/**
 * Every sampler control the panel draws, for one labeled block.
 * @returns {null | { [name]: { value: number, set: boolean, patterned: boolean, text?: string } }}
 *   value - the literal's number (the default where unset or patterned); set - some call sets it;
 *   patterned - that call's argument is not a number, so the panel must not write it; text - the
 *   argument as written, for a patterned one. `fit` is 'auto', a number, a pattern's text, or null.
 */
export function readSamplerControls(code, label, ctx = null) {
  const loc = locate(code, label, ctx);
  if (!loc) return null;
  const out = {};
  for (const [name, dflt] of Object.entries(SAMPLER_CTL_DEFAULTS)) {
    const at = loc.found[name];
    if (!at) {
      out[name] = { value: dflt, set: false, patterned: false };
    } else if (at.bare) {
      out[name] = { value: 1, set: true, patterned: false };
    } else {
      const text = code.slice(at.from, at.to);
      const num = NUM_ARG_RE.exec(text);
      out[name] = num
        ? { value: Number(num[1]), set: true, patterned: false }
        : { value: dflt, set: true, patterned: true, text: text.trim() };
    }
  }
  const fit = loc.found.fit;
  if (!fit) out.fit = null;
  else if (fit.bare) out.fit = 'auto';
  else {
    const text = code.slice(fit.from, fit.to);
    const num = NUM_ARG_RE.exec(text);
    out.fit = num ? Number(num[1]) : text.trim();
  }
  return out;
}

/** A number as the panel writes it: at most four decimals, no trailing zeros, no float dust. */
export function formatCtl(value) {
  const n = Number(Number(value).toFixed(4));
  return String(Object.is(n, -0) ? 0 : n);
}

/**
 * The edits that set controls on one labeled block. `values` is { name: number } for any of the
 * controls in SAMPLER_CTL_DEFAULTS except envscale/speed/stretch (the panel reads those, it never
 * writes them).
 *
 * A literal is rewritten in place, whichever spelling holds it. A patterned control is left alone
 * and reported in `skipped`. Unset controls are appended together at the end of the block's code:
 * all four envelope stages at once as one `.adsr(...)`, otherwise each as its own call.
 *
 * @returns {null | { edits: { from, to, text }[], skipped: string[] }} null when the block isn't in
 *   the buffer or has no code to chain onto. Edits never overlap; apply them from the end.
 */
export function samplerControlEdits(code, label, values, ctx = null) {
  const loc = locate(code, label, ctx);
  if (!loc) return null;
  const edits = [];
  const skipped = [];
  const append = {};
  for (const [name, value] of Object.entries(values)) {
    if (!(name in SAMPLER_CTL_DEFAULTS) || !Number.isFinite(value)) continue;
    const at = loc.found[name];
    if (!at) {
      append[name] = value;
      continue;
    }
    const text = at.bare ? '' : code.slice(at.from, at.to);
    if (!at.bare && !NUM_ARG_RE.test(text)) {
      skipped.push(name);
      continue;
    }
    // Keep the spacing the argument was written with: `.adsr(0.1, 0.2)` stays comma-space.
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    edits.push({ from: at.from, to: at.to, text: `${at.bare ? '' : lead}${formatCtl(value)}${at.bare ? '' : trail}` });
  }
  const names = APPEND_ORDER.filter((n) => n in append);
  if (names.length) {
    const at = appendIndex(code, loc.isCode, loc.block);
    if (at < 0) return null;
    const allStages = ENVELOPE_STAGES.every((s) => s in append);
    let text = '';
    for (const name of names) {
      if (allStages && ENVELOPE_STAGES.includes(name)) continue;
      text += `.${name}(${formatCtl(append[name])})`;
    }
    if (allStages) text += `.adsr(${ENVELOPE_STAGES.map((s) => formatCtl(append[s])).join(', ')})`;
    edits.push({ from: at, to: at, text });
  }
  return { edits, skipped };
}
