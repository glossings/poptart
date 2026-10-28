// The color picker's arithmetic (public/widgets/widget-math.mjs): the wheel, the palette tab's
// suggestions and how they sit on the theme's background, and the recent picks a browser keeps.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './public/widgets/widget-math.mjs';

const DARK = '#0e0f13';
const LIGHT = '#f6f4ef';
const hue = (hex) => M.hexToHsl(hex)[0];
const apart = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

test('hue rotations turn the wheel and keep saturation and lightness', () => {
  assert.equal(M.rotateHue('#ff0000', 120), '#00ff00');
  assert.equal(M.rotateHue('#ff0000', 240), '#0000ff');
  assert.equal(M.rotateHue('#ff0000', -120), '#0000ff');
  assert.equal(M.rotateHue('#ff0000', 180), '#00ffff');
  const [, s, l] = M.hexToHsl('#c05080');
  const [, s2, l2] = M.hexToHsl(M.rotateHue('#c05080', 90));
  assert.ok(Math.abs(s - s2) < 0.01 && Math.abs(l - l2) < 0.01);
  assert.equal(M.hslHex(360 + 120, 1, 0.5), '#00ff00');
});

test('contrast is WCAG\'s: 21 for black on white, 1 for a color on itself', () => {
  assert.ok(Math.abs(M.contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  assert.equal(M.contrastRatio('#336699', '#336699'), 1);
  assert.equal(M.contrastRatio('#000000', '#ffffff'), M.contrastRatio('#ffffff', '#000000'));
});

test('a color too close to the background is moved just far enough, lighter on dark and darker on light', () => {
  const onDark = M.fitToBackground('#1a1030', DARK);
  assert.ok(M.contrastRatio(onDark, DARK) >= M.MIN_GRAPHIC_CONTRAST);
  assert.ok(M.hexToHsl(onDark)[2] > M.hexToHsl('#1a1030')[2]);
  assert.ok(apart(hue(onDark), hue('#1a1030')) < 3);
  const onLight = M.fitToBackground('#f0e0a0', LIGHT);
  assert.ok(M.contrastRatio(onLight, LIGHT) >= M.MIN_GRAPHIC_CONTRAST);
  assert.ok(M.hexToHsl(onLight)[2] < M.hexToHsl('#f0e0a0')[2]);
  // Already readable: left as it was.
  assert.equal(M.fitToBackground('#ff7a9c', DARK), '#ff7a9c');
});

test('the suggestions are the wheel\'s relations of this track\'s hue', () => {
  const groups = M.colorSuggestions('#ff3355', [], DARK);
  const by = Object.fromEntries(groups.map((g) => [g.key, g]));
  const h0 = hue('#ff3355');
  assert.deepEqual(groups.map((g) => g.label), ['neighbors', 'opposite', 'split opposite', 'three-way', 'unused hues', 'in this song']);
  assert.deepEqual(by.neighbors.colors.map((c) => Math.round(apart(hue(c), h0))), [60, 30, 30, 60].map((d) => d));
  assert.ok(apart(hue(by.opposite.colors[0]), h0) > 177);
  assert.deepEqual(by.split.colors.map((c) => Math.round(apart(hue(c), h0) / 5) * 5), [150, 150]);
  assert.deepEqual(by.triad.colors.map((c) => Math.round(apart(hue(c), h0) / 5) * 5), [120, 120]);
  assert.deepEqual(by.song.colors, ['#ff3355']);
});

test('every suggestion reads on the theme\'s background, light or dark', () => {
  for (const bg of [DARK, LIGHT, '#000000', '#ffffff']) {
    for (const base of ['#ff7a9c', '#202020', '#f8f8f0', '#3355ff', '#ffee00']) {
      const groups = M.colorSuggestions(base, ['#40c0a0', '#e0e040', '#5050a0'], bg);
      for (const g of groups) {
        if (g.key === 'song') continue; // the colors already used are shown as they are
        for (const c of g.colors) assert.ok(M.contrastRatio(c, bg) >= M.MIN_GRAPHIC_CONTRAST, `${c} on ${bg} (${g.label})`);
      }
    }
  }
});

test('the song\'s other tracks set the suggestions\' saturation and lightness, and their hues are left open', () => {
  const others = ['#e04040', '#40e040'];
  const groups = M.colorSuggestions('#4040e0', others, DARK);
  const by = Object.fromEntries(groups.map((g) => [g.key, g]));
  const [, s0, l0] = M.hexToHsl(by.neighbors.colors[0]);
  const meanS = (M.hexToHsl(others[0])[1] + M.hexToHsl(others[1])[1]) / 2;
  assert.ok(Math.abs(s0 - Math.min(0.85, meanS)) < 0.02);
  assert.ok(l0 > 0.3 && l0 < 0.8);
  // Red, green and blue are taken: every open hue keeps its distance from all three.
  for (const c of by.open.colors) for (const h of [0, 120, 240]) assert.ok(apart(hue(c), h) >= 29, c);
  assert.deepEqual(by.song.colors, ['#4040e0', '#e04040', '#40e040']);
});

test('open hues split the widest gaps first', () => {
  assert.deepEqual(M.openHues([0], 1), [180]);
  assert.deepEqual(M.openHues([0, 180], 2), [90, 270]);
  assert.deepEqual(M.openHues([350, 10], 1), [180]);
});

test('the wheel maps a hue and saturation to a point and back', () => {
  for (const [h, s] of [[0, 1], [90, 0.5], [200, 0.25], [359, 0.9]]) {
    const p = M.wheelPoint(h, s, 100);
    const back = M.wheelAt(p.x, p.y, 100);
    assert.ok(apart(back.h, h) < 1e-6);
    assert.ok(Math.abs(back.s - s) < 1e-9);
  }
  assert.equal(M.wheelAt(500, 0, 100).s, 1); // past the rim is the rim
});

test('recent colors: newest first, no repeats, kept to the row', () => {
  let list = [];
  for (const c of ['#111111', '#222222', '#111111', '#ABCDEF']) list = M.rememberColor(list, c, 3);
  assert.deepEqual(list, ['#abcdef', '#111111', '#222222']);
  list = M.rememberColor(list, '#333333', 3);
  assert.deepEqual(list, ['#333333', '#abcdef', '#111111']);
});

test('recent colors survive storage that throws, is missing, or holds junk', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(M.readRecentColors(throwing, 'k', 16), []);
  assert.equal(M.writeRecentColors(throwing, 'k', ['#123456']), false);
  assert.deepEqual(M.readRecentColors(null, 'k', 16), []);
  assert.equal(M.writeRecentColors(null, 'k', ['#123456']), false);
  const kept = new Map();
  const ok = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  assert.equal(M.writeRecentColors(ok, 'k', ['#123456', '#ABCDEF']), true);
  assert.deepEqual(M.readRecentColors(ok, 'k', 16), ['#123456', '#abcdef']);
  kept.set('k', '{not json');
  assert.deepEqual(M.readRecentColors(ok, 'k', 16), []);
  kept.set('k', JSON.stringify(['red', '#123456', 4]));
  assert.deepEqual(M.readRecentColors(ok, 'k', 16), ['#123456']);
});
