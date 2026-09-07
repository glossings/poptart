'use strict';

// The arrangement painter's time region (public/client.js): the span of song the copy / cut /
// paste / duplicate / delete ops act on, and how a clip that only partly overlaps it is treated.
//
// The two edge rules are the whole substance of the feature and neither is visible in the UI until
// it is wrong: copying bars 8..16 of a 32-bar clip has to yield eight bars, and clearing the middle
// of a clip has to leave the two ends still sounding. Both are pure list arithmetic, lifted out of
// the shipped client.js rather than copied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const LIFTED = ['arTimeRegion', 'arClipsIn', 'arClearTime'].map(grab).join('\n\n');

/** The lifted region functions over a fake painter. */
function painter({ clips = [], sel = [], regionSpan = null, selRegion = null } = {}) {
  const arState = { clips, sel: new Set(sel), regionSpan, selRegion };
  // eslint-disable-next-line no-new-func
  const fns = new Function('arState', `${LIFTED}\nreturn { arTimeRegion, arClipsIn, arClearTime };`)(arState);
  return { fns, arState };
}

const clip = (label, start, len, roll = null) => ({ label, start, len, roll });
const shape = (cs) => cs.map((c) => [c.label, c.start, c.len]);

// ---------------------------------------------------------------------------------------------
// What marks a region
// ---------------------------------------------------------------------------------------------

test('nothing marked is no region at all', () => {
  assert.equal(painter().fns.arTimeRegion(), null);
});

test('selected clips mark the span they cover', () => {
  const a = clip('drums', 4, 4);
  const b = clip('bass', 12, 2);
  assert.deepEqual(painter({ clips: [a, b], sel: [a, b] }).fns.arTimeRegion(), [4, 14]);
});

test('a dragged span marks one, and unions with any selected clips', () => {
  const a = clip('drums', 4, 4);
  assert.deepEqual(painter({ regionSpan: [16, 24] }).fns.arTimeRegion(), [16, 24]);
  assert.deepEqual(painter({ clips: [a], sel: [a], regionSpan: [16, 24] }).fns.arTimeRegion(), [4, 24]);
});

test('a picked loop region marks one too - that is the point of picking it', () => {
  const chorus = { name: 'chorus', start: 8, end: 16 };
  assert.deepEqual(painter({ selRegion: chorus }).fns.arTimeRegion(), [8, 16]);
  // and it unions like the rest, so a loop plus a clip past it covers both
  const tail = clip('outro', 20, 4);
  assert.deepEqual(painter({ clips: [tail], sel: [tail], selRegion: chorus }).fns.arTimeRegion(), [8, 24]);
});

test('a zero-width mark is not a region', () => {
  assert.equal(painter({ regionSpan: [8, 8] }).fns.arTimeRegion(), null);
  assert.equal(painter({ selRegion: { name: 'x', start: 4, end: 4 } }).fns.arTimeRegion(), null);
});

// ---------------------------------------------------------------------------------------------
// Copying: what comes out of a span
// ---------------------------------------------------------------------------------------------

test('clips are trimmed to the span and their starts measured from it', () => {
  const { fns } = painter({
    clips: [
      clip('long', 0, 32), // straddles the whole span
      clip('inside', 10, 2), // wholly within
      clip('head', 6, 4), // overlaps the front edge
      clip('tail', 14, 4), // overlaps the back edge
      clip('before', 0, 4), // clear of it
      clip('after', 20, 4),
    ],
  });
  assert.deepEqual(shape(fns.arClipsIn(8, 16)), [
    ['long', 0, 8], // eight bars, not thirty-two
    ['inside', 2, 2],
    ['head', 0, 2], // only the part inside, at the span's start
    ['tail', 6, 2],
  ]);
});

test('a clip merely touching an edge is not in the span', () => {
  const { fns } = painter({ clips: [clip('a', 4, 4), clip('b', 16, 4)] });
  assert.deepEqual(fns.arClipsIn(8, 16), [], 'ending exactly at 8 and starting exactly at 16');
});

test('a copied section keeps each clip on its own track, roll binding and all', () => {
  const { fns } = painter({ clips: [clip('kick', 8, 4), clip('hat', 8, 4, 'fill')] });
  const copied = fns.arClipsIn(8, 12);
  assert.deepEqual(copied.map((c) => c.label), ['kick', 'hat'], 'the label IS the row now');
  assert.deepEqual(copied.map((c) => c.roll), [null, 'fill'], 'a bound clip pastes still bound');
});

// ---------------------------------------------------------------------------------------------
// Clearing: what a cut leaves behind
// ---------------------------------------------------------------------------------------------

test('clearing empties the span without moving anything else', () => {
  const { fns, arState } = painter({
    clips: [clip('before', 0, 4), clip('inside', 10, 2), clip('after', 20, 4)],
  });
  fns.arClearTime(8, 16);
  assert.deepEqual(shape(arState.clips), [['before', 0, 4], ['after', 20, 4]],
    'the clips outside stay exactly where they were - this is not a ripple delete');
});

test('a clip lying across the whole span is split in two', () => {
  const { fns, arState } = painter({ clips: [clip('long', 0, 32)] });
  fns.arClearTime(8, 16);
  assert.deepEqual(shape(arState.clips), [['long', 0, 8], ['long', 16, 16]],
    'it was sounding either side of what was taken, so both ends have to remain');
});

test('a clip overlapping one edge is trimmed to what survives', () => {
  const head = painter({ clips: [clip('head', 4, 8)] }); // 4..12, region 8..16
  head.fns.arClearTime(8, 16);
  assert.deepEqual(shape(head.arState.clips), [['head', 4, 4]]);

  const tail = painter({ clips: [clip('tail', 12, 8)] }); // 12..20
  tail.fns.arClearTime(8, 16);
  assert.deepEqual(shape(tail.arState.clips), [['tail', 16, 4]]);
});

test('clearing drops the selection, since what was selected may no longer exist', () => {
  const c = clip('gone', 10, 2);
  const { fns, arState } = painter({ clips: [c], sel: [c] });
  fns.arClearTime(8, 16);
  assert.equal(arState.clips.length, 0);
  assert.equal(arState.sel.size, 0);
});

// ---------------------------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------------------------

test('the loops strip drags a span with the arrow and a loop with the pencil', () => {
  assert.match(SRC, /arState\.drag = \{ kind: 'region', a, b: a \+ arCell\(\) \}/, 'pencil still draws a loop');
  assert.match(SRC, /arState\.drag = \{ kind: 'timeSel', a: Math\.max\(0, arBarsOf\(x\)\), x0: x \}/, 'arrow drags a span');
});

test('the clipboard ops are bound, and the ripple ops keep their own keys', () => {
  assert.match(SRC, /arCopyTime\(\{ cut: e\.key\.toLowerCase\(\) === 'x' \}\)/);
  assert.match(SRC, /e\.key\.toLowerCase\(\) === 'v'\) \{ arPasteTime\(\)/);
  assert.match(SRC, /\(e\.key === 'Delete' \|\| e\.key === 'Backspace'\)\) \{ arTimeDelete\(\)/);
  assert.match(SRC, /e\.key\.toLowerCase\(\) === 'd'\) \{ arTimeDuplicate\(\)/);
});

test('the ops that consume a span let go of the loop region that marked it', () => {
  // Otherwise the insert stretches that loop over both copies and the next press acts on double
  // the span - the gesture would grow instead of walking.
  const dup = grab('arTimeDuplicate');
  assert.match(dup, /arState\.selRegion = null;/);
  const del = grab('arTimeDelete');
  assert.match(del, /arState\.selRegion = null;/);
  // ...and escape can dismiss it, or the band it lights would be stuck on screen
  assert.match(SRC, /if \(arState\.regionSpan \|\| arState\.sel\.size \|\| arState\.selRegion \|\| arState\.autoSel\) \{/);
});
