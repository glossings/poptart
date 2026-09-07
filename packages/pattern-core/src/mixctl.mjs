// The mixer's code edits: a fader or pan knob in the editor's mixer writes a plain numeric
// `.postgain(x)` / `.pan(x)` onto the end of the track's block, the mute/solo buttons write the
// label markers (`_bass:` / `Sbass:`) the language already has, and typing over a strip's name
// rewrites the label itself - so the code stays the one source of truth (an eval later plays
// exactly what the mixer shows). Pure string-in/edit-out, so the browser applies the edit to
// CodeMirror and the tests here never need a DOM.
//
// The "trim" is the LAST .postgain(...)/.pan(...) call in the block, and only when its argument is
// a bare numeric literal - that's the call the mixer owns. A patterned call (.postgain(env()),
// .pan(sine(...))) is modulation, not a level, so it is never rewritten: the mixer appends a new
// literal call after it instead. For gain that composes (chained .postgain() multiply - the
// appended literal is a channel trim scaling the modulation); for pan the appended call replaces
// the patterned one, which is what grabbing the pan knob means.

import { splitLabeledBlocks, codeMask } from './labels.mjs';

// A bare numeric argument: the only kind of call the mixer may rewrite in place.
const NUM_ARG_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/;

// What a channel control reads as when the block doesn't set it - the same neutral values the
// scheduler snaps a dropped control back to (see CHANNEL_DEFAULTS in signal.mjs).
export const TRIM_DEFAULTS = { gain: 1, postgain: 1, pan: 0, width: 1, bassmono: 0 };

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
// `;` - `.postgain(1);` not `;.postgain(1)`. Blocks routinely end in blank lines and // comments (the
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
const LABEL_TOKEN_RE = /^([A-Za-z_$][\w$]*(?:#[\w$]+)?)\s*:(?!:)/; // same shape (and `::` exclusion, and `#variation`) as the splitter's
// ...and the token of a NESTED variation - an indented `#name:` under its base (see labels.mjs).
const NESTED_TOKEN_RE = /^[ \t]+([_S]*#[\w$]+[_S]*)\s*:(?!:)/;

/** Where a block's label token sits: { from, to, raw }, or null for a block that has none. */
function labelTokenAt(code, block) {
  const head = code.slice(block.start, block.start + 256);
  const m = (block.nested ? NESTED_TOKEN_RE : LABEL_TOKEN_RE).exec(head);
  if (!m) return null;
  const from = block.start + m[0].indexOf(m[1]);
  return { from, to: from + m[1].length, raw: m[1] };
}

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
  const tok = labelTokenAt(code, block);
  if (!tok) return null;
  const text = `${muted ? '_' : ''}${soloed ? 'S' : ''}${labelBase(tok.raw)}`;
  return { from: tok.from, to: tok.to, text };
}

// A name that can be written as a label and read back as itself. The identifier shape is the
// splitter's; the marker check is what stops `Snare` (which parses as a SOLOED `nare`) and
// `bass_` (a muted `bass`) from becoming names you can't get rid of.
const NAME_RE = /^[A-Za-z_$][\w$]*(?:#[\w$]+)?$/; // a name, or a variation's `base#name`

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

// The arrangement's clip string names blocks too - `_arrange("kick,0,8 kick#fill,12,4")` - and a
// clip left naming the old label is an orphan row playing nothing. Each clip token whose label is
// renamed (see `map`) is rewritten in place; the numbers after it are untouched.
const ARRANGE_CALL_RE = /\b_?arrange\s*\(\s*(['"])((?:[^'"\\\n]|\\.)*)\1/g;

// A block headed by group() is the mixdown of its variations (see groups.mjs). Read off the code
// the way the server reads it off the Sig, so the editor can tell a group from a track without an
// evaluation: the head call, and nothing before it but the label.
const GROUP_HEAD_RE = /^\s*group\s*\(\s*\)/;

/** Whether a labeled block (from splitLabeledBlocks) is a group: its code starts with `group()`. */
export function isGroupBlock(block) {
  return !!block && GROUP_HEAD_RE.test(block.code);
}

/**
 * The edits that turn the track `label` into a GROUP: what it played moves under it as the
 * variation `label#name`, its own line becomes `label: group()`, and every clip of the arrangement
 * that named it names the variation instead - so the song sounds exactly as it did, now with a
 * place for a second variation to go. The first variation made from the painter does this before
 * it is written (see the client's arCreateVariation), and it is what makes "a track with
 * variations" and "a group" the same thing.
 *
 *   kick: s("mbd*4").postgain(0.8)      ->    kick: group()
 *                                               #main: s("mbd*4").postgain(0.8)
 *
 * Nothing is moved UP onto the group: which calls a track shares with its variations is a choice
 * (a .postgain() is likely, an .fx() may or may not be), so the track's chain goes down whole and
 * the group starts bare. Same edit shape as renameEdits': ascending, apply back to front. Null
 * when the block isn't in the buffer, is already a group, or is itself a variation.
 *
 * @returns {{ edits: Array<{ from: number, to: number, text: string }>, member: string } | null}
 */
export function groupEdits(code, label, name = 'main', ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label);
  if (!block || block.variant != null || isGroupBlock(block)) return null;
  const tok = labelTokenAt(code, block);
  if (!tok) return null;
  const member = `${label}#${name}`;
  if (blocks.some((b) => b.label === member)) return null;
  // The label token, its colon, and the spaces up to the body: the body's first character stays
  // where it is, and everything below it (a chain continued on further lines) is untouched.
  const colon = code.indexOf(':', tok.to);
  let at = colon + 1;
  while (at < code.length && (code[at] === ' ' || code[at] === '\t')) at++;
  const edits = [{ from: colon + 1, to: at, text: ` group()\n  #${name}: ` }];
  edits.push(...arrangeRefEdits(code, mask, new Map([[label, member]])));
  edits.sort((a, b) => a.from - b.from);
  return { edits, member };
}

/**
 * The clip edits alone, for a block whose label has ALREADY changed - a base renamed by hand in the
 * code, which the editor notices at the next evaluation and whose clips it then brings along.
 * `map` is old label -> new. Same shape as renameEdits' edits: ascending, apply back to front.
 */
export function arrangeClipEdits(code, map, ctx = null) {
  const { mask } = ctx ?? analyze(code);
  return arrangeRefEdits(code, mask, map instanceof Map ? map : new Map(Object.entries(map)));
}

function arrangeRefEdits(code, mask, map) {
  const edits = [];
  ARRANGE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = ARRANGE_CALL_RE.exec(code))) {
    if (!mask[m.index]) continue;
    const raw = m[2];
    const open = m.index + m[0].length - 1 - raw.length; // the first character inside the quotes
    const tokenRe = /(^|\s)([^\s,]+),/g; // each clip's label: the token before its first comma
    let t;
    while ((t = tokenRe.exec(raw))) {
      // an older `label:roll` token renames by its label alone
      const label = t[2].split(':')[0];
      const to = map.get(label);
      if (to == null) continue;
      const at = open + t.index + t[1].length;
      edits.push({ from: at, to: at + label.length, text: to });
    }
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
  let name = String(newName).trim();
  // `#roll` typed for a variation is short for `kick#roll` - the base is understood.
  if (name.startsWith('#') && block.variant != null) name = block.base + name;
  if (!NAME_RE.test(name)) {
    return { error: `"${name}" can't be a pattern name - names start with a letter, _ or $ and hold letters, digits, _ or $` };
  }
  if (name === '$' || labelBase(name) !== name) {
    return { error: `"${name}" reads as a mute/solo marker (a leading or trailing _ or capital S) rather than a name` };
  }
  if (blocks.some((b) => b !== block && b.label === name)) {
    return { error: `"${name}" is already another pattern's name` };
  }
  const at = name.indexOf('#');
  const newBase = at < 0 ? name : name.slice(0, at);
  const newVariant = at < 0 ? null : name.slice(at + 1);
  // A NESTED variation's token is `#name` alone - its base is the block above it. So it can
  // be renamed within its family, but not moved to another: that would mean moving the block,
  // which is an edit for the person to make.
  if (block.nested && (newVariant == null || newBase !== block.base)) {
    return { error: `"${label}" is written under ${block.base}, so it stays a variation of it - to make it ${name}, write it out as \`${name}:\` at column 0` };
  }
  // Renaming a BASE takes its variations with it: `kick#fill` becomes `drums#fill`, in the code
  // and in the arrangement's clips, since a variation whose base has gone is an orphan and a
  // rename is not meant to make one. A nested variation's code needs nothing - its name is the
  // base's - but its clips do. Renaming a variation, or renaming a base INTO a variation
  // (`kick` -> `drums#fill`), moves that one block alone.
  const family = block.variant == null && newVariant == null
    ? blocks.filter((b) => b.base === label && b.variant != null)
    : [];
  const map = new Map([[label, name], ...family.map((b) => [b.label, `${name}#${b.variant}`])]);
  const markers = (b) => `${(b.ownMuted ?? b.muted) ? '_' : ''}${(b.ownSoloed ?? b.soloed) ? 'S' : ''}`;
  const headOf = (b, to) => {
    const tok = labelTokenAt(code, b);
    const written = b.nested ? `#${to.slice(to.indexOf('#') + 1)}` : to;
    return tok
      ? { from: tok.from, to: tok.to, text: `${markers(b)}${written}` }
      : { from: b.start, to: b.start, text: `${to}: ` };
  };
  const heads = [headOf(block, name), ...family.filter((b) => !b.nested).map((b) => headOf(b, map.get(b.label)))];
  const refs = sourceRefEdits(code, mask, label, name);
  const clips = arrangeRefEdits(code, mask, map);
  return { edits: [...heads, ...refs, ...clips].sort((a, b) => a.from - b.from), refs: refs.length, family: family.length };
}
