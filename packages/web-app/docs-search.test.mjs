// The guide's search (public/docs/search.js): the index it makes from the chapters, and what it
// finds in it. Run over the real pages, the way the browser reads them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const S = require('./public/docs/search.js');
const { CHAPTERS } = require('./public/docs/docs.js');

const page = (file) => fs.readFileSync(path.join(here, 'public', 'docs', `${file}.html`), 'utf8');
const indexFor = (web) => S.buildIndex(CHAPTERS, (file) => page(file), { web });

test('every chapter is indexed, a section per heading, each anchor a heading on its page', async () => {
  const sections = await indexFor(true);
  for (const c of CHAPTERS) assert.ok(sections.some((s) => s.file === c.file), `${c.file} has no sections`);
  for (const s of sections) {
    if (!s.anchor) continue;
    assert.ok(page(s.file).includes(`id="${s.anchor}"`), `${s.file}#${s.anchor} is not a heading`);
  }
  const widgets = sections.filter((s) => s.file === 'widgets').map((s) => s.anchor);
  assert.deepEqual(widgets, ['', 'controls', 'cells', 'size', 'displays', 'background', 'colors']);
});

test('a name the guide mentions finds the section about it first', async () => {
  const sections = await indexFor(true);
  const top = (q) => S.search(sections, q)[0];
  assert.deepEqual([top('matrix').file, top('matrix').anchor], ['widgets', 'cells']);
  assert.deepEqual([top('color').file, top('color').anchor], ['widgets', 'colors']);
  assert.equal(top('fmap').file !== undefined, true);
  assert.ok(S.search(sections, 'fmap').some((h) => h.file === 'reference'));
  // Every word has to be there; the order of the words does not matter.
  assert.deepEqual(S.search(sections, 'behind code').map((h) => h.anchor)[0], 'background');
  assert.deepEqual(S.search(sections, 'zzzz nothing'), []);
  assert.deepEqual(S.search(sections, '   '), []);
});

test('a result says where it is and shows the words around the match', async () => {
  const sections = await indexFor(true);
  const hit = S.search(sections, 'width height')[0];
  assert.equal(hit.chapter, 'Controls & displays');
  assert.equal(hit.section, 'Size');
  assert.equal(hit.snippet.match.toLowerCase(), 'width');
  assert.ok(hit.snippet.before.length <= 42 && hit.snippet.after.length <= 92);
  assert.deepEqual(S.snippetOf('one two three', 'two'), { before: 'one ', match: 'two', after: ' three' });
});

test('each build searches only its own passages, and never the code examples', () => {
  const html = '<main><h2 id="a">Alpha</h2><p>shared words</p><p data-build="desktop">desktop <span>only</span> words</p>'
    + '<div data-build="web"><div>web only words</div></div><pre><code>exampleOnly()</code></pre><p>with <code>.scope()</code></p></main>';
  const [web] = S.sectionsOf(html, { file: 'x', chapter: 'X', web: true });
  const [desk] = S.sectionsOf(html, { file: 'x', chapter: 'X', web: false });
  assert.match(web.text, /web only words/);
  assert.doesNotMatch(web.text, /desktop only/);
  assert.match(desk.text, /desktop only words/);
  assert.doesNotMatch(desk.text, /web only/);
  assert.doesNotMatch(web.text, /exampleOnly/);
  assert.deepEqual(web.names, ['scope']);
});

test('a page that cannot be read is left out, not the whole index', async () => {
  const sections = await S.buildIndex(CHAPTERS.slice(0, 3), (file) => (file === 'mini' ? Promise.reject(new Error('offline')) : page(file)));
  assert.ok(sections.length);
  assert.ok(!sections.some((s) => s.file === 'mini'));
});

test('the browser build ships the search', async () => {
  const docsJs = fs.readFileSync(path.join(here, 'public', 'docs', 'docs.js'), 'utf8');
  assert.match(docsJs, /\/docs\/search\.js/);
  // build-web copies public/ whole, the docs folder with it.
  const { build } = await import('./build-web.mjs');
  const out = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'guide-search-'));
  try {
    build({ out, quiet: true });
    assert.ok(fs.existsSync(path.join(out, 'docs', 'search.js')));
    assert.ok(fs.existsSync(path.join(out, 'docs', 'widgets.html')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
