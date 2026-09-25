// The guide's playable examples, played.
//
// Every `<pre data-run>` in the guide (public/docs/*.html) becomes a play button in the browser build, so every one
// has to be a whole buffer that evaluates there, names devices this build has and controls those
// devices have. Each is run through the real browser evaluate and Web Audio engine (against the
// stand-in audio graph web-evaluate.test.mjs uses) and fails on a thrown error or on the engine
// saying a device or a parameter does not exist - which in the page would be an example that plays
// silence, or plays without the thing it is there to show.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as patternCore from '@poptart/pattern-core';
import { FakeAudioContext, fakeWorkletFor } from '../web-engine/fake-context.mjs';
import { catalog } from '../web-engine/src/catalog.mjs';
import { WebAudioEngine } from '../web-engine/src/engine/web-audio-engine.mjs';
import { createEvaluator } from './public/web/evaluate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(here, 'public', 'docs');
const pages = fs.readdirSync(docsDir).filter((f) => f.endsWith('.html')).sort()
  .map((name) => ({ name, html: fs.readFileSync(path.join(docsDir, name), 'utf8') }));

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
  assert.ok(pages.flatMap((p) => runnableExamples(p.html)).length > 0);
});

test('the check catches a device or a control the browser build does not have', async () => {
  assert.equal((await play('a: note("c3").synth("NoSuchSynth")')).length, 1);
  assert.equal((await play('a: note("c3").synth("Wavetable").param("No Such Control", 0.5)')).length, 1);
});

for (const { name, html } of pages) {
  for (const { line, code } of runnableExamples(html)) {
    test(`docs/${name}:${line} plays in the browser build`, async () => {
      assert.deepEqual(await play(code), [], code);
    });
  }
}

// ---- the pages themselves ------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const { CHAPTERS } = require('./public/docs/docs.js');

test('every chapter docs.js lists is a page, and every page is listed', () => {
  assert.deepEqual(CHAPTERS.map((c) => `${c.file}.html`).sort(), pages.map((p) => p.name));
  for (const { name, html } of pages) {
    assert.ok(html.includes(`<body data-page="${name.replace('.html', '')}">`), `${name} names itself`);
  }
});

test('the guide links only to pages, headings and images that exist', () => {
  const ids = new Map(pages.map((p) => [p.name, new Set([...p.html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))]));
  for (const { name, html } of pages) {
    for (const [, target] of html.matchAll(/<a[^>]*href="(\/docs\/[^"]*)"/g)) {
      const [file, hash] = target.replace('/docs/', '').split('#');
      const page = file || 'index.html';
      assert.ok(ids.has(page), `${name} links to ${target}, which is not a page`);
      if (hash) assert.ok(ids.get(page).has(hash), `${name} links to ${target}, which has no such heading`);
    }
    for (const [, src] of html.matchAll(/<img[^>]*src="\/docs\/([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(docsDir, src)), `${name} shows ${src}, which is not there`);
    }
  }
});

test('every timeline in the guide builds, and makes events', async () => {
  const core = await import('@poptart/pattern-core');
  const names = Object.keys(core).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const make = new Function(...names, 'expr', 'return eval("(" + expr + ")")');
  for (const { name, html } of pages) {
    for (const [, expr] of html.matchAll(/<div class="row">([\s\S]*?)<\/div>/g)) {
      const code = unescape(expr).trim();
      const sig = make(...names.map((n) => core[n]), code);
      assert.ok(sig.stepsForCycle(0).some((s) => s.value != null), `${name}: ${code} makes no events`);
    }
  }
});
