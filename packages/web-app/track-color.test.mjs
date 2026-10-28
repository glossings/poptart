// A track's .color() as the browser build's evaluate reports it: what the editor's one color per
// track (client.js's trackColor) starts from, on either deck.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as patternCore from '@poptart/pattern-core';
import { FakeAudioContext, fakeWorkletFor } from '../web-engine/fake-context.mjs';
import { catalog } from '../web-engine/src/catalog.mjs';
import { WebAudioEngine } from '../web-engine/src/engine/web-audio-engine.mjs';
import { createEvaluator } from './public/web/evaluate.mjs';

async function evaluate(code, deck) {
  const ctx = new FakeAudioContext();
  const engine = new WebAudioEngine(ctx, { registry: catalog, warn: () => {}, AudioWorkletNode: fakeWorkletFor(catalog) });
  const transport = new patternCore.Transport(() => engine.getTime(), { cps: 0.5, paused: true });
  const evaluator = createEvaluator({ patternCore, engine, transport });
  try {
    return await evaluator.evaluate(code, deck ? { deck } : undefined);
  } finally {
    for (const sch of evaluator.schedulers.values()) sch.stop();
  }
}

test('each track reports its .color(), or null for the automatic one, on both decks', async () => {
  const code = 'kick: s("bd*4").color("Tomato")\nhats: s("hh*8")\nkeys: n("0 2").synth("Wavetable").color(\'#63b4ff\').gain(0.5)';
  for (const deck of [undefined, 'b']) {
    const res = await evaluate(code, deck);
    assert.deepEqual(res.tracks.map((t) => [t.label, t.color]), [['kick', 'tomato'], ['hats', null], ['keys', '#63b4ff']]);
  }
});
