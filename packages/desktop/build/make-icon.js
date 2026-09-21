#!/usr/bin/env node
'use strict';

// Draws the app icons: the header's logo chip, the same red-into-amber tile as the tab icon
// (web-app/public/favicon.svg), carrying the app's mark - an up arrow beside a hollow square -
// at the 1024px electron-builder converts to .icns and .ico. The tab icon stays a bare tile: at
// 16px a mark has no room, where an app icon is seen large.
//
//   icon.png      macOS. The tile sits on Apple's icon grid - an 824px body centered in the
//                 1024px canvas - so it is the size of its neighbors in the Dock instead of
//                 overflowing them. electron-builder also falls back to this file elsewhere.
//   icon-win.png  Windows. Full bleed, with the favicon's own corner proportion: Windows has no
//                 grid, and a padded icon reads as a small one in the taskbar.
//
// It is drawn here rather than exported from the SVG because a build machine has no SVG
// rasterizer to rely on, and shapes this simple do not need one: a rounded rectangle and a
// stroked line are distance functions, and a gradient is one line. Builtins only. Run it after
// changing the colors (keep them in step with favicon.svg); the PNGs it writes are committed.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
const FROM = [0xff, 0x30, 0x40]; // favicon.svg's gradient stops, top left...
const TO = [0xd8, 0xa2, 0x4a]; // ...to bottom right

// The mark, in units of the tile's side (0..1 across it), as line art of one stroke weight: an
// arrow of three strokes and a rounded square outline. One color for both, shaded top to bottom,
// over a soft shadow that lifts it off the tile.
// The two glyphs are meant to LOOK the same height, so the arrow is 3% taller (0.36 to the
// square's 0.35): a rounded point measured equal to a flat edge reads as shorter. The arrow's
// top and bottom are its center line, so its stroke ends reach half a stroke past them.
const STROKE = 0.072;
const ARROW = { x: 0.2875, top: 0.356, bottom: 0.644, arm: 0.125 };
const SQUARE = { x: 0.6985, y: 0.5, half: 0.175, corner: 0.06 }; // corner: of the stroke's center line
// A lit rim on the tile - lighter along the top edge, darker along the bottom - so the tile has
// the depth the mark's shadow implies. Width in tile units; strengths are mixes toward white/black.
const RIM = { width: 0.022, light: 0.2, dark: 0.12 };
const MARK_TOP = [0xff, 0xfb, 0xf4];
const MARK_BOTTOM = [0xff, 0xde, 0xc4];
const SHADOW = { color: [0x6e, 0x14, 0x1e], strength: 0.4, drop: 0.014, blur: 0.03 };

const ICONS = [
  { file: 'icon.png', body: 824, radius: 185 },
  { file: 'icon-win.png', body: SIZE, radius: Math.round((SIZE * 9) / 32) },
];

function strokeDistance(u, v, ax, ay, bx, by) {
  const h = Math.min(Math.max(((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0), 1);
  return Math.hypot(u - ax - (bx - ax) * h, v - ay - (by - ay) * h) - STROKE / 2;
}

/** Signed distance from a point to the mark, in tile units (negative inside a stroke). */
function markDistance(u, v) {
  const { x, top, bottom, arm } = ARROW;
  const center = SQUARE.half - STROKE / 2; // the outline's center line
  const qx = Math.abs(u - SQUARE.x) - (center - SQUARE.corner);
  const qy = Math.abs(v - SQUARE.y) - (center - SQUARE.corner);
  const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - SQUARE.corner;
  return Math.min(
    strokeDistance(u, v, x, top, x, bottom),
    strokeDistance(u, v, x, top, x - arm, top + arm),
    strokeDistance(u, v, x, top, x + arm, top + arm),
    Math.abs(box) - STROKE / 2,
  );
}

const clamp01 = (n) => Math.min(Math.max(n, 0), 1);
const smoothstep = (a, b, n) => {
  const s = clamp01((n - a) / (b - a));
  return s * s * (3 - 2 * s);
};

/** RGBA pixels of a gradient rounded square of side `body`, centered on a SIZE x SIZE canvas. */
function draw({ body, radius }) {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const inset = (SIZE - body) / 2;
  const half = body / 2;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      // Signed distance from the pixel's center to the rounded square's edge (negative inside);
      // half a pixel either side of the edge is the antialiasing ramp.
      const qx = Math.abs(x + 0.5 - SIZE / 2) - (half - radius);
      const qy = Math.abs(y + 0.5 - SIZE / 2) - (half - radius);
      const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const coverage = Math.min(Math.max(0.5 - distance, 0), 1);
      if (coverage === 0) continue;
      // The SVG's x1,y1=0,0 -> x2,y2=1,1 over the shape's own box: position along the diagonal.
      const t = Math.min(Math.max((x + 0.5 - inset + (y + 0.5 - inset)) / (2 * body), 0), 1);
      const at = (y * SIZE + x) * 4;
      const u = (x + 0.5 - inset) / body;
      const v = (y + 0.5 - inset) / body;
      const shade = SHADOW.strength * (1 - smoothstep(-SHADOW.blur / 4, SHADOW.blur, markDistance(u, v - SHADOW.drop)));
      const mark = clamp01(0.5 - markDistance(u, v) * body);
      const lit = clamp01((v - (ARROW.top - STROKE / 2)) / (ARROW.bottom - ARROW.top + STROKE));
      const rim = 1 - smoothstep(0, RIM.width * body, -distance);
      const light = RIM.light * rim * clamp01(1 - v * 2);
      const dark = RIM.dark * rim * clamp01(v * 2 - 1);
      for (let c = 0; c < 3; c += 1) {
        const flat = FROM[c] + (TO[c] - FROM[c]) * t;
        const tile = (flat + (255 - flat) * light) * (1 - dark);
        const shaded = tile + (SHADOW.color[c] - tile) * shade;
        const ink = MARK_TOP[c] + (MARK_BOTTOM[c] - MARK_TOP[c]) * lit;
        pixels[at + c] = Math.round(shaded + (ink - shaded) * mark);
      }
      pixels[at + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encode SIZE x SIZE RGBA pixels as a PNG (8-bit, no interlace, filter 0 on every row). */
function png(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 6, 0, 0, 0], 8); // bit depth, color type RGBA, compression, filter, interlace
  const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const icon of ICONS) {
  const file = path.join(__dirname, icon.file);
  fs.writeFileSync(file, png(draw(icon)));
  // eslint-disable-next-line no-console
  console.log(`[poptart] wrote ${path.relative(process.cwd(), file)}`);
}
