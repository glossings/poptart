// The two rules every warp mode keeps (see warp.mjs): amount 0 is the identity, and the result
// stays a phase. Both are asserted here for every mode at once, so adding a mode cannot quietly
// break the contract the oscillator and the modulation system rely on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { WARP_INDEX, WARP_MODES, warpPhase, warpSlope } from './src/dsp/warp.mjs';

const PHASES = Array.from({ length: 64 }, (_, i) => i / 64);
const AMOUNTS = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];

test('the mode list and its index map agree', () => {
  assert.equal(WARP_MODES[0], 'none');
  for (const [i, name] of WARP_MODES.entries()) assert.equal(WARP_INDEX[name], i);
  assert.equal(new Set(WARP_MODES).size, WARP_MODES.length, 'no duplicate mode names');
});

test('amount 0 is the identity, in every mode', () => {
  for (const [mode, name] of WARP_MODES.entries()) {
    for (const p of PHASES) {
      assert.equal(warpPhase(p, 0, mode), p, `${name} moved the phase at amount 0`);
    }
  }
});

test('a negative amount is treated as zero rather than running the mode backwards', () => {
  for (const [mode] of WARP_MODES.entries()) {
    for (const p of PHASES) assert.equal(warpPhase(p, -1, mode), p);
  }
});

test('every mode returns a phase in 0..1, at every amount', () => {
  for (const [mode, name] of WARP_MODES.entries()) {
    for (const a of AMOUNTS) {
      for (const p of PHASES) {
        const out = warpPhase(p, a, mode);
        assert.ok(Number.isFinite(out), `${name} at amount ${a}, phase ${p} gave ${out}`);
        assert.ok(out >= 0 && out <= 1, `${name} at amount ${a}, phase ${p} left the range: ${out}`);
      }
    }
  }
});

test('an amount above one is clamped, not extrapolated into nonsense', () => {
  for (const [mode] of WARP_MODES.entries()) {
    for (const p of PHASES) {
      assert.equal(warpPhase(p, 5, mode), warpPhase(p, 1, mode));
    }
  }
});

test('an unwrapped phase is wrapped before it is warped, so the map stays periodic', () => {
  for (const [mode, name] of WARP_MODES.entries()) {
    for (const a of AMOUNTS) {
      for (const p of PHASES) {
        assert.ok(
          Math.abs(warpPhase(p + 3, a, mode) - warpPhase(p, a, mode)) < 1e-12,
          `${name} is not periodic at amount ${a}`,
        );
        assert.ok(
          Math.abs(warpPhase(p - 3, a, mode) - warpPhase(p, a, mode)) < 1e-12,
          `${name} mishandles a negative phase at amount ${a}`,
        );
      }
    }
  }
});

test('an unknown mode plays dry rather than refusing to play', () => {
  for (const p of PHASES) {
    assert.equal(warpPhase(p, 1, 999), p);
    assert.equal(warpPhase(p, 1, -3), p);
  }
});

// The modes that promise smoothness are the ones an LFO can be swung through fast without
// clicking. The digital ones (quantize, binary, primes, sync) are steps BY DESIGN and are
// excluded by name rather than by loosening the bound for everybody.
//
// The test for "no jump" is not a bound on the slope - `bend-` is genuinely near-vertical just
// after the wrap and is still continuous there, and a slope bound would fail it. What tells a
// jump from a steep stretch is what happens as the step shrinks: a continuous map's biggest
// step shrinks with it, a discontinuity's does not.
test('the smooth modes have no jump in them', () => {
  const smooth = ['asym', 'bend+', 'bend-', 'flip', 'orbit', 'spin', 'chaos', 'reciprocal', 'sigmoid', 'fractal', 'brownian', 'mirror'];
  // Distance on the CIRCLE, not on the line: a mode that walks the phase past the end of the
  // cycle (orbit, spin, fractal, brownian all do) comes back round at 0, and 0.99 to 0.01 is a
  // step of two hundredths, not of nearly one. The table is periodic, so that wrap is read
  // seamlessly - it is the same measure warpSlope() uses for the same reason.
  const biggestStep = (mode, a, h) => {
    let worst = 0;
    for (let p = 0; p < 1 - h; p += h) {
      let d = warpPhase(p + h, a, mode) - warpPhase(p, a, mode);
      if (d > 0.5) d -= 1;
      else if (d < -0.5) d += 1;
      worst = Math.max(worst, Math.abs(d));
    }
    return worst;
  };
  for (const name of smooth) {
    const mode = WARP_INDEX[name];
    for (const a of AMOUNTS) {
      const coarse = biggestStep(mode, a, 1 / 2048);
      const fine = biggestStep(mode, a, 1 / 16384);
      assert.ok(fine <= coarse * 0.6 + 1e-9, `${name} at amount ${a} keeps a step of ${fine.toFixed(5)} however finely it is sampled, so it has a jump in it`);
    }
  }
});

test('a mode with a real jump in it is caught by that same measure', () => {
  // quantize is a staircase on purpose; the guard above would fail it, which is what makes the
  // guard worth having.
  const mode = WARP_INDEX.quantize;
  const biggestStep = (h) => {
    let worst = 0;
    for (let p = 0; p < 1 - h; p += h) worst = Math.max(worst, Math.abs(warpPhase(p + h, 1, mode) - warpPhase(p, 1, mode)));
    return worst;
  };
  assert.ok(biggestStep(1 / 16384) > biggestStep(1 / 2048) * 0.6, 'quantize should keep its step however finely it is sampled');
});

test('flip turns the table round without a step at the turn or at the wrap', () => {
  const mode = WARP_INDEX.flip;
  // Full amount: the rise takes a tenth of the cycle, the fall the rest.
  assert.ok(Math.abs(warpPhase(0.1, 1, mode) - 1) < 1e-12, 'the turn should reach the end of the table');
  assert.ok(Math.abs(warpPhase(0, 1, mode) - 0) < 1e-12);
  assert.ok(Math.abs(warpPhase(0.999999, 1, mode)) < 1e-5, 'the cycle should end back where it started');
});

test('the monotonic modes stay monotonic, which is what keeps them from adding harmonics of their own', () => {
  for (const name of ['bend+', 'bend-', 'reciprocal', 'sigmoid', 'asym']) {
    const mode = WARP_INDEX[name];
    for (const a of AMOUNTS) {
      let prev = -1;
      // Up to but not including 1: phase 1 IS phase 0, so the wrap is not a step backwards.
      for (let p = 0; p < 1; p += 1 / 512) {
        const out = warpPhase(p, a, mode);
        assert.ok(out >= prev - 1e-12, `${name} went backwards at ${p}, amount ${a}`);
        prev = out;
      }
    }
  }
});

test('sync reads the table more than once per cycle, which is the point of it', () => {
  const mode = WARP_INDEX.sync;
  let wraps = 0;
  let prev = warpPhase(0, 1, mode);
  for (let p = 1 / 2048; p <= 1; p += 1 / 2048) {
    const out = warpPhase(p, 1, mode);
    if (out < prev - 0.5) wraps++;
    prev = out;
  }
  assert.ok(wraps >= 8, `expected many table reads per cycle at full sync, saw ${wraps}`);
});

test('fold reads the table several times per cycle, mirrored', () => {
  const mode = WARP_INDEX.fold;
  const turns = [];
  let prev = warpPhase(0, 1, mode);
  let rising = true;
  for (let p = 1 / 2048; p <= 1; p += 1 / 2048) {
    const out = warpPhase(p, 1, mode);
    const nowRising = out > prev;
    if (nowRising !== rising) { turns.push(p); rising = nowRising; }
    prev = out;
  }
  assert.ok(turns.length >= 5, `expected several folds at full amount, saw ${turns.length}`);
});

test('the noisy modes are deterministic, so a note sounds the same every time it is played', () => {
  for (const name of ['brownian', 'primes', 'binary', 'chaos', 'fractal']) {
    const mode = WARP_INDEX[name];
    for (const p of PHASES) {
      assert.equal(warpPhase(p, 0.7, mode), warpPhase(p, 0.7, mode));
    }
  }
});

test('the slope is the traversal rate, which is what the oscillator band-limits against', () => {
  const inc = 1 / 1000;
  // Dry, the table is traversed at exactly the phase increment.
  assert.ok(Math.abs(warpSlope(0.3, inc, 0, WARP_INDEX.none) - inc) < 1e-12);
  // Under full sync it is traversed sixteen times faster, which is what would alias.
  const synced = warpSlope(0.3, inc, 1, WARP_INDEX.sync);
  assert.ok(synced > inc * 8, `expected a much faster traversal under sync, got ${synced / inc}x`);
});

test('a wrap is read as going round, not as a jump across the whole table', () => {
  const inc = 1 / 1000;
  // Straddling the wrap point in the dry mode must still report one increment of travel.
  const atWrap = warpSlope(1 - inc / 2, inc, 0, WARP_INDEX.none);
  assert.ok(Math.abs(atWrap - inc) < 1e-12, `a wrap reported ${atWrap / inc}x travel`);
});
