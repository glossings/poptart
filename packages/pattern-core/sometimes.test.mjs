// .sometimes(share, fn) is .when(rand().lt(share), fn) with the coin already tossed: every call
// draws its own rand(), so two of them are independent unless told to share a seed.
// Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, speed, resetRandomSeeds } from './src/signal.mjs';

/** Whether the callback's control landed on the hit at each of 64 eighths. */
const fired = (track) => Array.from({ length: 64 }, (_, k) => {
  const at = k * 0.125;
  return track.sampler.speed.sample(at, 1, at) === -1;
});
const share = (track) => fired(track).filter(Boolean).length / 64;
const flip = (x) => x.mul(speed('-1'));

test('the share is how often the callback applies', () => {
  resetRandomSeeds();
  assert.equal(share(s('bd*8').sometimes(1, flip)), 1, 'always');
  assert.equal(share(s('bd*8').sometimes(0, flip)), 0, 'never');
  const half = share(s('bd*8').sometimes(flip));
  assert.ok(half > 0.3 && half < 0.7, `a bare .sometimes() is a coin toss, got ${half}`);
  const rare = share(s('bd*8').sometimes(0.1, flip));
  assert.ok(rare > 0 && rare < 0.3, `a tenth is rare, got ${rare}`);
});

test('two .sometimes() on one document toss different coins', () => {
  resetRandomSeeds();
  const a = fired(s('bd*8').sometimes(0.5, flip));
  const b = fired(s('bd*8').sometimes(0.5, flip));
  assert.notDeepEqual(a, b);
});

test('a shared seed makes two of them agree, and a re-evaluation replays the take', () => {
  resetRandomSeeds();
  const a = fired(s('bd*8').sometimes(0.5, flip, { seed: 7 }));
  const b = fired(s('bd*8').sometimes(0.5, flip, { seed: 7 }));
  assert.deepEqual(a, b, 'same seed, same coins');
  const first = fired(s('bd*8').sometimes(0.5, flip));
  resetRandomSeeds();
  assert.deepEqual(fired(s('bd*8').sometimes(0.5, flip)), first, 'the document replays');
});

test('the share can be a pattern, read at the events', () => {
  resetRandomSeeds();
  const track = s('bd*8').sometimes('<0 1>', flip);
  const hits = fired(track);
  assert.ok(hits.slice(0, 8).every((h) => !h), 'a share of zero on the even cycles');
  assert.ok(hits.slice(8, 16).every((h) => h), 'and of one on the odd');
});

test('a callback is required', () => {
  assert.throws(() => s('bd').sometimes(0.5), /takes a share and a callback/);
});
