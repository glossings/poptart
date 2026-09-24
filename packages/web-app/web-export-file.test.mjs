// The export file, written in parts and read back line by line: an export with audio in it can
// be longer than the longest string a browser makes, so neither side may hold it as one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { exportParts, readExport } from './public/web/export-file.mjs';

const bundle = {
  format: 'poptart-store-1',
  exported: '2026-09-24T00:00:00.000Z',
  files: { 'patterns/a.js': { text: 'a: s("bd")\n\n// two\nlines', mtime: 1 } },
  audio: {
    packs: { wt: { files: [{ file: 'one.wav' }, { file: 'sub/two "q".wav' }] } },
    bytes: { 'wt/one.wav': 'AAAA', 'wt/sub/two "q".wav': 'BBBB\n' },
  },
};

test('the parts are the same JSON the whole object would have been', () => {
  const parts = exportParts(bundle);
  assert.deepEqual(JSON.parse(parts.join('')), bundle);
  assert.equal(parts.length, 1 + 2 + 1, 'the head, one part per audio file, the close');
  assert.ok(parts.slice(1, -1).every((p) => p.length < 40), 'each audio part holds one file and nothing else');
  assert.ok(!parts[0].includes('AAAA'), 'the head carries no audio');
});

test('a file written in parts is read back line by line into the same object', async () => {
  // Chunked oddly on purpose: a stream hands text over wherever it likes.
  const text = exportParts(bundle).join('');
  const file = new Blob([text.slice(0, 7), text.slice(7, 90), text.slice(90)]);
  assert.deepEqual(await readExport(file), bundle);
});

test('an export with no audio, or with an empty audio section, reads back', async () => {
  const plain = { format: 'poptart-store-1', files: {} };
  assert.deepEqual(await readExport(new Blob(exportParts(plain))), plain);
  assert.deepEqual(await readExport(new Blob([JSON.stringify(bundle)])), bundle);
  const empty = { ...bundle, audio: { packs: {}, bytes: {} } };
  assert.deepEqual(await readExport(new Blob(exportParts(empty))), empty);
});

test('a file cut short is refused, not half imported', async () => {
  const text = exportParts(bundle).join('');
  await assert.rejects(readExport(new Blob([text.slice(0, -3)])), SyntaxError);
});
