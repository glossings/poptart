// The automation strip's span selection and its edit ops (public/client.js): what a stretch of
// curve is when you copy it, what is left behind when you clear it, and what a paste does to what
// it lands on.
//
// A curve is not a clip, and the two places that differ are the whole substance here. Copying a
// span has to SAMPLE the edges - bars 8..16 of a sweep is the middle of the sweep, starting at the
// value it had reached - and pasting has to REPLACE the span it lands on, because a lane has one
// value at a time and two curves stacked on the same bars is a zigzag between them, not a thicker
// line. Neither is visible in the UI until it is wrong. The functions are lifted out of the shipped
// client.js rather than copied (see auto-lane.test.js), and run against the real sampler, so a
// change to either side shows up here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sampleAutoPoints, parseAutoPoints, serializeAutoPoints } from '../pattern-core/src/shape.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  // Past the parameter list first: one of these takes a destructured argument, whose brace would
  // otherwise read as the start of the body.
  let paren = 0;
  let i = SRC.indexOf('(', at);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') paren++;
    else if (SRC[i] === ')' && --paren === 0) break;
  }
  let depth = 0;
  let end = SRC.indexOf('{', i);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const NAMES = ['arAutoSegAtBar', 'arAutoEditable', 'arAutoSpanHint', 'arAutoPointsIn', 'arAutoClearSpan',
  'arAutoSplitSpan', 'arAutoMaterializeSpan', 'arAutoFit', 'arAutoNudge', 'arAutoNudgeStep',
  'arAutoInsert', 'arAutoLanded', 'arAutoCopySel', 'arAutoDeleteSel', 'arAutoPaste', 'arAutoDuplicateSel'];
const LIFTED = NAMES.map(grab).join('\n\n');

/** The lifted ops over a fake strip. Writes and redraws are counted rather than performed. */
function strip({ points = [{ x: 0, y: 0 }, { x: 8, y: 1 }], sel = null, own = true, focus = 0, range = [0, 1] } = {}) {
  const arState = {
    autoId: 'lane',
    autoOwn: own,
    autoPts: points.map((p) => ({ c: 0, ...p })),
    autoSel: sel,
    autoRange: range, // the strip's drawn range - what a group move is held inside (arAutoFit)
    focus,
  };
  const log = [];
  const env = {
    arState,
    shapeMod: { sampleAutoPoints },
    logLine: (m) => log.push(m),
    arWriteAuto: () => { env.writes++; },
    arRefreshAutoRange: () => {},
    drawArrange: () => {},
    // a quarter-bar paint grid, as the painter's default zoom gives (see arrange-snap.test.js)
    arSnapTo: (b) => Math.round(b * 4) / 4,
    arFmtBars: (n) => `${n} bars`,
    AR_AUTO_NUDGE: Number(/^const AR_AUTO_NUDGE = ([\d.]+);/m.exec(SRC)[1]),
    writes: 0,
  };
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const build = new Function(...keys,
    `let arAutoClipboard = null;\n${LIFTED}\n`
    + `return { ${NAMES.join(', ')}, clip: () => arAutoClipboard, setClip: (c) => { arAutoClipboard = c; } };`);
  return { fns: build(...keys.map((k) => env[k])), arState, env, log };
}

/** The curve as a handful of samples - the only thing about it that is actually observable. */
const curve = (pts, from, to, step = 0.5) => {
  const out = [];
  for (let b = from; b <= to + 1e-9; b += step) out.push(Math.round(sampleAutoPoints(pts, b) * 1e6) / 1e6);
  return out;
};
const xs = (pts) => pts.map((p) => Math.round(p.x * 1e6) / 1e6);

// ---------------------------------------------------------------------------------------------
// Copying a stretch of curve
// ---------------------------------------------------------------------------------------------

test('the points inside come out measured from the span start', () => {
  const { fns } = strip({ points: [{ x: 4, y: 0 }, { x: 6, y: 1 }, { x: 8, y: 0.5 }] });
  assert.deepEqual(fns.arAutoPointsIn(4, 8).map((p) => [p.x, p.y]), [[0, 0], [2, 1], [4, 0.5]]);
});

test('an edge cutting through a segment gets a point sampled where it cuts', () => {
  // a straight ramp 0..1 over bars 0..8, copied from the middle: bars 2..6 is 0.25..0.75
  const { fns } = strip({ points: [{ x: 0, y: 0 }, { x: 8, y: 1 }] });
  const got = fns.arAutoPointsIn(2, 6);
  assert.deepEqual(got.map((p) => [p.x, p.y]), [[0, 0.25], [4, 0.75]],
    'four bars of the sweep, not the whole eight');
});

test('the span is closed at both ends - a curve carries on where a clip stops', () => {
  const { fns } = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 0 }] });
  const got = fns.arAutoPointsIn(0, 4);
  assert.deepEqual(xs(got), [0, 4], 'the point AT the far edge belongs to the copy: it is where it ends up');
});

test('an edge landing exactly on a point does not double it', () => {
  const { fns } = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 0 }] });
  assert.deepEqual(xs(fns.arAutoPointsIn(4, 8)), [0, 4]);
});

test('a span off the end of the breakpoints copies as the flat stretch it is', () => {
  // past the last point a lane holds its end level (see sampleAutoPoints) - that is a shape too,
  // and pasting it has to flatten what it lands on rather than quietly doing nothing
  const { fns } = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 0.75 }] });
  assert.deepEqual(fns.arAutoPointsIn(16, 20).map((p) => [p.x, p.y]), [[0, 0.75], [4, 0.75]]);
});

test('the bend of a cut segment is carried over', () => {
  const { fns } = strip({ points: [{ x: 0, y: 0, c: 6 }, { x: 8, y: 1, c: 0 }] });
  assert.equal(fns.arAutoPointsIn(2, 6)[0].c, 6, 'the shape that was drawn is the shape you copied');
});

// ---------------------------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------------------------

test('clearing takes out the points in the span and lets the curve run through', () => {
  const { fns, arState } = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 6, y: 1 }, { x: 8, y: 1 }] });
  fns.arAutoClearSpan(4, 6);
  assert.deepEqual(xs(arState.autoPts), [0, 8]);
  // the shape that was there is gone, and what is left is the straight run between the survivors -
  // a lane has a value everywhere, so "nothing here" is not one of the things it can say
  assert.equal(sampleAutoPoints(arState.autoPts, 6), 0.75);
});

test('clearing is closed at both ends, like the span it is given', () => {
  const { fns, arState } = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 0 }, { x: 12, y: 1 }] });
  fns.arAutoClearSpan(4, 8);
  assert.deepEqual(xs(arState.autoPts), [0, 12], 'both edge points went - the span was marked over them');
});

test('clearing the whole lane leaves it flat rather than unparseable', () => {
  // a lane with no breakpoints at all cannot be written back out (parseAutoPoints wants one), and
  // a lane always has SOME value everywhere, so the last one out is replaced by what it was holding
  const { fns, arState } = strip({ points: [{ x: 0, y: 0.3 }, { x: 8, y: 0.9 }] });
  fns.arAutoClearSpan(0, 8);
  assert.equal(arState.autoPts.length, 1);
  assert.equal(arState.autoPts[0].y, 0.3, 'the value the span opened on');
  assert.doesNotThrow(() => parseAutoPoints(serializeAutoPoints(arState.autoPts)));
});

// ---------------------------------------------------------------------------------------------
// The ops on top of them
// ---------------------------------------------------------------------------------------------

test('cut copies then clears; copy leaves the lane alone', () => {
  const pts = [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 0 }];
  const copy = strip({ points: pts, sel: [0, 4] });
  copy.fns.arAutoCopySel();
  assert.deepEqual(xs(copy.arState.autoPts), [0, 4, 8]);
  assert.equal(copy.env.writes, 0, 'a copy is not an edit');

  const cut = strip({ points: pts, sel: [0, 4] });
  cut.fns.arAutoCopySel({ cut: true });
  assert.deepEqual(xs(cut.arState.autoPts), [8]);
  assert.equal(cut.env.writes, 1);
  assert.deepEqual(xs(cut.fns.clip().points), [0, 4], 'and the clipboard has what was taken');
});

test('duplicate repeats the span into the next one and walks the selection along', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }], sel: [0, 4] });
  s.fns.arAutoDuplicateSel();
  assert.deepEqual(s.arState.autoSel, [4, 8], 'the copy is the span now - pressing again walks on');
  assert.deepEqual(curve(s.arState.autoPts, 4, 8, 1), [0, 0.25, 0.5, 0.75, 1], 'the same ramp again');
  s.fns.arAutoDuplicateSel();
  assert.deepEqual(s.arState.autoSel, [8, 12]);
  assert.deepEqual(curve(s.arState.autoPts, 8, 12, 1), [0, 0.25, 0.5, 0.75, 1], 'and a third pass of it');
});

test('duplicate leaves the bars where they were - the lane rides the song, it does not push it', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 20, y: 0.5 }], sel: [0, 4] });
  s.fns.arAutoDuplicateSel();
  assert.equal(s.arState.autoPts.at(-1).x, 20, 'the point past the copy did not ripple along');
});

test('a paste replaces the span it lands on rather than interleaving with it', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }, { x: 6, y: 1 }, { x: 8, y: 0 }], sel: [0, 4] });
  s.fns.arAutoCopySel();
  s.arState.autoSel = [4, 8];
  s.fns.arAutoPaste();
  // bars 4..8 are now the copied 0..4, and nothing of what was there is left inside it
  assert.deepEqual(curve(s.arState.autoPts, 4, 8, 1), curve(s.arState.autoPts, 0, 4, 1));
  assert.equal(s.arState.autoPts.filter((p) => p.x > 4 + 1e-9 && p.x < 8 - 1e-9).length, 1,
    'one point inside the pasted span, not the old one as well');
});

test('with nothing marked, a paste lands where the last gesture was, snapped', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }], focus: 11.9 });
  s.fns.setClip({ width: 4, points: [{ x: 0, y: 0.2, c: 0 }, { x: 4, y: 0.8, c: 0 }] });
  s.fns.arAutoPaste();
  assert.deepEqual(s.arState.autoSel, [12, 16], 'snapped to the paint grid');
  assert.equal(sampleAutoPoints(s.arState.autoPts, 12), 0.2);
});

test('the ops say what they need instead of doing nothing', () => {
  const none = strip({ sel: null });
  none.fns.arAutoCopySel();
  none.fns.arAutoDeleteSel();
  none.fns.arAutoDuplicateSel();
  assert.equal(none.log.length, 3, 'each one asks for a span');
  assert.match(none.log[0], /span/);
  const empty = strip({ sel: [0, 4] });
  empty.fns.arAutoPaste();
  assert.match(empty.log[0], /clipboard/);
});

test('a library lane can be spanned and copied, but not written to', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }], sel: [0, 4], own: false });
  s.fns.arAutoCopySel();
  assert.deepEqual(xs(s.fns.clip().points), [0, 4], 'copying reads, so it is allowed');
  s.fns.arAutoDeleteSel();
  s.fns.arAutoDuplicateSel();
  s.fns.arAutoPaste();
  assert.deepEqual(xs(s.arState.autoPts), [0, 4], 'and nothing changed it');
  assert.equal(s.env.writes, 0);
  assert.ok(s.log.some((m) => /library/.test(m)), 'it says why, rather than going quiet');
});

// ---------------------------------------------------------------------------------------------
// Moving the breakpoints in a span as a group
// ---------------------------------------------------------------------------------------------

test('raising a span leaves the lane either side of it exactly where it was', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 12, y: 0 }], sel: [4, 8] });
  const before = curve(s.arState.autoPts, 0, 12, 1);
  s.fns.arAutoNudge(0.5);
  const after = curve(s.arState.autoPts, 0, 12, 1);
  assert.deepEqual(after.slice(0, 4), before.slice(0, 4), 'bars 0..3 untouched');
  assert.deepEqual(after.slice(4, 8), [0.5, 0.5, 0.5, 0.5], 'the span itself lifted');
  // Bar 8 reads as the value LEAVING the step - the lane is already back down by the time the
  // playhead is past it, which is what confining the change to the span means.
  assert.deepEqual(after.slice(8), before.slice(8), 'and bars 8..12 exactly as they were');
});

test('the edges of a raised span each get an anchor and its twin', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 12, y: 0 }], sel: [4, 8] });
  s.fns.arAutoNudge(0.5);
  assert.deepEqual(s.arState.autoPts.map((p) => [p.x, p.y]),
    [[0, 0], [4, 0], [4, 0.5], [8, 0.5], [8, 0], [12, 0]],
    'two on each edge bar: the value out there, and the value in here');
});

test('a second move picks up the same group, not the anchors it left behind', () => {
  // the whole point of the first-is-left / last-is-right rule in arAutoSplitSpan: without it the
  // anchors join the group on the next press and the step at the edges collapses
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 12, y: 0 }], sel: [4, 8] });
  s.fns.arAutoNudge(0.25);
  s.fns.arAutoNudge(0.25);
  assert.deepEqual(s.arState.autoPts.map((p) => [p.x, p.y]),
    [[0, 0], [4, 0], [4, 0.5], [8, 0.5], [8, 0], [12, 0]], 'two presses, still six points');
});

test('a span running off the end of the lane needs no anchor out there', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }], sel: [4, 8] });
  s.fns.arAutoNudge(-0.5);
  // an edge only needs a pair where there is curve beyond it to hold still; past the last
  // breakpoint the lane's end level IS what the move is changing, so nothing is pinned out there
  assert.deepEqual(s.arState.autoPts.map((p) => [p.x, p.y]), [[0, 0], [4, 1], [4, 0.5]]);
  assert.equal(sampleAutoPoints(s.arState.autoPts, 20), 0.5, 'the lane holds the new value past the span');
});

test('a group move keeps the group\'s shape when it reaches the end of the range', () => {
  const s = strip({ points: [{ x: 0, y: 0.2 }, { x: 4, y: 0.9 }], sel: [0, 4] });
  s.fns.arAutoNudge(0.5); // 0.9 + 0.5 would be 1.4, past the top of a 0..1 strip
  assert.deepEqual(s.arState.autoPts.map((p) => Math.round(p.y * 1e6) / 1e6), [0.3, 1],
    'the move is cut to what fits - the two do not converge on the ceiling');
});

test('a move with nowhere left to go writes nothing at all', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }], sel: [0, 4] });
  s.fns.arAutoNudge(0.5);
  assert.equal(s.env.writes, 0, 'no edit, no history entry, no evaluation');
  assert.equal(s.arState.autoPts.length, 2, 'and no edge points left behind for a move that never happened');
});

test('the step follows the range, so a lane in semitones is not nudged in hundredths', () => {
  const norm = strip();
  assert.equal(norm.fns.arAutoNudgeStep(false), 0.01);
  assert.equal(norm.fns.arAutoNudgeStep(true), 0.1, 'shift is the coarse step');
  const semis = strip({ range: [-12, 12] });
  assert.equal(Math.round(semis.fns.arAutoNudgeStep(false) * 100) / 100, 0.24);
});

test('a span covering the whole lane lifts all of it', () => {
  const s = strip({ points: [{ x: 0, y: 0 }, { x: 4, y: 0.5 }], sel: [0, 4] });
  s.fns.arAutoNudge(0.25);
  assert.deepEqual(s.arState.autoPts.map((p) => [p.x, p.y]), [[0, 0.25], [4, 0.75]], 'no anchors: there is no outside');
});

// ---------------------------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------------------------

test('the arrows work a marked span, and a drag inside the band moves the group', () => {
  const at = SRC.indexOf('if (arState.autoSel) {', SRC.indexOf('function initArrangeCanvas'));
  const keys = SRC.slice(at, at + 2200);
  assert.match(keys, /arAutoNudge\(e\.key === 'ArrowUp' \? step : -step\)/);
  assert.match(keys, /arState\.autoSel = \[a, a \+ w\];/, 'left/right walk the band along');
  assert.match(SRC, /arState\.drag = \{ kind: 'autoGroup', y0: y, span: \[\.\.\.arState\.autoSel\]/);
  // the edges go in on the first movement, so a click inside the band leaves nothing behind
  assert.match(SRC, /if \(!d\.mid && Math\.abs\(y - d\.y0\) >= 2\) \{/);
});

test('the strip drags a span with the arrow and places a point with the pencil', () => {
  assert.match(SRC, /arState\.drag = \{ kind: 'autoSel', a: Math\.max\(0, arBarsOf\(x\)\), x0: x \}/);
  assert.match(SRC, /if \(arTool === 'select' \|\| e\.shiftKey \|\| !editable\) \{/,
    'shift spans in the pencil too, and a library lane always spans');
  assert.match(SRC, /const index = arAutoAddPoint\(Math\.max\(0, arSnapTo\(arBarsOf\(x\)\)\), arAutoValAt\(y\)\);/);
});

test('a lane span takes the edit keys, ahead of the arrangement\'s own', () => {
  const at = SRC.indexOf('if (arState.autoSel) {', SRC.indexOf('function initArrangeCanvas'));
  const keys = SRC.slice(at, at + 1200);
  assert.match(keys, /arAutoCopySel\(\{ cut: e\.key\.toLowerCase\(\) === 'x' \}\)/);
  assert.match(keys, /arAutoDuplicateSel\(\)/);
  assert.match(keys, /arAutoDeleteSel\(\)/);
  // ...and it comes first, or cmd+shift+backspace would ripple the CLIPS out from under the lane
  assert.ok(at < SRC.indexOf('arTimeDelete(); e.preventDefault();'));
});

test('cmd+D duplicates the span, shifted or not', () => {
  // In the lanes the two are different ops - repeat the selected clips, or repeat that stretch of
  // time - but a curve has no objects apart from the time they sit on, so both keys mean the one
  // thing here. Unshifted cmd+D would otherwise fall through to the clips' duplicate and, with
  // nothing selected up there, do nothing at all.
  const at = SRC.indexOf('if (arState.autoSel) {', SRC.indexOf('function initArrangeCanvas'));
  assert.match(SRC.slice(at, at + 1200), /if \(mod && e\.key\.toLowerCase\(\) === 'd'\) \{ arAutoDuplicateSel\(\)/);
});

test('a paste goes to whichever clipboard was filled last, not to whatever is marked now', () => {
  // The reported flow: copy a curve, click where it should go - which lets the span go, as any
  // click does - and paste. Routing on the marked span alone put clips there instead.
  assert.match(SRC, /arClipSource = 'auto';/);
  assert.match(SRC, /arClipSource = 'clips';/);
  assert.match(SRC, /&& arAutoCount\(\) && \(arClipSource \? arClipSource === 'auto' : !!arState\.autoSel\)\) \{/);
});

test('an op with no target yet warns rather than erroring', () => {
  // nothing was refused and nothing is broken - the keystroke was just early, and an error pulses
  // the collapsed console red (see logLine)
  for (const m of ['the time ops need a region', 'edit ops need a span',
    'clipboard yet - select a span', 'clipboard yet - drag a span']) {
    assert.match(SRC, new RegExp(`${m}[^)]*?', 'warn'\\)`), m);
  }
});

test('marking a span in one place lets go of the other, and escape lets go of both', () => {
  assert.match(SRC, /arState\.autoSel = null; \/\/ a span marked up here is instead of one in the automation strip/);
  assert.match(SRC, /arState\.autoSel = null; \/\/ \.\.\.including one marked in the automation strip below/);
  assert.match(SRC, /if \(arState\.regionSpan \|\| arState\.sel\.size \|\| arState\.selRegion \|\| arState\.autoSel \|\| arState\.insert != null\) \{/);
});
