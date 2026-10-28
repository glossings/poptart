'use strict';

// MIDI clock out's tick train (server/midi-clock.js) on a clock the test drives: ticks are stamped
// with their beats, a late wake neither skips nor doubles one, a locate lands on the next
// sixteenth as stop, song position, continue and the tick, a tempo change keeps the waiting tick,
// and a jump of the mirror past it picks up from where the clock now is.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClockTicker } = require('./server/midi-clock');

/** A ticker on a fake clock: run(sec) advances time, firing timers as they fall due (or `late` after). */
function rig({ late = 0 } = {}) {
  let now = 100;
  let timers = [];
  let seq = 0;
  const sent = [];
  const ticker = new ClockTicker({
    now: () => now,
    send: (bytes, at) => sent.push({ bytes, at }),
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms / 1000 + late, fn }); return id; },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
  });
  const run = (sec) => {
    const end = now + sec;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = Math.max(now, t.at);
      t.fn();
    }
    now = end;
  };
  return { ticker, sent, run, get now() { return now; }, set now(v) { now = v; } };
}

const ticksOf = (sent) => sent.filter((m) => m.bytes[0] === 0xF8);

test('ticks are stamped on their beats, 24 a beat', () => {
  const r = rig();
  r.ticker.setState({ tempo: 2, b0: 0, t0: 100, running: true, latency: 0.05 });
  r.ticker.start();
  r.run(1);
  const ticks = ticksOf(r.sent);
  assert.ok(ticks.length >= 46 && ticks.length <= 50, `${ticks.length} ticks in a second at 120 bpm`);
  for (const m of ticks) {
    const k = (m.at - 100) * 2 * 24;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `tick on beat ${k / 24}`);
  }
  // Each sent exactly its lead before its stamp.
  assert.ok(ticks.every((m, i) => i === 0 || Math.abs((m.at - ticks[i - 1].at) - 1 / 48) < 1e-9));
});

test('a wake later than a tick neither skips nor doubles one', () => {
  const r = rig({ late: 0.03 }); // every timer fires 30 ms late, longer than a tick at 120 bpm
  r.ticker.setState({ tempo: 2, b0: 0, t0: 100, running: true, latency: 0.05 });
  r.ticker.start();
  r.run(1);
  const ks = ticksOf(r.sent).map((m) => Math.round((m.at - 100) * 48));
  assert.ok(ks.slice(1).every((k, i) => k === ks[i] + 1), `consecutive: ${ks.join(',')}`);
});

test('a locate lands on the next sixteenth: stop, song position, continue, tick on one stamp', () => {
  const r = rig();
  r.ticker.setState({ tempo: 2, b0: 3.1, t0: 100, running: true, latency: 0.05 });
  r.ticker.start({ locate: true });
  r.run(0.5);
  const i = r.sent.findIndex((m) => m.bytes[0] === 0xFC);
  const seq = r.sent.slice(i, i + 4);
  assert.deepEqual(seq.map((m) => m.bytes[0]), [0xFC, 0xF2, 0xFB, 0xF8]);
  assert.ok(seq.every((m) => m.at === seq[0].at));
  const k = Math.round((3.1 + (seq[0].at - 100) * 2) * 24);
  assert.equal(k % 6, 0);
  assert.equal(seq[1].bytes[1] + seq[1].bytes[2] * 128, k / 6);
  assert.equal(r.sent.filter((m) => m.bytes[0] === 0xFC).length, 1, 'the locate is spent once');
  // From the very top: a plain start.
  const top = rig();
  top.ticker.setState({ tempo: 2, b0: -0.2, t0: 100, running: true, latency: 0.05 });
  top.ticker.start({ locate: true });
  top.run(0.5);
  const j = top.sent.findIndex((m) => m.bytes[0] === 0xFC);
  assert.deepEqual(top.sent.slice(j, j + 3).map((m) => m.bytes[0]), [0xFC, 0xFA, 0xF8]);
  // Not running: ticks only, the locate waits.
  const stopped = rig();
  stopped.ticker.setState({ tempo: 2, b0: 0, t0: 100, running: false, latency: 0.05 });
  stopped.ticker.start({ locate: true });
  stopped.run(0.5);
  assert.ok(stopped.sent.every((m) => m.bytes[0] === 0xF8));
});

test('a tempo change keeps the waiting tick; a jump past it starts from the clock\'s new place', () => {
  const r = rig();
  r.ticker.setState({ tempo: 2, b0: 0, t0: 100, running: true, latency: 0.05 });
  r.ticker.start();
  r.run(0.2);
  const k = r.ticker._k;
  // Same beat position, faster tempo (what MirrorClock#setTempo hands over).
  const b = 0 + (r.now - 100) * 2;
  r.ticker.setState({ tempo: 3, b0: b, t0: r.now });
  assert.equal(r.ticker._k, k, 'the tick being waited for keeps its place');
  r.sent.length = 0;
  // Re-anchored a whole beat on: ticks carry on from there.
  r.ticker.setState({ b0: b + 1, t0: r.now });
  r.run(0.1);
  const first = ticksOf(r.sent)[0];
  const beat = (b + 1) + (first.at - r.now + 0.1) * 3;
  assert.ok(beat > b + 1, 'no burst of the skipped beat');
});
