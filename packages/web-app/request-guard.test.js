'use strict';

// Unit tests for the request guard (request-guard.js) - the browser-borne attack surface of a
// server whose /api/evaluate runs arbitrary JS: DNS rebinding (foreign Host header) and
// drive-by cross-origin POSTs (foreign Origin header).

const { test } = require('node:test');
const assert = require('node:assert');

const { blockReason, isLoopbackHostname } = require('./request-guard.js');

const ok = (req) => assert.strictEqual(blockReason(req), null, JSON.stringify(req));
const blocked = (req) => assert.match(blockReason(req) ?? '', /refused/, JSON.stringify(req));

test('normal local traffic passes', () => {
  ok({ method: 'GET', hostHeader: 'localhost:4000' });
  ok({ method: 'GET', hostHeader: '127.0.0.1:4000' });
  ok({ method: 'GET', hostHeader: '[::1]:4000' });
  ok({ method: 'GET', hostHeader: 'localhost' }); // no port
  ok({ method: 'GET', hostHeader: 'LOCALHOST:4000' }); // header case is client's choice
  // curl / same-machine scripts: no Origin header at all.
  ok({ method: 'POST', hostHeader: 'localhost:4000' });
});

test('the page itself can POST (loopback Origin)', () => {
  ok({ method: 'POST', hostHeader: 'localhost:4000', originHeader: 'http://localhost:4000' });
  ok({ method: 'POST', hostHeader: '127.0.0.1:4000', originHeader: 'http://127.0.0.1:4000' });
  // Mixed spellings are still the same machine - the guard is loopback-vs-not, not string-equality.
  ok({ method: 'POST', hostHeader: 'localhost:4000', originHeader: 'http://127.0.0.1:4000' });
});

test('DNS rebinding: foreign or missing Host is refused', () => {
  blocked({ method: 'GET', hostHeader: 'evil.example.com' });
  blocked({ method: 'GET', hostHeader: 'evil.example.com:4000' });
  blocked({ method: 'POST', hostHeader: 'evil.example.com:4000' });
  blocked({ method: 'GET', hostHeader: undefined });
  blocked({ method: 'GET', hostHeader: '' });
  // "localhost.evil.com" must not pass a suffix-happy check.
  blocked({ method: 'GET', hostHeader: 'localhost.evil.example.com' });
});

test('drive-by POSTs: foreign or unparseable Origin is refused', () => {
  blocked({ method: 'POST', hostHeader: 'localhost:4000', originHeader: 'https://evil.example.com' });
  // Sandboxed iframes and file:// pages send the literal string "null".
  blocked({ method: 'POST', hostHeader: 'localhost:4000', originHeader: 'null' });
  blocked({ method: 'POST', hostHeader: 'localhost:4000', originHeader: 'not a url' });
});

test('GETs with a foreign Origin are left to CORS (read-only, response unreadable)', () => {
  ok({ method: 'GET', hostHeader: 'localhost:4000', originHeader: 'https://evil.example.com' });
});

test('isLoopbackHostname decides the POPTART_HOST strictness switch', () => {
  assert.strictEqual(isLoopbackHostname('127.0.0.1'), true);
  assert.strictEqual(isLoopbackHostname('localhost'), true);
  assert.strictEqual(isLoopbackHostname('::1'), true);
  assert.strictEqual(isLoopbackHostname('0.0.0.0'), false);
  assert.strictEqual(isLoopbackHostname('192.168.1.20'), false);
});
