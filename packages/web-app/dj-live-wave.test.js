'use strict';

// The livecoded decks' waveform strip - its geometry, its colors and its end-of-track warning.
//
// The strip has no analysis behind it: it draws the channel meter's feed kept as history, under
// bar lines taken straight off the clock. What has to be right is where those land on screen. The
// playhead is pinned at the center, the same place a song deck's is, and that shared pin is the
// ONLY reason two strips stacked one above the other can be read against each other - so it is
// pinned here. And the meter trace is slid backwards by the feed's lag, never forwards: the wrong
// sign there draws a strip that looks entirely healthy while sitting twice the lag off its own
// bar lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Lifted out of the browser script the way pane-resize.test.js lifts settleSeamDrag: both are
// plain arithmetic with no DOM in them, so they run as-is. DJ_LIVE_TRACE_LAG comes along because
// djLiveTraceCycle closes over it, and the end-of-track warning's two constants likewise.
function loadWaveGeometry() {
  const src = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');
  const grab = (needle) => {
    const at = src.indexOf(needle);
    assert.ok(at > 0, `${needle} not found in public/client.js - this test needs updating`);
    const end = src.indexOf('\n}\n', at) + 3;
    return src.slice(at, end);
  };
  const num = (name) => {
    const m = src.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(m, `${name} not found in public/client.js`);
    return m[1];
  };
  // eslint-disable-next-line no-new-func
  return new Function(`
    const DJ_LIVE_TRACE_LAG = ${num('DJ_LIVE_TRACE_LAG')};
    const DJ_END_WARN_SEC = ${num('DJ_END_WARN_SEC')};
    const DJ_END_WARN_HURRY = ${num('DJ_END_WARN_HURRY')};
    ${grab('function djLiveWindow(')}
    ${grab('function djLiveTraceCycle(')}
    ${grab('function djEndWarnAt(')}
    return { djLiveWindow, djLiveTraceCycle, djEndWarnAt, DJ_LIVE_TRACE_LAG, DJ_END_WARN_SEC, DJ_END_WARN_HURRY };
  `)();
}
const { djLiveWindow, djLiveTraceCycle, djEndWarnAt, DJ_LIVE_TRACE_LAG, DJ_END_WARN_SEC, DJ_END_WARN_HURRY } = loadWaveGeometry();

// 120bpm: bpm = cps x 240, and a cycle is four beats - so half a cycle a second, two seconds a bar.
const CPS = 0.5;
const W = 800;

test('the playhead is the exact center, whatever the tempo, span or width', () => {
  for (const cps of [0.25, 0.5, 0.9, 2]) {
    for (const span of [0.25, 12, 60]) {
      for (const w of [1, 640, 1913]) {
        const { xOf } = djLiveWindow(7.25, cps, span, w);
        assert.ok(Math.abs(xOf(7.25) - w / 2) < 1e-9, `cps ${cps}, span ${span}, w ${w}`);
      }
    }
  }
});

test('the window is the span centered on now, in cycles', () => {
  const { cyc0, cyc1 } = djLiveWindow(10, CPS, 12, W); // 12s at 0.5 cps = 6 cycles across
  assert.equal(cyc0, 7);
  assert.equal(cyc1, 13);
});

test('a bar ahead sits where the span says it should', () => {
  const { xOf } = djLiveWindow(10, CPS, 12, W); // 6 cycles across 800px
  const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got} vs ${want}`);
  near(xOf(11), W / 2 + W / 6, 'one cycle right of the playhead');
  near(xOf(9), W / 2 - W / 6, 'one cycle left');
  near(xOf(7), 0, 'the left edge');
  near(xOf(13), W, 'the right edge');
});

test('the edges of the window are the edges of the canvas', () => {
  const { cyc0, cyc1, xOf } = djLiveWindow(3.7, 0.8, 20, W);
  assert.ok(Math.abs(xOf(cyc0)) < 1e-9);
  assert.ok(Math.abs(xOf(cyc1) - W) < 1e-9);
});

test('a meter frame is slid BACK by the lag, never forward', () => {
  const now = 100000;
  // A frame that landed this instant measured sound one lag ago - so it draws left of center.
  assert.ok(djLiveTraceCycle(now, now, 10, CPS) < 10);
  const behind = 10 - djLiveTraceCycle(now, now, 10, CPS);
  assert.ok(Math.abs(behind - (DJ_LIVE_TRACE_LAG / 1000) * CPS) < 1e-9);
});

test('an older frame lands further back, by exactly the time between them', () => {
  const now = 100000;
  const fresh = djLiveTraceCycle(now, now, 10, CPS);
  const old = djLiveTraceCycle(now - 2000, now, 10, CPS); // arrived 2s = one cycle earlier
  assert.ok(Math.abs((fresh - old) - 1) < 1e-9);
});

test('the trace and the grid agree: a hit heard now draws where it was heard', () => {
  // The moment the engine played one lag ago, and the meter frame reporting it, landing now.
  const now = 100000;
  const cycNow = 10;
  const heardAt = cycNow - (DJ_LIVE_TRACE_LAG / 1000) * CPS;
  const { xOf } = djLiveWindow(cycNow, CPS, 12, W);
  assert.ok(Math.abs(xOf(djLiveTraceCycle(now, now, cycNow, CPS)) - xOf(heardAt)) < 1e-9);
});

test('a stalled feed leaves a gap rather than sliding the history off the beat', () => {
  // Two frames 40ms apart, then a 400ms stall: the stalled one must be drawn 400ms back, not
  // one frame-width back. Placing columns by index instead of timestamp is what this rules out.
  const now = 100000;
  const gap = djLiveTraceCycle(now - 400, now, 10, CPS) - djLiveTraceCycle(now - 440, now, 10, CPS);
  const normal = djLiveTraceCycle(now, now, 10, CPS) - djLiveTraceCycle(now - 40, now, 10, CPS);
  assert.ok(Math.abs(gap - normal) < 1e-9, 'spacing is a function of elapsed time only');
  assert.ok(Math.abs(djLiveTraceCycle(now - 400, now, 10, CPS) - (10 - 0.2 - 0.045)) < 1e-9);
});

// --- the end-of-track warning (both kinds of deck flash the same way) --------------------------

test('a deck with plenty of track left never flashes', () => {
  for (const remain of [DJ_END_WARN_SEC + 0.01, 60, 600]) {
    for (const t of [0, 123, 456789]) {
      assert.equal(djEndWarnAt(remain, t), 0, `${remain}s left at ${t}ms`);
    }
  }
});

test('nothing to run out of is not a warning', () => {
  // A livecoded deck whose arrangement has no end, and a deck that has already passed its end.
  for (const remain of [NaN, null, undefined, Infinity, -0.5, -30]) {
    assert.equal(djEndWarnAt(remain, 1000), 0, String(remain));
  }
});

test('inside the window it pulses between dark and full, so it reads as a flash', () => {
  const seen = [];
  for (let ms = 0; ms < 2000; ms += 10) seen.push(djEndWarnAt(20, ms));
  assert.ok(Math.min(...seen) < 0.02, 'the pulse has to go dark, or it is just a border');
  assert.ok(Math.max(...seen) > 0.98, 'and it has to come up full');
  assert.ok(seen.every((v) => v >= 0 && v <= 1), 'strength is a 0..1 alpha');
});

test('the last seconds flash faster than the first ones', () => {
  const cycles = (remain) => {
    let crossings = 0;
    let was = djEndWarnAt(remain, 0);
    for (let ms = 10; ms <= 4000; ms += 10) {
      const now = djEndWarnAt(remain, ms);
      if (was < 0.5 && now >= 0.5) crossings++;
      was = now;
    }
    return crossings;
  };
  assert.ok(cycles(DJ_END_WARN_HURRY - 1) > cycles(DJ_END_WARN_SEC - 1),
    'under the hurry mark it has to quicken - that is what says "now" rather than "soon"');
});

// --- the colors: the same read as a file's, off the meter feed ---------------------------------
//
// A song deck's waveform is colored by the low/mid/high balance of the FILE, measured offline
// (osc-engine/wav.js). A livecoded deck has no file, so the engine measures the same three bands
// on its meter bus and the server folds them to the same shape - shares of the total, two
// decimals - which is what lets one color function draw both strips. If these two ever stop
// agreeing, two decks stacked to be read against each other are colored by different rules.

function loadBandShare() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const at = src.indexOf('function deckBandShare(');
  assert.ok(at > 0, 'deckBandShare not found in server.js - this test needs updating');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, src.indexOf('\n}\n', at) + 3)}\nreturn deckBandShare;`)();
}
const deckBandShare = loadBandShare();

test('the three bands come out as shares of the whole, not as levels', () => {
  const quiet = deckBandShare(0.000004, 0.000002, 0.000002);
  const loud = deckBandShare(0.4, 0.2, 0.2);
  assert.deepEqual(quiet, loud, 'the same balance at any level is the same color');
  assert.deepEqual(loud, [0.5, 0.25, 0.25]);
});

test('silence answers the way the file analysis answers it', () => {
  // wav.js's normalizeBands calls silence all-mid so it draws neutral; this has to match, or a
  // paused livecoded deck is a different color from a paused song deck.
  assert.deepEqual(deckBandShare(0, 0, 0), [0, 1, 0]);
  assert.deepEqual(deckBandShare(1e-20, 0, 1e-20), [0, 1, 0]);
});

test('a reading that is not a number cannot poison the color', () => {
  // The feed is floats off a UDP socket: one NaN must not turn the whole balance into NaN and
  // the column into `rgba(NaN, NaN, NaN)`, which paints nothing at all.
  assert.deepEqual(deckBandShare(NaN, 1, 0), [0, 1, 0]);
  assert.deepEqual(deckBandShare(-1, 0, 1), [0, 0, 1], 'a negative energy is no energy');
  assert.ok(deckBandShare(undefined, undefined, undefined).every(Number.isFinite));
});

test('the shares add up, so the painter never has to rescale them', () => {
  for (const e of [[1, 1, 1], [0.7, 0.2, 0.1], [1e-6, 1e-7, 1e-8], [9, 0, 0]]) {
    const got = deckBandShare(...e);
    const sum = got[0] + got[1] + got[2];
    assert.ok(Math.abs(sum - 1) <= 0.02, `${e} -> ${got} sums to ${sum}`);
  }
});
