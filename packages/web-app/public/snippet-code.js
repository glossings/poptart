'use strict';

// Injecting a snippet: working out what its names have to become in THIS buffer.
//
// A snippet carries its own definitions (see snippets.js) - `_roll("bass", …)` under a body that
// says `pianoroll("bass")`. Drop that into a buffer that already has a roll called `bass` and there
// are only two things that can happen, and both are wrong: the buffer's notes get clobbered, or the
// snippet quietly plays somebody else's. So every name the snippet brings is checked against the
// buffer first, and three cases come out of it:
//
//   nothing of that name        take it as it is
//   the SAME definition         reuse the buffer's - injecting a snippet twice must not leave
//                               bass2, bass3 behind it
//   a DIFFERENT one             rename the copy, and rewrite the body to name the copy
//
// Block labels go through the same mill: two blocks sharing a label are two tracks fighting over
// one engine track id.
//
// Every rename is reported, never silent. A `bass2` that appears from nowhere reads as a bug -
// which is the problem libraryBumpNote already exists to solve on the other side of the editor.
//
// Pure string-in, string-out: the caller reads the buffer, this decides, the caller writes. Loaded
// as a plain script in the browser (before client.js) and require()d by snippet-code.test.js, the
// same arrangement pattern-meta.js uses.

// A name a scoped kind owns only WITHIN something else. A preset belongs to the plugin it was
// captured from, so `disco` on a delay and `disco` on a reverb are two unrelated sounds that
// happen to share a word. Two scopes match when they agree, or when either is unknown - the same
// rule makeDefRegistry and lookupPreset both keep to.
const sameScope = (kind, a, b) => kind !== 'preset' || !a || !b || a === b;

const sameDef = (a, b) => a.kind === b.kind && a.id === b.id && sameScope(a.kind, a.scope, b.scope);

/**
 * A definition's code with its id swapped out, so two definitions of different names can be
 * compared on what they actually DEFINE. Purely positional: the id is the first argument, so
 * everything from the opening paren to the first top-level comma is the name and the rest is the
 * thing itself.
 */
function defBody(code) {
  const src = String(code ?? '');
  const open = src.indexOf('(');
  if (open < 0) return src.trim();
  let depth = 0;
  let inStr = null;
  let comma = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      // The call's own closing paren: everything between the first top-level comma and here is the
      // definition, and a `;` or a trailing comment after it is not part of what it defines.
      if (depth === 0) return src.slice(comma < 0 ? open + 1 : comma + 1, i).trim();
    } else if (ch === ',' && depth === 1 && comma < 0) comma = i;
  }
  return src.slice(comma < 0 ? open + 1 : comma + 1).trim();
}

/**
 * A definition's code with a new id written into it, the rest left exactly as it stood. Rebuilt
 * around defBody rather than patched in place, so it comes out in the one shape the editor writes -
 * a quoted id, then the definition - however the copy it came from was spelled.
 */
function withDefId(code, id) {
  const src = String(code ?? '');
  const open = src.indexOf('(');
  if (open < 0) return src;
  return `${src.slice(0, open + 1)}${JSON.stringify(String(id))}, ${defBody(src)})`;
}

/** `name` with a number appended until `taken` stops saying yes: bass -> bass2 -> bass3. */
function freshName(name, taken) {
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name}${i}`)) return `${name}${i}`;
}

/**
 * Rewrites the ids inside the id-string arguments of `calls` - `pianoroll("<bass lead>")` - without
 * touching anything else in the body. `calls` are { from, to } spans of the STRING CONTENTS,
 * relative to `body`, which the caller reads off the same registries that found them.
 */
function rewriteIdStrings(body, calls, renameOf) {
  const edits = [];
  for (const call of calls) {
    const str = body.slice(call.from, call.to);
    for (const [from, to] of pairsOf(str)) {
      const to2 = renameOf(str.slice(from, to), call);
      if (to2 != null) edits.push([call.from + from, call.from + to, to2]);
    }
  }
  return applyEdits(body, edits);
}

/** Every bare word in an id string, as [start, end) spans - `<bass lead>` gives two. */
function pairsOf(str) {
  const out = [];
  // Mini's own modifiers first, so the `2` of `<a b>*2` isn't read as a name. Blanked rather than
  // removed, so the spans still line up with the original string.
  const bare = String(str).replace(/[*/!@:]\s*\d+(?:\.\d+)?/g, (m) => ' '.repeat(m.length));
  for (const m of bare.matchAll(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/g)) {
    if (m[0] !== '_') out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** [from, to, text] edits against one string, applied last-first so the offsets hold. */
function applyEdits(text, edits) {
  let out = String(text);
  for (const [from, to, str] of [...edits].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, from) + str + out.slice(to);
  }
  return out;
}

/**
 * What to write, given what the snippet carries and what the buffer already holds.
 *
 *   body        the snippet's code, definitions already stripped off
 *   carried     [{ kind, id, scope, code }] - the definitions riding with it
 *   idCalls     [{ kind, from, to, scope }] - the spans of the id STRINGS inside `body` (the
 *               `<bass lead>` of `pianoroll("<bass lead>")`), which the caller reads off the same
 *               registries the editor uses everywhere else
 *   bufferDefs  [{ kind, id, scope, code }] the buffer already has - `code` may be omitted, in
 *               which case the name is treated as taken by something different
 *   taken       (kind, id, scope) => boolean, for names that exist outside the buffer too (the ★
 *               library, built-in shape presets). Optional.
 *   labels      the block labels the buffer already uses, for the body's own `bass:` lines
 *
 * Returns { body, defs, renames } - the body to insert, the definitions to file (the ones the
 * buffer hasn't already got), and a { kind, from, to } per rename for the caller to report.
 */
function planInjection({ body = '', carried = [], idCalls = [], bufferDefs = [], taken = null, labels = [] }) {
  const renames = [];
  const defs = [];
  const claimed = []; // names this injection has handed out, so two carried defs can't collide
  const isTaken = (kind, id, scope) =>
    bufferDefs.some((d) => sameDef(d, { kind, id, scope }))
    || claimed.some((d) => sameDef(d, { kind, id, scope }))
    || !!taken?.(kind, id, scope);

  // kind -> { from -> to } for the ids that moved, so the body can be rewritten in one pass below.
  const moved = new Map();
  for (const one of carried) {
    const kind = String(one.kind);
    const id = String(one.id);
    const scope = String(one.scope ?? '');
    const had = bufferDefs.find((d) => sameDef(d, { kind, id, scope }));
    // Already there, and the same thing - play the buffer's. This is what makes injecting the same
    // snippet twice idempotent instead of a source of bass2, bass3.
    if (had && had.code != null && defBody(had.code) === defBody(one.code)) continue;
    const id2 = had || isTaken(kind, id, scope) ? freshName(id, (n) => isTaken(kind, n, scope)) : id;
    claimed.push({ kind, id: id2, scope });
    defs.push({ kind, id: id2, scope, code: withDefId(one.code, id2) });
    if (id2 === id) continue;
    renames.push({ kind, from: id, to: id2, scope });
    if (!moved.has(kind)) moved.set(kind, new Map());
    moved.get(kind).set(id, id2);
  }

  // The body's `pianoroll("bass")` has to follow its definition. Only the id STRINGS are touched,
  // occurrence by occurrence - a blanket replace would also rewrite a `bass` that is a variable, a
  // sample name or a word in a comment.
  let out = String(body);
  if (moved.size) {
    out = rewriteIdStrings(out, idCalls, (word, call) => {
      const byKind = moved.get(call.kind);
      const to = byKind?.get(word);
      // A scoped kind only follows a rename made under the same owner: renaming ValhallaDelay's
      // `disco` must not repoint a Serum track's .preset("disco").
      if (to == null) return null;
      const rename = renames.find((r) => r.kind === call.kind && r.from === word);
      return rename && sameScope(call.kind, rename.scope, call.scope ?? '') ? to : null;
    });
  }

  // Block labels last, against the body as it now stands. Two blocks under one label are two
  // tracks fighting over a single engine track id, so a collision is renamed like any other.
  const labelSet = new Set(labels.map(String));
  for (const [from, to] of labelCollisions(out, labelSet)) {
    labelSet.add(to);
    renames.push({ kind: 'label', from, to, scope: '' });
    out = out.replace(new RegExp(`^([ \\t]*)${from}(?=[ \\t]*:)`, 'm'), `$1${to}`);
  }
  return { body: out, defs, renames };
}

/** The body's own labels that the buffer is already using, as [from, to] pairs. */
function labelCollisions(body, labelSet) {
  const out = [];
  const seen = new Set();
  for (const m of String(body).matchAll(/^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:(?!:)/gm)) {
    const name = m[1];
    if (name === '$' || seen.has(name) || !labelSet.has(name)) continue;
    seen.add(name);
    out.push([name, freshName(name, (n) => labelSet.has(n) || seen.has(n))]);
  }
  return out;
}

/**
 * Where a snippet's body goes in, and how it is spaced: [offset, text to write there].
 *
 * A one-line body beginning with `.` is a CHAIN FRAGMENT - `.lpf(sine.range(200, 2000))` off the
 * end of somebody's track - and belongs exactly where the caret is, inline and unpadded. Everything
 * else is a statement or a whole block, and gets a blank line above it and its own line below,
 * without stacking up a second blank line where the buffer already had one.
 *
 * `floor` is where the definitions block begins (null when there isn't one). The offset is clamped
 * above it: the bottom of the buffer is definitions, and code written into the middle of them would
 * be stranded down there below everything that plays.
 */
function placeSnippet(code, body, at, floor = null) {
  const src = String(code ?? '');
  const text = String(body ?? '');
  const where = Math.max(0, Math.min(floor === null ? src.length : floor, at));
  if (!text.includes('\n') && /^\s*\./.test(text)) return [where, text];
  const before = src.slice(0, where);
  const after = src.slice(where);
  const lead = !before || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  const tail = after.trim() ? (after.startsWith('\n') ? '\n' : '\n\n') : '\n';
  return [where, `${lead}${text}${tail}`];
}

/** "renamed roll "bass" to "bass2" - this buffer has another one" and friends, for the console. */
function renameNote({ kind, from, to }) {
  return kind === 'label'
    ? `renamed the block "${from}" to "${to}" - this buffer already has a "${from}:"`
    : `renamed ${kind} "${from}" to "${to}" - this buffer has a different ${kind} called "${from}"`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planInjection, placeSnippet, defBody, withDefId, freshName, renameNote };
}
