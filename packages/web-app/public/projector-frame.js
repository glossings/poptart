'use strict';

// Shaping a projector frame: turning a deck's raw buffer into the line that goes on a wall.
//
// This runs in the EDITOR, once per frame, and what it produces is what every consumer gets -
// the projector window, and anything subscribed to the feed (GET /api/projector/events). That is
// deliberate: a consumer should receive a string it can draw, not a buffer plus the rules for
// cutting one down, and nobody downstream wants the hundreds of kilobytes of base64 a patch
// carries once its plugin state is written out inline.
//
// Pure, and loaded as a plain script by index.html - see projector.test.js.
// ---------------------------------------------------------------------------------------------

/**
 * Apply `ranges` - each [from, to] or [from, to, replacement] - to `text`, carrying `spans`
 * through. The editor sends the places its own data sits (see client.js's projectorOmitRanges):
 * definitions blocks and the arrangement come out entirely, a captured plugin state or a page of
 * drawn notes comes down to an ellipsis.
 *
 * Overlapping ranges are resolved widest-first, because a blob inside a definitions block that is
 * going anyway must not cut a hole in the hole. A span is intersected with each surviving piece
 * rather than moved whole, so a lit atom inside a range vanishes with it and one that straddles
 * an edge keeps the half that is left, instead of landing somewhere arbitrary.
 */
function spliceRanges(text, spans = [], ranges = []) {
  const edits = [];
  for (const [s, e, replacement = ''] of ranges) {
    const from = Math.max(0, Math.min(text.length, s));
    const to = Math.max(0, Math.min(text.length, e));
    if (to > from) edits.push([from, to, String(replacement)]);
  }
  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const pieces = []; // [start in the original, end in the original, start in the output]
  let out = '';
  let at = 0;
  for (const [from, to, replacement] of edits) {
    if (from < at) continue; // inside one already applied
    if (from > at) {
      pieces.push([at, from, out.length]);
      out += text.slice(at, from);
    }
    out += replacement;
    at = to;
  }
  if (at < text.length) {
    pieces.push([at, text.length, out.length]);
    out += text.slice(at);
  }
  const moved = [];
  for (const [s, e] of spans) {
    for (const [from, to, outAt] of pieces) {
      const lo = Math.max(s, from);
      const hi = Math.min(e, to);
      if (hi > lo) moved.push([outAt + (lo - from), outAt + (hi - from)]);
    }
  }
  return { text: out, spans: moved };
}

/**
 * Collapse every run of whitespace in `text` to a single space, trimming the ends, and carry
 * `spans` (pairs of [start, end) offsets into `text`) through to the collapsed string.
 *
 * The map is built as the output is: `at[i]` is where the original character i landed, so a span
 * is remapped by looking up both its ends. A whitespace character maps to where the space it
 * folds into will go, which is what makes an end offset sitting on a newline come out as the end
 * of the word before it rather than swallowing the separator.
 */
function collapseWithSpans(text, spans = []) {
  const at = new Array(text.length + 1);
  let out = '';
  let pending = false; // whitespace seen but not yet emitted (dropped outright at the very start)
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      at[i] = out.length;
      pending = out.length > 0;
      continue;
    }
    if (pending) {
      out += ' ';
      pending = false;
    }
    at[i] = out.length;
    out += text[i];
  }
  at[text.length] = out.length;
  const moved = [];
  for (const [s, e] of spans) {
    if (!(s >= 0 && e <= text.length && s < e)) continue; // a span from a stale frame
    const from = at[s];
    const to = at[e];
    if (to > from) moved.push([from, to]);
  }
  return { text: out, spans: moved };
}

/**
 * The ends tidied - what taking a block off the foot of a buffer leaves behind. Collapsing does
 * this on its own; uncollapsed, without it, the wall carries the blank lines a definitions block
 * used to sit on.
 */
function trimWithSpans(text, spans = []) {
  const lead = /^\s*/.exec(text)[0].length;
  const tail = text.length - /\s*$/.exec(text)[0].length;
  return spliceRanges(text, spans, [[0, lead], [Math.max(lead, tail), text.length]]);
}

/**
 * Sorted, non-overlapping, inside [0, len) - what a renderer can walk straight through. Lit spans
 * arrive one list per track and a chord revisits the same atom, so duplicates are the normal case
 * rather than the exception.
 *
 * Only spans that really OVERLAP are folded together: two atoms that happen to sit against each
 * other get a box each, the way the editor draws them.
 */
function mergeSpans(spans, len) {
  const clean = [];
  for (const [s, e] of spans) {
    const from = Math.max(0, Math.min(len, s));
    const to = Math.max(0, Math.min(len, e));
    if (to > from) clean.push([from, to]);
  }
  clean.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const span of clean) {
    const last = out[out.length - 1];
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

/**
 * One deck, from buffer to the string that goes out: the editor's own data removed, the whole
 * thing optionally run together, the sounding spans carried through every step and tidied.
 *
 * `spans` on the way out are offsets into the text on the way out - the only coordinates any
 * consumer ever sees.
 */
function shapeProjectorDeck({ deck, text, spans = [], omit = [] }, collapse) {
  let shaped = spliceRanges(text ?? '', spans, omit);
  shaped = collapse
    ? collapseWithSpans(shaped.text, shaped.spans)
    : trimWithSpans(shaped.text, shaped.spans);
  return { deck, text: shaped.text, spans: mergeSpans(shaped.spans, shaped.text.length) };
}

/**
 * The decks as ONE string with one list of ranges into it - what a subscriber to the feed reads
 * (see server.js's projector feed).
 *
 * Flattening here rather than at the far end is the whole of what a consumer is spared: which
 * decks there are, which of them is playing, and how to rebase one deck's offsets past the length
 * of the one in front of it are all facts about poptart, and none of them belong in a reader that
 * is only being asked to draw a string.
 *
 * Collapsed, the decks are separated by two spaces, because the promise of collapsing is one
 * line; uncollapsed, by a blank line.
 */
function flattenProjectorFrame(decks, collapse) {
  const parts = (Array.isArray(decks) ? decks : [])
    .map((d) => (collapse ? collapseWithSpans(d?.text ?? '', d?.spans ?? []) : {
      text: d?.text ?? '', spans: d?.spans ?? [],
    }))
    .filter((d) => d.text.length);
  const gap = collapse ? '  ' : '\n\n';
  let text = '';
  const ranges = [];
  for (const part of parts) {
    const base = text.length;
    text += (base ? gap : '') + part.text;
    const at = base ? base + gap.length : 0;
    for (const [s, e] of part.spans) ranges.push([at + s, at + e]);
  }
  return { text, ranges: mergeSpans(ranges, text.length) };
}

// Also required by server.js, which flattens a frame per subscriber - one implementation, so the
// window and the feed can never disagree about what the code says.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    spliceRanges, collapseWithSpans, trimWithSpans, mergeSpans,
    shapeProjectorDeck, flattenProjectorFrame,
  };
}
