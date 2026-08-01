// Source-location transpile for playback highlighting.
//
// A step emitted by a Sig carries the `loc` (source span) of the mini-notation atom it came from
// - but that span is relative to the bare mini string, and the string sits somewhere inside the
// editor buffer. To highlight the right characters we need spans relative to the DOCUMENT. The
// robust way (Strudel does the same via its transpiler) is to hand each mini string its own source
// offset at eval time: we rewrite every pattern-position string literal `"…"` in a block into
// `mini("…", START)`, where START is the offset of the string's first content character within the
// block. `mini(str, offset)` adds that offset to every atom span (see parseMini), so the emitted
// steps' locs are block-relative; the browser adds the block's document position (one anchor) to
// place them. Block-relative offsets (not document-absolute) match splitLabeledBlocks' convention,
// where positions inside a block's `code` equal positions in the source minus the block `start`.
//
// This is behaviour-preserving: the pattern builders (n/note/s/mini and the chain methods that
// take mini) already accept a Sig, and `mini("…")` of a genuine mini string is exactly what they
// build internally - we've just tagged it with a location. A literal we MISS simply isn't
// highlighted (graceful); the predicate is deliberately conservative so a non-mini string
// (.synth("Serum 2"), .scale("F minor"), a .param() name) is never wrapped and its value is
// untouched. Kept dependency-free: pattern-core takes no parser dependency, and the scan mirrors
// labels.mjs's string/comment/template-aware style.
//
// Caveat: a bare-numeric sample name - s("3") - becomes mini("3", …) whose numeric coercion yields
// the number 3 rather than the string "3". Sample packs aren't bare numbers in practice, so this is
// noted rather than special-cased.

// Rewrites `code` so each pattern-position string/template literal is wrapped in mini(str, START),
// where START = `base` + the literal's first-content-char offset within `code`. Pass the block's
// document `start` as `base` to get document-absolute spans; the caller can then keep only spans
// that fall inside the block's own range (filtering out locations that leaked in from prebake or
// dynamic strings). Positions are computed from the ORIGINAL code (captured before any rewriting),
// so inserting the wrappers can't disturb the offsets we hand to mini().
export function injectLocations(code, base = 0) {
  const lits = scanLiterals(code);
  let out = '';
  let prev = 0;
  for (const lit of lits) {
    const before = code.slice(0, lit.fullStart);
    const after = code.slice(lit.fullEnd);
    if (lit.hasInterp || !isPatternPosition(before, after)) continue;
    out += code.slice(prev, lit.fullStart);
    out += `mini(${code.slice(lit.fullStart, lit.fullEnd)}, ${base + lit.contentStart})`;
    prev = lit.fullEnd;
  }
  out += code.slice(prev);
  return out;
}

// Calls whose string arguments NAME something outside the pattern language - a plugin, a MIDI or
// audio device, a bus, a scale, a channel-strip field spec - rather than carrying mini notation.
// This is the closed set: it's fixed by what the API talks to in the outside world, whereas
// pattern positions grow with every new combinator. So the predicate below denies from this list
// and treats everything else as a pattern - a new builder (choose(), and whatever comes next)
// highlights its arguments with no entry here. Add a call only when its string is a lookup key.
const NAME_ARG_CALLS = new Set([
  'synth', 'fx', 'scale', 'bus', 'bsend', 'as', 'midi', 'audio', 'lfo', 'midicc', 'midikeys', 'pianoroll',
  'param', // only the NAME (first argument); .param("Filter Freq", "0.2 0.8") patterns the value
]);
// Of those, the ones whose LATER arguments are also never patterns - a captured plugin-state blob
// (.synth("Serum 2", "<state>")), an lfo() options object, pianoroll()'s grid. param() is excluded:
// its second argument is the value pattern.
const NAME_ONLY_CALLS = new Set(['synth', 'fx', 'lfo', 'pianoroll', 'midicc', 'midikeys']);

// Is a string literal here used as a mini-notation pattern (vs a plugin/scale/param-name lookup)?
// `before` is the code up to the opening quote, `after` the code from just past the closing quote.
// In argument position the default is "pattern" (as in Strudel, where mini notation is what a
// string in a pattern expression means) and NAME_ARG_CALLS is what pulls a literal back out:
//   - a first argument, to a builder or a chain method - n("0 1"), .speed("2 1"), choose("1", "-1"),
//     including the option in a [option, weight] pair
//   - a later argument - .param("Filter Freq", "0.2 0.8") - unless the call is name-only
//   - a string that immediately chains a method (`"0 0.5 1".gte(0.5)`)
// OUTSIDE argument position the default flips to conservative: a bare literal (`const p = "…"`)
// is left alone, since there's no callee to check and it may well be a name held in a variable.
export function isPatternPosition(before, after) {
  // Guard: the literal must be a COMPLETE argument/expression - immediately closed by ) , ; ] }
  // or end of input, or chaining a method (`"0 1".fast(2)`). If an operator follows (`n("0 1" + x)`)
  // the literal is only part of a larger expression, and wrapping it in mini() would change what
  // the code computes - so leave it plain (no highlight, but sound preserved). This gate makes the
  // transpile stricter than the client's old highlight-only predicate, because a false positive now
  // affects evaluation, not just highlighting.
  const method = /^\s*\.\s*[A-Za-z_$]/.test(after);
  const complete = method || /^\s*[).,;\]}]/.test(after) || /^\s*$/.test(after);
  if (!complete) return false;
  // First argument: the callee sits immediately before the open paren (an optional `[` allows the
  // option in choose(["0", 3], …)). Its name decides.
  const first = before.match(/([A-Za-z_$][\w$]*)\s*\(\s*\[?\s*$/);
  if (first) return !NAME_ARG_CALLS.has(first[1]);
  // Later argument: a name-only call's arguments are never patterns. Matching requires no
  // parenthesis between that callee's `(` and here, so we only reject while still inside ITS
  // argument list - a nested call (fx("Reverb").speed("1 2")) has its own first-argument rule.
  if (/,\s*\[?\s*$/.test(before)) {
    const enclosing = before.match(/\b([A-Za-z_$][\w$]*)\s*\(\s*[^()]*$/);
    return !(enclosing && NAME_ONLY_CALLS.has(enclosing[1]));
  }
  if (method) return true;
  return false;
}

// Left-to-right scan collecting every string/template literal span, skipping comments so a quote
// inside `// …` or `/* … */` is never mistaken for a literal. Returns, per literal:
//   fullStart    index of the opening quote
//   contentStart index of the first content char (fullStart + 1) - the offset handed to mini()
//   fullEnd      index just past the closing quote
//   hasInterp    a template literal containing ${…} (its content isn't a static string - skip it)
function scanLiterals(code) {
  const out = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      i += 2;
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const fullStart = i;
      i++;
      while (i < n && code[i] !== c && code[i] !== '\n') {
        if (code[i] === '\\') i++;
        i++;
      }
      // Only a properly closed quote is a literal; an unterminated one (newline/EOF) is left alone.
      if (code[i] === c) {
        out.push({ fullStart, contentStart: fullStart + 1, fullEnd: i + 1, hasInterp: false });
        i++;
      }
      continue;
    }
    if (c === '`') {
      const fullStart = i;
      i++;
      let hasInterp = false;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') hasInterp = true;
        i++;
      }
      if (code[i] === '`') {
        out.push({ fullStart, contentStart: fullStart + 1, fullEnd: i + 1, hasInterp });
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}
