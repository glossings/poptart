// Strudel-style pattern labels: split editor code into named blocks, one track each.
//
//   $: n("0 2 3")...            anonymous pattern (auto-named $1, $2, ... by position)
//   bass: n("0 2 3")...         named pattern - the name becomes the engine track id
//   _bass: ...  /  bass_: ...   leading or trailing underscore mutes the pattern
//   Sbass: ...  /  bassS: ...   leading or trailing capital S solos it (if anything is
//                               soloed, only soloed patterns play; mute still wins)
//
// A label must start at column 0 (identifier followed by ':') *and* be in code: a `name:` inside
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

const LABEL_RE = /^([A-Za-z_$][\w$]*)\s*:(?!:)/;

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

// Lex `text` forward from `state`, in place. Called once per line as the block grows, NEVER on the
// block's accumulated text: re-lexing from the start each line made splitting a buffer quadratic in
// its length, which is exactly the buffer a pinned plugin state produces - and this runs in the same
// event loop as the note scheduler, so those milliseconds came straight out of the audio. Splitting
// text into chunks and advancing over each in turn gives the same result as one pass over the whole
// (see the `skipNext` carry, and note that the two-character lookaheads below can't straddle a
// newline), which is what lets the line loop reuse one state.
function scan(state, text) {
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
    // ordinary code context
    if (c === '/' && d === '/') { state.inLineComment = true; i++; }
    else if (c === '/' && d === '*') { state.inBlockComment = true; i++; }
    else if (c === '"' || c === "'") state.inString = c;
    else if (c === '`') state.stack.push('`');
    else if (c === '(' || c === '[' || c === '{') state.stack.push(c);
    else if (c === ')' || c === ']' || c === '}') state.stack.pop();
  }
  return state;
}

/**
 * @returns {Array<{ label: string, muted: boolean, soloed: boolean, code: string,
 *   start: number, end: number }>}
 *   `start`/`end` are character offsets of the block in the original source (the label line
 *   included), for editor tooling. `code` is the block's executable source with the label
 *   stripped (replaced by spaces, so inner character offsets still line up with the original).
 */
export function splitLabeledBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  let current = null;
  let state = null; // what `current`'s text so far has left open (see scan)
  let offset = 0;
  let anonCount = 0;
  let awaitingBody = false; // `current` is a label whose expression hasn't appeared yet

  const push = () => {
    if (current) {
      current.end = offset;
      blocks.push(current);
    }
  };

  for (const line of lines) {
    // Only look for a label where the previous lines have left us in code - inside an open
    // `/*…*/` or `` `…` ``, `$: …` is prose, not a new block.
    const m = current && endsUnparsed(state) ? null : LABEL_RE.exec(line);
    if (m) {
      push();
      const meta = parseLabel(m[1], () => `$${++anonCount}`);
      current = {
        ...meta,
        // Blank out the label instead of slicing it off, so positions inside `code` equal
        // positions inside `source` minus `start` - the highlighter depends on that.
        code: ' '.repeat(m[0].length) + line.slice(m[0].length),
        start: offset,
        end: offset,
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
      // A column-0 statement that isn't a label (or the first code before any label): its own
      // anonymous block. A pattern here plays; anything else (a `Signal.prototype` extension, a
      // shared `const`) is a setup block that binds/acts for the blocks below - see server.js.
      push();
      current = { label: `$${++anonCount}`, muted: false, soloed: false, code: line, start: offset, end: offset };
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

function parseLabel(raw, nextAnonName) {
  let name = raw;
  let muted = false;
  let soloed = false;

  // Order matters: strip mute underscores first so `_bassS:` works; keep stripping so
  // `S_bass:` does too. Never strip a marker if it would leave an empty name.
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

  if (name === '$' || name === '') name = nextAnonName();
  return { label: name, muted, soloed };
}
