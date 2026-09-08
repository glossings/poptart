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

const LIFTED = ['arTimeRegion', 'arRegionRows', 'arRowInRegion', 'arClipsIn', 'arClearTime']
  .map(grab).join('\n\n');

// A row is a base label here, exactly as it is in the painter: `kick#fill` paints onto `kick`'s
// row, so the row helpers the lifted code calls are that one rule and nothing else.
const baseOf = (l) => String(l).split('#')[0];
const rowEnv = { arRowOfLabel: (l) => baseOf(l), arRowLabel: (r) => r };

/** The lifted region functions over a fake painter. */
function painter({ clips = [], sel = [], regionSpan = null, regionRows = null, selRegion = null } = {}) {
  const arState = { clips, sel: new Set(sel), regionSpan, regionRows, selRegion };
  const env = { arState, ...rowEnv };
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const build = new Function(...keys, `${LIFTED}\nreturn { arTimeRegion, arRegionRows, arClipsIn, arClearTime };`);
  return { fns: build(...keys.map((k) => env[k])), arState };
}

const clip = (label, start, len) => ({ label, start, len });
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

test('a copied section keeps each clip on its own variation', () => {
  const { fns } = painter({ clips: [clip('kick', 8, 4), clip('hat#fill', 8, 4)] });
  const copied = fns.arClipsIn(8, 12);
  assert.deepEqual(copied.map((c) => c.label), ['kick', 'hat#fill'], 'the label is the block, variation and all');
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
// variation), and a join has to swallow the gaps between what it joins without moving anything.
// ---------------------------------------------------------------------------------------------

/** The split/join/duplicate ops over a fake painter. Writes and redraws are counted, not performed. */
function ops({ clips = [], sel = [], insert = null, regionSpan = null, regionRows = null, track = null } = {}) {
  const arState = {
    clips, sel: new Set(sel), insert, regionSpan, regionRows, selRegion: null, focus: 0,
    track: track ?? baseOf(clips[0]?.label ?? '') ?? null,
  };
  const logged = [];
  const env = {
    arState,
    logLine: (line) => logged.push(line),
    writeArrangeCall: () => {},
    drawArrange: () => {},
    ...rowEnv, // rows are bases; a variation's clips sit on its base's row
  };
  const LIFT = ['arSplitPoints', 'arOpTargets', 'arSplitClips', 'arJoinClips',
    'arRegionRows', 'arRowInRegion', 'arClipsIn', 'arClipOverlaps', 'arDuplicate'].map(grab).join('\n\n');
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const build = new Function(...keys, `${LIFT}\nreturn { arSplitClips, arJoinClips, arSplitPoints, arOpTargets, arClipOverlaps, arDuplicate };`);
  return { fns: build(...keys.map((k) => env[k])), arState, logged };
}

const clips = (st) => [...st.clips]
  .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || a.start - b.start)
  .map((c) => [c.label, c.start, c.len]);

test('a split at the marker makes two clips of one, same block, same music', () => {
  const a = { label: 'kick', start: 0, len: 8 };
  const { fns, arState } = ops({ clips: [a], sel: [a], insert: 3 });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 3], ['kick', 3, 5]]);
  assert.equal(arState.sel.size, 0, 'and a cut at a marker hands back nothing to hold');
});

test('a variation splits into two clips of the same variation - making one unique is a separate choice', () => {
  const a = { label: 'kick#fill', start: 4, len: 8 };
  const { fns, arState } = ops({ clips: [a], sel: [a], insert: 8, track: 'kick' });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick#fill', 4, 4], ['kick#fill', 8, 4]]);
  assert.ok(!/arMakeUnique\(pieces/.test(grab('arSplitClips')), 'a split never forks a block on its own');
});

test('a marker split takes the clip on the selected ROW, whichever variation it is', () => {
  const k = { label: 'kick#fill', start: 0, len: 8 };
  const b = { label: 'bass', start: 0, len: 8 };
  const { fns, arState } = ops({ clips: [k, b], insert: 4, track: 'kick' });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['bass', 0, 8], ['kick#fill', 0, 4], ['kick#fill', 4, 4]]);
});

test('a marked span splits at BOTH its edges, on every track it crosses', () => {
  const k = { label: 'kick', start: 0, len: 16 };
  const b = { label: 'bass', start: 0, len: 16 };
  const { fns, arState } = ops({ clips: [k, b], regionSpan: [4, 8] });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [
    ['bass', 0, 4], ['bass', 4, 4], ['bass', 8, 8],
    ['kick', 0, 4], ['kick', 4, 4], ['kick', 8, 8],
  ]);
});

test('with only a marker down, the split is the track you are on - not every track at once', () => {
  const k = { label: 'kick', start: 0, len: 8 };
  const b = { label: 'bass', start: 0, len: 8 };
  const { fns, arState } = ops({ clips: [k, b], insert: 4, track: 'kick' });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['bass', 0, 8], ['kick', 0, 4], ['kick', 4, 4]]);
});

test('a marker that no clip crosses cuts nothing, and says so rather than erroring', () => {
  const a = { label: 'kick', start: 0, len: 4 };
  const { fns, arState, logged } = ops({ clips: [a], sel: [a], insert: 4 }); // exactly its end
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 4]], 'an edge is not inside');
  assert.match(logged.join('\n'), /no clip crosses the marker/);
});

test('join makes one clip from the first onset to the last end, gaps swallowed', () => {
  const a = { label: 'kick', start: 0, len: 4 };
  const b = { label: 'kick', start: 12, len: 4 };
  const { fns, arState } = ops({ clips: [a, b], sel: [a, b] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['kick', 0, 16]]);
});

test('join is per track: two rows joined at once stay two clips', () => {
  const k1 = { label: 'kick', start: 0, len: 4 };
  const k2 = { label: 'kick', start: 8, len: 4 };
  const b1 = { label: 'bass', start: 0, len: 2 };
  const b2 = { label: 'bass', start: 6, len: 2 };
  const { fns, arState } = ops({ clips: [k1, k2, b1, b2], sel: [k1, k2, b1, b2] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['bass', 0, 8], ['kick', 0, 12]]);
});

test('join keeps the FIRST variation and says which it swallowed', () => {
  const a = { label: 'kick', start: 0, len: 4 };
  const b = { label: 'kick#fill', start: 4, len: 4 };
  const { fns, arState, logged } = ops({ clips: [a, b], sel: [a, b] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['kick', 0, 8]], 'one row, one clip, the first one\'s block');
  assert.match(logged.join('\n'), /kick#fill is no longer heard here/);
});

test('a span joins what it overlaps without being told which clips', () => {
  const a = { label: 'kick', start: 0, len: 2 };
  const b = { label: 'kick', start: 4, len: 2 };
  const c = { label: 'kick', start: 20, len: 2 };
  const { fns, arState } = ops({ clips: [a, b, c], regionSpan: [0, 8] });
  fns.arJoinClips();
  assert.deepEqual(clips(arState), [['kick', 0, 6], ['kick', 20, 2]], 'the one outside is left alone');
});

test('one clip is already joined, and says so rather than doing nothing', () => {
  const a = { label: 'kick', start: 0, len: 4 };
  const { fns, logged } = ops({ clips: [a], sel: [a] });
  fns.arJoinClips();
  assert.match(logged.join('\n'), /already joined/);
});

test('the title picks the clip up, the body marks the time under it', () => {
  // The title/body split, and the reason it works: a clip is an object at the top and a stretch of song
  // below. Without the second half there is nowhere to put a marker, and nothing to split at.
  assert.match(SRC, /part: y < top \+ AR_CLIP_TITLE_H \? 'title' : 'body'/);
  assert.match(SRC, /if \(hit && \(hit\.edge \|\| hit\.part === 'title'\)\) \{/, 'the title drags the clip');
  assert.match(SRC, /arState\.insert = Math\.max\(0, arSnapTo\(arBarsOf\(x\)\)\);\n\s+arState\.drag = \{ kind: 'timeSel'/,
    'the body sets the marker and drags a span');
  assert.match(SRC, /if \(mod && e\.key\.toLowerCase\(\) === 'e'\) \{ arSplitClips\(\); e\.preventDefault\(\); return; \}/);
  assert.match(SRC, /if \(mod && e\.key\.toLowerCase\(\) === 'j'\) \{ arJoinClips\(\); e\.preventDefault\(\); return; \}/);
});

test('a clip is a block: double-clicking it opens that block to edit, and the title says which', () => {
  // A clip names a block and nothing else. There is no roll to rebind and no variation to choose;
  // what a clip plays is one track's code, and the code is a double-click away.
  assert.ok(!/arRollHead|arBindRoll|arTrackRoll|\.roll\b/.test(SRC), 'the roll binding is gone from the painter');
  assert.ok(!/arBrushFor|arSetBrush|arCreateVariation/.test(SRC), 'and so is the brush that chose between variations');
  assert.match(SRC, /arSelectTrack\(clip\.label\);\n\s+arEditBlock\(clip\.label\);/);
  assert.match(SRC, /ctx\.fillText\(arClipTitle\(c\.label\)/);
  assert.match(grab('arClipTitle'), /return label;/, 'a clip is titled by its track');
});

test('the pencil paints the row it is put on, and a group takes no paint', () => {
  // Rows and tracks are 1:1, so painting needs no aim: the row IS the answer. What can't take
  // paint is a group (it makes no sound of its own) and an orphan (its block is gone).
  assert.match(SRC, /const label = arPaintLabel\(row\);\n\s+if \(!label\) \{ drawArrange\(\); return; \}/);
  assert.match(grab('arPaintLabel'), /r && r\.own && !r\.group \? r\.label : null/);
  assert.match(SRC, /if \(arRowLabel\(lane\) == null \|\| arPaintLabel\(lane\) != null\) continue;/,
    'and those rows dim while the pencil is in hand');
});

test('leaving the arrangement with a clip selected lands on its block', () => {
  assert.match(grab('closeArrangeEditor'), /const picked = arState \? \[\.\.\.arState\.sel\]\[0\]\?\.label \?\? null : null;/);
  assert.match(grab('closeArrangeEditor'), /if \(picked\) arGotoBlock\(picked\);/);
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
  assert.match(draw, /for \(const \[top, bot\] of bands\) ctx\.fillRect\(sx0, top, sx1 - sx0, bot - top\);/,
    'the span is filled over the rows it covers');
  // ...and the full height is still what a region covering every row draws (see arRegionRows)
  assert.match(draw, /if \(!timeRows\) bands\.push\(\[gridTop, gridBottom\]\);/);
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
  const a = { label: 'kick', start: 0, len: 12 };
  const { fns, arState } = ops({ clips: [a], regionSpan: [4, 8] });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 4], ['kick', 4, 4], ['kick', 8, 4]]);
  assert.deepEqual([...arState.sel].map((c) => [c.start, c.len]), [[4, 4]], 'the middle third alone');
  assert.deepEqual(arState.regionSpan, [4, 8], 'and the span it was marked with stands');
});

test('a split at a bare marker selects nothing - the marker is a place, not a choice of clips', () => {
  // Clicking into the middle of a clip to put the marker there and cutting should leave the cursor
  // exactly where it was put. Handing back the two halves reads as the selection jumping onto the
  // clip you just divided - and, via arTimeRegion, silently widens what the next key acts on.
  const a = { label: 'kick', start: 0, len: 8 };
  const { fns, arState } = ops({ clips: [a], sel: [a], insert: 4 });
  fns.arSplitClips();
  assert.deepEqual(clips(arState), [['kick', 0, 4], ['kick', 4, 4]], 'it still cuts');
  assert.equal(arState.sel.size, 0, 'and holds nothing afterwards');
  assert.equal(arState.insert, 4, 'the marker stays where it was put');
});

test('the whole _arrange call folds to a named chip, like a definitions run', () => {
  // `_arrange(⋯)` left the one part of the call that says nothing on screen. Nobody types any of
  // it, so the chip stands in for the lot and names what it is instead.
  const fold = grab('foldConfigBlobs');
  assert.match(fold, /foldSpan\(m\.index, close \+ 1, '⋯ arrangement'/);
  assert.ok(!/foldSpan\(open \+ 1, close, '⋯',/.test(fold), 'no argument-only fold left behind');
  assert.match(fold, /const key = `arrange:\$\{arrangeN\+\+\}`;/, 'keyed like a run\'s, by which one it is');
});

// ---------------------------------------------------------------------------------------------
// Variations: a clip may name `base#name`, a block of its own on the base's row.
// ---------------------------------------------------------------------------------------------

/** arMakeUnique over a fake painter: which blocks get made, and which clips move onto them. */
test('a member is colored a step off its group, so a kit reads as a family', () => {
  const src = grab('arHsl');
  assert.match(src, /\(hue \+ \(at \+ 1\) \* AR_MEMBER_HUE_STEP\) % 360/);
  assert.match(src, /const parent = arGroupParents\(\)\.get\(label\) \?\? null;/,
    'off the tree, not the row - a folded member has no row and still needs its color');
  assert.match(src, /const chosen = arState\?\.colors\?\.\[label\];\n\s+if \(chosen\) return hexToHsl\(chosen\);/, 'a chosen color wins');
  assert.match(SRC, /if \(state\.colors && Object\.keys\(state\.colors\)\.length\) opts\.colors = \{ \.\.\.state\.colors \};/,
    'and only chosen colors are written into the call');
});

test('renaming from a clip or the mixer goes through one path, and the painter follows', () => {
  // mixctl's renameEdits rewrites the code, the clips AND the group tree in the buffer; the
  // painter's own copy of the clips has to follow either way in.
  const apply = grab('arApplyRename');
  assert.match(apply, /for \(const c of arState\.clips\) if \(map\.has\(c\.label\)\) c\.label = map\.get\(c\.label\);/);
  assert.match(apply, /arState\.tracks = arState\.tracks\.map\(\(t\) => map\.get\(t\) \?\? t\);/);
  // arCM, not cm: the painter rewrites the deck it is on (see openArrangePainter)
  assert.match(grab('arRenameBlock'), /const res = mixctlMod\.renameEdits\(arCM\.getValue\(\), from, to\);[\s\S]{0,900}arApplyRename\(new Map\(\[\[from, to\]\]\)\);/);
  assert.match(grab('applyMixerRename'), /mixctlMod\.renameEdits\(cm\.getValue\(\), from, to\);[\s\S]*arApplyRename\(new Map\(\[\[from, to\]\]\)\);/);
  // the gesture: the clip menu and cmd+R put the name box over the clip's title
  assert.match(SRC, /items\.push\(\['rename…', \(\) => arRenameClip\(targets\[0\]\)/);
  assert.match(SRC, /if \(mod && e\.key\.toLowerCase\(\) === 'r'\) \{/);
  assert.match(grab('arCommitLaneName'), /if \(edit\.kind === 'clip'\) \{\n\s+if \(save && name && name !== edit\.from\) arRenameBlock\(edit\.from, name\);/);
});

test('a group gets a caret in the gutter and does NOT fold itself', () => {
  // It used to fold on every evaluation, which hid the member you were in the middle of writing.
  // Open is the default now; what is remembered is which groups you folded.
  const fold = grab('foldGroups');
  assert.match(fold, /const tree = groupsMod\.normalizeGroupTree\(mixctlMod\.readGroupTree\(code\)\);/);
  assert.match(fold, /cm\.setGutterMarker\(cm\.posFromIndex\(from\)\.line, GROUP_GUTTER, groupCaret\(/);
  assert.match(fold, /const folded = collapsedGroups\.has\(group\.label\);\n\s+.*\n\s+if \(!folded\) continue;/,
    'nothing folds unless the caret was pressed');
  // the run below a group stops at the first block that is not under it
  assert.match(fold, /if \(!under\.has\(b\.label\)\) break;/);
  // a group inside a folded group is already hidden - marking it would lay a chip inside a chip
  assert.match(fold, /if \(hiddenByAncestor\(group\.label\)\) continue;/);
  // ...and a group that leaves the buffer forgets it was folded, so a new one of that name opens
  assert.match(fold, /for \(const label of \[\.\.\.collapsedGroups\]\) if \(!live\.has\(label\)\) collapsedGroups\.delete\(label\);/);
  assert.match(SRC, /for \(const reg of DEF_REGISTRIES\) foldDefRuns\(code, reg\);\n\s+foldGroups\(code\);/);
  // the gutter has to be declared at construction, and cleared at the top of every pass
  assert.match(SRC, /gutters: \['CodeMirror-linenumbers', GROUP_GUTTER\],/);
  assert.match(fold, /cm\.clearGutter\(GROUP_GUTTER\);/);
  // a jump onto a member of a FOLDED group opens every group above it, or the cursor lands on a chip
  assert.match(grab('arGotoBlock'), /groupsMod\.ancestorsOf\(label, parents\)\.filter\(\(a\) => collapsedGroups\.has\(a\)\)/);
  assert.match(grab('arCreateGroup'), /collapsedGroups\.delete\(res\.name\);/, 'a group just made is shown');
  // and a fresh buffer starts with nothing folded
  assert.match(grab('forgetExpandedFolds'), /collapsedGroups\.clear\(\);/);
});

test('cmd+G groups the selection, and the gesture asks for a name in place', () => {
  assert.match(SRC, /'Cmd-G': \(ed\) => groupSelection\(ed\),/);
  assert.match(SRC, /'Shift-Ctrl-G': \(ed\) => groupSelection\(ed\),/, 'plain ctrl\+G is the mixer');
  const sel = grab('groupSelection');
  assert.match(sel, /\.filter\(\(b\) => b\.kind !== 'bare' && b\.start < to && b\.end > from\)/,
    'the tracks the selection covers are the members');
  assert.match(sel, /askGroupName\(ed, covered\[0\], name, \(chosen\) => arCreateGroup\(covered, chosen, ed\)\)/);
  assert.match(SRC, /items\.push\(\['group these tracks…', \(\) => groupSelection\(ed\)/, 'and it is on the editor menu too');
});

test('the caret says which way it will go, and toggles the group', () => {
  const caret = grab('groupCaret');
  assert.match(caret, /el\.textContent = folded \? '▸' : '▾';/);
  assert.match(caret, /if \(collapsedGroups\.has\(label\)\) collapsedGroups\.delete\(label\);\n\s+else collapsedGroups\.add\(label\);/);
  assert.match(caret, /refoldAll\(\);/, 'the marks are re-derived rather than patched');
  const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
  assert.match(css, /\.cm-s-poptart \.poptart-group-fold \{\n\s+width: 14px;\n\}/, 'a fixed gutter width, so the code does not shift');
});

test('double-clicking a clip flips to the code on its block - there is no second editor', () => {
  assert.ok(!/blockEdit/.test(SRC), 'the block window is gone');
  assert.match(grab('arEditBlock'), /closeArrangeEditor\(\);[\s\S]{0,200}arGotoBlock\(label\);/);
});

// ---------------------------------------------------------------------------------------------
// The region is a RECTANGLE - rows as well as bars
//
// A selection used to be a vertical slice: clicking one clip lit every track over its bars, and
// copy / cut / split / join all acted on the lot. It is a rectangle now (arRegionRows) - the rows
// you pointed at and no others - with the two RIPPLE ops (cmd+shift+D, cmd+shift+backspace) still
// taking the full height, because bars cannot move on one track and stand still on the next.
// ---------------------------------------------------------------------------------------------

test('a selected clip marks its own row, not a slice through the song', () => {
  const a = clip('kick', 4, 4);
  const { fns } = painter({ clips: [a, clip('bass', 4, 4)], sel: [a] });
  assert.deepEqual([...fns.arRegionRows()], ['kick']);
});

test('a variation marks its BASE\'s row - they share one', () => {
  const fill = clip('kick#fill', 8, 2);
  assert.deepEqual([...painter({ clips: [fill], sel: [fill] }).fns.arRegionRows()], ['kick']);
});

test('several selected clips mark every row they are on', () => {
  const a = clip('kick', 0, 4);
  const b = clip('bass', 8, 4);
  const { fns } = painter({ clips: [a, b], sel: [a, b] });
  assert.deepEqual([...fns.arRegionRows()].sort(), ['bass', 'kick']);
});

test('a dragged span carries the rows it was dragged across', () => {
  const { fns } = painter({ regionSpan: [0, 8], regionRows: new Set(['kick']) });
  assert.deepEqual([...fns.arRegionRows()], ['kick']);
});

test('letting the span go lets its rows go with it', () => {
  // regionRows is only read while a span is marked, so every place that drops the span drops the
  // rows too without having to remember to - there is one field to clear, not two.
  const { fns } = painter({ regionSpan: null, regionRows: new Set(['kick']) });
  assert.equal(fns.arRegionRows(), null);
});

test('nothing marked is every row - which is what the ripple ops want', () => {
  assert.equal(painter().fns.arRegionRows(), null);
});

test('a picked loop region is every row: it is a named span of the whole song', () => {
  const a = clip('kick', 0, 4);
  const { fns } = painter({ clips: [a], sel: [a], selRegion: { name: 'chorus', start: 8, end: 16 } });
  assert.equal(fns.arRegionRows(), null, 'even with a clip held, the loop widens it to the song');
});

test('copying a span takes only the marked rows', () => {
  const { fns } = painter({
    clips: [clip('kick', 0, 8), clip('bass', 0, 8)],
    regionSpan: [2, 6],
    regionRows: new Set(['kick']),
  });
  assert.deepEqual(shape(fns.arClipsIn(2, 6, fns.arRegionRows())), [['kick', 0, 4]]);
  // ...and with no rows marked it is still the whole slice
  assert.deepEqual(shape(fns.arClipsIn(2, 6, null)), [['kick', 0, 4], ['bass', 0, 4]]);
});

test('clearing a span leaves the rows it does not cover alone', () => {
  const { fns, arState } = painter({ clips: [clip('kick', 0, 8), clip('bass', 0, 8)] });
  fns.arClearTime(2, 6, new Set(['kick']));
  assert.deepEqual(shape(arState.clips), [['kick', 0, 2], ['kick', 6, 2], ['bass', 0, 8]]);
});

test('a span marked on one row splits and joins that row only', () => {
  const spl = ops({
    clips: [{ label: 'kick', start: 0, len: 12 }, { label: 'bass', start: 0, len: 12 }],
    regionSpan: [4, 8],
    regionRows: new Set(['kick']),
  });
  spl.fns.arSplitClips();
  assert.deepEqual(clips(spl.arState), [['bass', 0, 12], ['kick', 0, 4], ['kick', 4, 4], ['kick', 8, 4]]);

  const jn = ops({
    clips: [{ label: 'kick', start: 0, len: 2 }, { label: 'kick', start: 6, len: 2 },
      { label: 'bass', start: 0, len: 2 }, { label: 'bass', start: 6, len: 2 }],
    regionSpan: [0, 8],
    regionRows: new Set(['kick']),
  });
  jn.fns.arJoinClips();
  assert.deepEqual(clips(jn.arState), [['bass', 0, 2], ['bass', 6, 2], ['kick', 0, 8]]);
});

// ---------------------------------------------------------------------------------------------
// Duplicating overwrites what it lands on
//
// Two clips of one track sounding across the same bars is not a difference you can hear, so a
// copy that stacked was only ever a mess waiting to be noticed. The roll has always clipped its
// overlaps (prClipOverlaps); this is the same rule on the song's own timeline.
// ---------------------------------------------------------------------------------------------

test('a clip laid down cuts back whatever was under it on that row', () => {
  const under = { label: 'kick', start: 0, len: 16 };
  const over = { label: 'kick', start: 4, len: 4 };
  const { fns, arState } = ops({ clips: [under, over] });
  fns.arClipOverlaps([over]);
  assert.deepEqual(clips(arState), [['kick', 0, 4], ['kick', 4, 4], ['kick', 8, 8]],
    'the long clip becomes the part before it and the part after');
});

test('it clips per LABEL: a track never overlaps itself, and other tracks layer', () => {
  const loop = { label: 'kick', start: 0, len: 8 };
  const late = { label: 'kick', start: 6, len: 2 };
  const fill = { label: 'kickFill', start: 4, len: 2 };
  const { fns, arState } = ops({ clips: [loop, fill, late] });
  fns.arClipOverlaps([late]);
  assert.deepEqual(clips(arState), [['kick', 0, 6], ['kick', 6, 2], ['kickFill', 4, 2]],
    'its own earlier clip is trimmed; the sibling under it layers on');
});

test('...and never touches another row', () => {
  const over = { label: 'kick', start: 4, len: 4 };
  const { fns, arState } = ops({ clips: [{ label: 'bass', start: 0, len: 16 }, over] });
  fns.arClipOverlaps([over]);
  assert.deepEqual(clips(arState), [['bass', 0, 16], ['kick', 4, 4]]);
});

test('a clip only partly under the new one keeps the end that survives', () => {
  const over = { label: 'kick', start: 4, len: 8 };
  const { fns, arState } = ops({ clips: [{ label: 'kick', start: 0, len: 6 }, over] });
  fns.arClipOverlaps([over]);
  assert.deepEqual(clips(arState), [['kick', 0, 4], ['kick', 4, 8]]);
});

test('cmd+D on selected clips repeats them after themselves, overwriting', () => {
  const a = { label: 'kick', start: 0, len: 4 };
  const { fns, arState } = ops({ clips: [a, { label: 'kick', start: 4, len: 12 }], sel: [a] });
  fns.arDuplicate();
  assert.deepEqual(clips(arState), [['kick', 0, 4], ['kick', 4, 4], ['kick', 8, 8]]);
  assert.deepEqual([...arState.sel].map((c) => [c.start, c.len]), [[4, 4]], 'the copy is what you hold');
});

test('cmd+D on a span lifts a section out of the middle of a long clip', () => {
  // The note's own example: mark bars 4..8 of a clip running 0..16 and the copy lands at 8..12,
  // cutting what was there into the part before it and the part after.
  const { fns, arState } = ops({
    clips: [{ label: 'kick', start: 0, len: 16 }],
    regionSpan: [4, 8],
    regionRows: new Set(['kick']),
  });
  fns.arDuplicate();
  assert.deepEqual(clips(arState), [['kick', 0, 8], ['kick', 8, 4], ['kick', 12, 4]]);
  assert.deepEqual(arState.regionSpan, [8, 12], 'the span walks with the copy, so pressing again repeats');
});

test('a span duplicate stays on its own rows', () => {
  const { fns, arState } = ops({
    clips: [{ label: 'kick', start: 0, len: 16 }, { label: 'bass', start: 0, len: 16 }],
    regionSpan: [4, 8],
    regionRows: new Set(['kick']),
  });
  fns.arDuplicate();
  assert.deepEqual(clips(arState).filter((c) => c[0] === 'bass'), [['bass', 0, 16]]);
});

test('cmd+D with an empty span says so rather than doing nothing', () => {
  const { fns, logged } = ops({ clips: [{ label: 'kick', start: 0, len: 4 }], regionSpan: [8, 12] });
  fns.arDuplicate();
  assert.match(logged.join('\n'), /nothing in the marked span/);
});

test('the menu\'s explicit targets keep the clip shape even with a span marked', () => {
  // "duplicate after" on a right-clicked clip is about that clip, whatever else is marked.
  const a = { label: 'kick', start: 0, len: 4 };
  const { fns, arState } = ops({ clips: [a], regionSpan: [8, 12], regionRows: new Set(['kick']) });
  fns.arDuplicate([a]);
  assert.deepEqual(clips(arState), [['kick', 0, 4], ['kick', 4, 4]]);
});

test('the wiring: cmd+D reads the span, paste clips its overlaps, empty song drops the selection', () => {
  assert.match(SRC, /e\.key\.toLowerCase\(\) === 'd'\) \{ arDuplicate\(\); e\.preventDefault\(\)/,
    'cmd+D hands nothing in, so it can read the marked span itself');
  assert.match(grab('arPasteTime'), /arState\.clips\.push\(\.\.\.made\);\n\s+arClipOverlaps\(made\);/);
  // clicking empty song is the way OUT of a selection - escape was the only one before
  assert.match(SRC, /if \(y >= arGridBottom\(\)\) \{ arDropSelection\(\); drawArrange\(\); return; \}/);
  assert.match(SRC, /if \(row < 0 \|\| arRowLabel\(row\) == null\) \{ arDropSelection\(\); drawArrange\(\); return; \}/);
  assert.match(grab('arDropSelection'), /arState\.regionRows = null;/);
  // ...and the ripple ops stay the whole song's, whatever rows were marked when they were pressed
  assert.match(grab('arTimeDuplicate'), /arState\.regionRows = null;/);
  assert.ok(!/arRegionRows\(\)/.test(grab('arRemoveTime')), 'delete-time never narrows to rows');
});

test('a time drag carries the row it started on', () => {
  assert.match(SRC, /arState\.drag = \{ kind: 'timeSel', a: arState\.insert, x0: x, row0: row \}/);
  assert.match(SRC, /arState\.regionRows = arRowsBetween\(d\.row0, arRowOf\(y\)\);/);
  assert.match(SRC, /arState\.regionRows = arRowsBetween\(arRowOf\(Math\.min\(d\.y0, d\.y1\)\), arRowOf\(Math\.max\(d\.y0, d\.y1\)\)\);/);
});

test('the arrangement\'s length box fits a fractional one', () => {
  // A length dragged out in the ruler lands on the snap grid, so 12.75 is ordinary here where the
  // roll's grid and length are always whole - 46px clipped it and step="1" flagged it invalid.
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="arrangeLen" type="number" step="any"/);
  const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
  assert.match(css, /#arrangeLen \{\n\s+width: 68px;\n\}/);
});
