'use strict';

// The ★ library - definitions "made permanent" from the editor.
//
// A roll, LFO shape, plugin preset or sample pack is defined in the buffer it was drawn in, and
// ends with that buffer. Starring one copies its definition into a prebake source, which every
// later patch runs at startup (see server.js's runPrebake) - so the name becomes an option in
// every project: `pianoroll("bass")`, `lfo("swell")`, `.preset("growl")`, `sp("kit")` resolve
// against the library when the buffer has no definition of its own, and the pickers list them.
//
// The file is ~/.poptart/prebake/pinned.js: plain JavaScript, one definition per line, managed by
// poptart. It is a prebake source like any other, so hand-editing it works too - the rules this
// module keeps to (one statement per line, ids as literals) are what let it find and replace an
// entry by name afterwards. Kept apart from prebake.js, which is the user's own file and is never
// rewritten by tooling.
//
// Pure string-in, string-out: the server owns the file, this module owns its format.

const HEADER = `// poptart's ★ library - definitions pinned from the editor (the star beside a name).
// One definition per line. Runs at startup like every prebake file, so every project gets these.
// Safe to edit by hand; keep one definition per line so the editor can find them by name.
`;

const KINDS = new Set(['roll', 'shape', 'preset', 'pack', 'slices']);

/** String-aware scan from an opening paren to its match; -1 if unbalanced. */
function matchParen(code, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return ch === ')' ? i : -1;
    }
  }
  return -1;
}

/** The top-level arguments of a call body, split on commas outside strings and brackets. */
function splitArgs(inner) {
  const out = [];
  let depth = 0;
  let inStr = null;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(inner.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(inner.slice(from).trim());
  return out;
}

/** The value of an id literal - a quoted name or a bare number - or null for anything else. */
function literalValue(literal) {
  const quoted = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(literal ?? '');
  if (quoted) return quoted[2];
  return /^-?\d+(?:\.\d+)?$/.test(literal ?? '') ? String(Number(literal)) : null;
}

/**
 * Every pinned definition in `text`: { kind, id, scope, code, start, end }. `kind` is the bare
 * word (roll/shape/preset/pack/slices), `scope` the plugin of a preset ('' otherwise), `code` the whole
 * call, [start, end) the span of its line. A line that isn't one definition is left alone (a
 * comment, a blank, something hand-written) - it just isn't an entry.
 */
function parsePinned(text) {
  const out = [];
  const src = String(text ?? '');
  const re = /(^|\n)[ \t]*_(roll|shape|preset|pack|slices)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const afterBreak = m[0].slice(m[1].length); // the indentation, then the call
    const callStart = m.index + m[1].length + (afterBreak.length - afterBreak.trimStart().length);
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = splitArgs(src.slice(open + 1, close));
    const id = literalValue(args[0]);
    if (id == null) continue;
    const kind = m[2];
    const scope = kind === 'preset' ? literalValue(args[1]) ?? '' : '';
    const lineStart = src.lastIndexOf('\n', callStart - 1) + 1;
    const tail = /^[ \t;]*(?:\r?\n|$)/.exec(src.slice(close + 1));
    const end = close + 1 + (tail ? tail[0].length : 0);
    out.push({ kind, id, scope, code: src.slice(callStart, close + 1), start: lineStart, end });
    re.lastIndex = close + 1;
  }
  return out;
}

const same = (e, q) => e.kind === q.kind && e.id === String(q.id) && (e.kind !== 'preset' || e.scope === String(q.scope ?? ''));

/**
 * `text` with `code` filed under { kind, id, scope } - replacing the entry of that name if there
 * is one, appending otherwise. `code` must be exactly one definition of that kind and id, which
 * is what keeps the file a list of definitions the parser above can find again.
 */
function upsertPinned(text, { kind, id, scope = '', code }) {
  if (!KINDS.has(kind)) throw new Error(`can't pin a "${kind}" - only rolls, shapes, presets, packs and slice sets`);
  const one = String(code ?? '').trim();
  const parsed = parsePinned(one);
  if (parsed.length !== 1 || !same(parsed[0], { kind, id, scope }) || parsed[0].code !== one) {
    throw new Error(`a pinned ${kind} has to be one _${kind}(${JSON.stringify(String(id))}, …) definition`);
  }
  const src = String(text ?? '');
  const had = parsePinned(src).find((e) => same(e, { kind, id, scope }));
  if (had) return `${src.slice(0, had.start)}${one}\n${src.slice(had.end)}`;
  const base = src.trim() ? src.replace(/\s*$/, '\n') : HEADER;
  return `${base}${one}\n`;
}

/** `text` without the entry of that name (unchanged when there is none). */
function removePinned(text, { kind, id, scope = '' }) {
  const src = String(text ?? '');
  const had = parsePinned(src).find((e) => same(e, { kind, id, scope }));
  if (!had) return src;
  return `${src.slice(0, had.start)}${src.slice(had.end)}`;
}

// ---------------------------------------------------------------------------------------------
// Snippets. A snippet file is a phrase of code followed by the definitions it names, in exactly the
// arrangement a pinned file keeps them - which is why the format lives here, where both builds load
// it: the desktop's snippets.js keeps the files on disk, the browser build's host keeps them in its
// store, and both write and read them through these two.
// ---------------------------------------------------------------------------------------------

/**
 * The body and the sidecar, split apart.
 *
 * The sidecar is the TRAILING RUN of definitions - the last one, and every one above it separated
 * from the next by nothing but blank space, a `;` or a comment. That's exactly the shape defsEdit
 * writes at the bottom of a buffer, and taking only a trailing run is also what keeps a `_roll(` in
 * the middle of the body (inside a template literal, say) where it stands rather than hoisting text
 * out of the code it belongs to.
 */
function splitSnippet(code) {
  const src = String(code ?? '');
  const defs = parsePinned(src);
  const run = [];
  let below = src.length;
  for (let i = defs.length - 1; i >= 0; i--) {
    const def = defs[i];
    // Only blank space, `;` and comments between this definition and what has already joined the
    // run (or the end of the file, for the last one).
    if (!isBlankGap(src.slice(def.end, below))) break;
    run.unshift(def);
    below = def.start;
  }
  return {
    body: stripMetaHeader(src.slice(0, below)).replace(/\s+$/, ''),
    carries: run.map(({ kind, id, scope, code: c }) => ({ kind, id, scope, code: c })),
  };
}

// The `@title` / `@tags` lines off the top. They are how the snippet is FILED, not part of the
// phrase - and leaving them on would do real damage on the way back in, because parseMeta scans a
// whole buffer: an injected `// @tags 303` would quietly become the tags of the pattern it landed
// in. Only leading lines that are nothing but a metadata tag go; an ordinary comment above the
// code is somebody's note about it and stays with it.
const META_LINE = /^[ \t]*\/\/[ \t]*@(?:title|name|by|author|tags|tag)\b[^\n]*\n?/;

function stripMetaHeader(text) {
  let out = String(text);
  while (META_LINE.test(out)) out = out.replace(META_LINE, '');
  return out.replace(/^[ \t]*\n+/, '');
}

/** Whitespace, stray semicolons and whole-line comments - nothing that is code. */
function isBlankGap(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/[;\s]/g, '') === '';
}

/**
 * The file a snippet is saved as: its metadata, the body, then the definitions it carries - one
 * per line, which is the arrangement parsePinned (and splitSnippet above) can find again.
 */
function composeSnippet({ title = '', tags = [], body = '', defs = [] }) {
  const head = [];
  if (String(title).trim()) head.push(`// @title ${String(title).trim()}`);
  const clean = (Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/))
    .map((t) => String(t).replace(/^#/, '').trim().toLowerCase())
    .filter(Boolean);
  if (clean.length) head.push(`// @tags ${[...new Set(clean)].join(' ')}`);
  const lines = defs.map((d) => String(d?.code ?? '').trim()).filter(Boolean);
  return [head.join('\n'), String(body).trim(), lines.join('\n')].filter(Boolean).join('\n\n') + '\n';
}

// Loaded two ways: required by the desktop server, and imported by the browser build's host (see
// public/web/prebake.mjs), where there is no `module` and the functions are left on globalThis.
const api = { HEADER, KINDS, parsePinned, upsertPinned, removePinned, splitSnippet, composeSnippet };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.poptartPinnedDefs = api;
