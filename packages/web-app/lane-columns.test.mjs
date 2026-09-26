// The scrolling lanes on the dynamics figures (public/client.js). A lane drawn at its entries' own
// spacing lands between pixels and shimmers as it scrolls; laneColumns pins each entry to one
// pixel column for as long as it is on screen, so the picture only moves by whole columns.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

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

const laneColumns = new Function(`${grab('laneColumns')}\nreturn laneColumns;`)();

/** The ring a device would report after writing `end` entries of `stream`. */
const ring = (stream, end, n) => stream.slice(end - n, end);

const N = 256;
const stream = Array.from({ length: 4000 }, (_, i) => Math.sin(i * 0.37) + (i % 17 === 0 ? 3 : 0));

for (const width of [97, 180, 256, 311, 640]) {
  test(`a ${width}px lane scrolls by whole columns, each keeping its value`, () => {
    let prev = null;
    for (let end = 1000; end < 1040; end += 1 + (end % 3)) {
      const cols = laneColumns(ring(stream, end, N), end, width, 'max');
      assert.equal(cols.length, width);
      if (prev) {
        // Some whole shift lines every settled column up with the previous frame's.
        const fits = (s) => cols.slice(1, width - 1 - s).every((v, i) => v === null || v === prev.cols[i + 1 + s]);
        assert.ok(Array.from({ length: Math.min(width - 3, 40) }, (_, s) => s).some(fits), `no whole-column shift at end=${end}`);
      }
      prev = { cols, end };
    }
  });
}

test('a column keeps the peak of the entries it covers, or the trough', () => {
  const values = Array.from({ length: N }, (_, i) => (i === 100 ? 9 : i === 101 ? -9 : 0));
  assert.ok(laneColumns(values, 5000, 64, 'max').includes(9), 'a one-entry transient survives');
  assert.ok(laneColumns(values, 5000, 64, 'min').includes(-9));
});

test('a history that does not say how much it has written still draws', () => {
  const cols = laneColumns(new Array(N).fill(1), null, 120);
  assert.ok(cols.every((v) => v === 1));
});
