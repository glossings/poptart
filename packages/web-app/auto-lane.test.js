'use strict';

// The arrange view's automation strip (public/client.js): the value<->pixel mapping the curve is
// drawn and dragged through, the breakpoint hit-testing, and reading a lane's points back out of
// its _auto(...) definition.
//
// The strip is drawn on a canvas and edited with pointer events, neither of which a test can hold -
// but the arithmetic under both is ordinary, and it is where a silent wrong answer would live: a
// range that rescales mid-drag moves the point under the hand, an off-by-one in the segment search
// bends the wrong stretch of curve. Like slice-fit.test.js, the functions are lifted out of the
// shipped client.js rather than copied, so this fails if they drift.

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

// The constants the mapping is built on, read off the source so the test can't disagree with it.
function constant(name) {
  const m = new RegExp(`^const ${name} = (-?[\\d.]+);`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return Number(m[1]);
}
const AR_AUTO_H = constant('AR_AUTO_H');
const AR_AUTO_PAD = constant('AR_AUTO_PAD');
const AR_AUTO_HIT = constant('AR_AUTO_HIT');

const LIFTED = ['arAutoYOf', 'arAutoValAt', 'arRefreshAutoRange', 'arAutoPointAt', 'arAutoSegAtBar', 'arAutoSegmentAt', 'arAutoAddPoint', 'arAutoPointsOf', 'splitFirstArg']
  .map(grab)
  .join('\n\n');

/**
 * The lifted functions over a fake panel. The geometry the strip sits in is a plain linear map in
 * the real thing too (see arXOf/arBarsOf): the gutter is 96px and a bar is `pxPerCycle` wide.
 */
function harness({ points = [], range = null, pxPerCycle = 40, scroll = 0, def = null, prebake = [] } = {}) {
  const GUTTER = 96;
  const TOP = 400; // wherever the lanes happen to end - the strip's own math is relative to it
  const arState = {
    autoPts: points.map((p) => ({ ...p })),
    autoRange: range ?? [0, 1],
    autoId: 'lane',
  };
  const env = {
    arState,
    AR_AUTO_H,
    AR_AUTO_PAD,
    AR_AUTO_HIT,
    arAutoTop: () => TOP,
    arXOf: (bars) => GUTTER + (bars - scroll) * pxPerCycle,
    arBarsOf: (x) => scroll + (x - GUTTER) / pxPerCycle,
    arAutoDefOf: () => def,
    prPrebakeAutos: prebake,
    cm: { getValue: () => env.code ?? '' },
    shapeMod: null,
    code: '',
  };
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(env), `${LIFTED}\nreturn { arAutoYOf, arAutoValAt, arRefreshAutoRange, arAutoPointAt, arAutoSegmentAt, arAutoAddPoint, arAutoPointsOf };`);
  return { fns: build(...Object.values(env)), arState, env, TOP, GUTTER };
}

// ---------------------------------------------------------------------------------------------
// The value axis
// ---------------------------------------------------------------------------------------------

test('the strip maps its range top to bottom, padded at both ends', () => {
  const { fns, TOP } = harness();
  assert.equal(fns.arAutoYOf(1), TOP + AR_AUTO_PAD, 'the top of the range is the top of the strip');
  assert.equal(fns.arAutoYOf(0), TOP + AR_AUTO_H - AR_AUTO_PAD, 'and the bottom is the bottom');
  assert.equal(fns.arAutoYOf(0.5), TOP + AR_AUTO_H / 2, 'halfway is halfway');
});

test('y and value are inverses of each other', () => {
  const { fns } = harness();
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(fns.arAutoValAt(fns.arAutoYOf(v)) - v) < 1e-9, `round trip at ${v}`);
  }
});

test('reading past either end of the strip clamps rather than running off the range', () => {
  const { fns, TOP } = harness();
  assert.equal(fns.arAutoValAt(TOP - 50), 1);
  assert.equal(fns.arAutoValAt(TOP + AR_AUTO_H + 50), 0);
});

test('the range is 0..1 until something is drawn outside it', () => {
  const flat = harness({ points: [{ x: 0, y: 0.2 }, { x: 8, y: 0.9 }] });
  flat.fns.arRefreshAutoRange();
  assert.deepEqual(flat.arState.autoRange, [0, 1], 'a normalized lane keeps the parameter range');

  const semis = harness({ points: [{ x: 0, y: -12 }, { x: 8, y: 12 }] });
  semis.fns.arRefreshAutoRange();
  assert.deepEqual(semis.arState.autoRange, [-12, 12], 'a lane feeding .add() is drawn to fit');

  const loud = harness({ points: [{ x: 0, y: 0 }, { x: 4, y: 2.5 }] });
  loud.fns.arRefreshAutoRange();
  assert.deepEqual(loud.arState.autoRange, [0, 2.5], 'and one past unity keeps 0 at the floor');
});

test('0 and 1 are always on the strip, so its rules always mean something', () => {
  const { fns, arState } = harness({ points: [{ x: 0, y: 5 }] });
  fns.arRefreshAutoRange();
  assert.deepEqual(arState.autoRange, [0, 5], 'a lane living at 5 still shows where 0 and 1 are');
  const [lo, hi] = arState.autoRange;
  assert.ok(hi - lo >= 1, 'which also means the range can never be zero-height');
});

test('the drawn range is held, not recomputed - a drag cannot rescale under the hand', () => {
  const { fns, arState } = harness({ points: [{ x: 0, y: 0 }, { x: 8, y: 1 }] });
  const before = fns.arAutoYOf(1);
  arState.autoPts[1].y = 4; // as a drag would, before the range is refreshed
  assert.equal(fns.arAutoYOf(1), before, 'the mapping still reads the held range');
  fns.arRefreshAutoRange(); // ...which only follows the data once the hand is off
  assert.deepEqual(arState.autoRange, [0, 4]);
});

// ---------------------------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------------------------

test('a breakpoint is grabbed within the hit radius, and the nearest one wins', () => {
  const { fns, GUTTER, TOP } = harness({ points: [{ x: 0, y: 1 }, { x: 4, y: 0 }], pxPerCycle: 40 });
  const x4 = GUTTER + 160;
  const y4 = TOP + AR_AUTO_H - AR_AUTO_PAD;
  assert.equal(fns.arAutoPointAt(x4, y4), 1);
  assert.equal(fns.arAutoPointAt(x4 + AR_AUTO_HIT - 1, y4), 1, 'just inside the radius');
  assert.equal(fns.arAutoPointAt(x4 + AR_AUTO_HIT + 4, y4), null, 'just outside it');

  // two points a few pixels apart: the closer one is the one grabbed
  const close = harness({ points: [{ x: 0, y: 0.5 }, { x: 0.1, y: 0.5 }], pxPerCycle: 40 });
  const y = close.fns.arAutoYOf(0.5);
  assert.equal(close.fns.arAutoPointAt(close.GUTTER + 1, y), 0);
  assert.equal(close.fns.arAutoPointAt(close.GUTTER + 4, y), 1);
});

test('the segment under x is the one a bend applies to', () => {
  const { fns, GUTTER } = harness({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 0 }], pxPerCycle: 40 });
  assert.equal(fns.arAutoSegmentAt(GUTTER + 40), 0, 'bar 1 is in the first segment');
  assert.equal(fns.arAutoSegmentAt(GUTTER + 240), 1, 'bar 6 is in the second');
  assert.equal(fns.arAutoSegmentAt(GUTTER + 400), null, 'past the last point there is nothing to bend');
});

test('a zero-width segment is never the one bent', () => {
  // a vertical step: two points at the same bar, which has no stretch to push a curve into
  const { fns, GUTTER } = harness({ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 8, y: 1 }], pxPerCycle: 40 });
  assert.equal(fns.arAutoSegmentAt(GUTTER + 160), 0, 'the step itself is not offered');
});

// ---------------------------------------------------------------------------------------------
// Adding points
// ---------------------------------------------------------------------------------------------

test('a new breakpoint lands in ascending bar order, and its index is the one dragged', () => {
  const { fns, arState } = harness({ points: [{ x: 0, y: 0 }, { x: 8, y: 1 }] });
  const i = fns.arAutoAddPoint(4, 0.5);
  assert.equal(i, 1);
  assert.deepEqual(arState.autoPts.map((p) => p.x), [0, 4, 8]);
  assert.deepEqual(arState.autoPts[i], { x: 4, y: 0.5, c: 0 });

  assert.equal(fns.arAutoAddPoint(12, 0.2), 3, 'past the end appends');
  // A bar that already has a point gets the new one AFTER it - two points at one bar is a vertical
  // step, and drawing one puts the far end of the step under the hand, which is the half you meant.
  assert.equal(fns.arAutoAddPoint(0, 0.9), 1);
  assert.deepEqual(arState.autoPts.map((p) => p.x), [0, 0, 4, 8, 12]);
});

test('adding into an empty lane works - the first click has to land somewhere', () => {
  const { fns, arState } = harness({ points: [] });
  assert.equal(fns.arAutoAddPoint(2, 0.3), 0);
  assert.equal(arState.autoPts.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Reading a lane out of the buffer
// ---------------------------------------------------------------------------------------------

test('the points come out of the definition the editor wrote', async () => {
  const shapeMod = await import(require('node:url').pathToFileURL(
    path.join(path.dirname(require.resolve('@poptart/pattern-core')), 'shape.mjs'),
  ).href);
  const code = '_auto("intro", "0,0 16,0 20,1,-2 32,0.3")';
  const h = harness({ def: { open: code.indexOf('('), close: code.length - 1 } });
  h.env.code = code;
  h.env.shapeMod = shapeMod;
  // rebuilt with the module and code in scope
  // eslint-disable-next-line no-new-func
  const fns = new Function(...Object.keys(h.env), `${LIFTED}\nreturn { arAutoPointsOf };`)(...Object.values(h.env));
  const pts = fns.arAutoPointsOf('intro');
  assert.deepEqual(pts.map((p) => [p.x, p.y]), [[0, 0], [16, 0], [20, 1], [32, 0.3]]);
  assert.equal(pts[2].c, -2);
});

test('half-typed breakpoints read as nothing rather than throwing every frame', async () => {
  const shapeMod = await import(require('node:url').pathToFileURL(
    path.join(path.dirname(require.resolve('@poptart/pattern-core')), 'shape.mjs'),
  ).href);
  const code = '_auto("intro", "0,0 16,")';
  const h = harness({ def: { open: code.indexOf('('), close: code.length - 1 } });
  h.env.code = code;
  h.env.shapeMod = shapeMod;
  // eslint-disable-next-line no-new-func
  const fns = new Function(...Object.keys(h.env), `${LIFTED}\nreturn { arAutoPointsOf };`)(...Object.values(h.env));
  assert.equal(fns.arAutoPointsOf('intro'), null);
});

test('a name with no definition falls back to the prebake library', () => {
  const h = harness({ def: null, prebake: [{ id: 'swell', points: [{ x: 0, y: 0 }, { x: 16, y: 1 }] }] });
  // eslint-disable-next-line no-new-func
  const fns = new Function(...Object.keys(h.env), `${LIFTED}\nreturn { arAutoPointsOf };`)(...Object.values(h.env));
  assert.deepEqual(fns.arAutoPointsOf('swell').map((p) => p.x), [0, 16]);
  assert.equal(fns.arAutoPointsOf('nothere'), null);
});

// ---------------------------------------------------------------------------------------------
// The wiring the strip depends on
// ---------------------------------------------------------------------------------------------

test('the automation registry is one of the def registries, so folding and auto-naming reach it', () => {
  assert.match(SRC, /const autoDefs = makeDefRegistry\(\{/);
  assert.match(SRC, /defCall: '_auto'/);
  assert.match(SRC, /useCall: 'auto'/);
  const m = /const DEF_REGISTRIES = \[([^\]]*)\]/.exec(SRC);
  assert.ok(m, 'DEF_REGISTRIES not found');
  assert.ok(m[1].includes('autoDefs'), 'autoDefs must be in DEF_REGISTRIES');
});

test('the strip only adds to the canvas height when it is open', () => {
  const size = grab('arSizeCanvas');
  assert.match(size, /arAutoShown\(\) \? arAutoBottom\(\) : arGridBottom\(\)/);
  assert.match(size, /arCanvas\.style\.height/, 'the CSS height has to follow, or the strip is clipped');
});
