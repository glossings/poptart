// The pictures of what a device has been doing: the history rings behind the scrolling lanes,
// and the reports the devices post them in.

import test from 'node:test';
import assert from 'node:assert/strict';

import { History, HISTORY_BLOCKS } from './src/dsp/history.mjs';
import { COMPRESSOR, CompressorProcessor } from './src/devices/compressor.mjs';
import { DUCKER, DuckerProcessor } from './src/devices/ducker.mjs';
import { CHORUS, ChorusProcessor } from './src/devices/chorus.mjs';
import { PHASER, PhaserProcessor } from './src/devices/phaser.mjs';
import { LIMITER, LimiterProcessor } from './src/devices/limiter.mjs';
import { MULTIBAND, MultibandProcessor } from './src/devices/multiband.mjs';
import { defaultValues } from './src/descriptor.mjs';
import { Reporter } from './src/worklets/shared.mjs';

const SR = 48000;
const BLOCK = 128;

test('a history reads oldest first and is a copy', () => {
  const h = new History(4, -1);
  assert.deepEqual(h.snapshot(), [-1, -1, -1, -1], 'filled with its resting value');
  for (const v of [1, 2, 3, 4, 5]) h.push(v);
  const out = h.snapshot();
  assert.deepEqual(out, [2, 3, 4, 5]);
  out[0] = 99;
  assert.deepEqual(h.snapshot(), [2, 3, 4, 5], 'the ring is not the array handed out');
  assert.equal(new History().snapshot().length, HISTORY_BLOCKS);
});

/** Runs a processor over `blocks` blocks of a loud sine and returns its report. */
function run(Impl, descriptor, blocks, over = {}, sidechain = null) {
  const fx = new Impl(SR, BLOCK);
  const params = { ...defaultValues(descriptor), ...over };
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BLOCK; i++, n++) inL[i] = inR[i] = 0.9 * Math.sin((n / SR) * 2 * Math.PI * 220);
    fx.process([inL, inR], out, BLOCK, params, sidechain?.(b) ?? null, (b * BLOCK) / SR);
  }
  return fx.report();
}

test('a compressor reports where it is and where it has been', () => {
  const report = run(CompressorProcessor, COMPRESSOR, 400, { threshold: -30, ratio: 8 });
  const curve = report.meters.curve;
  assert.ok(curve.inDb > -6 && curve.inDb < 0, `a loud sine reads near full scale, got ${curve.inDb}`);
  assert.ok(curve.grDb < -10, `and is pulled well down, got ${curve.grDb}`);
  assert.equal(curve.history.inDb.length, HISTORY_BLOCKS);
  assert.equal(curve.history.grDb.length, HISTORY_BLOCKS);
  // Kept as single floats, so near rather than equal.
  assert.ok(Math.abs(curve.history.inDb[HISTORY_BLOCKS - 1] - curve.inDb) < 1e-5, 'the newest entry is the current reading');
  assert.ok(Math.abs(curve.history.grDb[HISTORY_BLOCKS - 1] - curve.grDb) < 1e-5);
  assert.ok(Math.abs(curve.history.blockSec - BLOCK / SR) < 1e-9);
  // The first entries are the attack: the reduction deepens from nothing.
  assert.ok(curve.history.grDb[0] > curve.history.grDb[HISTORY_BLOCKS - 1]);
});

test('a limiter and each band of a multiband report the same shape', () => {
  const lim = run(LimiterProcessor, LIMITER, 300, { gain: 12 }).meters.curve;
  assert.equal(lim.history.inDb.length, HISTORY_BLOCKS);
  assert.ok(lim.grDb < 0, 'twelve decibels into a limiter is held back');
  const mb = run(MultibandProcessor, MULTIBAND, 300).meters;
  for (const key of ['low.curve', 'mid.curve', 'high.curve']) {
    assert.equal(mb[key].history.inDb.length, HISTORY_BLOCKS, key);
    assert.equal(mb[key].history.grDb.length, HISTORY_BLOCKS, key);
  }
});

test('a ducker reports the gain it applied, the signal under it, and the key where there is one', () => {
  const free = run(DuckerProcessor, DUCKER, 400, { amount: 0.8 });
  assert.equal(free.keyed, false);
  assert.equal(free.history.key, null, 'no key patched, no key drawn');
  assert.equal(free.history.gain.length, HISTORY_BLOCKS);
  const gains = free.history.gain;
  assert.ok(Math.min(...gains) < 0.4, `the dip reaches down, got ${Math.min(...gains)}`);
  assert.ok(Math.max(...gains) > 0.95, 'and the level comes back');
  assert.ok(Math.max(...free.history.out) > 0.5, 'the output peaks are the signal');

  // A key that hits once, hard: the dip follows it rather than the clock.
  const kick = (b) => (b % 200 === 10 ? [new Float32Array(BLOCK).fill(0.9)] : [new Float32Array(BLOCK)]);
  const keyed = run(DuckerProcessor, DUCKER, 400, { amount: 0.8, threshold: -24 }, kick);
  assert.equal(keyed.keyed, true);
  assert.equal(keyed.history.key.length, HISTORY_BLOCKS);
  assert.ok(Math.max(...keyed.history.key) > 0.5, 'the key envelope is reported');
});

test('a chorus and a phaser report their LFO phase, moving', () => {
  const a = run(ChorusProcessor, CHORUS, 10).phase;
  const b = run(ChorusProcessor, CHORUS, 20).phase;
  assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1);
  assert.notEqual(a, b);
  const p = run(PhaserProcessor, PHASER, 10).phase;
  assert.ok(p > 0 && p < 1);
});

test('a reporter asks for a report only on the blocks it posts', () => {
  const posted = [];
  const reporter = new Reporter({ postMessage: (m) => posted.push(m) }, COMPRESSOR);
  reporter.receive({ kind: 'watch', on: true });
  let asked = 0;
  const params = Object.fromEntries(COMPRESSOR.params.map((p) => [p.id, [0.5]]));
  for (let i = 0; i < 10; i++) reporter.tick(params, () => { asked += 1; return { n: asked }; });
  assert.equal(posted.length, 2, 'every fifth block posts');
  assert.equal(asked, 2, 'and the report is built only for those');
  assert.deepEqual(posted.map((m) => m.report), [{ n: 1 }, { n: 2 }]);
});
