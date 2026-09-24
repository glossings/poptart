// The local server for the browser build.
//
// Two of its jobs are worth testing and the rest is node's http module doing its work: saying
// what a file is, and refusing to serve anything outside the folder it was pointed at. The
// content types matter more than they look - a build with no bundler loads its modules AS
// modules, and a browser refuses a module that does not arrive as JavaScript, so getting `.mjs`
// wrong is a blank page rather than a warning.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contentType, resolveRequest, serve } from './serve-web.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-serve-'));
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>page</title>');
fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'web', 'boot.mjs'), 'export const ok = 1;\n');

test('a module is served as javascript, which is the whole reason this exists', () => {
  assert.match(contentType('web/boot.mjs'), /^text\/javascript/);
  assert.match(contentType('client.js'), /^text\/javascript/);
  assert.match(contentType('style.css'), /^text\/css/);
  assert.match(contentType('packs/pt_kit/manifest.json'), /^application\/json/);
  assert.match(contentType('packs/pt_kit/kick.wav'), /^audio\/wav/);
  assert.equal(contentType('something.unknown'), 'application/octet-stream');
});

test('the root of the site is the page', () => {
  assert.equal(resolveRequest('/', root), path.join(root, 'index.html'));
  assert.equal(resolveRequest('/web/boot.mjs', root), path.join(root, 'web', 'boot.mjs'));
});

test('a query string is not part of the filename', () => {
  assert.equal(resolveRequest('/web/boot.mjs?v=2', root), path.join(root, 'web', 'boot.mjs'));
  assert.equal(resolveRequest('/web/boot.mjs#top', root), path.join(root, 'web', 'boot.mjs'));
});

test('nothing outside the folder is reachable, however the path is spelled', () => {
  // Percent-encoded and plain alike. What is asserted is the property that matters - the answer
  // is always inside the folder - rather than a particular way of saying no: a path that climbs
  // is collapsed back to the root and then simply is not there, which is a 404 and is fine.
  for (const attempt of ['/../package.json', '/%2e%2e/package.json', '/web/../../package.json', '/..%2fpackage.json', '/../../../etc/passwd']) {
    const got = resolveRequest(attempt, root);
    assert.ok(got === null || got.startsWith(root + path.sep), `${attempt} resolved to ${got}, which is outside the folder`);
  }
  assert.equal(resolveRequest('/%ZZ', root), null, 'malformed encoding is refused, not guessed at');
  assert.equal(resolveRequest('/a\0b', root), null);
});

test('a path inside the folder that merely looks suspicious is still served', () => {
  fs.writeFileSync(path.join(root, 'a..b.txt'), 'fine');
  assert.equal(resolveRequest('/a..b.txt', root), path.join(root, 'a..b.txt'));
});

test('it serves the page, a module and a 404, with no caching in the way', async () => {
  const server = await serve({ root, port: 0, log: () => {} });
  const { port } = server.address();
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: await res.text() };
  };

  try {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    // A cached module is an edit that appears not to have happened, which is the worst possible
    // failure for a folder somebody is rebuilding and reloading.
    assert.equal(page.cache, 'no-store');

    const mod = await get('/web/boot.mjs');
    assert.match(mod.type, /^text\/javascript/);
    assert.match(mod.body, /export const ok/);

    assert.equal((await get('/web/missing.mjs')).status, 404);
    // Collapsed back to the root, where there is no such file. Not an escape, just a miss.
    assert.equal((await get('/../package.json')).status, 404);
  } finally {
    // In a finally because a server left listening keeps the process alive: a failed assertion
    // above would otherwise hang the whole suite instead of failing one test in it. fetch keeps
    // its socket for reuse and close() waits for open connections, so those go first.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
