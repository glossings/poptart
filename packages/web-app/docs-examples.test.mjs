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

// A name the engine does not know is reported this way (web-audio-engine.mjs), and so is an option
// a list control does not have (an option name with a space, double-quoted, arrives as two words);
// anything else it says - a pack still loading, say - is not the example's fault.
const BROKEN = /there is no device called|has no parameter called|cannot take/;

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
  assert.equal((await play('a: note("c3").synth("Rings").param("Model", "Sympathetic String")')).length, 1);
  assert.deepEqual(await play('a: note("c3").synth("Rings").param("Model", "\'Sympathetic String\'")'), []);
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

// ---- the examples as the app itself (?embed) -------------------------------------------------------

test('an example used in the guide is the app, embedded: isolated, and out of the guide\'s history', async () => {
  const { injectBoot } = await import('./build-web.mjs');
  const index = fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');
  assert.match(index, /if \(\/\[\?&\]embed\\b\/\.test\(location\.search\)\) root\.dataset\.embed = '1';/);
  assert.match(injectBoot(index), /m\.boot\(\{ isolated: document\.documentElement\.dataset\.embed === "1" \}\)/,
    'an example never reads or writes the reader\'s own patterns and prebake');
  const body = (name) => client.slice(client.indexOf(`function ${name}(`), client.indexOf('\n}\n', client.indexOf(`function ${name}(`)));
  assert.match(body('checkpointUrl'), /if \(EMBEDDED\) return;/, 'a frame\'s pushState would land in the guide tab\'s history');
  assert.match(body('saveRestoreBuffer'), /if \(EMBEDDED\) return;/, 'every example shares the guide tab\'s sessionStorage');
  assert.match(client, /window\.poptartEmbedCode = \(\) => cm\.getValue\(\);/, 'the guide reads the edited code back');
  // A fixed panel has no offsetParent, so that is not how the frame asks whether one is open.
  assert.match(body('embedPanelOpen'), /getClientRects\(\)\.length/);
  assert.ok(!/offsetParent\)/.test(body('embedPanelOpen')));
  // ...and it is not measured: sized by the window, a panel would chase a frame grown to fit it.
  assert.ok(!/offsetHeight|scrollHeight/.test(body('embedPanelOpen')));
});

// ---- the examples on the desktop -----------------------------------------------------------------

test('on the desktop an example is the browser build too, served by the desktop server', () => {
  const server = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
  const docs = fs.readFileSync(path.join(docsDir, 'docs.js'), 'utf8');
  const boot = fs.readFileSync(path.join(here, 'public', 'web', 'boot.mjs'), 'utf8');
  assert.match(docs, /^ {2}setUpExamples\(\);$/m, 'examples play in both builds');
  // `/?embed` is index.html with the in-page host booted in front of the editor, so an example
  // plays on that page's own engine and never on the one the desktop's window is using.
  assert.match(server, /if \(urlPath === '\/index\.html' && \/\(\^\|&\)embed\\b\/\.test\(query\)\) return serveEmbed\(res\);/);
  const serveEmbed = server.slice(server.indexOf('async function serveEmbed('), server.indexOf('\nfunction serveStatic('));
  assert.match(serveEmbed, /injectBoot\(html\)/);
  // ...and every path that host loads from is served, from a folder that is there.
  const paths = boot.slice(boot.indexOf('export const PATHS'), boot.indexOf('});', boot.indexOf('export const PATHS')));
  const wanted = [...paths.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 5);
  const prefixes = [...server.matchAll(/\{ prefix: '([^']+)'/g)].map((m) => m[1]);
  for (const url of wanted) {
    assert.ok(prefixes.some((p) => `${url}/`.startsWith(p)), `${url} is served on the desktop`);
  }
  const packages = path.resolve(here, '..');
  for (const dir of ['web-engine/src', 'web-engine/public/worklets', 'web-engine/public/packs', 'web-engine/public/devices', 'osc-engine/sample-map-core.mjs']) {
    assert.ok(fs.existsSync(path.join(packages, dir)), `${dir} is there to serve`);
  }
  // A module the page's host imports from beside itself that is NOT in public/web is one the web
  // build puts there (pinned-defs.js), and the desktop has to serve it at the same path.
  const webDir = path.join(here, 'public', 'web');
  for (const file of fs.readdirSync(webDir).filter((f) => f.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(webDir, file), 'utf8');
    for (const [, name] of src.matchAll(/(?:from\s+|import\()\s*'\.\/([^'/]+)'/g)) {
      if (fs.existsSync(path.join(webDir, name))) continue;
      assert.match(server, new RegExp(`prefix: '/web/', root: __dirname, only: \\[[^\\]]*'${name.replace('.', '\\.')}'`),
        `/web/${name} (imported by ${file}) is served on the desktop`);
    }
  }
  // A frame cannot reach the desktop's own window, so "open" copies the code there instead.
  assert.match(docs, /isWeb \? 'open ↗' : 'copy'/);
});
