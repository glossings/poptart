// The recorder tap: a meter while a panel is open, and a sample-exact capture window.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RecorderTap } from './src/devices/recorder.mjs';

const SR = 48000;
const BLOCK = 128;

function run(tap, blocks, fill = (f) => f) {
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) { l[i] = fill(b * BLOCK + i); r[i] = -fill(b * BLOCK + i); }
    tap.process(l, r, BLOCK, b * BLOCK);
  }
}

test('a capture holds exactly the frames of its window, to the sample', () => {
  const posted = [];
  const tap = new RecorderTap(SR, (m) => posted.push(m));
  // Frames 1000 to 31000: not on a block boundary at either end, and longer than one chunk.
  tap.receive({ kind: 'record', id: 7, start: 1000 / SR, end: 31000 / SR });
  run(tap, 300);
  const chunks = posted.filter((m) => m.kind === 'chunk');
  const done = posted.find((m) => m.kind === 'done');
  assert.equal(done.id, 7);
  assert.equal(done.frames, 30000);
  const left = chunks.flatMap((c) => [...c.l]);
  assert.equal(left.length, 30000);
  assert.equal(left[0], 1000, 'the first frame is the window\'s first');
  assert.equal(left.at(-1), 30999, 'and the last is the one before its end');
  assert.equal(chunks[0].r[0], -1000, 'both sides');
  assert.ok(chunks.length >= 2, 'posted in chunks, not held to the end');
});

test('the meter posts peak and rms about twenty times a second, only while on', () => {
  const posted = [];
  const tap = new RecorderTap(SR, (m) => posted.push(m));
  run(tap, 40, () => 0.5);
  assert.equal(posted.length, 0);
  tap.receive({ kind: 'meter', on: true });
  run(tap, 375, () => 0.5);   // one second
  const levels = posted.filter((m) => m.kind === 'level');
  assert.ok(levels.length >= 19 && levels.length <= 20, `about twenty, on block boundaries: ${levels.length}`);
  assert.equal(levels[0].peak, 0.5);
  assert.ok(Math.abs(levels[0].rms) < 1e-9, 'the rms is of the mix, and these sides cancel');
});

test('a cancelled take posts nothing more', () => {
  const posted = [];
  const tap = new RecorderTap(SR, (m) => posted.push(m));
  tap.receive({ kind: 'record', id: 1, start: 0, end: 1 });
  run(tap, 10);
  tap.receive({ kind: 'cancel' });
  run(tap, 400);
  assert.equal(posted.filter((m) => m.kind === 'done').length, 0);
});
