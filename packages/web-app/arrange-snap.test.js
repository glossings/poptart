'use strict';

// The arrangement painter's paint grid (public/client.js): `auto` divides it by how far the view
// is zoomed in, so the grid you snap to is always a grid you can see and hit.
//
// What this guards is the pair staying in step. The painter draws its vertical grid from arCell()
// and skips cells narrower than 5px, while every gesture quantizes through arSnapTo() - so a
// division finer than the drawing threshold means snapping to lines that aren't there. Under auto
// that can't happen, and the test below says so in the same arithmetic the painter uses, lifted
// out of the shipped file rather than copied.

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

function constant(name) {
  const m = new RegExp(`^const ${name} = (-?[\\d.]+);`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return Number(m[1]);
}
function list(name) {
  const m = new RegExp(`^const ${name} = \\[([^\\]]*)\\]`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return m[1].split(',').map((s) => Number(s.trim()));
}

const AR_SNAPS = list('AR_SNAPS');
const AR_AUTO_SNAP_PX = constant('AR_AUTO_SNAP_PX');
const AR_DEFAULT_PX_PER_CYCLE = constant('AR_DEFAULT_PX_PER_CYCLE');
const AR_MIN_PX_PER_CYCLE = constant('AR_MIN_PX_PER_CYCLE');
const AR_MAX_PX_PER_CYCLE = constant('AR_MAX_PX_PER_CYCLE');

/** arSnapAuto/arSnap/arCell/arSnapTo over a fake painter at one zoom and one snap setting. */
function at(pxPerCycle, snap = 'auto') {
  const arState = { pxPerCycle, snap };
  const src = [grab('arSnapAuto'), 'const arSnap = () => (arState.snap === \'auto\' ? arSnapAuto() : arState.snap);',
    'const arCell = () => 1 / arSnap();',
    'const arSnapTo = (bars) => { const n = arSnap(); return Math.round(bars * n) / n; };'].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('arState', 'AR_SNAPS', 'AR_AUTO_SNAP_PX',
    `${src}\nreturn { arSnapAuto, arSnap, arCell, arSnapTo };`)(arState, AR_SNAPS, AR_AUTO_SNAP_PX);
}

test('auto divides finer as the view zooms in, and back to bars as it zooms out', () => {
  const seen = [6, 12, 22, 44, 88, 176, 400].map((px) => at(px).arSnapAuto());
  // never coarser as the zoom goes up
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `division went backwards at ${i}: ${seen}`);
  assert.equal(at(AR_MIN_PX_PER_CYCLE).arSnapAuto(), 1, 'fully zoomed out is whole bars');
  assert.equal(at(AR_MAX_PX_PER_CYCLE).arSnapAuto(), Math.max(...AR_SNAPS), 'fully zoomed in is the finest offered');
});

test('the default zoom lands on quarters - auto starts where the painter has always sat', () => {
  assert.equal(at(AR_DEFAULT_PX_PER_CYCLE).arSnapAuto(), 4);
});

test('every division auto picks is one the painter actually draws', () => {
  // drawArrange skips a cell narrower than 5px; snapping to one would be aiming at nothing.
  for (let px = AR_MIN_PX_PER_CYCLE; px <= AR_MAX_PX_PER_CYCLE; px += 1) {
    const n = at(px).arSnapAuto();
    assert.ok(AR_SNAPS.includes(n), `${n} is not one of the offered divisions (at ${px}px)`);
    assert.ok(px / n >= AR_AUTO_SNAP_PX || n === 1,
      `at ${px}px a 1/${n} cell is ${(px / n).toFixed(1)}px - finer than auto should ever go`);
    assert.ok(px / n >= 5 || n === 1, `at ${px}px a 1/${n} cell is too fine for the painter to draw`);
  }
});

test('auto never picks a division it could go finer than by one step', () => {
  for (let px = AR_MIN_PX_PER_CYCLE; px <= AR_MAX_PX_PER_CYCLE; px += 1) {
    const n = at(px).arSnapAuto();
    const finer = AR_SNAPS.find((c) => c > n);
    if (finer) assert.ok(px / finer < AR_AUTO_SNAP_PX, `at ${px}px it settled on 1/${n} with room for 1/${finer}`);
  }
});

test('a pinned division ignores the zoom entirely', () => {
  assert.equal(at(400, 8).arSnapAuto(), 16, 'auto would say sixteenths here...');
  assert.equal(at(400, 8).arSnap(), 8, '...but a pinned 1/8 stays 1/8');
  assert.equal(at(6, 8).arSnap(), 8, 'at any zoom');
  assert.equal(at(44, 3).arSnap(), 3, 'including a hand-typed division the menu never offers');
});

test('the cell and the quantizer agree, whichever mode is in force', () => {
  for (const [px, snap] of [[44, 'auto'], [400, 'auto'], [6, 'auto'], [44, 16], [44, 3]]) {
    const fns = at(px, snap);
    const cell = fns.arCell();
    assert.ok(Math.abs(fns.arSnapTo(cell) - cell) < 1e-9, `a cell boundary must be its own snap (${px}px, ${snap})`);
    assert.ok(Math.abs(fns.arSnapTo(cell * 3) - cell * 3) < 1e-9, 'and so must any whole number of them');
    assert.ok(Math.abs(fns.arSnapTo(cell * 0.4)) < 1e-9, 'while a fraction of one rounds to the cell below');
    assert.ok(Math.abs(fns.arSnapTo(cell * 2.6) - cell * 3) < 1e-9, 'and one past the halfway to the cell above');
  }
});

test('the menu offers auto, and the change handler keeps it a string', () => {
  assert.match(SRC, /autoOpt\.value = 'auto'/);
  assert.match(SRC, /arSnapSelect\.value === 'auto' \? 'auto' :/);
  // Written into the call only when pinned: 'auto' IS the default, so it stays absent.
  assert.match(SRC, /if \(state\.snap !== arrangeMod\.ARRANGE_DEFAULT_SNAP\) opts\.snap = state\.snap;/);
});
