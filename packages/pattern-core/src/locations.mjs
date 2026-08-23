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

import { looksLikeNoteString } from './pianoroll.mjs';
import { looksLikeShapeData } from './shape.mjs';

// Rewrites `code` so each pattern-position string/template literal is wrapped in mini(str, START),
// where START = `base` + the literal's first-content-char offset within `code`. Pass the block's
// document `start` as `base` to get document-absolute spans; the caller can then keep only spans
// that fall inside the block's own range (filtering out locations that leaked in from prebake or
// dynamic strings). Positions are computed from the ORIGINAL code (captured before any rewriting),
// so inserting the wrappers can't disturb the offsets we hand to mini().
export function injectLocations(code, base = 0) {
  const { lits, masked } = scanLiterals(code);
  let out = '';
  let prev = 0;
  for (const lit of lits) {
    // Position is judged on the MASKED code: what is inside other literals and comments is not
    // syntax, and a path like "Kick & Bass (Amin).wav" in the previous argument would otherwise
    // hand the paren scan a `)` to stop on, leaving this literal looking like a pattern.
    const before = masked.slice(0, lit.fullStart);
    const after = masked.slice(lit.fullEnd);
    if (lit.hasInterp || !isPatternPosition(before, after, code.slice(lit.contentStart, lit.fullEnd - 1))) continue;
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
  'synth', 'fx', 'scale', 'setscale', 'bus', 'bsend', 'as', 'midi', 'audio', 'input', 'lfo', 'midicc', 'midikeys', 'pianoroll',
  // The editor's own definition calls: an id to look one up by, then the drawn data the matching
  // builder takes. Underscored because nobody types them (see server.js's INTERNAL_BUILDERS); the
  // bare spellings stay listed so a buffer written before the rename still transpiles correctly.
  '_roll', 'roll',
  '_shape', 'shape',
  // ...and the preset definition: an id, the plugin the state came from, then the state blob.
  // `.preset("<a b>")` itself is deliberately NOT here - its argument is always a pattern of
  // names, so it wants highlighting exactly as pianoroll("<a b>") does.
  '_preset',
  // ...and the named sample pack: an id, then the list of files it is made of. `sp("<kit kit2>")`
  // itself is a pattern of names and stays a pattern, like s().
  '_pack',
  'param', // only the NAME (first argument); .param("Filter Freq", "0.2 0.8") patterns the value
]);
// Of those, the ones whose LATER arguments are also never patterns - a captured plugin-state blob
// (.synth("Serum 2", "<state>")), an lfo() options object, pianoroll()'s grid, roll()'s drawn
// notes, input()'s channel numbers (a hardware channel is wiring, not something that can vary per
// step). param() is excluded: its second argument is the value pattern.
const NAME_ONLY_CALLS = new Set(['synth', 'fx', 'lfo', 'pianoroll', '_roll', 'roll', '_shape', 'shape', '_preset', '_pack', 'midicc', 'midikeys', 'input']);

// Callee names whose METHOD form takes a literal name while the same-named builder takes mini:
// .se("hits/stab.wav") is a plain path (a "/" would be a mini operator) and .sr("stab") a plain
// recording name, but se("'hits/stab.wav'")/sr("stab*2") are patterns. The dot before the callee
// is what tells the two apart. .s() is NOT here: a pack name is a valid one-atom mini pattern,
// so the method form takes patterns too (note("c e g").s("<bd sd>")) and Sig#_asSampler samples
// the wrapped argument per onset.
const METHOD_NAME_ARG_CALLS = new Set(['se', 'sr']);

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
// The three `before` patterns below are all anchored to its END, but a regex search still tries
// every start position - so testing them against the whole prefix costs a scan of the entire
// buffer PER LITERAL, which on a patch carrying captured plugin state is tens of milliseconds an
// eval, taken out of the scheduler's 150ms lookahead. This returns the shortest suffix of
// `before` that can still contain any of their matches, which makes the cost proportional to the
// code around the literal instead of to the buffer.
//
// It's a superset of every match, not a guess: each pattern's match either contains an unmatched
// `(` - which, since nothing but whitespace, `[`, `,` or non-paren filler may follow it, is
// necessarily the LAST paren in `before` - or contains no paren at all and sits at the very end.
// So cutting at the last paren keeps them all. The cut then extends left over whitespace and an
// identifier, since the callee name is part of two of the matches, and stopping on a non-word
// character leaves the window starting on a real word boundary, so `\b` still means what it did.
function tailWindow(before) {
  let i = before.length;
  while (i > 0 && before[i - 1] !== '(' && before[i - 1] !== ')') i--;
  if (i === 0) {
    // No paren at all, so the two patterns that need one can't match either way; only the
    // later-argument comma test survives, and it's made of nothing but `,`, `[` and whitespace.
    let j = before.length;
    while (j > 0 && /[\s[,]/.test(before[j - 1])) j--;
    return before.slice(j);
  }
  i--; // include the paren itself
  while (i > 0 && /\s/.test(before[i - 1])) i--;
  while (i > 0 && /[\w$]/.test(before[i - 1])) i--;
  return before.slice(i);
}

export function isPatternPosition(before, after, text = '') {
  // Guard: the literal must be a COMPLETE argument/expression - immediately closed by ) , ; ] }
  // or end of input, or chaining a method (`"0 1".fast(2)`). If an operator follows (`n("0 1" + x)`)
  // the literal is only part of a larger expression, and wrapping it in mini() would change what
  // the code computes - so leave it plain (no highlight, but sound preserved). This gate makes the
  // transpile stricter than the client's old highlight-only predicate, because a false positive now
  // affects evaluation, not just highlighting.
  const method = /^\s*\.\s*[A-Za-z_$]/.test(after);
  const complete = method || /^\s*[).,;\]}]/.test(after) || /^\s*$/.test(after);
  if (!complete) return false;
  const near = tailWindow(before); // same matches as `before`, without rescanning the buffer
  // First argument: the callee sits immediately before the open paren (an optional `[` allows the
  // option in choose(["0", 3], …)). Its name decides.
  const first = near.match(/([A-Za-z_$][\w$]*)\s*\(\s*\[?\s*$/);
  if (first) {
    // pianoroll() and lfo() each take either DRAWN DATA or a pattern of names, in the same
    // argument position, and only the names are mini notation worth tagging. These are the two
    // calls whose argument is judged by what it SAYS rather than by which call it is - see
    // looksLikeNoteString / looksLikeShapeData.
    if (first[1] === 'pianoroll') return !!text.trim() && !looksLikeNoteString(text);
    if (first[1] === 'lfo') return !!text.trim() && !looksLikeShapeData(text);
    if (NAME_ARG_CALLS.has(first[1])) return false;
    if (METHOD_NAME_ARG_CALLS.has(first[1])) {
      // Method form only: scan left from the callee (a suffix of `before` starting inside `near`)
      // over whitespace for the chaining dot; the bare builder of the same name stays a pattern.
      let j = before.length - near.length + first.index;
      while (j > 0 && /\s/.test(before[j - 1])) j--;
      if (j > 0 && before[j - 1] === '.') return false;
    }
    return true;
  }
  // Later argument: a name-only call's arguments are never patterns. Matching requires no
  // parenthesis between that callee's `(` and here, so we only reject while still inside ITS
  // argument list - a nested call (fx("Reverb").speed("1 2")) has its own first-argument rule.
  if (/,\s*\[?\s*$/.test(near)) {
    const enclosing = near.match(/\b([A-Za-z_$][\w$]*)\s*\(\s*[^()]*$/);
    return !(enclosing && NAME_ONLY_CALLS.has(enclosing[1]));
  }
  if (method) return true;
  return false;
}

// Left-to-right scan collecting every string/template literal span, skipping comments so a quote
// inside `// …` or `/* … */` is never mistaken for a literal. Returns { lits, masked }: per literal
//   fullStart    index of the opening quote
//   contentStart index of the first content char (fullStart + 1) - the offset handed to mini()
//   fullEnd      index just past the closing quote
//   hasInterp    a template literal containing ${…} (its content isn't a static string - skip it)
// and `masked`, the same code with every literal's CONTENT and every comment's body blanked to
// spaces (newlines kept, so every offset still lines up) - the code as syntax alone, for the
// position tests, which must not read a paren or an operator that sits inside a string.
function scanLiterals(code) {
  const out = [];
  const mask = code.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (mask[k] !== '\n') mask[k] = ' ';
  };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      const from = i;
      i += 2;
      while (i < n && code[i] !== '\n') i++;
      blank(from, i);
      continue;
    }
    if (c === '/' && d === '*') {
      const from = i;
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      blank(from, Math.min(i, n));
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
        blank(fullStart + 1, i);
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
        blank(fullStart + 1, i);
        i++;
      }
      continue;
    }
    i++;
  }
  return { lits: out, masked: mask.join('') };
}
