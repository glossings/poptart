// Wavetable frames and their mipmaps. The band-limiting here is what keeps a bright frame from
// turning to hash when it is played high or read several times per cycle by a warp, so these
// tests check the harmonic content directly rather than eyeballing a waveform.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bandLimit, fft, fromHarmonics, harmonicsOf } from './src/dsp/fft.mjs';
import {
  BASIC_FRAME_NAMES,
  FRAME_LENGTH,
  buildMipmaps,
  buildTable,
  builtInTables,
  harmonicSchedule,
  harmonicsAtLevel,
  lengthAtLevel,
  levelCount,
  mipLevelFor,
  normalizeFrame,
  removeDc,
} from './src/dsp/tables.mjs';

/** The amplitude of each harmonic, 1-indexed, with anything below the floor read as absent. */
function spectrum(frame, floor = 1e-6) {
  const { amp } = harmonicsOf(frame);
  const out = [];
  for (let k = 1; k < amp.length; k++) if (amp[k] * 2 > floor) out.push({ k, a: amp[k] * 2 });
  return out;
}

test('the transform round-trips', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + i / n);
  const im = new Float64Array(n);
  const reCopy = Float64Array.from(re);
  fft(re, im);
  fft(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - reCopy[i]) < 1e-9, `sample ${i} came back as ${re[i]}`);
});

test('the transform refuses a length it cannot handle, rather than returning noise', () => {
  assert.throws(() => fft(new Float64Array(3), new Float64Array(3)), /power of two/);
  assert.throws(() => fft(new Float64Array(8), new Float64Array(4)), /same length/);
});

test('a harmonic series comes back as the harmonics it was built from', () => {
  const frame = fromHarmonics(256, 8, (k) => (k === 1 ? 1 : k === 3 ? 0.5 : k === 7 ? 0.25 : 0));
  const found = spectrum(frame, 1e-4);
  assert.deepEqual(found.map((h) => h.k), [1, 3, 7]);
  assert.ok(Math.abs(found[0].a - 1) < 1e-6);
  assert.ok(Math.abs(found[1].a - 0.5) < 1e-6);
  assert.ok(Math.abs(found[2].a - 0.25) < 1e-6);
});

test('band-limiting drops the harmonics above the limit and leaves the rest alone', () => {
  const frame = fromHarmonics(256, 60, (k) => 1 / k);
  const cut = bandLimit(frame, 8);
  const found = spectrum(cut, 1e-4);
  assert.deepEqual(found.map((h) => h.k), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const h of found) assert.ok(Math.abs(h.a - 1 / h.k) < 1e-6, `harmonic ${h.k} was changed`);
});

test('a band-limited frame is still real, with no imaginary residue left behind', () => {
  const frame = fromHarmonics(128, 40, (k) => 1 / k);
  const cut = bandLimit(frame, 5);
  for (const v of cut) assert.ok(Number.isFinite(v) && Math.abs(v) < 4, `sample left the range: ${v}`);
  // A real signal's spectrum is symmetric; if the mirror bins had been zeroed unevenly the
  // inverse transform would have left a complex part behind and the frame would not repeat.
  // The tolerance is a float32 one because that is what a frame is stored as - band-limiting an
  // already band-limited frame only has to put back what single precision can hold.
  const again = bandLimit(cut, 5);
  for (let i = 0; i < cut.length; i++) assert.ok(Math.abs(again[i] - cut[i]) < 1e-6, `sample ${i} moved by ${Math.abs(again[i] - cut[i])}`);
});

test('the level schedule is dense where one harmonic matters and sparse where it does not', () => {
  const schedule = harmonicSchedule(2048);
  assert.equal(schedule[0], 1024, 'level 0 is the whole spectrum');
  assert.equal(schedule[schedule.length - 1], 1, 'the last level is a sine');
  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i] < schedule[i - 1], `level ${i} should be duller than level ${i - 1}`);
  }
  // Half-octave steps while the counts are large...
  assert.ok(Math.abs(schedule[1] / schedule[0] - 1 / Math.SQRT2) < 0.01);
  // ...one harmonic at a time once they are small, because that is where it is audible.
  assert.deepEqual(schedule.slice(-8), [8, 7, 6, 5, 4, 3, 2, 1]);
});

test('an out-of-range level clamps rather than reading off the end of the schedule', () => {
  assert.equal(harmonicsAtLevel(2048, -5), 1024);
  assert.equal(harmonicsAtLevel(2048, 999), 1);
  assert.equal(levelCount(2048), harmonicSchedule(2048).length);
});

test('dull levels are stored short, so the pyramid costs about twice one frame', () => {
  const n = 2048;
  let total = 0;
  for (let l = 0; l < levelCount(n); l++) {
    const len = lengthAtLevel(n, l);
    total += len;
    assert.ok(len >= 16 && len <= n, `level ${l} length ${len}`);
    assert.equal(len & (len - 1), 0, `level ${l} length should be a power of two`);
    assert.ok(len >= Math.min(n, harmonicsAtLevel(n, l) * 2), `level ${l} is too short to hold its harmonics`);
  }
  // Without decimation the pyramid would be every level at full length - twenty-two frames.
  assert.ok(total < n * 8, `the whole pyramid came to ${total} samples against one frame of ${n}`);
  assert.ok(total < levelCount(n) * n * 0.35, 'decimation should be saving most of the memory');
});

test('level 0 is the frame exactly as it was loaded', () => {
  const frame = fromHarmonics(256, 100, (k) => 1 / k);
  const mips = buildMipmaps(frame);
  assert.equal(mips.length, levelCount(256));
  assert.equal(mips[0], frame, 'level 0 should be the same array, not a round trip through the transform');
});

test('each mip level really has had its harmonics removed', () => {
  const frame = fromHarmonics(256, 127, (k) => 1 / k);
  const mips = buildMipmaps(frame);
  for (let l = 1; l < mips.length; l++) {
    const limit = harmonicsAtLevel(256, l);
    const found = spectrum(mips[l], 1e-5);
    const highest = found.length ? found[found.length - 1].k : 0;
    assert.ok(highest <= limit, `level ${l} should stop at harmonic ${limit}, found ${highest}`);
    assert.ok(highest >= Math.min(limit, 1), `level ${l} lost everything`);
  }
});

test('the mip level rises with the traversal rate, so a higher note reads a duller copy', () => {
  const slow = mipLevelFor(1 / 4096, FRAME_LENGTH);
  const fast = mipLevelFor(1 / 16, FRAME_LENGTH);
  assert.equal(slow, 0, 'a slow traversal can afford every harmonic');
  assert.ok(fast > slow);
  assert.ok(fast <= levelCount(FRAME_LENGTH) - 1);
});

// The property the oscillator's crossfade depends on: BOTH copies it blends must already fit
// under the limit, so it is the floor that has to be safe, not the ceiling. Blending towards
// the nearest level in each direction would let the harmonics this whole pyramid exists to
// remove back in at a reduced volume.
test('the FLOOR of the level chosen is already safe, so a blend cannot alias', () => {
  for (let i = 0; i < 400; i++) {
    const rate = Math.pow(10, -4 + (i / 400) * 3.7);   // a sweep from very slow to very fast
    const level = mipLevelFor(rate, FRAME_LENGTH);
    const harmonics = harmonicsAtLevel(FRAME_LENGTH, Math.floor(level));
    assert.ok(
      harmonics * rate <= 0.5 + 1e-9 || level === 0,
      `rate ${rate.toExponential(2)} chose level ${level.toFixed(3)}, whose floor keeps ${harmonics} harmonics and folds over`,
    );
  }
});

// The sweep starts just past the point where the full-bandwidth frame stops fitting, because
// that one transition is a genuine step: level 0 IS the frame, so there is nothing brighter to
// fade from. It happens around a 23 Hz note and moves only content above 17 kHz.
test('the level moves continuously with the rate, so a sweeping pitch hears no step', () => {
  const first = 1 / FRAME_LENGTH + 1e-6;
  let prev = mipLevelFor(first, FRAME_LENGTH);
  for (let i = 1; i <= 4000; i++) {
    const rate = first * Math.pow(10, (i / 4000) * 3);
    const level = mipLevelFor(rate, FRAME_LENGTH);
    assert.ok(level - prev >= -1e-9, `the level went backwards at rate ${rate}`);
    assert.ok(level - prev < 0.1, `the level jumped by ${(level - prev).toFixed(3)} at rate ${rate}`);
    prev = level;
  }
});

test('the level is fractional, so the oscillator can blend between two of them', () => {
  const level = mipLevelFor(1 / 700, FRAME_LENGTH);
  assert.ok(level > 0 && level < levelCount(FRAME_LENGTH) - 1);
  assert.ok(!Number.isInteger(level), 'a fractional level is what makes the crossfade possible');
});

test('a stopped or reversed traversal still asks for a legal level', () => {
  assert.equal(mipLevelFor(0, FRAME_LENGTH), 0);
  assert.equal(mipLevelFor(-1 / 4096, FRAME_LENGTH), 0, 'direction does not change what aliases');
  assert.equal(mipLevelFor(-1 / 2, FRAME_LENGTH), levelCount(FRAME_LENGTH) - 1);
  assert.equal(mipLevelFor(50, FRAME_LENGTH), levelCount(FRAME_LENGTH) - 1);
});

test('a table refuses frames it cannot index', () => {
  assert.throws(() => buildTable('x', []), /has no frames/);
  assert.throws(() => buildTable('x', [new Float32Array(100)]), /power of two/);
  assert.throws(() => buildTable('x', [new Float32Array(64), new Float32Array(128)]), /same length/);
});

test('normalizing leaves a silent frame silent rather than dividing by nothing', () => {
  const silent = new Float32Array(16);
  assert.equal(normalizeFrame(silent), silent);
  const loud = normalizeFrame(Float32Array.from([0, 0.25, -0.5, 0.1]));
  assert.ok(Math.abs(Math.max(...loud.map(Math.abs)) - 1) < 1e-6);
});

test('removing the offset centers a frame without changing its shape', () => {
  const offset = Float32Array.from([1, 2, 3, 4]);
  const centered = removeDc(offset);
  assert.ok(Math.abs(centered.reduce((a, b) => a + b, 0)) < 1e-6);
  assert.deepEqual([...centered], [-1.5, -0.5, 0.5, 1.5]);
});

test('the shipped tables build, and Basic holds the classic waveforms in brightness order', () => {
  const tables = builtInTables();
  assert.deepEqual(tables.map((t) => t.name), ['Basic', 'Harmonics', 'Odd', 'PWM', 'Sync', 'Fold', 'FM', 'Organ', 'Vocal']);
  const basic = tables[0];
  assert.equal(basic.frameCount, 7);
  assert.equal(basic.frameCount, BASIC_FRAME_NAMES.length);
  assert.equal(basic.length, FRAME_LENGTH);
  assert.equal(basic.mips.length, 7);
  assert.equal(basic.mips[0].length, levelCount(FRAME_LENGTH));
});

test('the Basic frames are the waveforms they claim to be', () => {
  const [basic] = builtInTables();
  const [sine, triangle, saw, square] = basic.mips.map((m) => m[0]);

  const sineHarmonics = spectrum(sine, 1e-3);
  assert.deepEqual(sineHarmonics.map((h) => h.k), [1], 'a sine has one harmonic and no others');

  // A triangle is odd harmonics falling as 1/k squared; a square is odd harmonics at 1/k. Both
  // are checked by the ratio of the third harmonic to the first, which tells them apart.
  const triRatio = spectrum(triangle, 1e-4).find((h) => h.k === 3).a / spectrum(triangle, 1e-4).find((h) => h.k === 1).a;
  const sqRatio = spectrum(square, 1e-4).find((h) => h.k === 3).a / spectrum(square, 1e-4).find((h) => h.k === 1).a;
  assert.ok(Math.abs(triRatio - 1 / 9) < 0.01, `triangle third harmonic ratio was ${triRatio}`);
  assert.ok(Math.abs(sqRatio - 1 / 3) < 0.01, `square third harmonic ratio was ${sqRatio}`);

  // A saw has the even harmonics a square and a triangle lack - that is what makes it a saw.
  const sawEven = spectrum(saw, 1e-4).filter((h) => h.k % 2 === 0);
  assert.ok(sawEven.length > 100, `a saw should carry its even harmonics, found ${sawEven.length}`);
  assert.equal(spectrum(square, 1e-4).filter((h) => h.k % 2 === 0).length, 0, 'a square has no even harmonics');
});

test('the pulse frames narrow, and a pulse sits centered rather than pushing the amp off zero', () => {
  const [basic] = builtInTables();
  for (const i of [4, 5, 6]) {
    const frame = basic.mips[i][0];
    const mean = frame.reduce((a, b) => a + b, 0) / frame.length;
    assert.ok(Math.abs(mean) < 1e-3, `frame ${i} has an offset of ${mean}`);
    assert.ok(Math.abs(Math.max(...frame.map(Math.abs)) - 1) < 1e-3, `frame ${i} is not normalized`);
  }
  // A narrower pulse puts more of its energy up the series. That has to be measured over the
  // whole spectrum, not at one harmonic: a pulse of duty w has nulls wherever k*w is a whole
  // number, so any single harmonic can be louder in the WIDER pulse and say nothing about
  // brightness. The fraction of the energy above the eighth harmonic is the honest measure, and
  // it rises monotonically from the square through each narrowing pulse.
  const brightness = (i) => {
    let above = 0;
    let total = 0;
    for (const h of spectrum(basic.mips[i][0], 0)) {
      total += h.a * h.a;
      if (h.k > 8) above += h.a * h.a;
    }
    return above / total;
  };
  const [square, p37, p25, p12] = [3, 4, 5, 6].map(brightness);
  assert.ok(p37 > square, `pulse 37 (${p37.toFixed(4)}) should be brighter than the square (${square.toFixed(4)})`);
  assert.ok(p25 > p37, `pulse 25 (${p25.toFixed(4)}) should be brighter than pulse 37 (${p37.toFixed(4)})`);
  assert.ok(p12 > p25, `pulse 12 (${p12.toFixed(4)}) should be brighter than pulse 25 (${p25.toFixed(4)})`);
});

test('every shipped frame is normalized and finite, so no table is quietly louder than the rest', () => {
  for (const table of builtInTables()) {
    for (const [i, mips] of table.mips.entries()) {
      const peak = Math.max(...mips[0].map(Math.abs));
      assert.ok(Math.abs(peak - 1) < 1e-3, `${table.name} frame ${i} peaks at ${peak}`);
      for (const v of mips[0]) assert.ok(Number.isFinite(v));
    }
  }
});
