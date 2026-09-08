// Strudel-style pattern labels: split editor code into named blocks, one track each.
//
//   $: n("0 2 3")...            anonymous pattern (auto-named $1, $2, ... by position)
//   bass: n("0 2 3")...         named pattern - the name becomes the engine track id
//   _bass: ...  /  bass_: ...   leading or trailing underscore mutes the pattern
//   Sbass: ...  /  bassS: ...   leading or trailing capital S solos it (if anything is
//                               soloed, only soloed patterns play; mute still wins)
//
// A label must start at column 0 (identifier followed by ':' - inside a `group({ ... })` body it
// may be indented, see NESTED_LABEL_RE) *and* be in code: a `name:` inside
// an open `/*…*/` comment or a multi-line `` `…` `` template is only text there, so it doesn't
// start a block - see `endsUnparsed`. Continuation lines - `.param(…)` chains, the body of a
// `function () { … }`, a multi-line `` `<…>` `` template - stay with the block they continue, so
// they're never mistaken for a new block either. A **column-0 statement that
// isn't a label** (e.g. `Signal.prototype.co = …`, a bare `const x = …`) starts its own
// anonymous block, so language extensions and shared declarations can sit anywhere in the
// buffer, between tracks, not just at the top - see `continuesBlock` for how continuation is
// told apart from a fresh statement without a full JS parse.
//
// A label's expression may start on a line *below* it - `pluck:` on its own, the pattern
// indented underneath - which is what JS means by a labeled statement anyway. Until that
// expression turns up, the label is still waiting for its body, so the next line of code joins
// it however it's indented; see `awaitingBody`.
//
// Kept dependency-free on purpose: the browser imports this file directly (served as ESM by
// web-app/server.js) to know block boundaries and muted regions for playback highlighting.

// A label is a name and nothing else. Labels are a FLAT namespace: what a track belongs to is
// WHERE it is written - inside a `group({ ... })` block's braces (see the group splitting below and
// groups.mjs) - never in its name, so a track can be regrouped without being renamed and the
// arrangement, the mixer and a rename all address one bare name.
const LABEL_RE = /^([A-Za-z_$][\w$]*)\s*:(?!:)/;

// Inside a group's braces the same label shape is conventionally indented, so the anchor allows
// leading blanks there. Only there: at the top level a column-0 anchor is what keeps an indented
// `speed: 2,` inside somebody's options object from reading as a track.
const NESTED_LABEL_RE = /^[ \t]*([A-Za-z_$][\w$]*)\s*:(?!:)/;

// Does the state a block is in continue into `line`, rather than `line` starting a new
// expression? Two ways to continue: (1) the block ends mid-expression - unbalanced (){}[], an
// unclosed backtick template, or an open block comment (tracked by `scan`, which is string/
// comment/template aware so brackets inside `"…"`/`` `…` `` don't count); (2) `line` begins with
// `.`, which JS's automatic-semicolon-insertion joins to the previous line (`x\n.foo()` is one
// method chain). Everything else at column 0 is a fresh statement. Regex literals aren't
// lexed (rare in patch code); an unbalanced bracket inside one would read as still-open.
function continuesBlock(state, line) {
  return endsOpen(state) || /^\s*\./.test(line);
}

// True if the block so far ends somewhere a following line can't be read as code at all: inside
// a `/*…*/` comment or a `` `…` `` template. Text there only looks like a label - `/* $: broken? */`
// is a comment, not a block - so `splitLabeledBlocks` suppresses label matching while it's true. An
// unclosed bracket deliberately doesn't count: a stray `(` is a typo, and swallowing every
// label below it would hide the rest of the patch instead of just the broken line.
//
// `inTemplate` covers `${…}` interpolations too, not just literal template text: a column-0
// label inside one would split the template's own closing line off into a block of its own.
function endsUnparsed(state) {
  return state.inBlockComment || state.stack.includes('`');
}

// True if the block so far ends inside an unclosed bracket, backtick template, or block comment -
// i.e. a following line is part of the same expression.
function endsOpen(state) {
  return state.stack.length > 0 || state.inBlockComment;
}

// What a partly-lexed block has left open. Single/double-quoted strings are line-local (JS forbids
// a raw newline inside one), but they're still carried here rather than reset per line, so that
// feeding the text in chunks lexes exactly as feeding it whole would.
function newScan() {
  return {
    stack: [], // '(' '[' '{' for brackets, '`' for template contexts (typed so `${}` nests)
    inBlockComment: false,
    inLineComment: false,
    inString: null, // "'" or '"' while inside a quoted string
    skipNext: false, // a backslash escape at the very end of the last chunk eats this char
  };
}

// Lex `text` forward from `state`, in place, optionally recording which characters were live code.
// Called once per line as the block grows, NEVER on the block's accumulated text: re-lexing from
// the start each line made splitting a buffer quadratic in its length, which is exactly the buffer
// a pinned plugin state produces - and this runs in the same event loop as the note scheduler, so
// those milliseconds came straight out of the audio. Splitting text into chunks and advancing over
// each in turn gives the same result as one pass over the whole
// (see the `skipNext` carry, and note that the two-character lookaheads below can't straddle a
// newline), which is what lets the line loop reuse one state.
//
// `mask`, when given, is a Uint8Array parallel to the whole source into which a 1 is written at
// `base + i` for every character that is live code - see codeMask, the one caller that passes it.
// Nothing else is marked, so a comment's, string's or template's characters keep the array's 0.
function scan(state, text, mask = null, base = 0) {
  for (let i = 0; i < text.length; i++) {
    if (state.skipNext) { state.skipNext = false; continue; }
    const c = text[i];
    const d = text[i + 1];
    if (state.inLineComment) {
      if (c === '\n') state.inLineComment = false;
      continue;
    }
    if (state.inBlockComment) {
      if (c === '*' && d === '/') { state.inBlockComment = false; i++; }
      continue;
    }
    if (state.inString) {
      // A backslash escape whose escaped character lands in the next chunk carries as skipNext.
      if (c === '\\') { if (i + 1 < text.length) i++; else state.skipNext = true; }
      else if (c === state.inString || c === '\n') state.inString = null;
      continue;
    }
    if (state.stack[state.stack.length - 1] === '`') {
      // inside a template literal: only ` (close) and ${ (interpolation) change state
      if (c === '\\') { if (i + 1 < text.length) i++; else state.skipNext = true; }
      else if (c === '`') state.stack.pop();
      else if (c === '$' && d === '{') { state.stack.push('{'); i++; }
      continue;
    }
    // ordinary code context. The characters that OPEN a comment, string or template count as
    // not-code themselves, so a mask query never lands "in code" on a `//` or a quote.
    if (c === '/' && d === '/') { state.inLineComment = true; i++; }
    else if (c === '/' && d === '*') { state.inBlockComment = true; i++; }
    else if (c === '"' || c === "'") state.inString = c;
    else if (c === '`') state.stack.push('`');
    else {
      if (mask) mask[base + i] = 1;
      if (c === '(' || c === '[' || c === '{') state.stack.push(c);
      else if (c === ')' || c === ']' || c === '}') state.stack.pop();
    }
  }
  return state;
}

/**
 * @returns {Array<{ label: string, kind: 'labeled'|'anon'|'bare',
 *   muted: boolean, soloed: boolean, code: string, start: number, end: number,
 *   parent: string|null, depth: number, group?: boolean, bodyStart?: number, bodyEnd?: number }>}
 *   `start`/`end` are character offsets of the block in the original source (the label line
 *   included), for editor tooling. `code` is the block's executable source with the label
 *   stripped (replaced by spaces, so inner character offsets still line up with the original).
 *
 * Every block is a track with one name, one engine track, one row in the arrangement - and a block
 * whose expression is headed by `group({ ... })` holds other tracks INSIDE its braces:
 *
 *   drums: group({
 *     kick: s("mbd*4")
 *     snare: s("msn").off(1/2)
 *   }).fx("Pro-C 2")
 *
 * The braces are structure, not code that runs: the body is split into ordinary blocks of its own
 * (each with `parent` set to the group's label and `depth` one deeper), recursively, and the
 * group's OWN `code` keeps its span with the body blanked to spaces - so it evaluates as
 * `group({})` plus its chain, offsets still lined up, and the engine never sees the nesting as
 * anything but blocks and a parent map (see groups.mjs's treeOfBlocks and routeGroups). A group
 * block also carries `group: true` (bodyless `group()` heads too) and, when it has braces,
 * `bodyStart`/`bodyEnd` - the character span between them, which is what the editor folds. The
 * `group(` must head the block's expression; wrapped any deeper it is just an argument.
 *
 * `muted`/`soloed` are what THIS block's label says. A marker on a GROUP reaches everything under
 * it, but that is the tree's business, so the host applies it (see groups.mjs's ancestorsOf and
 * descendantsOf) - this file stays a lexer.
 *
 * `kind` says how the block was WRITTEN, which the label alone can't: every block that isn't
 * named gets a `$n` label, but a `$: …` you typed and a bare column-0 statement mean different
 * things by it.
 *   labeled  `kick: …` - a named track.
 *   anon     `$: …` - a track you didn't feel like naming. It promises sound, so the arrangement
 *            gives it a row and the host says so when it turns out not to make any.
 *   bare     a statement at column 0 with no label at all - `setbpm(140)`, `const kb = …`, a
 *            `Signal.prototype` extension. Setup, almost always; it is allowed to evaluate to a
 *            pattern (and then it plays), but nothing treats it as a part of the song.
 */
export function splitLabeledBlocks(source) {
  return splitBlocks(String(source), { nested: false, counter: { n: 0 }, base: 0, parent: null, depth: 0 });
}

// How deep group({ group({ ... }) }) may nest before the splitter stops exploding bodies. A song
// wants two or three levels; the guard is against a pathological buffer, not a real one.
const MAX_GROUP_DEPTH = 12;

// One splitting pass over `source` - the whole buffer, or (recursively) the body of a group's
// braces. `counter` numbers anonymous blocks and is SHARED down the recursion, so `$n` names stay
// unique across the buffer; `base` is where `source` starts in the document, so every block's
// `start`/`end` is document-absolute at any depth.
function splitBlocks(source, opts) {
  const { nested, counter, base, parent, depth } = opts;
  const labelRe = nested ? NESTED_LABEL_RE : LABEL_RE;
  const lines = source.split('\n');
  const blocks = [];
  let current = null;
  let state = null; // what `current`'s text so far has left open (see scan)
  let offset = 0;
  let awaitingBody = false; // `current` is a label whose expression hasn't appeared yet

  const push = () => {
    if (current) {
      current.end = base + Math.min(offset, source.length);
      blocks.push(current);
      explodeGroup(current, blocks, opts);
    }
  };

  for (const line of lines) {
    // Only look for a label where the previous lines have left us in code - inside an open
    // `/*…*/` or `` `…` ``, `$: …` is prose, not a new block. NESTED bodies add one more guard:
    // their label anchor allows indentation, so indentation no longer keeps a continuation line's
    // `state: "…"` (inside an open options object) from looking like a label - there, a label only
    // splits when the block so far is CLOSED. At the top level an open bracket deliberately does
    // not suppress a column-0 label (a stray `(` is a typo, and swallowing the rest of the buffer
    // for it would hide the whole patch); inside one group's braces the blast radius is the body.
    const inCode = !(current && endsUnparsed(state)) && !(nested && current && endsOpen(state));
    const m = inCode ? labelRe.exec(line) : null;
    if (m) {
      push();
      const meta = parseLabel(m[1], () => `$${++counter.n}`);
      const raw = m[0];
      current = {
        ...meta,
        kind: meta.anon ? 'anon' : 'labeled',
        // Blank out the label instead of slicing it off, so positions inside `code` equal
        // positions inside `source` minus `start` - the highlighter depends on that.
        code: ' '.repeat(raw.length) + line.slice(raw.length),
        start: base + offset,
        end: base + offset,
        parent,
        depth,
      };
      state = scan(newScan(), current.code);
      awaitingBody = !hasCode(current.code);
    } else if (current && (continuesBlock(state, line) || (awaitingBody && hasCode(line)))) {
      // Part of the current block's still-open expression (a chain, a brace body, a multi-line
      // template), or the body a bare `name:` line is still waiting for - stays with it either way.
      current.code += '\n' + line;
      scan(state, '\n' + line);
      if (hasCode(line)) awaitingBody = false;
    } else if (hasCode(line)) {
      // A statement that isn't a label (or the first code before any label): its own anonymous
      // block. A pattern here plays; anything else (a `Signal.prototype` extension, a shared
      // `const`) is a setup block that binds/acts for the blocks below - see server.js.
      push();
      const label = `$${++counter.n}`;
      current = { label, kind: 'bare', muted: false, soloed: false, code: line, start: base + offset, end: base + offset, parent, depth };
      state = scan(newScan(), line);
      awaitingBody = false;
    } else if (current) {
      // A blank or comment-only line that isn't continuing anything - keep it with the current
      // block so line offsets stay aligned; it doesn't start a block of its own.
      current.code += '\n' + line;
      scan(state, '\n' + line);
    }
    offset += line.length + 1; // +1 for the newline
  }
  push();

  return blocks.filter((b) => hasCode(b.code));
}

// A block's expression headed by `group(`; capture up to the argument position so the body brace,
// when there is one, is the character right after the match.
const GROUP_HEAD_RE = /^\s*group\s*\(/;
const GROUP_BODY_RE = /^(\s*group\s*\(\s*)\{/;

// A just-completed `group({ ... })` block gives up its body: the blocks inside the braces are
// split out as blocks of their own (appended right after it, so document order holds) and the
// body's characters are blanked out of the group's own `code` - newlines kept, so every offset
// still lines up and the code evaluates as `group({})` plus whatever is chained after the braces.
function explodeGroup(block, blocks, opts) {
  if (!GROUP_HEAD_RE.test(block.code)) return;
  block.group = true; // a mixdown head, braces or not (a bodyless `main: group()` is still a group)
  const bm = GROUP_BODY_RE.exec(block.code);
  if (!bm || opts.depth >= MAX_GROUP_DEPTH) return;
  const open = bm[1].length; // index of the `{` within `code`
  const close = matchingBrace(block.code, open);
  if (close < 0) return; // never closes: a half-typed group is one (broken) block, not a landslide
  const body = block.code.slice(open + 1, close);
  block.bodyStart = block.start + open + 1;
  block.bodyEnd = block.start + close;
  block.code = block.code.slice(0, open + 1) + body.replace(/[^\n]/g, ' ') + block.code.slice(close);
  blocks.push(...splitBlocks(body, {
    nested: true,
    counter: opts.counter,
    base: block.bodyStart,
    parent: block.label,
    depth: opts.depth + 1,
  }));
}

// The index of the `}` closing the `{` at `openIdx` of `code`, honoring strings, templates and
// comments - or -1 when it never closes (or a mismatched closer gets there first). A local,
// character-precise cousin of `scan`, which is fed by line and can't answer mid-line questions.
function matchingBrace(code, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < n && code[i] !== c && code[i] !== '\n') { if (code[i] === '\\') i++; i++; } i++; continue; }
    if (c === '`') { i++; while (i < n && code[i] !== '`') { if (code[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return c === '}' ? i : -1;
    }
    i++;
  }
  return -1;
}

/**
 * Which characters of `source` are live code, as a Uint8Array parallel to it: 1 for code, 0 for
 * everything inside a line or block comment, a quoted string, or a template literal's text
 * (`${…}` interpolations are code again).
 *
 * This exists for the editor tools that find a call with a regex and then rewrite it - auto-pin's
 * `{ state }` write, conf's `.param()` upsert, the plugin-window handles. A commented-out line is a
 * sound you are NOT hearing, and it is idiomatic here to keep one:
 *
 *     // .synth("Serum 2", { state: "…A…" })
 *     .synth("Serum 2", { state: "…B…" })
 *
 * so a regex that can't tell code from comment writes the running plugin's state onto the parked
 * copy, and counts a commented `.fx(` when numbering slots - which addresses a different plugin
 * than the one the server is holding. Asking this first is what keeps a rewrite on the line that
 * is actually playing. Same lexer the block splitter runs, so both agree about what is code.
 *
 * @returns {Uint8Array} length === source.length
 */
export function codeMask(source) {
  const text = String(source);
  const mask = new Uint8Array(text.length);
  scan(newScan(), text, mask);
  return mask;
}

/**
 * Is this block nothing but a call to `name(...)` - `setscale("F minor")` on its own line and
 * nothing else? Global setup calls that the host HOISTS have to be recognizable *before* anything
 * is evaluated (see web-app's server.js: the last setscale in a buffer sets the key for the whole
 * buffer, patterns above it included), and a hoistable one is exactly this shape. Deliberately
 * narrow: anything mixed in with other code keeps its place and runs in document order. Parens
 * inside string literals aren't lexed - a scale name has none - so at worst an exotic argument
 * isn't hoisted and behaves as it did before.
 */
export function isBareCallBlock(code, name) {
  const bare = String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .trim();
  const head = new RegExp(`^${name}\\s*\\(`).exec(bare);
  if (!head) return false;
  let depth = 0;
  for (let i = head[0].length - 1; i < bare.length; i++) {
    if (bare[i] === '(') depth++;
    else if (bare[i] === ')' && --depth === 0) return /^\s*;?\s*$/.test(bare.slice(i + 1));
  }
  return false;
}

// Is any line of `text` more than whitespace and not a `//` comment? Walks the lines and stops at
// the first one that is, rather than splitting the whole text into an array first: this is asked
// of entire blocks, which a pinned plugin state makes megabytes long, and the answer is almost
// always on the first line.
function hasCode(text) {
  let i = 0;
  while (i <= text.length) {
    let nl = text.indexOf('\n', i);
    if (nl === -1) nl = text.length;
    const t = text.slice(i, nl).trim();
    if (t !== '' && !t.startsWith('//')) return true;
    i = nl + 1;
  }
  return false;
}

/**
 * The mute/solo markers off a label token: `_bassS` -> { name: 'bass', muted, soloed }. Order
 * matters: strip mute underscores first so `_bassS:` works; keep stripping so `S_bass:` does too.
 * Never strip a marker if it would leave an empty name.
 */
function stripMarkers(raw) {
  let name = raw;
  let muted = false;
  let soloed = false;
  let changed = true;
  while (changed && name.length > 1) {
    changed = false;
    if (name.startsWith('_') || name.endsWith('_')) {
      muted = true;
      name = name.startsWith('_') ? name.slice(1) : name.slice(0, -1);
      changed = true;
    } else if (name.length > 1 && (name.startsWith('S') || name.endsWith('S'))) {
      soloed = true;
      name = name.startsWith('S') ? name.slice(1) : name.slice(0, -1);
      changed = true;
    }
  }
  return { name, muted, soloed };
}

function parseLabel(raw, nextAnonName) {
  const stripped = stripMarkers(raw);
  let { name } = stripped;
  const { muted, soloed } = stripped;
  let anon = false;

  if (name === '$' || name === '') {
    name = nextAnonName();
    anon = true; // written `$:` - a track, just not a named one (see the kinds above)
  }
  return { label: name, muted, soloed, anon };
}
