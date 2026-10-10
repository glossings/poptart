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
    ${grab('function djLiveTraceAdd(')}
    ${grab('function djEndWarnAt(')}
    return { djLiveWindow, djLiveTraceCycle, djLiveTraceAdd, djEndWarnAt, DJ_LIVE_TRACE_LAG, DJ_END_WARN_SEC, DJ_END_WARN_HURRY };
  `)();
}
const { djLiveWindow, djLiveTraceCycle, djLiveTraceAdd, djEndWarnAt, DJ_LIVE_TRACE_LAG, DJ_END_WARN_SEC, DJ_END_WARN_HURRY } = loadWaveGeometry();

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

// --- how many lanes the stack has -------------------------------------------------------------
//
// Four canvases go into the stack, two per deck: the deck's own waveform (it holds a file) and the
// livecode strip (it holds code). A deck is one or the other, so the stack shows TWO lanes.
//
// It showed three. Inside its pane a deck's waveform canvas is hidden by the PANE, so a deck that
// has never held a song has never had `hidden` set on the canvas itself - and up in the stack,
// where the canvas is its own flex item, that unhidden empty canvas is a third lane. Which lane
// is which is decided in two different places (the strip works it out every frame, the waveform is
// told by the pane opening and closing), so what has to be pinned is that the stack settles both
// of them against the same fact at the moment it takes the canvases.

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');

function grabFunction(name) {
  const at = CLIENT_SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in public/client.js - this test needs updating`);
  const end = CLIENT_SRC.indexOf('\n}\n', at) + 3;
  return CLIENT_SRC.slice(at, end);
}

test('the stack hides each deck\'s waveform unless that deck holds a song', () => {
  const fn = grabFunction('applyMixStack');
  assert.match(fn, /stack\.append\(/, 'applyMixStack no longer fills the stack - this test needs updating');
  // Said at the append, not trusted to have been said earlier: this is the one moment the
  // canvases become their own lanes, and the only moment that catches a deck which has never
  // held a song at all.
  assert.match(
    fn,
    /detailEl\.classList\.toggle\('hidden', !songPanes\[d\]\.song\)/,
    'nothing sets the waveform lanes\' visibility as they enter the stack - a deck that has never '
    + 'held a file leaves a blank third lane',
  );
});

test('the two lanes of one deck are mutually exclusive by construction', () => {
  // The strip is for a deck playing CODE, so it tests for the absence of the song the waveform
  // tests for the presence of. If both ever tested the same way the stack could show a deck
  // twice, which is the same three lanes by another route.
  assert.match(grabFunction('djLiveWaveOn'), /!songPanes\[deck\]\.song/);
  assert.match(grabFunction('applyMixStack'), /!songPanes\[d\]\.song/);
});

test('both decks\' pairs go into the stack, in a fixed order', () => {
  const fn = grabFunction('applyMixStack');
  const append = fn.slice(fn.indexOf('stack.append('));
  const order = [...append.matchAll(/(songPanes\.[ab]\.detailEl|djLiveWaveEls\.[ab])/g)].map((m) => m[1]);
  assert.deepEqual(order, [
    'songPanes.a.detailEl', 'djLiveWaveEls.a', 'songPanes.b.detailEl', 'djLiveWaveEls.b',
  ], 'deck A\'s pair then deck B\'s - the visual order either way round, so no path that changes '
    + 'what a deck holds has to reorder the stack');
});

// --- the grid is the DECK's, not the clock's -----------------------------------------------------
//
// A livecode deck that joins a playing set starts its arrangement at the next clock position, so
// its own bar one lives at a fractional transport cycle. The grid used to draw bare integer
// cycles - the OTHER record's bars - and kept doing so after that record stopped, which made the
// strip impossible to beatmatch by eye. The clock twin's anchors carry the real mapping.

const { djLiveGridShift } = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
  const at = src.indexOf('function djLiveGridShift(');
  assert.ok(at > 0, 'djLiveGridShift not found in client.js - this test needs updating');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, src.indexOf('\n}', at) + 2)}\nreturn { djLiveGridShift };`)();
})();

test('a deck that joined mid-set wears its own bars, shifted off the clock\'s', () => {
  // Joined at transport cycle 16.25 with its arrangement at zero: bar one is at 16.25, so the
  // grid shifts by a quarter cycle - exactly the offset that was being drawn as "on the grid".
  const twin = { anchors: [{ cycle: 16.25, pos: 0 }] };
  assert.equal(djLiveGridShift(twin, 20), 0.25 + 16);
});

test('a deck started on its own keeps the clock\'s grid - the two have always agreed there', () => {
  assert.equal(djLiveGridShift({ anchors: [{ cycle: 0, pos: 0 }] }, 5), 0);
  assert.equal(djLiveGridShift(null, 5), 0, 'no twin at all is a deck on its own time');
  assert.equal(djLiveGridShift({ anchors: [] }, 5), 0);
});

test('a loop jump moves the mapping, and the anchor in force is the one the window is in', () => {
  // Playing from cycle 10 (pos 0), a region looped back at cycle 18 to pos 4: past 18 the
  // deck's bars sit where the SECOND anchor says, not where the first did.
  const twin = { anchors: [{ cycle: 10, pos: 0 }, { cycle: 18, pos: 4 }] };
  assert.equal(djLiveGridShift(twin, 12), 10);
  assert.equal(djLiveGridShift(twin, 20), 14);
  assert.equal(djLiveGridShift(twin, 9), 10, 'before every anchor, the first is the mapping');
});

// A held nudge is a phase correction, not a tempo. The strip's scale comes from the deck's tempo
// with the bend taken back out, or the picture zooms in and out by 4% under the finger - the same
// rule the song strips keep with baseRate.
test('the livecoded strip is scaled by the deck\'s tempo without the nudge or the bend', () => {
  const at = CLIENT_SRC.indexOf('const deckBaseCps = ');
  assert.ok(at > 0, 'deckBaseCps not found in client.js - this test needs updating');
  // eslint-disable-next-line no-new-func
  const deckBaseCps = new Function('deckClock', `${CLIENT_SRC.slice(at, CLIENT_SRC.indexOf('\n};', at) + 3)}\nreturn deckBaseCps;`);
  const held = deckBaseCps(() => ({ cps: 0.5 * 1.04, bend: 0.04 }));
  assert.ok(Math.abs(held('a') - 0.5) < 1e-12, `scaled by ${held('a')}`);
  assert.equal(deckBaseCps(() => ({ cps: 0.5 }))('a'), 0.5, 'the room\'s snapshot carries no bend');
  const draw = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function djLiveWaveDraw('));
  assert.match(draw.slice(0, draw.indexOf('\n}\n')), /const cps = deckBaseCps\(deck\)/);
});

// ---------------------------------------------------------------------------------------------
// The trace under a clock that is being moved
// ---------------------------------------------------------------------------------------------

test('a nudged deck carries the drums already on its strip along with their beat lines', async () => {
  // Reported 2026-10-10: holding the platter on a deck playing code slid the bar lines and left
  // the drums behind. A frame used to be kept with its arrival TIME and placed again at every
  // draw from the tempo, so whatever the clock had been moved by since - a held drag, a jog, the
  // tempo fader - was how far each hit sat from the beat it was played on. Kept at the deck cycle
  // it sounded on, the hit and its line are one position and nothing can come between them.
  const { Transport, DeckClock } = await import('../pattern-core/src/scheduler.mjs');
  const songSync = require('./song-sync.js');
  let now = 0;
  const room = new Transport(() => now, { cps: CPS, paused: true });
  room.start(now);
  const deck = new DeckClock(room);
  deck.align();
  const mirror = () => { const t = deck.snapshot(); return { cps: t.cps, pos: t.baseCycle + (now - t.baseSec) * t.cps }; };

  // A kick on every beat of the deck's clock; its meter frame lands one lag later and is stamped
  // exactly as djLiveTracePush stamps it.
  const ring = [];
  const kicks = []; // the frames that carry a kick, with the beat each one IS
  const waiting = [];
  let beat = Math.floor(deck.cycleAt(now) * 4);
  const run = (until) => {
    while (now < until - 1e-9) {
      now += 0.005;
      const at = Math.floor(deck.cycleAt(now) * 4);
      if (at !== beat) { beat = at; waiting.push({ due: now + DJ_LIVE_TRACE_LAG / 1000, cycle: at / 4 }); }
      while (waiting.length && waiting[0].due <= now) {
        const { cps, pos } = mirror();
        const frame = { c: djLiveTraceCycle(now * 1000, now * 1000, pos, cps), p: 1 };
        djLiveTraceAdd(ring, frame, 2000);
        kicks.push({ frame, cycle: waiting.shift().cycle });
      }
    }
  };
  // The run above steps 5ms at a time, twice over (the beat, then the lag): 10ms is its own grain.
  // What it is looking for is 80ms (the drag) and 500ms (the jog).
  const SIM_SLOP_MS = 12;
  const worstMs = () => Math.max(...kicks.map((k) => Math.abs(k.frame.c - k.cycle) / CPS * 1000));

  run(4);
  assert.ok(worstMs() < SIM_SLOP_MS, `on a straight clock a kick sits on its beat (${worstMs()}ms)`);
  deck.setBend(songSync.effectiveRate(1, -1, 0) - 1); // the drag, held for two seconds
  run(6);
  deck.setBend(0);
  run(7);
  assert.ok(Math.abs(deck.offset) > 0.03, 'the drag really did move the deck against the room');
  assert.ok(worstMs() < SIM_SLOP_MS, `and every kick, before the drag and during it, is still on its beat (${worstMs()}ms)`);
  // A beat forward: the same again for a step. Taken between kicks - a frame still in flight when
  // the clock steps measured sound from before the step and is stamped after it, which is one
  // lag's worth of trace out of place at the seam and not what this is about.
  while (waiting.length) run(now + 0.005);
  deck.jog(0.25);
  beat = Math.floor(deck.cycleAt(now) * 4); // the step is not itself a kick
  run(9);
  assert.ok(worstMs() < SIM_SLOP_MS, `a jog leaves them there too (${worstMs()}ms)`);
});

test('the history only runs forward: a clock stepped back gives up what it is about to replay', () => {
  const ring = [];
  for (const c of [1, 1.1, 1.2, 1.3]) djLiveTraceAdd(ring, { c }, 100);
  djLiveTraceAdd(ring, { c: 1.15 }, 100); // jogged back a little
  assert.deepEqual(ring.map((f) => f.c), [1, 1.1, 1.15]);
  djLiveTraceAdd(ring, { c: 0 }, 100); // back to the top
  assert.deepEqual(ring.map((f) => f.c), [0]);
  // A paused clock stamps every frame alike; they are kept, not taken for a step back.
  djLiveTraceAdd(ring, { c: 0 }, 100);
  assert.equal(ring.length, 2);
  for (let i = 0; i < 10; i++) djLiveTraceAdd(ring, { c: 1 + i }, 4);
  assert.deepEqual(ring.map((f) => f.c), [7, 8, 9, 10], 'and it is still a ring');
});

test('the strip stamps a frame as it lands and draws it from the stamp', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');
  assert.match(src, /const c = djLiveTraceCycle\(t, t, currentCyclePos\(deck\), deckClock\(deck\)\.cps\);/,
    'the position reads the clock as it is being bent');
  assert.match(src, /const x = xOf\(ring\[i\]\.c\);/);
  assert.doesNotMatch(src, /djLiveTraceCycle\(ring\[i\]/, 'nothing works a kept frame out again from the tempo');
});
