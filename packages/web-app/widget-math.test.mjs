// The arithmetic behind the editor's inline widgets (public/widgets/widget-math.mjs): what a control
// writes into the code, and what a display reads out of a frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './public/widgets/widget-math.mjs';

test('a control writes its value clamped, snapped and with as many decimals as its range wants', () => {
  assert.equal(M.snapValue(1.4, 0, 1), 1);
  assert.equal(M.snapValue(0.26, 0, 1, 0.25), 0.25);
  assert.equal(M.snapValue(7, 10, 0), 7); // a reversed range still clamps
  assert.equal(M.decimalsFor(0, 1), 2);
  assert.equal(M.decimalsFor(20, 20000), 0);
  assert.equal(M.decimalsFor(0, 10), 1);
  assert.equal(M.decimalsFor(0, 1, 0.125), 3);
  assert.equal(M.decimalsFor(0, 100, 1), 0);
});

test('only a plain number literal is read back as the control\'s value', () => {
  assert.equal(M.literalNumber(' 0.5 '), 0.5);
  assert.equal(M.literalNumber('-2e-3'), -0.002);
  assert.equal(M.literalNumber('.25'), 0.25);
  assert.equal(M.literalNumber('x / 2'), null);
  assert.equal(M.literalNumber('"0.5"'), null);
  assert.deepEqual(M.stringContent('"x . x"'), { from: 1, to: 6, text: 'x . x' });
  assert.equal(M.stringContent('steps'), null);
});

test('a scope starts at the latest rising zero crossing that leaves it a full window', () => {
  const n = 400;
  const wave = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / 50 + 0.3));
  const start = M.scopeTrigger(wave, 100);
  assert.ok(start <= n - 100);
  assert.ok(wave[start - 1] < 0 && wave[start] >= 0);
  assert.ok(start > n - 100 - 50, 'the latest one, so the picture is current');
  assert.equal(M.scopeTrigger(new Array(400).fill(0.2), 100), 300); // DC: no crossing, the latest window
});

test('a spectrum column reads the loudest bin it covers', () => {
  const db = new Array(1024).fill(-120);
  db[43] = -6; // ~1 kHz at 23.4 Hz a bin
  const cols = M.spectrumColumns(db, 23.4375, 300);
  const peak = cols.indexOf(Math.max(...cols));
  // 1 kHz is 1.7 decades above 20 Hz out of 3: about 57% of the way across.
  assert.ok(Math.abs(peak / 300 - Math.log10(1000 / 20) / 3) < 0.02, `peak at column ${peak}`);
  assert.equal(Math.max(...cols), -6);
});

test('the goniometer puts mono straight up and out-of-phase sideways', () => {
  const mono = M.imagerPoints([0.5, -0.5], [0.5, -0.5]);
  assert.ok(Math.abs(mono.pts[0]) < 1e-9 && mono.pts[1] > 0.7);
  assert.ok(Math.abs(mono.correlation - 1) < 1e-9);
  const anti = M.imagerPoints([0.5, -0.5], [-0.5, 0.5]);
  assert.ok(Math.abs(anti.pts[1]) < 1e-9);
  assert.ok(Math.abs(anti.correlation + 1) < 1e-9);
  assert.equal(M.imagerPoints([0, 0], [0, 0]).correlation, 0);
});

test('notes are named with c3 = 60', () => {
  assert.equal(M.midiOf('c3'), 60);
  assert.equal(M.midiOf('f#2'), 54);
  assert.equal(M.midiOf('eb4'), 75);
  assert.equal(M.midiOf('bd'), null);
  assert.equal(M.pitchClassOf(61), 1);
  assert.equal(M.pitchClassOf('a2'), 9);
  assert.equal(M.valueLabel(60, true), 'c3');
  assert.equal(M.valueLabel('bd'), 'bd');
});

test('a punchcard folds onto the values it has: numbers low to high, then words in order', () => {
  const { rows, count } = M.punchcardRows([[0, 1, 64], [1, 2, 'sd'], [0, 1, 60], [2, 3, 'bd'], [3, 4, 64]]);
  assert.equal(count, 4);
  assert.deepEqual([...rows.entries()], [[60, 0], [64, 1], ['sd', 2], ['bd', 3]]);
});

test('a plot is padded so a flat line sits mid-height, unless the range is fixed', () => {
  assert.deepEqual(M.plotRange([0.5, 0.5]), [0, 1]);
  const [lo, hi] = M.plotRange([0, 10]);
  assert.ok(lo < 0 && hi > 10);
  assert.deepEqual(M.plotRange([0, 10], 0, 20), [0, 20]);
  assert.deepEqual(M.plotRange([null, NaN]), [0, 1]);
});

test('the cells the highlighter is lighting, and a meter that falls back slowly', () => {
  const cells = [{ from: 0, to: 1 }, { from: 2, to: 3 }, { from: 4, to: 6 }];
  assert.deepEqual(M.litCells([[102, 103]], 100, cells), [1]);
  assert.deepEqual(M.litCells([[100, 101], [104, 106]], 100, cells), [0, 2]);
  assert.deepEqual(M.litCells([[90, 91]], 100, cells), []); // another atom's span
  assert.deepEqual(M.litCells([[100, 101]], -1, cells), []); // steps(8): no text to light
  const prev = Float32Array.from([-10, -10]);
  assert.deepEqual([...M.decay(prev, [-5, -40], 2)], [-5, -12]);
});

test('a spectrum\'s level axis is fixed by its range and height, and thins its labels when short', () => {
  const tall = M.spectrumTicks(-90, 0, 200);
  assert.deepEqual(tall.lines, [0, -12, -24, -36, -48, -60, -72, -84]);
  assert.deepEqual(tall.labels, tall.lines);
  const short = M.spectrumTicks(-90, 0, 64);
  assert.deepEqual(short.labels, [0, -24, -48, -72]);
  assert.equal(M.freqLabel(100), '100');
  assert.equal(M.freqLabel(10000), '10k');
  assert.ok(Math.abs(M.freqX(632.4555, 300) - 150) < 0.01); // the middle of 20 Hz - 20 kHz, on a log axis
});

test('a corner drag scales the size by how far the hand went, inside the kind\'s range', () => {
  const range = { min: 8, max: 48 };
  assert.equal(M.draggedSize(16, { width: 160, height: 40 }, 80, 0, 'xy', range), 24);
  assert.equal(M.draggedSize(16, { width: 160, height: 40 }, 0, 20, 'xy', range), 24);
  assert.equal(M.draggedSize(16, { width: 160, height: 40 }, 0, 20, 'x', range), 16);
  assert.equal(M.draggedSize(16, { width: 160, height: 40 }, -200, 0, 'x', range), 8);
  assert.equal(M.draggedSize(64, { width: 100, height: 64 }, 0, 640, 'y', { min: 24, max: 240 }), 240);
});

test('a row of fours gaps before each beat; any other row runs on', () => {
  assert.deepEqual([...Array(8).keys()].filter((i) => M.beatStart(i, 8)), [4]);
  assert.deepEqual([...Array(16).keys()].filter((i) => M.beatStart(i, 16)), [4, 8, 12]);
  assert.deepEqual([...Array(6).keys()].filter((i) => M.beatStart(i, 6)), []);
  assert.deepEqual([...Array(4).keys()].filter((i) => M.beatStart(i, 4)), []);
});

test('a track without a .color() keeps the same palette color on every evaluation, keyed by its name', () => {
  const dark = M.trackPalette('#ff7a9c', '#0e0f13');
  const light = M.trackPalette('#c04c6e', '#f6f4ef');
  assert.equal(dark.length, 12);
  assert.ok(dark.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.equal(new Set(dark).size, 12);
  assert.deepEqual(M.trackPalette('#ff7a9c', '#0e0f13'), dark); // the same theme, the same palette
  // Lighter on a dark theme, darker on a light one.
  const lum = (hex) => M.parseHex(hex).reduce((a, b) => a + b, 0);
  assert.ok(lum(dark[3]) > lum(light[3]));
  assert.equal(M.isLightBg('#f6f4ef'), true);
  assert.equal(M.isLightBg('#0e0f13'), false);
  const auto = M.resolveTrackColor({ label: 'bass', color: null }, dark);
  assert.equal(auto, dark[M.nameHash('bass') % 12]);
  assert.equal(M.resolveTrackColor({ label: 'bass', color: null }, dark), auto);
  assert.equal(M.nameHash('bass'), M.nameHash('bass'));
  assert.notEqual(M.nameHash('bass'), M.nameHash('kick'));
  // A color it was given wins; one the browser can't draw falls back to the automatic one.
  assert.equal(M.resolveTrackColor({ label: 'bass', color: 'pink' }, dark), 'pink');
  assert.equal(M.resolveTrackColor({ label: 'bass', color: 'nope' }, dark, { isColor: (x) => x !== 'nope' }), auto);
  assert.equal(M.resolveTrackColor(null, dark, { fallback: '#ff7a9c' }), '#ff7a9c');
});

test('the displays behind the code share the height in bands, in the order written', () => {
  assert.deepEqual(M.backgroundBands(0, 600), []);
  assert.deepEqual(M.backgroundBands(1, 600), [{ y: 0, height: 600 }]);
  assert.deepEqual(M.backgroundBands(3, 601), [{ y: 0, height: 200 }, { y: 200, height: 200 }, { y: 400, height: 201 }]);
});

test('a corner drag sets width and height apart, each inside its range', () => {
  const ranges = { width: { min: 8, max: 48 }, height: { min: 8, max: 48 } };
  assert.deepEqual(M.draggedBox({ width: 16, height: 16 }, { width: 160, height: 40 }, 80, 0, ranges), { width: 24, height: 16 });
  assert.deepEqual(M.draggedBox({ width: 16, height: 16 }, { width: 160, height: 40 }, 0, 20, ranges), { width: 16, height: 24 });
  assert.deepEqual(M.draggedBox({ width: 16, height: 16 }, { width: 160, height: 40 }, 160, -40, ranges), { width: 32, height: 8 });
});

test('a meter stands up when it is taller than wide, with the desk\'s ticks where they fit', () => {
  assert.equal(M.meterVertical(12, 80), true);
  assert.equal(M.meterVertical(48, 12), false);
  assert.equal(M.meterVertical(20, 20), false);
  assert.deepEqual(M.meterTicks(140), [6, 0, -6, -12, -18, -24, -36]);
  assert.ok(M.meterTicks(40).length < 7);
  assert.equal(M.meterColor(0), '#f85149');
  assert.equal(M.meterColor(-6), '#d29922');
  assert.equal(M.meterColor(-20), '#3fb950');
});
