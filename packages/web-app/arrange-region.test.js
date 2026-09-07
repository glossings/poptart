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
  assert.match(SRC, /if \(arState\.regionSpan \|\| arState\.sel\.size \|\| arState\.selRegion \|\| arState\.autoSel \|\| arState\.insert != null\) \{/);
});

// ---------------------------------------------------------------------------------------------
// Split and join
//
// The two edits a painted arrangement is mostly made of, and the two whose arithmetic is easy to
// get subtly wrong: a split has to leave the same music sounding (two clips back to back, same
// roll), and a join has to swallow the gaps between what it joins without moving anything.
// ---------------------------------------------------------------------------------------------

/** The split/join ops over a fake painter. Writes and redraws are counted, not performed. */
function ops({ clips = [], sel = [], insert = null, regionSpan = null, track = null } = {}) {
  const arState = { clips, sel: new Set(sel), insert, regionSpan, track: track ?? clips[0]?.label ?? null };
  const logged = [];
  const env = {
    arState,
    logLine: (line) => logged.push(line),
    writeArrangeCall: () => {},
    drawArrange: () => {},
    arTrackRoll: () => null,
  };
  const LIFT = ['arSplitPoints', 'arOpTargets', 'arSplitClips', 'arJoinClips'].map(grab).join('\n\n');
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const build = new Function(...keys, `${LIFT}\nreturn { arSplitClips, arJoinClips, arSplitPoints, arOpTargets };`);
  return { fns: build(...keys.map((k) => env[k])), arState, logged };
}

const clips = (st) => [...st.clips]
  .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || a.start - b.start)
  .map((c) => [c.label, c.start, c.len, c.roll ?? null]);

test('a split at the marker makes two clips of one, same roll, same music', () => {
  const a = { label: 'kick', start: 0, len: 8, roll: null };
  const { fns, arState } = ops({ clips: [a], sel: [a], insert: 3 });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 3, null], ['kick', 3, 5, null]]);
  assert.equal(arState.sel.size, 2, 'the pieces are what you are holding afterwards');
});

test('a bound clip splits into two clips of the same roll', () => {
  const a = { label: 'kick', start: 4, len: 8, roll: 'fill' };
  const { fns, arState } = ops({ clips: [a], sel: [a], insert: 8 });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 4, 4, 'fill'], ['kick', 8, 4, 'fill']]);
});

test('a marked span splits at BOTH its edges, on every track it crosses', () => {
  const k = { label: 'kick', start: 0, len: 16, roll: null };
  const b = { label: 'bass', start: 0, len: 16, roll: null };
  const { fns, arState } = ops({ clips: [k, b], regionSpan: [4, 8] });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [
    ['bass', 0, 4, null], ['bass', 4, 4, null], ['bass', 8, 8, null],
    ['kick', 0, 4, null], ['kick', 4, 4, null], ['kick', 8, 8, null],
  ]);
});

test('with only a marker down, the split is the track you are on - not every track at once', () => {
  const k = { label: 'kick', start: 0, len: 8, roll: null };
  const b = { label: 'bass', start: 0, len: 8, roll: null };
  const { fns, arState } = ops({ clips: [k, b], insert: 4, track: 'kick' });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['bass', 0, 8, null], ['kick', 0, 4, null], ['kick', 4, 4, null]]);
});

test('a marker that no clip crosses cuts nothing, and says so rather than erroring', () => {
  const a = { label: 'kick', start: 0, len: 4, roll: null };
  const { fns, arState, logged } = ops({ clips: [a], sel: [a], insert: 4 }); // exactly its end
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 4, null]], 'an edge is not inside');
  assert.match(logged.join('\n'), /no clip crosses the marker/);
});

test('join makes one clip from the first onset to the last end, gaps swallowed', () => {
  const a = { label: 'kick', start: 0, len: 4, roll: null };
  const b = { label: 'kick', start: 12, len: 4, roll: null };
  const { fns, arState } = ops({ clips: [a, b], sel: [a, b] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['kick', 0, 16, null]]);
});

test('join is per track: two rows joined at once stay two clips', () => {
  const k1 = { label: 'kick', start: 0, len: 4, roll: null };
  const k2 = { label: 'kick', start: 8, len: 4, roll: null };
  const b1 = { label: 'bass', start: 0, len: 2, roll: null };
  const b2 = { label: 'bass', start: 6, len: 2, roll: null };
  const { fns, arState } = ops({ clips: [k1, k2, b1, b2], sel: [k1, k2, b1, b2] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['bass', 0, 8, null], ['kick', 0, 12, null]]);
});

test('join keeps the FIRST roll and says which drawings it swallowed', () => {
  const a = { label: 'kick', start: 0, len: 4, roll: 'main' };
  const b = { label: 'kick', start: 4, len: 4, roll: 'fill' };
  const { fns, arState, logged } = ops({ clips: [a, b], sel: [a, b] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['kick', 0, 8, 'main']]);
  assert.match(logged.join('\n'), /fill is no longer heard here/);
});

test('a span joins what it overlaps without being told which clips', () => {
  const a = { label: 'kick', start: 0, len: 2, roll: null };
  const b = { label: 'kick', start: 4, len: 2, roll: null };
  const c = { label: 'kick', start: 20, len: 2, roll: null };
  const { fns, arState } = ops({ clips: [a, b, c], regionSpan: [0, 8] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['kick', 0, 6, null], ['kick', 20, 2, null]], 'the one outside is left alone');
});

test('one clip is already joined, and says so rather than doing nothing', () => {
  const a = { label: 'kick', start: 0, len: 4, roll: null };
  const { fns, logged } = ops({ clips: [a], sel: [a] });
  fns.arJoinClips();
  assert.match(logged.join('\n'), /already joined/);
});

test('the title picks the clip up, the body marks the time under it', () => {
  // Ableton's split, and the reason it works: a clip is an object at the top and a stretch of song
  // below. Without the second half there is nowhere to put a marker, and nothing to split at.
  assert.match(SRC, /part: y < top \+ AR_CLIP_TITLE_H \? 'title' : 'body'/);
  assert.match(SRC, /if \(hit && \(hit\.edge \|\| hit\.part === 'title'\)\) \{/, 'the title drags the clip');
  assert.match(SRC, /arState\.insert = Math\.max\(0, arSnapTo\(arBarsOf\(x\)\)\);\n\s+arState\.drag = \{ kind: 'timeSel'/,
    'the body sets the marker and drags a span');
  assert.match(SRC, /if \(mod && e\.key\.toLowerCase\(\) === 'e'\) \{ arSplitClips\(\); e\.preventDefault\(\); return; \}/);
  assert.match(SRC, /if \(mod && e\.key\.toLowerCase\(\) === 'j'\) \{ arJoinClips\(\); e\.preventDefault\(\); return; \}/);
});

test('a clip names its roll, and double-clicking that name offers the others', () => {
  // Nothing forks from the arrangement any more: a variation is drawn in the piano roll, which is
  // where you are going anyway, and the clip only says which drawing it plays.
  assert.ok(!/arForkRoll/.test(SRC), 'the fork gesture is gone');
  assert.match(SRC, /const arRollHead = makeNamePicker\(\{/, 'a searchable list, like every other named thing');
  assert.match(SRC, /if \(clipHit\.part === 'title'\) arOpenRollPicker\(\[clip\], x,/);
});

test('the editing verbs take cmd, never ctrl - the ctrl chords are the app\'s own', () => {
  // ctrl+A opens the arrangement, cmd+A selects every clip in it. A panel that took either for its
  // editing verbs made those two the same keystroke, which is what this asks about: every keydown
  // that offers copy / paste / duplicate / select-all reads the platform modifier, not both.
  assert.match(SRC, /function editMod\(e\) \{\n\s+return IS_MAC \? e\.metaKey && !e\.ctrlKey : e\.ctrlKey && !e\.metaKey;/);
  const keys = grab('initArrangeCanvas');
  assert.match(keys, /const mod = editMod\(e\);/);
  assert.ok(!/const mod = e\.metaKey \|\| e\.ctrlKey;/.test(keys), 'no key handler takes either modifier');
  // ...and the roll, the sample lists and the organize windows answer the same way
  assert.equal((SRC.match(/const (mod|meta) = editMod\(e\);/g) ?? []).length, 5);
});

test('a marked span is shaded over the tracks, not only on the ruler', () => {
  // The ruler band was enough while a span was something you dragged out up there. A drag across a
  // clip's body marks one now, so it has to be visible where the drag happened - over the music.
  const draw = grab('drawArrange');
  assert.match(draw, /ctx\.fillRect\(sx0, gridTop, sx1 - sx0, gridBottom - gridTop\)/,
    'the span is filled across the rows');
  assert.match(draw, /ctx\.fillRect\(rx0, AR_RULER_TOP, rx1 - rx0, AR_RULER\)/, '...and still banded on the ruler');
  // The insert marker stays quieter than the playhead: an arrow in the ruler and a glow, not a
  // second hard rule down the song competing with the thing that is actually moving.
  assert.match(draw, /ctx\.shadowBlur = 5;/);
  assert.match(draw, /ctx\.lineTo\(ix, AR_LANES_TOP - 1\);/, 'the arrow points down at the place');
});

test('a split inside a span leaves you holding the middle, not the whole clip', () => {
  // The marked region is the union of the span and the selected clips (arTimeRegion), so selecting
  // every piece would widen the band back over the clip that was just divided - which reads as the
  // selection jumping to the thing you cut rather than staying where you were working.
  const a = { label: 'kick', start: 0, len: 12, roll: null };
  const { fns, arState } = ops({ clips: [a], regionSpan: [4, 8] });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 4, null], ['kick', 4, 4, null], ['kick', 8, 4, null]]);
  assert.deepEqual([...arState.sel].map((c) => [c.start, c.len]), [[4, 4]], 'the middle third alone');
  assert.deepEqual(arState.regionSpan, [4, 8], 'and the span it was marked with stands');
});

test('a split at a bare marker leaves both halves held', () => {
  const a = { label: 'kick', start: 0, len: 8, roll: null };
  const { fns, arState } = ops({ clips: [a], sel: [a], insert: 4 });
  fns.arSplitClips();
  assert.equal(arState.sel.size, 2, 'the whole of what was cut');
});
