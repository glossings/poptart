// The mixer's code edits: a fader or pan knob in the editor's mixer writes a plain numeric
// `.gain(x)` / `.pan(x)` onto the end of the track's block, the mute/solo buttons write the
// label markers (`_bass:` / `Sbass:`) the language already has, and typing over a strip's name
// rewrites the label itself - so the code stays the one source of truth (an eval later plays
// exactly what the mixer shows). Pure string-in/edit-out, so the browser applies the edit to
// CodeMirror and the tests here never need a DOM.
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

// What a channel control reads as when the block doesn't set it - the same neutral values the
// scheduler snaps a dropped control back to (see CHANNEL_DEFAULTS in signal.mjs).
export const TRIM_DEFAULTS = { gain: 1, pan: 0, width: 1, bassmono: 0 };

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
export function readTrim(code, label, name, fallback = TRIM_DEFAULTS[name] ?? 0, ctx = null) {
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

// A name that can be written as a label and read back as itself. The identifier shape is the
// splitter's; the marker check is what stops `Snare` (which parses as a SOLOED `nare`) and
// `bass_` (a muted `bass`) from becoming names you can't get rid of.
const NAME_RE = /^[A-Za-z_$][\w$]*$/;

// The calls that take a TRACK LABEL as a string: `audio("drums")` reads another track's output,
// `midi("kick")` re-triggers off its notes - both also as methods (`.audio(…)` for a sidechain,
// `.midi(…)`), and both accepting a `track:` prefix that forces the track over a device or bus of
// the same name. These move with a rename: left behind, they don't error, they quietly resolve to
// a device, a bus, or nothing, which is the worst way for a rename to go wrong.
const SOURCE_REF_RE = /\b(?:audio|midi)\s*\(\s*(['"])((?:[^'"\\\n]|\\.)*)\1/g;

// Every source-name string in the buffer that names `from`, as edits to its contents. Masked like
// everything else here, so a commented-out `// .audio("kick")` keeps the name it was parked with.
function sourceRefEdits(code, mask, from, to) {
  const edits = [];
  SOURCE_REF_RE.lastIndex = 0;
  let m;
  while ((m = SOURCE_REF_RE.exec(code))) {
    if (!mask[m.index]) continue;
    const raw = m[2];
    const close = m.index + m[0].length - 1; // the closing quote
    const name = raw.trim();
    if (name === from) edits.push({ from: close - raw.length, to: close, text: to });
    else if (name === `track:${from}`) edits.push({ from: close - raw.length, to: close, text: `track:${to}` });
  }
  return edits;
}

/**
 * The edits that rename a labeled block to `newName`: its label token (mute/solo markers kept, in
 * the canonical `_S` order) plus every source call in the buffer that names it. A block with no
 * label token at all - a bare column-0 statement, the thing that made it anonymous - gets one
 * written in front of it, since naming it is exactly what the mixer is being asked for.
 *
 * @returns {{ edits: Array<{ from: number, to: number, text: string }>, refs: number }
 *   | { error: string }}
 *   `edits` are in ascending order and overlap nothing: apply them BACK TO FRONT so an earlier
 *   one never shifts a later one's offsets. `refs` counts the source calls among them. `error` is
 *   a sentence for the log - the name is unusable or taken, or the block has gone.
 */
export function renameEdits(code, label, newName, ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label);
  if (!block) return { error: `there's no block named "${label}" in the buffer any more` };
  const name = String(newName).trim();
  if (!NAME_RE.test(name)) {
    return { error: `"${name}" can't be a pattern name - names start with a letter, _ or $ and hold letters, digits, _ or $` };
  }
  if (name === '$' || labelBase(name) !== name) {
    return { error: `"${name}" reads as a mute/solo marker (a leading or trailing _ or capital S) rather than a name` };
  }
  if (blocks.some((b) => b !== block && b.label === name)) {
    return { error: `"${name}" is already another pattern's name` };
  }
  const m = LABEL_TOKEN_RE.exec(code.slice(block.start, block.start + 256));
  const head = m
    ? { from: block.start, to: block.start + m[1].length, text: `${block.muted ? '_' : ''}${block.soloed ? 'S' : ''}${name}` }
    : { from: block.start, to: block.start, text: `${name}: ` };
  const refs = sourceRefEdits(code, mask, label, name);
  return { edits: [head, ...refs].sort((a, b) => a.from - b.from), refs: refs.length };
}
