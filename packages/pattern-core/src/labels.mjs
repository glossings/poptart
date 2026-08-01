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
// Kept dependency-free on purpose: the browser imports this file directly (served as ESM by
// web-app/server.js) to know block boundaries and muted regions for playback highlighting.

const LABEL_RE = /^([A-Za-z_$][\w$]*)\s*:(?!:)/;

// Does `line` continue the expression `code` has open so far, rather than start a new one?
// Two ways to continue: (1) `code` ends mid-expression - unbalanced (){}[], an unclosed
// backtick template, or an open block comment (scanned by `scanOpen`, which is string/comment/
// template aware so brackets inside `"…"`/`` `…` `` don't count); (2) `line` begins with `.`,
// which JS's automatic-semicolon-insertion joins to the previous line (`x\n.foo()` is one
// method chain). Everything else at column 0 is a fresh statement. Regex literals aren't
// lexed (rare in patch code); an unbalanced bracket inside one would read as still-open.
function continuesBlock(code, line) {
  return endsOpen(code) || /^\s*\./.test(line);
}

// True if `code` ends somewhere a following line can't be read as code at all: inside a `/*…*/`
// comment or a `` `…` `` template. Text there only looks like a label - `/* $: broken? */` is a
// comment, not a block - so `splitLabeledBlocks` suppresses label matching while it's true. An
// unclosed bracket deliberately doesn't count: a stray `(` is a typo, and swallowing every
// label below it would hide the rest of the patch instead of just the broken line.
function endsUnparsed(code) {
  const { inBlockComment, inTemplate } = scanOpen(code);
  return inBlockComment || inTemplate;
}

// True if `code` ends inside an unclosed bracket, backtick template, or block comment - i.e. a
// following line is part of the same expression.
function endsOpen(code) {
  const { depth, inBlockComment } = scanOpen(code);
  return depth > 0 || inBlockComment;
}

// Lex `code` far enough to know what's still open at its end. Single/double-quoted strings are
// treated as line-local (JS forbids a raw newline inside them), so only `` ` `` templates span
// lines.
function scanOpen(code) {
  const stack = []; // '(' '[' '{' for brackets, '`' for template contexts (typed so `${}` nests)
  let inBlockComment = false;
  let inLineComment = false;
  let inString = null; // "'" or '"' while inside a quoted string (reset at newline)
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const d = code[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && d === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') i++; // skip the escaped char
      else if (c === inString || c === '\n') inString = null;
      continue;
    }
    if (stack[stack.length - 1] === '`') {
      // inside a template literal: only ` (close) and ${ (interpolation) change state
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && d === '{') { stack.push('{'); i++; }
      continue;
    }
    // ordinary code context
    if (c === '/' && d === '/') { inLineComment = true; i++; }
    else if (c === '/' && d === '*') { inBlockComment = true; i++; }
    else if (c === '"' || c === "'") inString = c;
    else if (c === '`') stack.push('`');
    else if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') stack.pop();
  }
  // `inTemplate` covers `${…}` interpolations too, not just literal template text: a column-0
  // label inside one would split the template's own closing line off into a block of its own.
  return { depth: stack.length, inBlockComment, inTemplate: stack.includes('`') };
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
  let offset = 0;
  let anonCount = 0;

  const push = () => {
    if (current) {
      current.end = offset;
      blocks.push(current);
    }
  };

  for (const line of lines) {
    // Only look for a label where the previous lines have left us in code - inside an open
    // `/*…*/` or `` `…` ``, `$: …` is prose, not a new block.
    const m = current && endsUnparsed(current.code) ? null : LABEL_RE.exec(line);
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
    } else if (current && continuesBlock(current.code, line)) {
      // Part of the current block's still-open expression (a chain, a brace body, a multi-line
      // template) - stays with it.
      current.code += '\n' + line;
    } else if (hasCode(line)) {
      // A column-0 statement that isn't a label (or the first code before any label): its own
      // anonymous block. A pattern here plays; anything else (a `Signal.prototype` extension, a
      // shared `const`) is a setup block that binds/acts for the blocks below - see server.js.
      push();
      current = { label: `$${++anonCount}`, muted: false, soloed: false, code: line, start: offset, end: offset };
    } else if (current) {
      // A blank or comment-only line that isn't continuing anything - keep it with the current
      // block so line offsets stay aligned; it doesn't start a block of its own.
      current.code += '\n' + line;
    }
    offset += line.length + 1; // +1 for the newline
  }
  push();

  return blocks.filter((b) => hasCode(b.code));
}

function hasCode(text) {
  return text.split('\n').some((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('//');
  });
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
