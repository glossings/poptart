// The prebake and the ★ library in the page: run as the desktop runs them, into the definitions
// every evaluation starts from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as patternCore from '@poptart/pattern-core';
import { memoryStore } from './public/web/kv.mjs';
import { createStorage } from './public/web/storage.mjs';
import { createBlockEvaluator } from './public/web/block-eval.mjs';
import { createPrebake } from './public/web/prebake.mjs';

const require = createRequire(import.meta.url);
const pinnedDefs = require('./pinned-defs.js');
const meta = require('./public/pattern-meta.js');

function rig() {
  const storage = createStorage(memoryStore(), { meta });
  const prebakeDefs = new Map();
  const lines = [];
  const prebake = createPrebake({ patternCore, storage, prebakeDefs, createBlockEvaluator, pinnedDefs, log: (l) => lines.push(l) });
  return { storage, prebakeDefs, prebake, lines };
}

test('a prebake\'s definitions reach every evaluation, and a broken block stops nothing else', async () => {
  const { storage, prebakeDefs, prebake } = rig();
  await storage.writePrebake('const bassline = n("0 3 5")\n\n$: this is not javascript\n\nconst lead = n("7 5")');
  const errors = await prebake.run();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^prebake\.js/);
  assert.ok(prebakeDefs.has('bassline') && prebakeDefs.has('lead'), 'the blocks either side of the broken one ran');
  // Run again with it gone: the definitions are replaced, not added to.
  await storage.writePrebake('const lead = n("7 5")');
  await prebake.run();
  assert.deepEqual([...prebakeDefs.keys()], ['lead']);
});

test('pinning files a definition under its name, runs it, and unpinning hands its code back', async () => {
  const { prebake } = rig();
  const pinned = await prebake.pin({ kind: 'shape', id: 'swell', code: '_shape("swell", "0,0 1,1")' });
  assert.deepEqual(pinned.errors, []);
  assert.deepEqual(pinned.pinned.map((e) => [e.kind, e.id]), [['shape', 'swell']]);
  assert.ok(patternCore.lookupShape('swell', 'prebake'), 'the shape is a library name from now');
  const again = await prebake.pin({ kind: 'shape', id: 'swell', code: '_shape("swell", "0,1 1,0")' });
  assert.equal(again.pinned.length, 1, 'a second pin replaces the first');
  const out = await prebake.unpin({ kind: 'shape', id: 'swell' });
  assert.match(out.code, /0,1 1,0/);
  assert.deepEqual(out.pinned, []);
});

test('a definition a snippet needs is found in the library, or said not to be there', async () => {
  const { prebake } = rig();
  await prebake.pin({ kind: 'shape', id: 'pluck2', code: '_shape("pluck2", "0,1 1,0")' });
  const [hit, miss] = await prebake.resolveDefs([{ kind: 'shape', id: 'pluck2' }, { kind: 'roll', id: 'nothing' }]);
  assert.match(hit.code, /pluck2/);
  assert.equal(miss.code, null);
  assert.match(miss.why, /no roll definition named "nothing"/);
});
