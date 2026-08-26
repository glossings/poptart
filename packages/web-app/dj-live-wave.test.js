'use strict';

// The livecoded decks' waveform strip - its two pieces of geometry.
//
// The strip has no analysis behind it: it draws the channel meter's feed kept as history, under
// bar lines taken straight off the clock. What has to be right is where those land on screen. The
// playhead is pinned at the centre, the same place a song deck's is, and that shared pin is the
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
// djLiveTraceCycle closes over it.
function loadWaveGeometry() {
  const src = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');
  const grab = (needle) => {
    const at = src.indexOf(needle);
    assert.ok(at > 0, `${needle} not found in public/client.js - this test needs updating`);
    const end = src.indexOf('\n}\n', at) + 3;
    return src.slice(at, end);
  };
  const lag = src.match(/const DJ_LIVE_TRACE_LAG = (\d+);/);
  assert.ok(lag, 'DJ_LIVE_TRACE_LAG not found in public/client.js');
  // eslint-disable-next-line no-new-func
  return new Function(`
    const DJ_LIVE_TRACE_LAG = ${lag[1]};
    ${grab('function djLiveWindow(')}
    ${grab('function djLiveTraceCycle(')}
    return { djLiveWindow, djLiveTraceCycle, DJ_LIVE_TRACE_LAG };
  `)();
}
const { djLiveWindow, djLiveTraceCycle, DJ_LIVE_TRACE_LAG } = loadWaveGeometry();

// 120bpm: bpm = cps x 240, and a cycle is four beats - so half a cycle a second, two seconds a bar.
const CPS = 0.5;
const W = 800;

test('the playhead is the exact centre, whatever the tempo, span or width', () => {
  for (const cps of [0.25, 0.5, 0.9, 2]) {
    for (const span of [0.25, 12, 60]) {
      for (const w of [1, 640, 1913]) {
        const { xOf } = djLiveWindow(7.25, cps, span, w);
        assert.ok(Math.abs(xOf(7.25) - w / 2) < 1e-9, `cps ${cps}, span ${span}, w ${w}`);
      }
    }
  }
});

test('the window is the span centred on now, in cycles', () => {
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
  // A frame that landed this instant measured sound one lag ago - so it draws left of centre.
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
