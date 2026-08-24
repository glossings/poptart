'use strict';

// walkAudioFiles is what the pack panel's search looks through and what adding a folder takes, so
// the order it returns matters as much as the contents: a folder's own files come first, in name
// order, then each subfolder's - adding a tree leaves the indexes you already had at the top.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walkAudioFiles, matchAudioPaths } = require('./samples');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-walk-'));
const touch = (rel) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '');
  return abs;
};

touch('kick.wav');
touch('clap.aiff');
touch('notes.txt');
touch('._hidden.wav');
touch('breaks/amen.wav');
touch('breaks/apache.flac');
touch('breaks/slow/think.wav');
touch('.git/objects/nope.wav');

test('walks the whole tree, own files first, names sorted', async () => {
  const { files, truncated } = await walkAudioFiles(root);
  assert.deepStrictEqual(files, [
    'clap.aiff',
    'kick.wav',
    'breaks/amen.wav',
    'breaks/apache.flac',
    'breaks/slow/think.wav',
  ]);
  assert.strictEqual(truncated, false);
});

test('skips non-audio and hidden entries', async () => {
  const { files } = await walkAudioFiles(root);
  assert.ok(!files.some((f) => f.includes('notes.txt')));
  assert.ok(!files.some((f) => f.includes('hidden')));
  assert.ok(!files.some((f) => f.startsWith('.git/')));
});

test('a depth cut clips that branch only - the folders beside it still come back', async () => {
  touch('deep/a/b/c/buried.wav');
  touch('zzz/last.wav');
  const { files, truncated } = await walkAudioFiles(root, { maxDepth: 2 });
  assert.ok(files.includes('zzz/last.wav'), 'a sibling after the too-deep branch was dropped');
  assert.ok(!files.some((f) => f.includes('buried')), 'went deeper than the cap');
  assert.strictEqual(truncated, true);
  fs.rmSync(path.join(root, 'deep'), { recursive: true });
  fs.rmSync(path.join(root, 'zzz'), { recursive: true });
});

test('depth and file caps report themselves as truncated', async () => {
  const shallow = await walkAudioFiles(root, { maxDepth: 1 });
  assert.deepStrictEqual(shallow.files, ['clap.aiff', 'kick.wav', 'breaks/amen.wav', 'breaks/apache.flac']);
  assert.strictEqual(shallow.truncated, true);

  const capped = await walkAudioFiles(root, { limit: 2 });
  assert.deepStrictEqual(capped.files, ['clap.aiff', 'kick.wav']);
  assert.strictEqual(capped.truncated, true);
});

test('a symlink loop is walked once, not forever', async () => {
  try {
    fs.symlinkSync(root, path.join(root, 'breaks', 'loop'));
  } catch {
    return; // no symlink permission here; the guard is still covered by the cap test above
  }
  const { files } = await walkAudioFiles(root);
  assert.ok(files.length < 50, `expected the loop to be cut short, got ${files.length} files`);
  fs.unlinkSync(path.join(root, 'breaks', 'loop'));
});

test('an unreadable folder is nothing, not a throw', async () => {
  assert.deepStrictEqual(await walkAudioFiles(path.join(root, 'nope')), { files: [], truncated: false });
});

test('a search matches anywhere in the path, every term, either case', async () => {
  const { files } = await walkAudioFiles(root);
  assert.deepStrictEqual(matchAudioPaths(files, 'BREAK'), ['breaks/amen.wav', 'breaks/apache.flac', 'breaks/slow/think.wav']);
  assert.deepStrictEqual(matchAudioPaths(files, 'break slow'), ['breaks/slow/think.wav']);
  assert.deepStrictEqual(matchAudioPaths(files, 'amen 909'), []);
  assert.deepStrictEqual(matchAudioPaths(files, '  '), files); // an empty search filters nothing
});
