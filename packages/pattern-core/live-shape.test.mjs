// A drawn shape dragged in the editor is heard as it is drawn: Scheduler#liveShape re-sends every
// modulator playing the old drawing with the new one, and keeps it until the next evaluation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { lfo, synth } from './src/signal.mjs';
import { parseShapePoints } from './src/shape.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mock() {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, { get: (t, p) => (p in t ? t[p] : (...a) => calls.push({ m: p, a })) });
  return { engine, sent: () => calls.filter((c) => c.m === 'setParamLFO') };
}

test('the modulators playing the dragged drawing take the new one, and only those', () => {
  const { engine, sent } = mock();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(synth('W').param('A', lfo('0,0 0.5,1 1,0')).param('B', lfo('0,1 1,0')));
  const before = sent().length;
  const from = parseShapePoints('0,0 0.5,1 1,0');
  const to = parseShapePoints('0,0 0.25,1 1,0');
  assert.equal(sched.liveShape(from, to), 1);
  const resent = sent().slice(before);
  assert.equal(resent.length, 1);
  assert.equal(resent[0].a[2], 'A');
  assert.deepEqual(resent[0].a[3].points, to);
  // Dragged again from where it is now, it still matches.
  assert.equal(sched.liveShape(to, parseShapePoints('0,0 0.2,1 1,0')), 1);
  assert.equal(sched.liveShape(from, to), 0, 'the old drawing is no longer playing');
});
