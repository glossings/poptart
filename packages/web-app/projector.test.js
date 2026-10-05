'use strict';

// The projector (F1) - the two pieces of it that are logic rather than layout.
//
// collapseWithSpans is the one that can go wrong quietly: the text it returns is what is on the
// wall, and the spans it returns are the boxes drawn on that text. If the two ever disagree the
// box lands on the wrong word, which looks exactly like the highlighter being broken - so every
// case here checks the remapped span by SLICING the collapsed string with it, never by its
// numbers alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// projector-frame.js is a plain browser script of pure functions - the shaping the EDITOR does
// before a frame goes anywhere, so every consumer gets the same string.
const FRAME_SRC = fs.readFileSync(path.join(__dirname, 'public', 'projector-frame.js'), 'utf8');
// eslint-disable-next-line no-new-func
const { collapseWithSpans, mergeSpans, spliceRanges, trimWithSpans } = new Function(
  `${FRAME_SRC}; return { collapseWithSpans, mergeSpans, spliceRanges, trimWithSpans };`)();

// client.js is the whole editor and cannot be loaded here, so the one function under test is read
// out of its source - the same trick highlight-grid.test.js uses on server.js.
function sliceFn(file, name) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in ${file} - this test needs updating`);
  let depth = 0;
  let end = src.indexOf('{', at);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, end)}; return ${name};`)();
}
const projectorSize = sliceFn(path.join('public', 'client.js'), 'projectorSize');

/** What a span actually covers once the text has been run together. */
const lit = (text, spans) => spans.map(([s, e]) => text.slice(s, e));

// ---------------------------------------------------------------------------------------------
// Running the code together
// ---------------------------------------------------------------------------------------------

test('every run of whitespace becomes one space, and the ends are trimmed', () => {
  const src = '\n  kick: s("bd*4")\n    .gain(0.8)\n\n  hat:\ts("hh*8")\n';
  assert.equal(collapseWithSpans(src).text, 'kick: s("bd*4") .gain(0.8) hat: s("hh*8")');
});

test('text with nothing to collapse comes back as it was', () => {
  const { text, spans } = collapseWithSpans('s("bd sd")', [[3, 5]]);
  assert.equal(text, 's("bd sd")');
  assert.deepEqual(lit(text, spans), ['bd']);
});

test('a span still covers its own atom after the lines in front of it are gone', () => {
  const src = 'kick: s("bd sd")\n  .gain(0.8)\n\nhat: s("hh hh")';
  // "hh" the second time round, counted in the ORIGINAL text - what the highlighter hands over.
  const at = src.lastIndexOf('hh');
  const { text, spans } = collapseWithSpans(src, [[at, at + 2]]);
  assert.equal(text, 'kick: s("bd sd") .gain(0.8) hat: s("hh hh")');
  assert.deepEqual(spans, [[text.lastIndexOf('hh'), text.lastIndexOf('hh') + 2]]);
  assert.deepEqual(lit(text, spans), ['hh']);
});

test('a span ending at a line break keeps its own characters, not the space the break became', () => {
  const src = 'a("bd")\nb("sd")';
  const { text, spans } = collapseWithSpans(src, [[0, 7]]);
  assert.equal(text, 'a("bd") b("sd")');
  assert.deepEqual(lit(text, spans), ['a("bd")']);
});

test('a span that spreads over a line break keeps the space the break became', () => {
  const src = 'bd\n\n   sd';
  const { text, spans } = collapseWithSpans(src, [[0, src.length]]);
  assert.equal(text, 'bd sd');
  assert.deepEqual(lit(text, spans), ['bd sd']);
});

test('indentation in front of a lit atom is not counted into it', () => {
  const src = 'x:\n      s("bd")';
  const at = src.indexOf('s("bd")');
  const { text, spans } = collapseWithSpans(src, [[at, at + 7]]);
  assert.equal(text, 'x: s("bd")');
  assert.deepEqual(lit(text, spans), ['s("bd")']);
});

test('spans from a frame older than the text are dropped rather than clamped onto it', () => {
  // The buffer was edited between the highlighter's grid and this frame: a span past the end
  // would otherwise draw a box around the last word of a patch it does not belong to.
  const { spans } = collapseWithSpans('s("bd")', [[3, 5], [40, 44], [5, 5], [-2, 3]]);
  assert.deepEqual(spans, [[3, 5]]);
});

test('an empty patch collapses to nothing without throwing', () => {
  assert.deepEqual(collapseWithSpans('', []), { text: '', spans: [] });
  assert.deepEqual(collapseWithSpans('   \n\n  ', [[0, 3]]), { text: '', spans: [] });
});

// ---------------------------------------------------------------------------------------------
// Leaving the editor's own data out
// ---------------------------------------------------------------------------------------------

test('a cut range goes, and the code after it moves up with its boxes intact', () => {
  const src = 'kick: s("bd*4")\n_roll(0, "c3 e3")\nhat: s("hh*8")\n';
  const at = src.indexOf('hh*8');
  const cut = [src.indexOf('_roll'), src.indexOf('hat:')];
  const { text, spans } = spliceRanges(src, [[at, at + 4]], [cut]);
  assert.equal(text, 'kick: s("bd*4")\nhat: s("hh*8")\n');
  assert.deepEqual(lit(text, spans), ['hh*8']);
});

test('a box inside a cut goes with it rather than landing somewhere else', () => {
  // The highlighter never lights a definition, but a frame from before an edit might name one.
  const src = 'a: s("bd")\n_roll(0, "c3")\n';
  const { text, spans } = spliceRanges(src, [[20, 22]], [[11, src.length]]);
  assert.equal(text, 'a: s("bd")\n');
  assert.deepEqual(spans, []);
});

test('several cuts come out in one pass, in any order, overlapping or not', () => {
  const src = 'AA 11 BB 22 CC';
  const { text } = spliceRanges(src, [], [[9, 12], [0, 3], [5, 6], [4, 6]]);
  assert.equal(text, '1BB CC');
});

test('a span straddling a cut keeps the half that is left', () => {
  const { text, spans } = spliceRanges('abcdef', [[1, 5]], [[2, 4]]);
  assert.equal(text, 'abef');
  assert.deepEqual(lit(text, spans), ['b', 'e']);
});

test('nothing to cut leaves the text and its boxes exactly as they were', () => {
  const { text, spans } = spliceRanges('a: s("bd")', [[6, 8]], []);
  assert.equal(text, 'a: s("bd")');
  assert.deepEqual(lit(text, spans), ['bd']);
});

test('a blob inside live code comes down to an ellipsis, leaving the call around it', () => {
  // The case that makes the projector usable at all: a patch with its plugin state written out
  // inline runs to hundreds of kilobytes of base64, and .fx("Kickstart 2") is the readable part.
  const src = 'pad: s("x").fx("Kickstart 2", { state: "H4sIAAAA" }).co(8)';
  const at = src.indexOf('"x"');
  const { text, spans } = spliceRanges(src, [[at, at + 3]], [[src.indexOf(','), src.indexOf('}') + 1]]);
  assert.equal(text, 'pad: s("x").fx("Kickstart 2").co(8)');
  assert.deepEqual(lit(text, spans), ['"x"']);
});

test('a replacement moves the boxes after it by its own length, not the hole it filled', () => {
  const src = 'pianoroll("60,0,4,0.8 62,4,4,0.8").s("pad")';
  const at = src.indexOf('"pad"');
  const data = [src.indexOf('"60'), src.indexOf('").s') + 1, '"⋯"'];
  const { text, spans } = spliceRanges(src, [[at, at + 5]], [data]);
  assert.equal(text, 'pianoroll("⋯").s("pad")');
  assert.deepEqual(lit(text, spans), ['"pad"']);
});

test('a blob inside a block that is going anyway does not cut a hole in the hole', () => {
  // Both passes find the same base64: the definitions run contains it, and the state pattern
  // matches it on its own. Widest first, and the narrow one is dropped.
  const src = 'a: s("bd")\n_preset("p", "Serum 2", { state: "H4sI" })\n';
  const run = [src.indexOf('_preset'), src.length];
  const blob = [src.indexOf(', { state'), src.indexOf('})') + 1];
  assert.equal(spliceRanges(src, [], [blob, run]).text, 'a: s("bd")\n');
  assert.equal(spliceRanges(src, [], [run, blob]).text, 'a: s("bd")\n');
});

test('the blank lines a cut block leaves at the foot are trimmed off', () => {
  // Uncollapsed, this is the difference between a patch on the wall and a patch with a hole
  // under it where the definitions used to be.
  const { text, spans } = trimWithSpans('\n\nkick: s("bd")\n\n\n', [[2, 6]]);
  assert.equal(text, 'kick: s("bd")');
  assert.deepEqual(lit(text, spans), ['kick']);
});

test('a deck that is nothing but definitions trims away to nothing', () => {
  assert.deepEqual(trimWithSpans('\n   \n\n', []), { text: '', spans: [] });
});

// ---------------------------------------------------------------------------------------------
// The boxes
// ---------------------------------------------------------------------------------------------

test('the spans come out sorted, and duplicates fold into one box', () => {
  // One atom reached through two tracks' regions, and a chord lighting the same location twice.
  assert.deepEqual(mergeSpans([[10, 12], [3, 5], [10, 12]], 20), [[3, 5], [10, 12]]);
});

test('overlapping spans merge, but two atoms sitting against each other get a box each', () => {
  assert.deepEqual(mergeSpans([[0, 4], [2, 6]], 10), [[0, 6]]);
  assert.deepEqual(mergeSpans([[0, 2], [2, 4]], 10), [[0, 2], [2, 4]]);
});

test('spans are held inside the text, and empty ones never reach the renderer', () => {
  assert.deepEqual(mergeSpans([[8, 20], [-5, 2], [4, 4]], 10), [[0, 2], [8, 10]]);
});

// ---------------------------------------------------------------------------------------------
// The whole shaping, which is what a consumer of the feed receives
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-new-func
const shapeProjectorDeck = new Function(`${FRAME_SRC}; return shapeProjectorDeck;`)();

test('a deck comes out as a string and offsets into THAT string', () => {
  const src = 'kick: s("bd*4").fx("K", { state: "H4sI" })\n\n_roll("r", "60,0,4,0.8")\n';
  const at = src.indexOf('bd*4');
  const deck = shapeProjectorDeck({
    deck: 'a',
    text: src,
    spans: [[at, at + 4]],
    omit: [
      [src.indexOf(', { state'), src.indexOf('})') + 1],
      [src.indexOf('_roll'), src.length],
    ],
  }, true);
  assert.equal(deck.deck, 'a');
  assert.equal(deck.text, 'kick: s("bd*4").fx("K")');
  // The contract the feed promises: slicing the text by a span gives the atom that is sounding.
  assert.deepEqual(lit(deck.text, deck.spans), ['bd*4']);
});

test('uncollapsed keeps the line breaks, and the spans still land', () => {
  const src = 'a: s("bd")\n  .gain(0.5)\n';
  const at = src.indexOf('0.5');
  const deck = shapeProjectorDeck({ deck: 'a', text: src, spans: [[at, at + 3]] }, false);
  assert.equal(deck.text, 'a: s("bd")\n  .gain(0.5)');
  assert.deepEqual(lit(deck.text, deck.spans), ['0.5']);
});

test('a deck with nothing sounding is a string and an empty list, never a missing key', () => {
  const deck = shapeProjectorDeck({ deck: 'b', text: 'b: s("hh")' }, true);
  assert.deepEqual(deck, { deck: 'b', text: 'b: s("hh")', spans: [] });
});

// eslint-disable-next-line no-new-func
const flattenProjectorFrame = new Function(`${FRAME_SRC}; return flattenProjectorFrame;`)();

test('two decks become one string, the second deck\'s ranges moved onto it', () => {
  const frame = flattenProjectorFrame([
    { deck: 'a', text: 'kick: s("bd")', spans: [[9, 11]] },
    { deck: 'b', text: 'hat: s("hh")', spans: [[8, 10]] },
  ], true);
  assert.equal(frame.text, 'kick: s("bd")  hat: s("hh")');
  assert.deepEqual(frame.ranges.map(([s, e]) => frame.text.slice(s, e)), ['bd', 'hh']);
});

test('uncollapsed, the decks are a blank line apart and the line breaks survive', () => {
  const frame = flattenProjectorFrame([
    { deck: 'a', text: 'kick:\n  s("bd")', spans: [[11, 13]] },
    { deck: 'b', text: 'hat: s("hh")', spans: [] },
  ], false);
  assert.equal(frame.text, 'kick:\n  s("bd")\n\nhat: s("hh")');
  assert.deepEqual(frame.ranges.map(([s, e]) => frame.text.slice(s, e)), ['bd']);
});

test('an empty deck takes no separator with it', () => {
  // A deck that shaped away to nothing (all definitions, say) must not leave a gap at the front
  // of the frame, which would push every range along by two.
  const frame = flattenProjectorFrame([
    { deck: 'a', text: '', spans: [] },
    { deck: 'b', text: 'hat: s("hh")', spans: [[8, 10]] },
  ], true);
  assert.equal(frame.text, 'hat: s("hh")');
  assert.deepEqual(frame.ranges.map(([s, e]) => frame.text.slice(s, e)), ['hh']);
});

test('no decks at all is an empty string and no ranges, never null', () => {
  assert.deepEqual(flattenProjectorFrame([], true), { text: '', ranges: [] });
  assert.deepEqual(flattenProjectorFrame(undefined, false), { text: '', ranges: [] });
});

// ---------------------------------------------------------------------------------------------
// The resolution setting
// ---------------------------------------------------------------------------------------------

test('a resolution is the size the window opens at', () => {
  assert.deepEqual(projectorSize('1920x1080', 1512, 945), { width: 1920, height: 1080 });
  assert.deepEqual(projectorSize('3840x2160', 1512, 945), { width: 3840, height: 2160 });
});

test('"screen" is whichever screen poptart is on', () => {
  assert.deepEqual(projectorSize('screen', 1512, 945), { width: 1512, height: 945 });
});

test('a setting that is not a resolution opens the default, never a window of nothing', () => {
  for (const bad of [null, undefined, '', 'fullscreen', '1920', 'x', '1920xX']) {
    assert.deepEqual(projectorSize(bad, 1512, 945), { width: 1920, height: 1080 },
      `${bad} should fall back`);
  }
});
