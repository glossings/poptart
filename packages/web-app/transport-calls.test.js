'use strict';

// Guard against the whole class of "the host calls a Transport method that isn't there" bug.
// server.js drives the shared clock by name and is not importable on its own (requiring it
// starts a server), so nothing else here would notice a call that has no method behind it -
// and where those calls live, a TypeError is thrown inside a callback (a Link report arriving,
// a desk gesture) rather than at a request, which takes the whole process down mid-set.
//
// That is exactly what happened while Link was being split out of a shared branch: the follower
// kept calling transport.shiftCycles after the method had gone back the other way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Transport } = require('@poptart/pattern-core');

const SERVER = path.join(__dirname, 'server.js');

/** Every `transport.foo(` / `transport?.foo(` the server calls, as a sorted set of names. */
function transportCalls(src) {
  const names = new Set();
  for (const m of src.matchAll(/\btransport\??\.([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  return [...names].sort();
}

test('every Transport method server.js calls exists on Transport', () => {
  const called = transportCalls(fs.readFileSync(SERVER, 'utf8'));
  assert.ok(called.length > 5, `expected to find the clock calls, found: ${called.join(', ')}`);
  // An instance, not the prototype: getTime is handed in at construction and assigned per clock.
  const tr = new Transport(() => 0, { cps: 0.5, paused: true });
  const missing = called.filter((name) => typeof tr[name] !== 'function');
  tr.dispose();
  assert.deepEqual(
    missing,
    [],
    `server.js calls Transport method(s) that do not exist: ${missing.join(', ')}. ` +
      'Add them in pattern-core\'s scheduler.mjs, or fix the call site.',
  );
});

test('the scan finds the calls it is meant to find', () => {
  const called = transportCalls('transport.setBpm(1); transport?.stop(); if (transport.paused) x();');
  assert.deepEqual(called, ['setBpm', 'stop']); // a property read is not a call, and is not checked
});
