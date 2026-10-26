// A drawn LFO whose breakpoints move (a shape dragged in the editor, then the evaluation after it)
// is redrawn under the phase it has reached, not started over.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext } from './fake-context.mjs';
import { LfoConnection } from './src/engine/modulators.mjs';

test('moving the breakpoints keeps the phase; a new mode starts again', () => {
  const ctx = new FakeAudioContext();
  const target = { value: 0 };
  const lfo = new LfoConnection(ctx, target, { shape: 'custom', mode: 'free', rateHz: 1, min: 0, max: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  ctx.currentTime = 0.3;
  const before = lfo._phaseAt(0.3);
  lfo.update({ points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }] });
  assert.ok(Math.abs(lfo.startPhase - before) < 1e-9, `carried on at ${before}, not ${lfo.startPhase}`);
  assert.equal(lfo.startedAt, 0.3);
  lfo.update({ mode: 'retrigger', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] });
  assert.equal(lfo.startPhase, 0, 'a different kind of LFO is a fresh one');
});
