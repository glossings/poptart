// The static build, checked as a tree of files.
//
// There is no browser here to open the page in, so what can be checked is everything that has to
// be TRUE before a browser could: that every module the page imports resolves to a file that was
// copied, that every script and stylesheet the page names is there, and that the one edit the
// build makes to the page is the one it meant to make.
//
// This is the test that stands in for "does the deploy work". A broken import in a build with no
// bundler is not a build error - there is no build - it is a blank page and a line in somebody
// else's console, and it is exactly the kind of thing a copy step gets wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, injectAnalytics, injectBoot, markDocsWeb, replaceSketch, WEB_SKETCH } from './build-web.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-web-build-'));

build({ out, quiet: true });

/** Every file under a directory, as paths relative to it. */
function walk(dir, base = dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

const files = new Set(walk(out));

/** The specifiers a module imports, static and dynamic alike. */
function importsOf(source) {
  const out = [];
  for (const m of source.matchAll(/(?:^|[\s;}])import\s*(?:[\w${},*\s]+from\s*)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of source.matchAll(/(?:^|[\s;(=])export\s*(?:[\w${},*\s]+)from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** Resolves a specifier the way a browser would, against the page's root. */
function resolveSpecifier(fromFile, spec) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;          // a URL; not ours to check
  if (spec.startsWith('/')) return spec.slice(1);
  const dir = path.posix.dirname(fromFile);
  return path.posix.normalize(path.posix.join(dir, spec));
}

test('every module the built page imports resolves to a file that was copied', () => {
  const broken = [];
  for (const file of files) {
    // Only the modules. The `.js` files in this build are classic scripts by design - the editor
    // and the worklets - and the next test is what holds them to that.
    if (!file.endsWith('.mjs')) continue;
    if (file.startsWith('vendor/')) continue;                  // a third-party bundle, not ours
    const source = fs.readFileSync(path.join(out, file), 'utf8');
    for (const spec of importsOf(source)) {
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null) continue;
      if (!files.has(resolved)) broken.push(`${file} imports ${spec} (${resolved}), which is not in the build`);
    }
  }
  assert.deepEqual(broken, [], 'a specifier that does not resolve is a blank page with no build error');
});

test('the worklets are classic scripts, which is the whole reason they are bundled', () => {
  // addModule() loads a worklet, and whether the engine inside it will honor an `import` is not
  // something this project can find out from here - it varies by browser and by version, and a
  // wrong guess is a device that fails to load in somebody else's browser. The engine's build
  // flattens them for that reason; this is what notices if one ever stops being flattened.
  for (const file of files) {
    if (!file.startsWith('web-engine/worklets/')) continue;
    const source = fs.readFileSync(path.join(out, file), 'utf8');
    const modular = /^\s*(?:import|export)\s/m.test(source);
    assert.equal(modular, false, `${file} still has module syntax in it`);
  }
});

test('every script and stylesheet the page names is in the build', () => {
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const named = [
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
  ];
  assert.ok(named.length > 8, `the page should name its assets, found ${named.length}`);
  const missing = named
    .filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href))
    .map((href) => href.replace(/^\.?\//, '').split('?')[0])
    .filter((rel) => !files.has(rel));
  assert.deepEqual(missing, [], 'a page that names a file the build does not have is a broken deploy');
});

test('the host is started before the editor, not after it', () => {
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const boot = html.indexOf('__poptartHostReady');
  const client = html.indexOf('<script src="client.js">');
  assert.ok(boot > 0 && client > 0);
  assert.ok(boot < client, 'the editor makes its first request while it is being evaluated');
  // A module script is deferred and would run after the editor. The tag has to be a classic one
  // that starts the import itself.
  assert.equal(/<script type="module"[^>]*>[^<]*__poptartHostReady/.test(html), false);
});

test('injecting the boot tag twice does not do it twice', () => {
  const once = injectBoot('<script src="client.js"></script>');
  assert.equal(injectBoot(once), once);
});

test('injecting into a page with no editor says so rather than producing a silent dud', () => {
  assert.throws(() => injectBoot('<html></html>'), /could not find the editor script tag/);
});

test('every element the editor looks up by id is in the page it is served with', () => {
  // The editor reaches for its panels by id as it loads, and a lookup that comes back null is
  // not an error anywhere near the cause: it is a TypeError on the next line, at load, which
  // takes the whole editor down. Adding a panel means adding its markup, and this is what says
  // so - a check worth having in a build whose page and script are two files copied side by side.
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(out, 'client.js'), 'utf8');
  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const asked = new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
  assert.ok(asked.size > 100, `the scan should have found the editor's lookups, found ${asked.size}`);
  assert.deepEqual([...asked].filter((id) => !present.has(id)), []);
});

test('rebuilding empties the output folder without replacing it', () => {
  // Whoever is serving the last build is sitting in this folder. Removing it and making a new
  // one with the same name leaves them holding a directory that no longer exists - the shell
  // stops working entirely, with an error that names getcwd and nothing else.
  const again = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-web-rebuild-'));
  build({ out: again, quiet: true });
  const before = fs.statSync(again).ino;
  fs.writeFileSync(path.join(again, 'stale.txt'), 'from the last build');
  build({ out: again, quiet: true });
  assert.equal(fs.statSync(again).ino, before, 'the folder itself must survive a rebuild');
  assert.equal(fs.existsSync(path.join(again, 'stale.txt')), false, 'but nothing in it should');
  assert.ok(fs.existsSync(path.join(again, 'index.html')));
  fs.rmSync(again, { recursive: true, force: true });
});

test('the generated device window has somewhere to draw itself', () => {
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  for (const id of ['devicePanel', 'deviceTitle', 'deviceSections', 'deviceClose']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing from the page`);
  }
});

test('the page opens on a sketch that names only what this build ships', () => {
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const m = html.match(/<textarea id="editor"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(m, 'the editor textarea is where the first buffer comes from');
  const shown = m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  assert.equal(shown, WEB_SKETCH);
  assert.doesNotMatch(html, /Serum/, 'the desktop sketch names a plugin this build does not have');
});

test('a page with no editor textarea is refused rather than shipped with the wrong sketch', () => {
  assert.throws(() => replaceSketch('<html></html>'), /textarea/);
});

test('the pieces the page fetches at runtime are all there', () => {
  for (const needed of [
    'web/boot.mjs',
    'pattern-core/index.mjs',
    'web-engine/src/index.mjs',
    'web-engine/worklets/poptart-synths.js',
    'web-engine/worklets/poptart-effects.js',
    'web-engine/worklets/poptart-wasm.js',
    'web-engine/devices/Galactic.wasm',
    'web-engine/packs/pt_kit/manifest.json',
    'web-engine/packs/pt_keys/manifest.json',
    'vendor/codemirror/lib/codemirror.js',
    'vendor/codemirror/lib/codemirror.css',
  ]) {
    assert.ok(files.has(needed), `${needed} is missing from the build`);
  }
});

test('the worklets the engine asks for are exactly the ones the build ships', async () => {
  // As a file:// URL: a bare absolute path is not one on Windows, where "C:" reads as a scheme.
  const engine = await import(pathToFileURL(path.join(out, 'web-engine', 'src', 'index.mjs')).href);
  for (const file of engine.WORKLET_FILES) {
    assert.ok(files.has(`web-engine/worklets/${file}`), `${file} is named by the engine and not built`);
  }
});

test('nothing in the build reaches for a Node module', () => {
  const offenders = [];
  for (const file of files) {
    if (!/\.m?js$/.test(file) || file.startsWith('vendor/')) continue;
    const source = fs.readFileSync(path.join(out, file), 'utf8');
    if (/from\s*'node:|require\(\s*'node:/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a page cannot import from Node');
});

test.after(() => fs.rmSync(out, { recursive: true, force: true }));

test('the visit counter goes in the head once, and never on this machine', () => {
  const page = '<html><head><title>x</title></head><body></body></html>';
  const once = injectAnalytics(page);
  assert.equal(injectAnalytics(once), once, 'injecting twice is a no-op');
  assert.ok(once.indexOf('/_vercel/insights/script.js') < once.indexOf('</head>'), 'in the head');
  assert.match(once, /"localhost", "127\.0\.0\.1"/, 'a local serve does not ask for a script it cannot serve');
  assert.throws(() => injectAnalytics('<body></body>'), /could not find the page head/);
});

test('the visit counter reports the page, never a pattern in the link, and one view per load', () => {
  // Run the injected script against a stand-in window and read what it would send.
  const html = injectAnalytics('<html><head></head></html>');
  const code = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const win = {};
  new Function('window', 'location', 'document', code)(win, { hostname: 'localhost' }, {});
  const [name, beforeSend] = win.vaq[0];
  assert.equal(name, 'beforeSend');
  const shared = 'https://pastree.cc/?x=1#bm90ZTogYSBwYXR0ZXJu';
  assert.deepEqual(beforeSend({ type: 'pageview', url: shared }), { type: 'pageview', url: 'https://pastree.cc/' });
  assert.equal(beforeSend({ type: 'pageview', url: 'https://pastree.cc/#s=abc' }), null, 'a checkpoint is not another visit');
  assert.equal(beforeSend({ type: 'event', url: shared }).url, 'https://pastree.cc/');
});

test('the guide is marked as the browser build\'s, once', () => {
  const page = '<!doctype html>\n<html lang="en">\n<head></head></html>';
  const marked = markDocsWeb(page);
  assert.match(marked, /<html lang="en" class="web">/);
  assert.equal(markDocsWeb(marked), marked);
  assert.throws(() => markDocsWeb('<p>no html tag</p>'), /<html>/);
});
