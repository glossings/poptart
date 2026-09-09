'use strict';

// Where a zoom with no pointer behind it aims (public/client.js): the arrangement painter's +/-
// buttons and the piano roll's +/- keys both move toward the last place a GESTURE touched, rather
// than toward a fixed edge or the middle of the view.
//
// The rule has two halves and the second is the one that would rot quietly: a focus that has been
// scrolled out of view falls back to the center, so zooming stays a zoom and never turns into a
// jump to somewhere you can't see. Both panels implement it separately (their coordinate systems
// have nothing in common), so both are checked here against the same expectations.

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

// ---------------------------------------------------------------------------------------------
// The arrangement painter
// ---------------------------------------------------------------------------------------------

const AR_GUTTER = 96;
const AR_W = 896; // 800px of timeline past the gutter

/** arZoomFocusX at one scroll/zoom, with `focus` at some bar (or none). */
function arFocus({ focus = null, scroll = 0, pxPerCycle = 40 }) {
  const arState = { focus, scroll, pxPerCycle };
  // eslint-disable-next-line no-new-func
  return new Function('arState', 'AR_GUTTER', 'arW',
    `const arXOf = (bars) => AR_GUTTER + (bars - arState.scroll) * arState.pxPerCycle;
     ${grab('arZoomFocusX')}
     return arZoomFocusX();`)(arState, AR_GUTTER, AR_W);
}

const AR_MID = AR_GUTTER + (AR_W - AR_GUTTER) / 2;

test('the painter zooms toward the bar the last gesture touched', () => {
  // bar 5 at 40px/bar with nothing scrolled = 96 + 200
  assert.equal(arFocus({ focus: 5 }), AR_GUTTER + 200);
  assert.equal(arFocus({ focus: 5, scroll: 2 }), AR_GUTTER + 120, 'and follows the scroll');
});

test('having touched nothing yet, it zooms toward the middle of the view - never the left edge', () => {
  const x = arFocus({ focus: null });
  assert.equal(x, AR_MID);
  assert.notEqual(x, AR_GUTTER, 'the old behavior: everything crawled away to the right');
});

test('a focus scrolled out of view falls back to the middle rather than jumping to it', () => {
  assert.equal(arFocus({ focus: 5, scroll: 40 }), AR_MID, 'off the left');
  assert.equal(arFocus({ focus: 500 }), AR_MID, 'off the right');
  // ...but one still on screen, however near an edge, is honored
  assert.equal(arFocus({ focus: 0 }), AR_GUTTER, 'exactly at the left edge is still visible');
  assert.equal(arFocus({ focus: 20 }), AR_GUTTER + 800, 'and exactly at the right edge too');
});

test('every gesture records the focus, and a drag carries it along', () => {
  assert.match(SRC, /if \(x >= AR_GUTTER\) arState\.focus = arBarsOf\(x\);/, 'set on pointerdown');
  assert.match(SRC, /if \(d && x >= AR_GUTTER\) arState\.focus = arBarsOf\(x\);/, 'and updated through a drag');
  // The buttons are the whole point of the change: they must not pass an anchor of their own.
  assert.match(SRC, /arZoomInBtn\.addEventListener\('click', \(\) => arState && arZoomAt\(1\.25\)\)/);
  assert.match(SRC, /function arZoomAt\(factor, x = arZoomFocusX\(\)\)/);
});

// ---------------------------------------------------------------------------------------------
// The piano roll
// ---------------------------------------------------------------------------------------------

const PR_GUTTER = 40;

/** prZoomFocusPx over a fake metrics object. */
function prFocus({ focusCell = null, scroll = 0, cellW = 20, gridW = 800 }) {
  const prState = { focusCell };
  // eslint-disable-next-line no-new-func
  return new Function('prState', 'PR_GUTTER', 'm',
    `${grab('prZoomFocusPx')}\nreturn prZoomFocusPx(m);`)(prState, PR_GUTTER, { scroll, cellW, gridW });
}

const PR_MID = PR_GUTTER + 400;

test('the roll zooms toward the cell the last gesture touched', () => {
  assert.equal(prFocus({ focusCell: 10 }), PR_GUTTER + 200);
  assert.equal(prFocus({ focusCell: 10, scroll: 4 }), PR_GUTTER + 120, 'and follows the scroll');
});

test('the roll falls back to the middle with no focus, or one out of view', () => {
  assert.equal(prFocus({ focusCell: null }), PR_MID);
  assert.equal(prFocus({ focusCell: 2, scroll: 30 }), PR_MID, 'off the left');
  assert.equal(prFocus({ focusCell: 300 }), PR_MID, 'off the right');
  assert.equal(prFocus({ focusCell: 0 }), PR_GUTTER, 'an edge is still on screen');
});

test('the roll records its focus on press and through a drag, and its keys pass no anchor', () => {
  assert.match(SRC, /if \(px >= PR_GUTTER\) prState\.focusCell = prCellFloat\(px, m\);/);
  assert.match(SRC, /prZoomBy\(e\.key === '-' \|\| e\.key === '_' \? 1 \/ PR_BTN_ZOOM : PR_BTN_ZOOM\);/);
  // the wheel still pins to the pointer, which beats any remembered focus
  assert.match(SRC, /prZoomBy\(Math\.exp\(-e\.deltaY \* PR_ZOOM_WHEEL\), px\)/);
});

// ---------------------------------------------------------------------------------------------
// The painter's REMEMBERED view: reopening the arrangement puts you back where you were working,
// not at bar 1 of a song you were forty bars into. What is worth pinning is the restore, because
// the view is remembered across SONGS: the numbers saved off a forty-track, two-hundred-bar patch
// must never open a short one looking at empty space past its end, or at rows it doesn't have.
// ---------------------------------------------------------------------------------------------

/** arRestoreView into a painter holding a `loopLen`-bar song of `rows` tracks. */
function arRestore(saved, { loopLen = 32, rows = 8, visibleRows = 8, visibleBars = 20 } = {}) {
  const arState = { pxPerCycle: 44, scroll: 0, scrollLane: 0 };
  // eslint-disable-next-line no-new-func
  new Function('arState', 'arDeck', 'arReadViews', 'arLoopLen', 'arVisibleBars', 'arRowCount',
    'arVisibleRows', 'AR_MIN_PX_PER_CYCLE', 'AR_MAX_PX_PER_CYCLE', `
    let arViewSaved = null;
    const arViewOf = (st) => \`\${st.pxPerCycle}|\${st.scroll}|\${st.scrollLane}\`;
    const arClampRows = () => {
      arState.scrollLane = Math.max(0, Math.min(arState.scrollLane, arRowCount() - arVisibleRows()));
    };
    ${grab('arRestoreView')}
    arRestoreView();`)(
    arState, 'a', () => ({ a: saved }), () => loopLen, () => visibleBars,
    () => rows, () => visibleRows, 6, 400,
  );
  return arState;
}

test('the painter reopens where it was left, zoom and position both', () => {
  assert.deepEqual(arRestore({ px: 120, scroll: 12, lane: 3 }, { rows: 20, visibleRows: 8 }),
    { pxPerCycle: 120, scroll: 12, scrollLane: 3 });
});

test('never past the end of THIS song - the view is remembered across patches', () => {
  // Half a screen short of the end: landing a little before where you left off is a view you can
  // read, and landing past it is a blank canvas that looks like the song has gone.
  assert.equal(arRestore({ px: 44, scroll: 400 }, { loopLen: 32, visibleBars: 20 }).scroll, 22);
  assert.equal(arRestore({ px: 44, scroll: -5 }).scroll, 0, 'and never before the top');
  assert.equal(arRestore({ px: 44, scroll: 500 }, { loopLen: 8, visibleBars: 20 }).scroll, 0,
    'a song shorter than the view starts at bar 1');
});

test('rows that are no longer there are scrolled back to ones that are', () => {
  assert.equal(arRestore({ lane: 30 }, { rows: 10, visibleRows: 8 }).scrollLane, 2);
  assert.equal(arRestore({ lane: 30 }, { rows: 4, visibleRows: 8 }).scrollLane, 0,
    'a song that fits does not scroll at all');
});

test('a zoom out of range is clamped, and junk leaves the default alone', () => {
  assert.equal(arRestore({ px: 9000 }).pxPerCycle, 400);
  assert.equal(arRestore({ px: 0.5 }).pxPerCycle, 6);
  assert.deepEqual(arRestore({ px: 'wide', scroll: null, lane: undefined }),
    { pxPerCycle: 44, scroll: 0, scrollLane: 0 });
});

test('nothing remembered for this deck opens the painter exactly as it always did', () => {
  assert.deepEqual(arRestore(undefined), { pxPerCycle: 44, scroll: 0, scrollLane: 0 });
});
