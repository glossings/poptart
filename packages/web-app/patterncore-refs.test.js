'use strict';

// server.js drives pattern-core through one namespace object (`patternCore = await
// import('@poptart/pattern-core')`), so a name that exists in a source module but was never
// re-exported from index.mjs only fails when its code path runs live - complete-mix shipped
// calling patternCore.adoptDefs before index.mjs exported it (2026-08-24), and no test noticed
// because deck-defs.test.mjs imports from src/rolls.mjs directly. This scans the server source
// for every `patternCore.<name>` and demands each one is a real export.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every patternCore.* the server references is a real pattern-core export', async () => {
  const pc = await import('@poptart/pattern-core');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // names mentioned in comments are not calls
  const names = [...new Set([...src.matchAll(/\bpatternCore\??\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(names.length > 5, `the scan should find the server's pattern-core surface (got ${names.length})`);
  const missing = names.filter((n) => !(n in pc));
  assert.deepEqual(missing, [], `server.js calls patternCore.{${missing.join(', ')}} but pattern-core does not export it`);
});
