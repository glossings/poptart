// Starting up when things are not there.
//
// The interesting part of boot is not the happy path - that needs a browser - but what happens
// when a piece of it is missing, because on the day this is first deployed ONE OF THEM WILL BE:
// the sourced sample packs are served from a repository that does not exist until somebody
// publishes it, so the very first load takes the failure path below. A page that refused to
// start over a sample library it could not reach would be a page that never started at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateIndex, INDEX_FORMAT } from '../web-engine/src/packs/library.mjs';
import { PATHS, readBuiltInPacks, readLibrary } from './public/web/boot.mjs';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, statusText: 'Not Found' };

test('a sample library that is not there costs the sourced packs and nothing else', async () => {
  const library = await readLibrary(async () => notFound, 'https://nowhere.invalid/packs', validateIndex);
  assert.deepEqual(library.packs, []);
  assert.equal(library.problems.length, 1);
  assert.match(library.problems[0], /did not load/);
});

test('a library behind a network that refuses outright is the same non-event', async () => {
  const library = await readLibrary(async () => { throw new Error('offline'); }, 'https://nowhere.invalid', validateIndex);
  assert.deepEqual(library.packs, []);
  assert.match(library.problems[0], /offline/);
});

test('with no library address at all, there is nothing to report', async () => {
  const library = await readLibrary(async () => ok({}), null, validateIndex);
  assert.deepEqual(library, { packs: [], problems: [] });
});

test('a library that is there is read, and a bad pack in it does not take the rest down', async () => {
  const index = {
    format: INDEX_FORMAT,
    packs: [
      { id: 'pt_good', title: 'Good', files: [{ file: 'a.wav', license: 'CC0-1.0', source: 'https://x.invalid' }] },
      { id: 'pt_bad', title: 'Bad', files: [{ file: 'b.wav', source: 'https://x.invalid' }] },
    ],
  };
  const library = await readLibrary(async () => ok(index), 'https://cdn.invalid/p', validateIndex);
  assert.deepEqual(library.packs.map((p) => p.id), ['pt_good']);
  assert.equal(library.problems.length, 1);
});

test('a built-in pack that will not load is skipped rather than fatal', async () => {
  const manifests = await readBuiltInPacks(async (url) => (
    url.includes('pt_kit') ? ok({ id: 'pt_kit', title: 'Kit', files: [] }) : notFound
  ));
  assert.deepEqual(manifests.map((m) => m.id), ['pt_kit']);
});

test('the paths the page fetches from are all site-absolute', () => {
  // A relative path here would resolve against whatever folder the module happens to sit in,
  // which is not where any of these live.
  for (const [name, value] of Object.entries(PATHS)) {
    assert.ok(value.startsWith('/'), `${name} is ${value}, which is not rooted at the site`);
  }
});
