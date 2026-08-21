// The mixer's code edits: a fader or pan knob in the editor's mixer writes a plain numeric
// `.gain(x)` / `.pan(x)` onto the end of the track's block, and the mute/solo buttons write the
// label markers (`_bass:` / `Sbass:`) the language already has - so the code stays the one
// source of truth (an eval later plays exactly what the mixer shows). Pure string-in/edit-out,
// so the browser applies the edit to CodeMirror and the tests here never need a DOM.
//
// The "trim" is the LAST .gain(...)/.pan(...) call in the block, and only when its argument is a
// bare numeric literal - that's the call the mixer owns. A patterned call (.gain(env()),
// .pan(sine(...))) is modulation, not a level, so it is never rewritten: the mixer appends a new
// literal call after it instead. For gain that composes (chained .gain() multiply - the appended
// literal is a channel trim scaling the modulation); for pan the appended call replaces the
// patterned one, which is what grabbing the pan knob means.

import { splitLabeledBlocks, codeMask } from './labels.mjs';

// A bare numeric argument: the only kind of call the mixer may rewrite in place.
const NUM_ARG_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/;

// Matching close paren for the opener at `openIdx`, counting only characters the mask says are
// code - brackets inside strings and comments don't nest. -1 if unbalanced.
function matchParen(code, mask, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (!mask[i]) continue;
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The last `.name(...)` call in [from, to) that is real code, as { open, close } paren indices.
function lastCall(code, mask, name, from, to) {
  const re = new RegExp(`\\.\\s*${name}\\s*\\(`, 'g');
  re.lastIndex = from;
  let found = null;
  let m;
  while ((m = re.exec(code)) && m.index < to) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, mask, open);
    if (close < 0 || close >= to) continue;
    found = { open, close };
  }
  return found;
}

// Where an appended call goes: just past the block's last code character, but before a trailing
// `;` - `.gain(1);` not `;.gain(1)`. Blocks routinely end in blank lines and // comments (the
// splitter keeps them with the block), which the mask skips over.
function appendIndex(code, mask, block) {
  let i = Math.min(block.end, code.length) - 1;
  while (i >= block.start && (!mask[i] || /\s/.test(code[i]))) i--;
  if (i < block.start) return -1;
  return code[i] === ';' ? i : i + 1;
}

/**
 * The lex work every read/edit here needs, computed once: the block list and the code mask.
 * Callers touching several controls in one pass (the mixer's code→UI sync runs two reads per
 * strip) compute this once and pass it as `ctx`; single-gesture edits just omit it.
 */
export function analyze(code) {
  return { blocks: splitLabeledBlocks(code), mask: codeMask(code) };
}

/**
 * The current trim for one channel control of one labeled block.
 * @returns {{ value: number, patterned: boolean } | null}
 *   value - the trailing literal's value (control's default if there is no literal call);
 *   patterned - a non-literal call for this control exists that the mixer won't touch.
 *   null when the block isn't in the buffer.
 */
export function readTrim(code, label, name, fallback = name === 'gain' ? 1 : 0, ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label);
  if (!block) return null;
  const call = lastCall(code, mask, name, block.start, block.end);
  if (!call) return { value: fallback, patterned: false };
  const arg = code.slice(call.open + 1, call.close);
  const num = NUM_ARG_RE.exec(arg);
  if (!num) return { value: fallback, patterned: true };
  return { value: Number(num[1]), patterned: false };
}

/**
 * The edit that sets a block's trim to `value`: { from, to, text } as character indices into
 * `code`, or null when the block isn't in the buffer (or holds no code to chain onto). Rewrites
 * the trailing literal call in place when there is one; otherwise appends `.name(value)` at the
 * end of the block's code.
 */
export function trimEdit(code, label, name, value, ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label);
  if (!block) return null;
  const call = lastCall(code, mask, name, block.start, block.end);
  if (call) {
    const arg = code.slice(call.open + 1, call.close);
    if (NUM_ARG_RE.test(arg)) return { from: call.open + 1, to: call.close, text: String(value) };
  }
  const at = appendIndex(code, mask, block);
  if (at < 0) return null;
  return { from: at, to: at, text: `.${name}(${value})` };
}

/** Round a fader/knob value to what's worth writing in the code: 2 decimals, no trailing zeros. */
export function formatTrim(value) {
  return Number(value.toFixed(2));
}

// The raw label token a labeled block starts with. A bare-statement anonymous block has none
// (that's what MADE it anonymous), so flagEdit can't mark it; a `$:` block does (`$`), and takes
// markers like any named label (`_$:` is a muted anonymous block).
const LABEL_TOKEN_RE = /^([A-Za-z_$][\w$]*)\s*:(?!:)/; // same shape (and `::` exclusion) as the splitter's

// The token with its mute/solo markers stripped, exactly as the splitter's parseLabel strips
// them (leading/trailing `_` mutes, then leading/trailing capital `S` solos, repeatedly, never
// down to an empty name).
function labelBase(raw) {
  let name = raw;
  let changed = true;
  while (changed && name.length > 1) {
    changed = false;
    if (name.startsWith('_') || name.endsWith('_')) {
      name = name.startsWith('_') ? name.slice(1) : name.slice(0, -1);
      changed = true;
    } else if (name.startsWith('S') || name.endsWith('S')) {
      name = name.startsWith('S') ? name.slice(1) : name.slice(0, -1);
      changed = true;
    }
  }
  return name;
}

/**
 * The edit that sets a block's mute/solo state: rewrites the label token in the canonical marker
 * form (`_Sname` - underscore first, exactly what parseLabel reads back as muted+soloed). Null
 * when the block isn't in the buffer or has no label token to mark. The block keeps its parsed
 * label either way, so nothing else about the strip changes identity.
 */
export function flagEdit(code, label, { muted = false, soloed = false } = {}, ctx = null) {
  const { blocks } = ctx ?? { blocks: splitLabeledBlocks(code) };
  const block = blocks.find((b) => b.label === label);
  if (!block) return null;
  const m = LABEL_TOKEN_RE.exec(code.slice(block.start, block.start + 256));
  if (!m) return null;
  const text = `${muted ? '_' : ''}${soloed ? 'S' : ''}${labelBase(m[1])}`;
  return { from: block.start, to: block.start + m[1].length, text };
}
