'use strict';

// The desktop's `files` pack (dropped-files.js): dropped audio listed by the path where it lives,
// a name already in the pack replaced in place, and the drop routes' lookups in drop order.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDroppedFiles, locateDrops, addDroppedSample } = require('./dropped-files.js');

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-dropped-'));
// The store keeps absolute paths as this platform writes them (D:\\music\\... on Windows).
const abs = (p) => path.resolve(p);

test('an empty or unreadable list is an empty pack', () => {
  const dir = freshDir();
  assert.deepEqual(createDroppedFiles(path.join(dir, 'none.json')).read(), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.deepEqual(createDroppedFiles(path.join(dir, 'bad.json')).read(), []);
});

test('files join the end, and a name already there takes that place', () => {
  const dir = freshDir();
  const store = createDroppedFiles(path.join(dir, 'sub', 'files-pack.json'));
  assert.deepEqual(store.add('/music/a/kick.wav'), { index: 0, name: 'kick.wav', ref: 'files:kick.wav', replaced: false });
  assert.equal(store.add('/music/loop.wav').index, 1);
  const again = store.add('/elsewhere/kick.wav');
  assert.deepEqual(again, { index: 0, name: 'kick.wav', ref: 'files:kick.wav', replaced: true });
  assert.deepEqual(store.read(), [abs('/elsewhere/kick.wav'), abs('/music/loop.wav')]);
  // What is on disk is the list - read back by a fresh store, as a restarted server would.
  assert.deepEqual(createDroppedFiles(store.file).read(), [abs('/elsewhere/kick.wav'), abs('/music/loop.wav')]);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).version, 1);
});

test('drops are looked up in order: a path verified, a file found, a failure null', async () => {
  const seen = [];
  const paths = await locateDrops([
    { path: '/a/song.mp3' },
    { name: 'b.wav', size: 3, sha256: 'x' },
    { name: 'gone.wav', size: 1, sha256: 'y' },
    { name: 'throws.wav' },
  ], {
    verify: async (p) => { seen.push(['verify', p]); return p; },
    find: async (item) => {
      seen.push(['find', item.name]);
      if (item.name === 'throws.wav') throw new Error('locateSample needs the file size');
      return item.name === 'b.wav' ? '/found/b.wav' : null;
    },
  });
  assert.deepEqual(paths, ['/a/song.mp3', '/found/b.wav', null, null]);
  assert.deepEqual(seen.map((s) => s[0]), ['verify', 'find', 'find', 'find']);
  assert.deepEqual(await locateDrops(undefined, {}), []);
});

test('a dropped sample is listed where it was found, and says when a library folder shadows the pack', async () => {
  const dir = freshDir();
  const store = createDroppedFiles(path.join(dir, 'files-pack.json'));
  const deps = { store, find: async () => '/found/loop.wav', verify: async () => null };
  assert.deepEqual(await addDroppedSample({ name: 'loop.wav', size: 3, sha256: 'z' }, deps),
    { ref: 'files:loop.wav', index: 0, name: 'loop.wav', path: abs('/found/loop.wav'), shadowed: false });
  const shadowed = await addDroppedSample({ name: 'loop.wav' }, { ...deps, shadowed: () => true });
  assert.equal(shadowed.shadowed, true);
  await assert.rejects(addDroppedSample({ path: '/nowhere/x.wav' }, deps), /couldn't find where x\.wav lives on disk/);
  assert.deepEqual(store.read(), [abs('/found/loop.wav')]);
});
