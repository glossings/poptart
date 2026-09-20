'use strict';

// The piano roll's bend overlay (public/client.js): the semitone<->pixel mapping the curve is drawn
// and dragged through, breakpoint and segment hit-testing, the flat line a first edit starts from,
// and the round trip through the roll's own call.
//
// The overlay is a canvas edited with pointer events, neither of which a test can hold - but the
// arithmetic under both is ordinary, and it is where a silent wrong answer would live: a scale that
// disagrees with the grid puts the curve under the wrong note, an off-by-one in the segment search
// curves the wrong stretch. Like auto-lane.test.js, the functions are lifted out of the shipped
// client.js rather than copied, so this fails if they drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  // The body starts after the PARAMETER list, which may itself be braced: prCallOpts destructures
  // its argument, and starting the brace count at the first `{` would end the lift on the closing
  // brace of the parameters and hand back half a function.
  let depth = 0;
  let bodyAt = -1;
  for (let i = SRC.indexOf('(', at); i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && --depth === 0) { bodyAt = SRC.indexOf('{', i); break; }
  }
  assert.ok(bodyAt > 0, `could not find ${name}'s body`);
  depth = 0;
  for (let i = bodyAt; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  assert.fail(`unbalanced braces in ${name}`);
  return '';
}

/** A `const NAME = expr;` from the source, evaluated - so the test can't disagree with the code. */
function constant(name) {
  const m = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  // eslint-disable-next-line no-new-func
  return new Function('PR_ROWS', `return (${m[1]});`)(constantRaw('PR_ROWS'));
}
function constantRaw(name) {
  const m = new RegExp(`^const ${name} = (-?[\\d.]+);`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return Number(m[1]);
}

const PR_ROWS = constantRaw('PR_ROWS');
const PR_GUTTER = constantRaw('PR_GUTTER_KEYS'); // the keyboard's gutter - the width a bend is drawn against
const PR_BEND_RANGE = constant('PR_BEND_RANGE');
const PR_BEND_HIT = constantRaw('PR_BEND_HIT');
const PR_BEND_MAGNET = constantRaw('PR_BEND_MAGNET');
// eslint-disable-next-line no-new-func
const PR_SNAP_PX = new Function(`return ${/^const PR_SNAP_PX = (\[[^\]]*\]);/m.exec(SRC)[1]};`)();
const DEFAULT_BEND_RANGE = constantRaw('DEFAULT_BEND_RANGE');

// The arrow functions the section is mostly made of, lifted as their whole `const … = …;` lines.
function grabConsts(names) {
  return names.map((n) => {
    const m = new RegExp(`^const ${n} = [^;]*;`, 'm').exec(SRC);
    assert.ok(m, `${n} not found in client.js`);
    return m[0];
  }).join('\n');
}

const LIFTED = [
  grabConsts(['prBendKey', 'prBendCenterY', 'prBendY', 'prBendSemisAt', 'prBendValueAt', 'prBendLoop',
    'prBendAlignTop', 'prBendEps']),
  'let prBendClipboard = null;', // module-level in the real thing; per-harness here, so tests don't leak
  grab('prBendExtent'),
  grab('prBendNoteRows'),
  grab('prBendMagnet'),
  grab('prBendAlignedRow'),
  grab('prBendPointAt'),
  grab('prBendSegAtCell'),
  grab('prBendSegmentAt'),
  grab('prBendSeed'),
  grab('prBendAddPoint'),
  grab('prBendCell'),
  // The real snapper, not a stand-in: what a bend point snaps to IS the roll's own division grid,
  // and a stub that rounded to whole cells would have quietly tested a rule the panel doesn't have.
  grab('prSnapCell'),
  grab('prBarDivisions'),
  grab('prBendSpanHint'),
  grab('prBendPointsIn'),
  grab('prBendClearSpan'),
  grab('prBendSplitSpan'),
  grab('prBendMaterializeSpan'),
  grab('prBendFit'),
  grab('prBendNudge'),
  grab('prBendInsert'),
  grab('prBendCopySel'),
  grab('prBendDeleteSel'),
  grab('prBendPaste'),
  grab('prBendDuplicateSel'),
  grab('prCallOpts'),
].join('\n\n');

const RETURNED = ['prBendKey', 'prBendY', 'prBendSemisAt', 'prBendValueAt', 'prBendLoop', 'prBendExtent', 'prBendPointAt',
  'prBendSegAtCell', 'prBendSegmentAt', 'prBendSeed', 'prBendAddPoint', 'prBendCell', 'prCallOpts',
  'prBendNoteRows', 'prBendMagnet', 'prBendAlignedRow', 'prBendAlignTop', 'prBendPointsIn', 'prBendClearSpan',
  'prBendMaterializeSpan', 'prBendFit', 'prBendNudge', 'prBendInsert', 'prBendCopySel',
  'prBendDeleteSel', 'prBendPaste', 'prBendDuplicateSel'];

/**
 * The lifted functions over a fake panel. The roll's geometry is a plain linear map in the real
 * thing too (see prCellToX/prCellFloat in prMetrics): the gutter is 54px and a cell is `cellW` wide.
 */
function harness({ bend = [], sel = null, notes = [], grid = 16, len = 16, start = 0, cellW = 20, scroll = 0, pitchTop = 83 } = {}) {
  const GRID_TOP = 16; // PR_TOPBAR in the real panel
  const GRID_H = 384; // PR_GRIDH
  // minCell/cols are the RENDERED span - what prMetrics works out from the loop plus whatever is
  // drawn outside it. They are the only fence a bend point has left, so the tests need them real.
  const m = {
    gridTop: GRID_TOP, gridH: GRID_H, rowH: GRID_H / PR_ROWS, rows: PR_ROWS, cellW, scroll, W: 660,
    minCell: Math.min(0, start), cols: start + len + 24,
  };
  const prState = {
    bend: bend.map((p) => ({ ...p })),
    bendSel: sel,
    bendHeld: null,
    caret: null,
    notes: notes.map((n) => ({ ...n })),
    grid, len, start, pitchTop, mode: 'note', swing: 0, swinggrid: null,
  };
  const log = [];
  const committed = [];
  const env = {
    prState,
    PR_ROWS,
    PR_GUTTER,
    PR_BEND_RANGE,
    PR_BEND_HIT,
    PR_BEND_MAGNET,
    shapeMod: require('../pattern-core/src/shape.mjs'),
    prCellToX: (cell, mm) => PR_GUTTER + (cell - mm.scroll) * mm.cellW,
    prCellFloat: (px, mm) => mm.scroll + (px - PR_GUTTER) / mm.cellW,
    PR_SNAP_PX,
    // The panel's own plumbing, stubbed: committing writes the call and records undo (covered by
    // the roll's other tests), and the note axis is the identity here - a note's row IS its lane.
    prBendCommit: () => committed.push(prBendKeyOf(prState.bend)),
    logLine: (text, kind) => log.push({ text, kind }),
    drawPianoroll: () => {},
    prLiveNotes: (ns) => ns.filter((n) => !n.hidden),
    prRowOf: (n) => n.midi,
    prPosOf: (row) => row,
  };
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(env), `${LIFTED}\nreturn { ${RETURNED.join(', ')} };`);
  return { fns: build(...Object.values(env)), prState, m, GRID_TOP, GRID_H, log, committed };
}

/** The undo key's shape, computed outside the harness so the commit stub can use it. */
const prBendKeyOf = (points) => (points ?? []).map((p) => `${p.x},${p.y},${p.c ?? 0}`).join(' ');

// ---------------------------------------------------------------------------------------------
// The semitone axis - one grid row per semitone, zero in the middle
// ---------------------------------------------------------------------------------------------

test('a semitone is exactly one grid row, measured from the centre', () => {
  const { fns, m, GRID_TOP, GRID_H } = harness();
  const centre = GRID_TOP + GRID_H / 2;
  assert.equal(fns.prBendY(0, m), centre, 'no bend sits on the middle of the grid');
  // This is the whole reason the curve is drawn over the notes rather than in a lane of its own:
  // two semitones of bend is two rows tall, against the very notes it bends.
  assert.equal(fns.prBendY(2, m), centre - 2 * m.rowH, 'up two semitones is up two rows');
  assert.equal(fns.prBendY(-2, m), centre + 2 * m.rowH, '...and down is down');
});

test('pixels and semitones are inverses, clamped to the half-grid either way', () => {
  const { fns, m } = harness();
  for (const v of [-12, -3, -0.5, 0, 1.75, 12]) {
    assert.ok(Math.abs(fns.prBendSemisAt(fns.prBendY(v, m), m) - v) < 1e-9, `round trip at ${v}`);
  }
  assert.equal(PR_BEND_RANGE, 12, 'an octave either way - a musical reach, not half of however many rows are on screen');
  assert.equal(fns.prBendSemisAt(-500, m), PR_BEND_RANGE, 'dragging off the top stops at the reach');
  assert.equal(fns.prBendSemisAt(5000, m), -PR_BEND_RANGE, '...and off the bottom likewise');
});

// ---------------------------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------------------------

test('a press near a breakpoint grabs it, and the nearest one wins', () => {
  const { fns, m } = harness({ bend: [{ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 5, y: 2 }] });
  const at = (cell, semis) => [fns.prBendY(semis, m), PR_GUTTER + cell * m.cellW];
  const [y4, x4] = at(4, 2);
  assert.equal(fns.prBendPointAt(x4, y4, m), 1, 'dead on it');
  assert.equal(fns.prBendPointAt(x4 + PR_BEND_HIT - 1, y4, m), 1, 'within the grab radius');
  assert.equal(fns.prBendPointAt(x4, y4 + 40, m), null, 'well below it: nothing');
  // Two points a cell apart: the press goes to whichever is closer, not to whichever is first.
  const mid = (x4 + PR_GUTTER + 5 * m.cellW) / 2;
  assert.equal(fns.prBendPointAt(mid + 3, y4, m), 2, 'the nearer of two neighbours');
});

test('a press on the curve between two points finds that segment', () => {
  const { fns, m } = harness({ bend: [{ x: 0, y: 0 }, { x: 8, y: 4 }, { x: 16, y: 0 }] });
  const onCurveAt = (cell) => [PR_GUTTER + cell * m.cellW, fns.prBendY(fns.prBendValueAt(cell), m)];
  assert.equal(fns.prBendSegmentAt(...onCurveAt(4), m), 0, 'the rising half');
  assert.equal(fns.prBendSegmentAt(...onCurveAt(12), m), 1, 'the falling half');
  const [x] = onCurveAt(4);
  assert.equal(fns.prBendSegmentAt(x, fns.prBendY(fns.prBendValueAt(4), m) + 40, m), null, 'off the curve: nothing');
});

test('a LEVEL segment is not curvable, so a press there places a point instead', () => {
  // Curvature is the shape of a journey between two values; a segment that goes nowhere has none.
  // Without this, the flat line a curve starts from would swallow every press that opened it.
  const { fns, m } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 0 }] });
  const centreY = fns.prBendY(0, m);
  assert.equal(fns.prBendSegmentAt(PR_GUTTER + 8 * m.cellW, centreY, m), null);
  // ...while a sloped one at the same place is.
  const sloped = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 4 }] });
  const y = sloped.fns.prBendY(sloped.fns.prBendValueAt(8), sloped.m);
  assert.equal(sloped.fns.prBendSegmentAt(PR_GUTTER + 8 * sloped.m.cellW, y, sloped.m), 0);
});

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

test('the first edit lays a flat line across the loop, so a bend comes back', () => {
  // A lone breakpoint would HOLD its value over the whole loop - a detuned roll, not a bend. The
  // ends are pinned at zero first, so one press gives a rise and a return.
  const { fns, prState } = harness({ bend: [], grid: 16, len: 16, start: 4 });
  fns.prBendSeed();
  assert.deepEqual(prState.bend, [{ x: 4, y: 0, c: 0 }, { x: 20, y: 0, c: 0 }], 'pinned at the loop window\'s own ends');
  fns.prBendSeed();
  assert.equal(prState.bend.length, 2, 'seeding again leaves the curve it already has alone');
});

test('a new breakpoint lands in ascending cell order wherever it is dropped', () => {
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 0 }] });
  assert.equal(fns.prBendAddPoint(8, 3), 1, 'between the ends');
  assert.equal(fns.prBendAddPoint(2, -1), 1, 'before that one');
  assert.deepEqual(prState.bend.map((p) => p.x), [0, 2, 8, 16]);
  assert.deepEqual(prState.bend.map((p) => p.y), [0, -1, 3, 0]);
});

test('a breakpoint may be drawn outside the loop, and is fenced only by what is on screen', () => {
  // Out there it does not sound - the curve is read at `cell mod len` - but it is drawn, and
  // opening the loop up to it brings it in. The same freedom the notes have.
  const { fns, m } = harness({ grid: 16, len: 8, start: 4 });
  assert.deepEqual(fns.prBendLoop(), [4, 12], 'the loop is still the stretch that plays');
  assert.equal(fns.prBendCell(PR_GUTTER + 16 * m.cellW, m, false, false), 16, 'past the loop\'s end is allowed');
  assert.equal(fns.prBendCell(PR_GUTTER - 5000, m, false, false), m.minCell, 'dragged off the left: the rendered edge');
  assert.equal(fns.prBendCell(PR_GUTTER + 5000 * m.cellW, m, false, false), m.cols, '...and the rendered edge on the right');
});

test('the extent is the loop widened by whatever was drawn outside it', () => {
  const inside = harness({ grid: 16, len: 16, start: 0, bend: [{ x: 2, y: 1 }, { x: 8, y: 0 }] });
  assert.deepEqual(inside.fns.prBendExtent(), [0, 16], 'a curve within the loop does not widen it');
  const past = harness({ grid: 16, len: 16, start: 0, bend: [{ x: 2, y: 1 }, { x: 30, y: 0 }] });
  assert.deepEqual(past.fns.prBendExtent(), [0, 30], '...and one reaching past it does');
});

test('a bend point snaps to the roll\'s divisions, to whole cells with shift, and free with alt', () => {
  // A bend is the one thing on this grid that lives between the cells, so it is also the only one
  // with a way to turn the grid off entirely.
  const { fns, m } = harness({ grid: 16, len: 16, start: 0, cellW: 20 });
  const at = (cell, ...mods) => Math.round(fns.prBendCell(PR_GUTTER + cell * m.cellW, m, ...mods) * 100) / 100;
  // Near a bar line the coarse division pulls the point onto it, past where mere rounding would.
  assert.equal(at(15.3, false, false), 16, 'no modifier: the bar line wins from within its reach');
  assert.equal(at(15.3, true, false), 15, 'shift: the nearest whole cell, bar line or not');
  assert.equal(at(15.3, false, true), 15.3, 'alt: exactly where the pointer is');
  assert.equal(at(15.3, true, true), 15.3, 'alt wins over shift - both ask for less snapping, not more');
  // Away from any division the magnet has nothing in reach, so the two agree on the nearest cell.
  assert.equal(at(6.4, false, false), 6);
  assert.equal(at(6.4, true, false), 6);
});

// ---------------------------------------------------------------------------------------------
// What gets written into the call
// ---------------------------------------------------------------------------------------------

test('a curve is written into the roll\'s options; a flat one is not written at all', () => {
  const curve = [{ x: 0, y: 0, c: 0 }, { x: 8, y: 2, c: -3 }, { x: 16, y: 0, c: 0 }];
  const { fns } = harness({ bend: curve });
  assert.equal(fns.prCallOpts({ grid: 16, len: 16, bend: curve }).bend, '0,0 8,2,-3 16,0');
  // Flattening a bend out has to leave the roll exactly as it would have been had one never been
  // drawn - not a row of zeroes, which would still cost the track a polled control at playback.
  assert.equal('bend' in fns.prCallOpts({ grid: 16, len: 16, bend: [{ x: 0, y: 0 }, { x: 16, y: 0 }] }), false);
  assert.equal('bend' in fns.prCallOpts({ grid: 16, len: 16, bend: [] }), false);
  assert.equal('bend' in fns.prCallOpts({ grid: 16, len: 16 }), false, 'a roll-shaped state with no bend field at all');
});

test('the undo key tells two curves apart, curvature included', () => {
  const { fns } = harness();
  const a = [{ x: 0, y: 0, c: 0 }, { x: 8, y: 2, c: 0 }];
  assert.notEqual(fns.prBendKey(a), fns.prBendKey([{ x: 0, y: 0, c: 0 }, { x: 8, y: 2, c: -3 }]), 'a bent segment is an edit');
  assert.notEqual(fns.prBendKey(a), fns.prBendKey([]), 'and so is deleting the curve');
  assert.equal(fns.prBendKey([]), fns.prBendKey(undefined), 'no curve reads the same either way round');
});

// ---------------------------------------------------------------------------------------------
// The call parser, against the builder that has to read the same text back
// ---------------------------------------------------------------------------------------------

test('what the panel writes is what pianoroll() reads', async () => {
  const { pianoroll } = await import('../pattern-core/src/signal.mjs');
  const { fns } = harness();
  const curve = [{ x: 0, y: 0, c: 0 }, { x: 8, y: 3, c: 0 }, { x: 16, y: 0, c: 0 }];
  const opts = fns.prCallOpts({ grid: 16, len: 16, bend: curve });
  const roll = pianoroll('60,0,4', opts);
  // Written at cell 8 of a 16-cell loop on a 16-per-cycle grid: half a cycle in.
  assert.equal(roll.channel.bend.sample(0.5, 1, 0.5), 3);
  assert.equal(DEFAULT_BEND_RANGE, 2, 'the overlay draws its reach lines at the same default the language uses');
});

// ---------------------------------------------------------------------------------------------
// The marked span, and the edit verbs on it
// ---------------------------------------------------------------------------------------------

/** A curve as `cell,semitones` pairs, for readable assertions. */
const shape = (pts) => pts.map((p) => `${Math.round(p.x * 1000) / 1000},${Math.round(p.y * 1000) / 1000}`).join(' ');

test('lifting a span moves that stretch and leaves the curve either side of it', () => {
  // A slide from 0 up to 2 and back, with the middle four cells marked.
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 8, y: 2 }, { x: 16, y: 0 }], sel: [6, 10] });
  const mid = fns.prBendMaterializeSpan(6, 10);
  for (const p of mid) p.y += 1;
  // Each edge gains a PAIR on the same cell: an anchor holding the old value out there, and its
  // twin inside the span which moved. That is the vertical step at the edge of a lifted selection.
  assert.equal(shape(prState.bend), '0,0 6,1.5 6,2.5 8,3 10,2.5 10,1.5 16,0');
  assert.equal(fns.prBendValueAt(0), 0, 'the curve before the span is untouched');
  assert.equal(fns.prBendValueAt(16), 0, '...and after it');
  assert.equal(fns.prBendValueAt(8), 3, 'inside, everything came up by one');
});

test('lifting the same span twice does not re-lift the anchors it left behind', () => {
  // A cell carrying two breakpoints is a vertical step: the first belongs to the left, the last to
  // the right. Without that rule the anchors would be picked up by the next move and dragged along,
  // and the step at the edge would grow every time.
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 0 }], sel: [4, 12] });
  for (const p of fns.prBendMaterializeSpan(4, 12)) p.y += 1;
  const once = shape(prState.bend);
  for (const p of fns.prBendMaterializeSpan(4, 12)) p.y += 1;
  assert.equal(shape(prState.bend), once.replace(/,1(?= |$)/g, ',2'), 'only the inside moved again');
  assert.equal(prState.bend.length, 6, 'and no new anchors appeared');
});

test('a group lift is clamped as one move, so the shape survives hitting the ceiling', () => {
  // Clamping point by point would flatten whichever reached the reach first, quietly rewriting the
  // curve you were only trying to raise.
  const { fns } = harness();
  assert.equal(fns.prBendFit([0, 2], 15), PR_BEND_RANGE - 2, 'only as far as the highest point can go');
  assert.equal(fns.prBendFit([-2, 0], -15), -PR_BEND_RANGE + 2, '...and likewise downward');
  assert.equal(fns.prBendFit([0, 2], 5), 5, 'a move that fits is not clamped at all');
  assert.equal(fns.prBendFit([], 5), 0, 'nothing selected, nothing to move');
});

test('arrow keys lift a marked span, a fine step by default', () => {
  const { fns, prState, committed } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 0 }], sel: [4, 12] });
  fns.prBendNudge(0.25);
  assert.equal(fns.prBendValueAt(8), 0.25);
  assert.equal(committed.length, 1, 'a nudge is an edit: it writes and records undo');
  fns.prBendNudge(0.25);
  assert.equal(fns.prBendValueAt(8), 0.5, 'and they accumulate without restacking anchors');
  assert.equal(fns.prBendValueAt(0), 0, 'outside the span, nothing moved');
});

test('a nudge with no span says how to make one instead of doing nothing', () => {
  const { fns, log, committed } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 2 }] });
  fns.prBendNudge(1);
  assert.equal(committed.length, 0);
  assert.match(log[0].text, /need a span/);
  assert.equal(log[0].kind, 'warn');
});

test('copying a span trims it at the edges, at the values the curve had reached there', () => {
  // Copying the middle of a slide has to give you that stretch of the slide, starting where it had
  // got to - not the whole slide, and not a stretch that starts from zero.
  const { fns } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 4 }], sel: [4, 8] });
  const points = fns.prBendPointsIn(4, 8);
  assert.equal(shape(points), '0,1 4,2', 'measured from the span\'s own start');
});

test('a span over a roll that does not bend copies as the flat stretch it is', () => {
  // So pasting it FLATTENS what it lands on, rather than quietly doing nothing.
  const { fns } = harness({ bend: [], sel: [0, 8] });
  assert.equal(shape(fns.prBendPointsIn(0, 8)), '0,0 8,0');
});

test('cut takes the span out and leaves it on the clipboard for paste', () => {
  const { fns, prState, committed } = harness({ bend: [{ x: 0, y: 0 }, { x: 8, y: 3 }, { x: 16, y: 0 }], sel: [6, 10] });
  fns.prBendCopySel({ cut: true });
  assert.equal(shape(prState.bend), '0,0 16,0', 'the peak is gone; the curve runs straight across');
  assert.equal(committed.length, 1);
  // ...and pasting it back somewhere else reproduces the shape there.
  prState.bendSel = [0, 4];
  fns.prBendPaste();
  assert.equal(fns.prBendValueAt(2), 3, 'the peak landed two cells into the new span');
  assert.deepEqual(prState.bendSel, [0, 4], 'what landed is the span now, so it repeats');
});

test('a paste replaces the stretch it lands on rather than overlaying it', () => {
  // Two curves stacked on the same cells is not a thicker curve, it is a zigzag between them.
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 8, y: 0 }, { x: 16, y: 0 }], sel: [0, 8] });
  fns.prBendCopySel();
  prState.bendSel = [8, 16];
  fns.prBendPaste();
  const inSpan = prState.bend.filter((p) => p.x > 8 && p.x < 16);
  assert.equal(inSpan.length, 1, 'exactly the pasted peak lives in there - nothing was left under it');
  assert.equal(fns.prBendValueAt(12), 2);
});

test('paste with nothing copied says so rather than failing silently', () => {
  const { fns, log, committed } = harness({ bend: [{ x: 0, y: 0 }, { x: 16, y: 1 }] });
  fns.prBendPaste();
  assert.equal(committed.length, 0);
  assert.match(log[0].text, /nothing on the bend clipboard/);
});

test('duplicate repeats the span into the stretch after it, and walks along', () => {
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 0 }, { x: 16, y: 0 }], sel: [0, 4] });
  fns.prBendDuplicateSel();
  assert.deepEqual(prState.bendSel, [4, 8], 'the copy is the span now: pressing again walks one more along');
  assert.equal(fns.prBendValueAt(6), 2, 'the peak repeated a span later');
  fns.prBendDuplicateSel();
  assert.equal(fns.prBendValueAt(10), 2, 'and again');
});

test('duplicate carries on past the end of the loop rather than stopping at it', () => {
  // What lands out there does not sound yet - it waits for the loop to be opened up to it, which is
  // how a phrase gets built longer than the window it was started in.
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 8, y: 2 }, { x: 16, y: 0 }], sel: [8, 16] });
  fns.prBendDuplicateSel();
  assert.deepEqual(prState.bendSel, [16, 24], 'the copy sits past the loop, and is the span now');
  assert.equal(fns.prBendValueAt(16), 2, 'the shape repeated from where the loop ends');
  assert.deepEqual(fns.prBendExtent(), [0, 24], 'and the view grows to hold it');
  assert.equal(fns.prBendLoop()[1], 16, 'the loop itself is untouched - opening it is the user\'s call');
});

test('paste lands at the caret when nothing is marked', () => {
  // The complaint this answers: without a declared position a paste can only go back where the
  // material came from, which is the head of the roll as often as not.
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 4, y: 0 }, { x: 16, y: 0 }], sel: [0, 4] });
  fns.prBendCopySel();
  prState.bendSel = null;
  prState.caret = 10;
  fns.prBendPaste();
  assert.equal(fns.prBendValueAt(12), 3, 'the peak landed two cells past the caret');
  assert.deepEqual(prState.bendSel, [10, 14], 'what landed is the span now');
});

test('paste with no caret and no span falls back to the loop\'s opening', () => {
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 4, y: 0 }, { x: 16, y: 0 }], sel: [0, 4] });
  fns.prBendCopySel();
  prState.bendSel = null;
  prState.caret = null;
  fns.prBendPaste();
  assert.deepEqual(prState.bendSel, [0, 4]);
});

test('a paste may land past the loop, unfolded rather than squashed against its end', () => {
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 4, y: 0 }, { x: 16, y: 0 }], sel: [0, 4] });
  fns.prBendCopySel();
  prState.bendSel = null;
  prState.caret = 20;
  fns.prBendPaste();
  assert.equal(fns.prBendValueAt(22), 3, 'the shape kept its width out there');
  assert.deepEqual(fns.prBendExtent(), [0, 24]);
});

test('deleting a span can empty the curve outright - that is how a roll says it does not bend', () => {
  const { fns, prState } = harness({ bend: [{ x: 0, y: 0 }, { x: 8, y: 2 }, { x: 16, y: 0 }], sel: [0, 16] });
  fns.prBendDeleteSel();
  assert.deepEqual(prState.bend, [], 'no breakpoints left at all');
  assert.equal('bend' in fns.prCallOpts({ grid: 16, len: 16, bend: prState.bend }), false, 'so nothing is written');
});

// ---------------------------------------------------------------------------------------------
// The wheel's magnet
// ---------------------------------------------------------------------------------------------

test('the zero line lands on a note\'s row centre at pitchTop = pos + half the grid - half a row', () => {
  // The alignment that makes the curve readable as pitch: with zero parked on the note being bent,
  // where the curve goes IS where the note goes.
  const { fns, m, GRID_TOP, GRID_H } = harness({ notes: [{ midi: 60 }] });
  const aligned = fns.prBendAlignTop(60, m);
  assert.equal(aligned, 60 + PR_ROWS / 2 - 0.5);
  // Check it really centres the row: the row's top is (pitchTop - pos) rows below the grid's top.
  const rowTop = GRID_TOP + (aligned - 60) * m.rowH;
  assert.ok(Math.abs(rowTop + m.rowH / 2 - (GRID_TOP + GRID_H / 2)) < 1e-9, 'row centre meets the zero line');
});

test('the wheel is pulled onto the nearest drawn note, and let go past the magnet', () => {
  const { fns, m } = harness({ notes: [{ midi: 60 }, { midi: 67 }] });
  const near = fns.prBendAlignTop(60, m);
  assert.equal(fns.prBendMagnet(near + PR_BEND_MAGNET / 2, m), near, 'inside the magnet: snapped');
  assert.equal(fns.prBendMagnet(near - PR_BEND_MAGNET / 2, m), near, '...from either side');
  const loose = near + PR_BEND_MAGNET + 0.1;
  assert.equal(fns.prBendMagnet(loose, m), loose, 'past it: scrolling is scrolling again');
  // Two notes in reach of each other would be unusual, but the nearer one wins either way.
  assert.equal(fns.prBendMagnet(fns.prBendAlignTop(67, m) + 0.1, m), fns.prBendAlignTop(67, m));
});

test('a roll with no notes has nothing to magnetize to', () => {
  const { fns, m } = harness({ notes: [] });
  assert.equal(fns.prBendMagnet(41.3, m), 41.3);
  assert.equal(fns.prBendAlignedRow(m), null);
});

test('hidden notes are not magnet targets, and a duplicated row is one target', () => {
  // Buried notes are kept in the panel so they can come back, but they do not sound and are not
  // drawn - so the zero line has no business clicking onto them.
  const { fns, m } = harness({ notes: [{ midi: 60 }, { midi: 60 }, { midi: 72, hidden: true }] });
  assert.deepEqual(fns.prBendNoteRows(m), [60], 'one row, once');
});

test('the centre line knows when it is sitting on a note', () => {
  const { fns, m, prState } = harness({ notes: [{ midi: 64 }] });
  prState.pitchTop = fns.prBendAlignTop(64, m);
  assert.equal(fns.prBendAlignedRow(m), 64);
  prState.pitchTop += 0.2;
  assert.equal(fns.prBendAlignedRow(m), null, 'off the alignment, the line is just a line');
});
