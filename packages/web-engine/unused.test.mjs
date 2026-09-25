// Nothing imported and never used, nothing declared and never read.
//
// The repository carries no linter, and in this package a dead import is worse than untidy: the
// worklet bundler follows import statements, so a name nobody uses still drags its whole module
// into the flattened file a browser downloads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir = here, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `public` holds generated bundles, which repeat every name they were built from.
    if (entry.name === 'node_modules' || entry.name === 'public') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** How many times a name appears as a whole word. One means only its own import or declaration. */
function mentions(source, name) {
  return source.split(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`)).length - 1;
}

test('nothing is imported and then never used', () => {
  const problems = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"];?\s*$/gm)) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (name && mentions(source, name) <= 1) {
          problems.push(`${path.relative(here, file)} imports ${name} and never uses it`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('no module-level constant is declared and never read', () => {
  const problems = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^const ([A-Z][A-Z0-9_]*) =/gm)) {
      if (mentions(source, match[1]) <= 1) {
        problems.push(`${path.relative(here, file)} declares ${match[1]} and never uses it`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the check can actually see a problem, so a clean result means something', () => {
  const source = "import { used, unused } from './x.mjs';\nconst GONE = 1;\nused();\n";
  assert.equal(mentions(source, 'unused'), 1, 'an unused import is mentioned once');
  assert.equal(mentions(source, 'used'), 2, 'a used one is mentioned twice');
  assert.equal(mentions(source, 'GONE'), 1);
});
