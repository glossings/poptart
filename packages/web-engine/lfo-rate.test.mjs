// A patterned LFO rate in the browser engine. Each rate change reaches an LfoConnection as an anchor
// timestamped at its step, carrying the phase and the new rate (see pattern-core's
// Scheduler#_scheduleRateChanges), so a connection can be holding several sources at once: the one
// playing and the ones queued in the lookahead. What it plays has to be the JS count, and a re-send
// in between (a range bound that is a signal) must not throw the queue away.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { note, saw, sine, lfoPhaseCount } from '../pattern-core/src/signal.mjs';
import { Scheduler } from '../pattern-core/src/scheduler.mjs';

function makeEngine() {
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog) });
  engine.createTrack('t1');
  engine.loadEffect('t1', 'Filter', 1);
  return { ctx, engine };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const wrapDist = (a, b) => {
  const d = Math.abs((((a - b) % 1) + 1) % 1);
  return Math.min(d, 1 - d);
};

test('anchors carrying a rate queue up, each source running at its own rate', () => {
  const { ctx, engine } = makeEngine();
  engine.setParamLFO('t1', 1, 'Cutoff', { shape: 'saw', rateHz: 0.5, phaseCycles: 0, min: 0, max: 1, rateFromAnchors: true });
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  const first = conn.node;
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.25, 0.15, 1);
  const second = conn.node;
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.5, 0.2, 2);
  const third = conn.node;
  assert.ok(near(conn._phaseAt(0.1), 0.05), 'before the first change: 0.5 Hz from the start');
  assert.ok(near(conn._phaseAt(0.17), 0.27), 'between the two: from 0.25 at 1 Hz');
  assert.ok(near(conn._phaseAt(0.25), 0.6), 'after the second: from 0.5 at 2 Hz');
  assert.ok(near(first.stopped.when, 0.15));
  assert.ok(near(second.started.when, 0.15) && near(second.stopped.when, 0.2));
  assert.ok(near(third.started.when, 0.2) && third.stopped == null);
  assert.ok(near(third.playbackRate.value / second.playbackRate.value, 2), 'the last source runs twice as fast');
  ctx.advance(0.3);
});

test('a re-send of a patterned rate leaves the running rate to the anchors', () => {
  const { engine } = makeEngine();
  const ir = { shape: 'saw', rateHz: 0.5, phaseCycles: 0, min: 0, max: 1, rateFromAnchors: true };
  engine.setParamLFO('t1', 1, 'Cutoff', ir);
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  const rate = conn.node.playbackRate.value;
  engine.setParamLFO('t1', 1, 'Cutoff', { ...ir, rateHz: 4 });
  assert.equal(conn.node.playbackRate.value, rate);
  assert.equal(conn.rateHz(), 0.5);
});

test('a range re-sent while anchors wait keeps them, on the new buffer', () => {
  const { ctx, engine } = makeEngine();
  const ir = { shape: 'saw', rateHz: 0.5, phaseCycles: 0, min: 0, max: 1, rateFromAnchors: true };
  engine.setParamLFO('t1', 1, 'Cutoff', ir);
  const conn = engine.modulators.get('t1').get('1:Cutoff');
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.25, 0.15, 1);
  engine.anchorParamLFO('t1', 1, 'Cutoff', 0.5, 0.2, 2);
  const queued = conn.segments.filter((s) => s.startedAt > 0.1).map((s) => s.node);
  ctx.advance(0.1);
  engine.setParamLFO('t1', 1, 'Cutoff', { ...ir, max: 0.5 });
  for (const node of queued) assert.ok(node.stopped.when <= node.started.when, 'the old queued sources never play');
  const starts = conn.segments.map((s) => [s.startedAt, s.startPhase, s.rateHz]);
  assert.deepEqual(starts.map(([at]) => at), [0.1, 0.15, 0.2], 'now, then the two anchors again');
  assert.ok(near(starts[0][1], 0.05) && starts[0][2] === 0.5, 'now carries on where 0.5 Hz had got to');
  assert.deepEqual(starts.slice(1).map(([, p, r]) => [p, r]), [[0.25, 1], [0.5, 2]]);
  assert.ok(near(conn._phaseAt(0.25), 0.6));
  // Only one source is on the parameter at any moment from here: each stops where the next starts.
  const [a, b, c] = conn.segments.map((s) => s.node);
  assert.ok(near(a.stopped.when, 0.15) && near(b.stopped.when, 0.2) && c.stopped == null);
});

test('driven by the scheduler, the connection plays the JS count', () => {
  for (const [label, lfo] of [
    ['steps', saw('<0.25 1 [2 4] 3>')],
    ['continuous', saw(sine(0.5).range(0.5, 3))],
    ['swept range', saw('<1 2>').range('<0 0.2>', 1)],
  ]) {
    const { ctx, engine } = makeEngine();
    const cps = 0.5;
    const sch = new Scheduler(engine, { trackId: 't1', cps });
    sch.setPattern(note('c').fx('Filter').param('Cutoff', lfo));
    // The chain the pattern asks for is already there (makeEngine); the LFO is on its slot 1.
    sch.start(0);
    clearInterval(sch._timer);
    const conn = () => engine.modulators.get('t1').get('1:Cutoff') ?? assert.fail(`no modulator: ${[...(engine.modulators.get('t1')?.keys() ?? [])]}`);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      sch._tick();
      ctx.advance(0.03);
      const t = ctx.currentTime;
      if (t < 0.5) continue; // the first anchor lands a lookahead after the start
      const want = lfoPhaseCount(lfo.lfoIR, t, cps, t * cps);
      const got = conn()._phaseAt(t);
      assert.ok(wrapDist(got, want) < 1e-6, `${label}: at ${t.toFixed(2)}s the connection is at ${got % 1}, the JS count at ${want % 1}`);
      checked++;
    }
    assert.ok(checked > 200);
  }
});
