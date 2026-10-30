// Highlight spans are combined in one place: mini.mjs's joinLocs/withLocs. A span list spread by
// hand elsewhere is a second way to do it, and the way a function ends up lighting nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src');

test('spans are only ever combined by joinLocs and withLocs', () => {
  const handMade = /\.\.\.stepLocs\(|\.\.\.[\w.?]*\blocs\b\s*[\],]/;
  const found = [];
  for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    const helper = file === 'mini.mjs' ? /export function withLocs[\s\S]*?\n}\n/.exec(text)?.[0] ?? '' : '';
    text.replace(helper, '').split('\n').forEach((line, i) => {
      if (!line.trim().startsWith('//') && handMade.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'combine spans with joinLocs()/withLocs() from mini.mjs');
});
