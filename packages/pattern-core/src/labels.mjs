// Strudel-style pattern labels: split editor code into named blocks, one track each.
//
//   $: n("0 2 3")...            anonymous pattern (auto-named $1, $2, ... by position)
//   bass: n("0 2 3")...         named pattern - the name becomes the engine track id
//   _bass: ...  /  bass_: ...   leading or trailing underscore mutes the pattern
//   Sbass: ...  /  bassS: ...   leading or trailing capital S solos it (if anything is
//                               soloed, only soloed patterns play; mute still wins)
//
// A label must start at column 0 (identifier followed by ':'), so indented continuation lines
// like `.param("…", …)` and object literals like `sine({ rate: 0.3 })` are never mistaken for
// labels. Code with no labels at all is treated as a single anonymous block, which keeps the
// original one-expression usage working unchanged.
//
// Kept dependency-free on purpose: the browser imports this file directly (served as ESM by
// web-app/server.js) to know block boundaries and muted regions for playback highlighting.

const LABEL_RE = /^([A-Za-z_$][\w$]*)\s*:(?!:)/;

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
    const m = LABEL_RE.exec(line);
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
    } else if (current) {
      current.code += '\n' + line;
    } else if (hasCode(line)) {
      // Code (not blank lines / comments) before any label: one implicit anonymous block.
      current = { label: `$${++anonCount}`, muted: false, soloed: false, code: line, start: offset, end: offset };
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
