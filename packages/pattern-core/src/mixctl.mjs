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
// markers like any named label (`_$:` is a muted anonymous block). Leading blanks allowed for a
// block inside a group's braces - same shape (and `::` exclusion) as the splitter's NESTED_LABEL_RE.
const LABEL_TOKEN_RE = /^[ \t]*([A-Za-z_$][\w$]*)\s*:(?!:)/;

/** Where a block's label token sits: { from, to, raw }, or null for a block that has none. */
function labelTokenAt(code, block) {
  const head = code.slice(block.start, block.start + 256);
  const m = LABEL_TOKEN_RE.exec(head);
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
const NAME_RE = /^[A-Za-z_$][\w$]*$/;

// The calls that take a TRACK LABEL as a string: `audio("drums")` reads another track's output,
// `midi("kick")` re-triggers off its notes, `copy("kick")` re-evaluates its whole pattern - all
// also as methods (`.audio(…)` for a sidechain, `.midi(…)`, `.copy(…)` for a note swap), and the
// first two accepting a `track:` prefix that forces the track over a device or bus of the same
// name. These move with a rename: left behind, they don't error, they quietly resolve to a
// device, a bus, or nothing, which is the worst way for a rename to go wrong.
const SOURCE_REF_RE = /\b(?:audio|midi|copy)\s*\(\s*(['"])((?:[^'"\\\n]|\\.)*)\1/g;

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

// The arrangement's clip string names blocks too - `_arrange("kick,0,8 fill,12,4")` - and a clip
// left naming the old label is an orphan row playing nothing. Each clip token whose label is
// renamed (see `map`) is rewritten in place; the numbers after it are untouched.
const ARRANGE_CALL_RE = /\b_?arrange\s*\(\s*(['"])((?:[^'"\\\n]|\\.)*)\1/g;

/**
 * Whether a labeled block (from splitLabeledBlocks) is a group: its expression is headed by
 * `group(`. The splitter marks it (see labels.mjs's explodeGroup), so the editor can tell a group
 * from a track without an evaluation.
 */
export function isGroupBlock(block) {
  return !!block?.group;
}

// Just past the last live-code character in [from, to) - the position after a member run's final
// statement (its trailing `;` included, comments and blank lines not), where a wrap's `})` goes.
function lastCodeEnd(code, mask, from, to) {
  let i = Math.min(to, code.length) - 1;
  while (i >= from && (!mask[i] || /\s/.test(code[i]))) i--;
  return i < from ? -1 : i + 1;
}

// Each newline in [from, to) that separates real code lines - mask 1 means the break itself is
// code, so the line after it is NOT the middle of a template literal or an open block comment,
// and indenting or dedenting it can't change what a string says.
function codeLineBreaks(code, mask, from, to) {
  const out = [];
  for (let i = Math.max(0, from); i < Math.min(to, code.length); i++) {
    if (code[i] === '\n' && mask[i]) out.push(i);
  }
  return out;
}

/**
 * The edits that wrap the blocks `labels` in a new `name: group({ ... })` - the cmd+G gesture.
 * Pure text: the selected blocks' lines move inside the braces (indented two spaces, template-
 * safe), and that is the whole of membership - there is no side table to update.
 *
 * The members must be CONSECUTIVE in the buffer - which is what a highlighted selection is, and
 * what braces can hold. Setup between two tracks (a shared `const`) is wrapped along - it is part
 * of that section - but another track that wasn't selected is an error, so the caller can say so
 * rather than swallowing it. All selected blocks must also sit at the same depth (all inside the
 * same braces, or all outside): a selection reaching from inside one group's body to past its
 * close has no one place a wrapper could go.
 *
 * Nothing is moved onto the group: what calls its members share is a choice (a .postgain() is
 * likely, an .fx() may or may not be), so the group starts bare and what goes on it is written by
 * hand. Same edit shape as renameEdits': ascending, apply back to front.
 *
 * @returns {{ edits: Array<{from,to,text}>, name: string, members: string[] } | { error: string }}
 */
export function groupWrapEdits(code, labels, name, ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const wanted = new Set(labels);
  const chosen = blocks.filter((b) => wanted.has(b.label));
  if (!chosen.length) return { error: 'nothing to group - select the tracks first' };
  const named = String(name ?? '').trim();
  if (!NAME_RE.test(named) || named === '$' || labelBase(named) !== named) {
    return { error: `"${named}" can't be a group name - names start with a letter, _ or $ and hold letters, digits, _ or $` };
  }
  if (blocks.some((b) => b.label === named)) return { error: `"${named}" is already another pattern's name` };
  const parent = chosen[0].parent ?? null;
  if (chosen.some((b) => (b.parent ?? null) !== parent)) {
    return { error: 'the selection reaches across a group boundary - group tracks that sit side by side' };
  }
  const spanStart = chosen[0].start;
  const spanEnd = Math.max(...chosen.map((b) => b.end));
  // Consecutive? A track inside the span that wasn't selected and isn't already INSIDE a selected
  // group block would be swallowed by the wrap, so it refuses by name.
  const inside = (b) => chosen.some((c) => b !== c && b.start >= c.start && b.end <= c.end);
  const between = blocks.filter((b) => !wanted.has(b.label) && b.kind !== 'bare' && !inside(b)
    && b.start >= spanStart && b.start < spanEnd);
  if (between.length) {
    return { error: `${JSON.stringify(between[0].label)} sits between the tracks being grouped - a group is a run of lines, so move it out of the way first` };
  }
  const closeAt = lastCodeEnd(code, mask, spanStart, spanEnd);
  if (closeAt < 0) return { error: 'nothing to group - select the tracks first' };
  // Inside a group's body the members already sit at an indent, and the new head takes it too - a
  // wrapper written at column 0 would read as a TOP-level label and break the enclosing group open.
  const indent = /^[ \t]*/.exec(code.slice(spanStart, spanStart + 64))[0];
  const edits = [{ from: spanStart, to: spanStart, text: `${indent}${named}: group({\n  ` }];
  for (const nl of codeLineBreaks(code, mask, spanStart, closeAt)) {
    if (code[nl + 1] === '\n' || nl + 1 >= closeAt) continue; // a blank line takes no indent
    edits.push({ from: nl + 1, to: nl + 1, text: '  ' });
  }
  edits.push({ from: closeAt, to: closeAt, text: `\n${indent}})` });
  return { edits, name: named, members: chosen.map((b) => b.label) };
}

/**
 * The edits that dissolve the group `label`: its members' lines move back out of the braces
 * (dedented, template-safe) to where the group sat, and the group's own line - its chain
 * included - goes. Losing a group frees what was in it, never silences it. A bodyless group
 * (`main: group()`) simply loses its line. Ascending; apply back to front.
 *
 * @returns {{ edits: Array<{from,to,text}>, members: string[] } | { error: string }}
 */
export function ungroupEdits(code, label, ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label && b.group);
  if (!block) return { error: `there's no group named "${label}" in the buffer any more` };
  const members = blocks.filter((b) => b.parent === label).map((b) => b.label);
  const statementEnd = lastCodeEnd(code, mask, block.start, block.end);
  if (block.bodyStart == null) {
    // Bodyless: remove the whole line (through its newline, so no blank line is left behind).
    let to = statementEnd;
    while (to < code.length && code[to] !== '\n') to++;
    return { edits: [{ from: block.start, to: Math.min(to + 1, code.length), text: '' }], members };
  }
  const edits = [];
  // The head: `label: group({` and, when the body starts on the next line, that newline too.
  const headTo = code[block.bodyStart] === '\n' ? block.bodyStart + 1 : block.bodyStart;
  edits.push({ from: block.start, to: headTo, text: '' });
  // The tail: the closing `})`, the group's own chain after it, and the line break before it.
  let tailFrom = block.bodyEnd;
  while (tailFrom > block.bodyStart && (code[tailFrom - 1] === ' ' || code[tailFrom - 1] === '\t')) tailFrom--;
  if (tailFrom > block.bodyStart && code[tailFrom - 1] === '\n') tailFrom--;
  edits.push({ from: tailFrom, to: Math.max(tailFrom, statementEnd), text: '' });
  // The members lose the wrap's indent - only on breaks the mask calls code, so a template
  // literal's text keeps its spaces (and never inside the tail deletion above).
  for (const nl of codeLineBreaks(code, mask, block.bodyStart, block.bodyEnd)) {
    if (nl + 3 > tailFrom) continue;
    if (code[nl + 1] === ' ' && code[nl + 2] === ' ') edits.push({ from: nl + 1, to: nl + 3, text: '' });
  }
  return { edits: edits.sort((a, b) => a.from - b.from), members };
}

/**
 * The edits that move ONE member out of its group: its lines leave the braces (dedented) and
 * land just below the group's block, one level up - out of a subgroup means into the parent
 * group. The group itself stands, other members untouched; a group emptied this way is left as
 * `group({})`, still a bus, still foldable. Ascending; apply back to front.
 *
 * @returns {{ edits: Array<{from,to,text}>, parent: string } | { error: string }}
 */
export function extractFromGroupEdits(code, label, ctx = null) {
  const { blocks, mask } = ctx ?? analyze(code);
  const block = blocks.find((b) => b.label === label && b.parent != null);
  if (!block) return { error: `"${label}" isn't inside a group` };
  const parent = blocks.find((b) => b.label === block.parent && b.group);
  if (!parent) return { error: `"${label}" isn't inside a group` };
  const segEnd = Math.min(block.end, parent.bodyEnd ?? block.end);
  let text = code.slice(block.start, segEnd);
  // Dedent relative to the segment's own offsets, then make sure it lands as whole lines.
  const breaks = codeLineBreaks(code, mask, block.start, segEnd).map((nl) => nl - block.start);
  for (const nl of breaks.reverse()) {
    if (text[nl + 1] === ' ' && text[nl + 2] === ' ') text = text.slice(0, nl + 1) + text.slice(nl + 3);
  }
  const indent = /^[ \t]*/.exec(text)[0];
  text = text.slice(indent.length >= 2 ? 2 : indent.length);
  if (!text.endsWith('\n')) text += '\n';
  const at = Math.min(parent.end, code.length);
  const lead = at > 0 && code[at - 1] !== '\n' ? '\n' : '';
  return {
    edits: [
      { from: block.start, to: segEnd, text: '' },
      { from: at, to: at, text: `${lead}${text}` },
    ],
    parent: parent.label,
  };
}

/**
 * The DATA edits alone - the arrangement's clips - for a block whose label has ALREADY changed: a
 * track renamed by hand in the code, which the editor notices at the next evaluation and whose
 * place in the song it then brings along. `map` is old label -> new. Same shape as renameEdits'
 * edits: ascending, apply back to front. (Group membership needs nothing here: it is where the
 * block SITS, and the block hasn't moved.)
 */
export function arrangeClipEdits(code, map, ctx = null) {
  const { mask } = ctx ?? analyze(code);
  const m = map instanceof Map ? map : new Map(Object.entries(map));
  return arrangeRefEdits(code, mask, m).sort((a, b) => a.from - b.from);
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
  const map = new Map([[label, name]]);
  const markers = `${block.muted ? '_' : ''}${block.soloed ? 'S' : ''}`;
  const tok = labelTokenAt(code, block);
  const head = tok
    ? { from: tok.from, to: tok.to, text: `${markers}${name}` }
    : { from: block.start, to: block.start, text: `${name}: ` };
  const refs = sourceRefEdits(code, mask, label, name);
  const clips = arrangeRefEdits(code, mask, map);
  // Group membership follows for free: it is where the block sits, and a rename moves nothing.
  return {
    edits: [head, ...refs, ...clips].sort((a, b) => a.from - b.from),
    refs: refs.length,
  };
}
