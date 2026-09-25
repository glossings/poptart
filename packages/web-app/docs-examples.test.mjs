// The guide's playable examples, played.
//
// Every `<pre data-run>` in docs.html becomes a play button in the browser build, so every one
// has to be a whole buffer that evaluates there, names devices this build has and controls those
// devices have. Each is run through the real browser evaluate and Web Audio engine (against the
// stand-in audio graph web-evaluate.test.mjs uses) and fails on a thrown error or on the engine
// saying a device or a parameter does not exist - which in the page would be an example that plays
// silence, or plays without the thing it is there to show.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as patternCore from '@poptart/pattern-core';
import { FakeAudioContext, fakeWorkletFor } from '../web-engine/fake-context.mjs';
import { catalog } from '../web-engine/src/catalog.mjs';
import { WebAudioEngine } from '../web-engine/src/engine/web-audio-engine.mjs';
import { createEvaluator } from './public/web/evaluate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = fs.readFileSync(path.join(here, 'public', 'docs.html'), 'utf8');

const unescape = (html) => html
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

/** Every playable example, as { line, code }. */
export function runnableExamples(html) {
  const out = [];
  for (const m of html.matchAll(/<pre\b[^>]*\bdata-run\b[^>]*>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/g)) {
    out.push({ line: html.slice(0, m.index).split('\n').length, code: unescape(m[1]) });
  }
  return out;
}

// A name the engine does not know is reported this way (web-audio-engine.mjs); anything else it
// says - a pack still loading, say - is not the example's fault.
const BROKEN = /there is no device called|has no parameter called/;

async function play(code) {
  const ctx = new FakeAudioContext();
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  const transport = new patternCore.Transport(() => engine.getTime(), { cps: 0.5, paused: true });
  const evaluator = createEvaluator({ patternCore, engine, transport });
  try {
    evaluator.evaluate(code);
    // Parameters reach the devices as the schedulers run, so give them a few ticks.
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    for (const sch of evaluator.schedulers.values()) sch.stop();
  }
  return warnings.filter((w) => BROKEN.test(w));
}

test('the guide has playable examples', () => {
  assert.ok(runnableExamples(docs).length > 0);
});

test('the check catches a device or a control the browser build does not have', async () => {
  assert.equal((await play('a: note("c3").synth("NoSuchSynth")')).length, 1);
  assert.equal((await play('a: note("c3").synth("Wavetable").param("No Such Control", 0.5)')).length, 1);
});

for (const { line, code } of runnableExamples(docs)) {
  test(`docs.html:${line} plays in the browser build`, async () => {
    assert.deepEqual(await play(code), [], code);
  });
}
