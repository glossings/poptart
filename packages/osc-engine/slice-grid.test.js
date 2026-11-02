'use strict';

// Slice grids - `.slices(8)`, `.slices("1/4")` - laid over a file: the shared rule
// (slice-grid-core.mjs), and the desktop's playSample and the browser's engine cutting the same
// events at the same places. No engine boot on either side.

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index.js');
const { fittedLength, isSliceGrid, divisionPositions, evenPositions, gridSlices } = require('./slice-grid-core.mjs');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const count = (n) => ({ grid: { count: n } });
const div = (every, label, extra = {}) => ({ grid: { every, label, ...extra } });

// --- the rule ---------------------------------------------------------------------------------

test('fittedLength is .fit()\'s length: auto the nearest power of two, a number as asked', () => {
  assert.equal(fittedLength('auto', 2.1), 2);
  assert.equal(fittedLength('auto', 2.9), 4);
  assert.equal(fittedLength('auto', 0.7), 0.5);
  assert.equal(fittedLength(3, 2.1), 3);
  assert.equal(fittedLength(null, 2.1), null);
  assert.equal(fittedLength(0, 2.1), null);
});

test('an even count cuts every file into that many', () => {
  assert.deepEqual(evenPositions(4), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(gridSlices(count(8), { measures: 3.3 }).positions, [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 8));
});

test('a division is one slice per that much of the fitted length', () => {
  assert.equal(divisionPositions(0.25, 1).length, 4, 'one cycle of quarters');
  assert.equal(divisionPositions(0.25, 2).length, 8, 'two cycles');
  assert.deepEqual(divisionPositions(0.25, 2), [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 8));
  // Dotted eighths over one cycle: 5 1/3 of them, so five whole ones and a shorter last slice.
  const dotted = divisionPositions(0.1875, 1);
  assert.equal(dotted.length, 6);
  assert.ok(near(dotted[5], 0.9375));
  assert.equal(divisionPositions(1 / 24, 1).length, 24, '16th triplets');
  // A hair over the length is not a slice of its own.
  assert.equal(divisionPositions(0.25, 1.001).length, 4);
});

test('a division is laid over the fit given, else the length .fit() would give', () => {
  assert.deepEqual(gridSlices(div(0.25, '1/4'), { fit: 2, measures: 1.3 }), { positions: divisionPositions(0.25, 2), cycles: 2, assumed: false });
  assert.deepEqual(gridSlices(div(0.25, '1/4'), { fit: 'auto', measures: 1.3 }).cycles, 1);
  const none = gridSlices(div(0.25, '1/4'), { measures: 2.9 });
  assert.equal(none.cycles, 4);
  assert.equal(none.assumed, true);
  // An audition carries the chain's fit on the grid; a fit on the event wins over it.
  assert.equal(gridSlices(div(0.25, '1/4', { fit: 2 }), { measures: 1.3 }).cycles, 2);
  assert.equal(gridSlices(div(0.25, '1/4', { fit: 2 }), { fit: 4, measures: 1.3 }).cycles, 4);
});

test('isSliceGrid tells a grid from positions and from a map of files', () => {
  assert.ok(isSliceGrid(count(8)));
  assert.ok(isSliceGrid(div(0.25, '1/4')));
  assert.ok(!isSliceGrid([0, 0.5]));
  assert.ok(!isSliceGrid({ 'breaks/a.wav': [0, 0.5] }));
  assert.ok(!isSliceGrid({ grid: [0, 0.5] }), 'a file called "grid" is still a file');
  assert.ok(!isSliceGrid(null));
});

// --- both engines -----------------------------------------------------------------------------

const DURATION = 4.2;

function desktop() {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  engine.getTime = () => 0;
  engine._packs.set('breaks', { status: 'ready', files: [{ path: 'breaks/a.wav', duration: DURATION, channels: 2 }] });
  engine._send = () => {};
  const warnings = [];
  const warn = console.warn;
  return {
    engine,
    warnings,
    play: (cfg) => {
      console.warn = (m) => warnings.push(m);
      try {
        return engine.playSample('t1', 'breaks', cfg, 0, 0.25);
      } finally {
        console.warn = warn;
      }
    },
  };
}

async function browser() {
  const { FakeAudioContext, fakeWorkletFor } = await import('../web-engine/fake-context.mjs');
  const { catalog } = await import('../web-engine/src/catalog.mjs');
  const { WebAudioEngine } = await import('../web-engine/src/engine/web-audio-engine.mjs');
  const ctx = new FakeAudioContext();
  const buffer = ctx.createBuffer(1, DURATION * 4000, 4000);
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog, warn: (m) => warnings.push(m), AudioWorkletNode: fakeWorkletFor(catalog),
    samples: { get: () => buffer, fileKey: () => 'breaks/a.wav' },
  });
  engine.createTrack('t1');
  return { engine, warnings, play: (cfg) => engine.playSample('t1', 'breaks', cfg, 0, 0.25) };
}

const CASES = [
  ['an even count', { slice: 3, slices: count(8), secPerCycle: 1 }, [3 / 8, 4 / 8]],
  ['a count wraps', { slice: 9, slices: count(8), secPerCycle: 1 }, [1 / 8, 2 / 8]],
  ['quarters over the chain\'s fit(2)', { slice: 5, slices: div(0.25, '1/4'), fit: 2, secPerCycle: 1 }, [5 / 8, 6 / 8]],
  ['dotted eighths over fit(1)', { slice: 5, slices: div(0.1875, '1/8.'), fit: 1, secPerCycle: 1 }, [0.9375, 1]],
  ['16th triplets over fit() auto', { slice: 30, slices: div(1 / 24, '1/16t'), fit: 'auto', secPerCycle: 1 }, [30 / 96, 31 / 96]],
  ['quarters with no fit', { slice: 7, slices: div(0.25, '1/4'), secPerCycle: 2 }, [7 / 8, 1]],
  ['quarters, spliced, keep the chain fit for the grid', { slice: 2, slices: div(0.25, '1/4'), fit: 1, splice: 1, secPerCycle: 1 }, [0.5, 0.75]],
  ['an audition\'s grid carries the fit', { slice: 1, slices: div(0.5, '1/2', { fit: 4 }), secPerCycle: 1 }, [1 / 8, 2 / 8]],
];

test('the desktop and the browser cut a grid at the same places, at the same speed', async () => {
  const web = await browser();
  for (const [what, cfg, [begin, end]] of CASES) {
    const d = desktop().play({ ...cfg });
    const b = web.play({ ...cfg });
    assert.ok(!d.skipped && !b.skipped, `${what}: plays (${d.skipped ?? b.skipped ?? ''})`);
    assert.ok(near(d.begin, begin) && near(d.end, end), `${what}: desktop ${d.begin}..${d.end}, want ${begin}..${end}`);
    assert.ok(near(b.begin, d.begin) && near(b.end, d.end), `${what}: browser ${b.begin}..${b.end}, desktop ${d.begin}..${d.end}`);
    assert.ok(near(b.speed, d.speed), `${what}: browser speed ${b.speed}, desktop ${d.speed}`);
  }
});

test('a division with no fit is laid over what .fit() would give, said once per file on both', async () => {
  // 4.2 s at 2 s a cycle is 2.1 cycles, which .fit() makes 2: eight quarters. The rate is the
  // file's own, since nothing asked for a fit.
  const d = desktop();
  const web = await browser();
  for (const k of [0, 1, 2]) {
    const cfg = { slice: k, slices: div(0.25, '1/4'), secPerCycle: 2 };
    assert.ok(near(d.play({ ...cfg }).begin, k / 8));
    assert.ok(near(web.play({ ...cfg }).begin, k / 8));
  }
  assert.equal(d.warnings.length, 1);
  assert.equal(web.warnings.length, 1);
  assert.match(d.warnings[0], /\.slices\("1\/4"\): a\.wav has no fit, so its 1\/4s are laid over 2 cycles/);
  assert.equal(d.warnings[0].replace('[poptart] ', ''), web.warnings[0].replace('[web-engine] ', ''), 'the same line on both');
  assert.ok(near(d.play({ slice: 0, slices: div(0.25, '1/4'), secPerCycle: 2 }).speed, 1), 'unfitted: the natural rate');
});

test('a count needs no fit and says nothing', async () => {
  const d = desktop();
  d.play({ slice: 0, slices: count(8), secPerCycle: 2 });
  assert.equal(d.warnings.length, 0);
});

test('the speed a fit gives and the length a division is laid over come from one rule', async () => {
  // fit(4) on a 2.1-cycle file: speed 2.1/4, and quarters over 4 cycles - sixteen of them.
  const d = desktop().play({ slice: 15, slices: div(0.25, '1/4'), fit: 4, secPerCycle: 2 });
  assert.ok(near(d.speed, 2.1 / 4));
  assert.ok(near(d.begin, 15 / 16) && near(d.end, 1));
});

test('a set\'s own fit lays a division where the chain has none (the plan both builds share)', async () => {
  const { planSample } = await import('../web-engine/src/engine/sample-plan.mjs');
  const p = planSample({ duration: DURATION }, { slice: 3, secPerCycle: 1 }, 0, 0.25, { grid: div(0.25, '1/4'), authoredFit: 1 });
  assert.deepEqual([p.begin, p.end], [0.75, 1]);
  assert.equal(p.gridAssumed, null);
  const chain = planSample({ duration: DURATION }, { slice: 3, fit: 2, secPerCycle: 1 }, 0, 0.25, { grid: div(0.25, '1/4'), authoredFit: 1 });
  assert.deepEqual([chain.begin, chain.end], [3 / 8, 4 / 8], 'the chain\'s fit wins, as for the rate');
});

test('a named set still chops on its markers on both engines', async () => {
  const web = await browser();
  const b = web.play({ slice: 1, slices: { 'breaks/a.wav': [0, 0.3, 0.6] }, secPerCycle: 1 });
  // The desktop keys a file outside the library by its basename (samples.js sampleKey).
  const d = desktop().play({ slice: 1, slices: { 'a.wav': [0, 0.3, 0.6] }, secPerCycle: 1 });
  assert.deepEqual([b.begin, b.end], [0.3, 0.6]);
  assert.deepEqual([d.begin, d.end], [0.3, 0.6]);
});
