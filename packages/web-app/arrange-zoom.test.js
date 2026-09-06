'use strict';

// Where a zoom with no pointer behind it aims (public/client.js): the arrangement painter's +/-
// buttons and the piano roll's +/- keys both move toward the last place a GESTURE touched, rather
// than toward a fixed edge or the middle of the view.
//
// The rule has two halves and the second is the one that would rot quietly: a focus that has been
// scrolled out of view falls back to the centre, so zooming stays a zoom and never turns into a
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
  assert.notEqual(x, AR_GUTTER, 'the old behaviour: everything crawled away to the right');
});

test('a focus scrolled out of view falls back to the middle rather than jumping to it', () => {
  assert.equal(arFocus({ focus: 5, scroll: 40 }), AR_MID, 'off the left');
  assert.equal(arFocus({ focus: 500 }), AR_MID, 'off the right');
  // ...but one still on screen, however near an edge, is honoured
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
