'use strict';

// Unit tests for sample-locate.js - finding a dropped file on the disk by its name, size and
// bytes: exact names only, verified by hash, the library's own copy preferred, the fallback walk
// where Spotlight has nothing, and an honest null when the file is nowhere.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { locateDroppedFile, verifyDroppedPath, rankPaths, searchRoots } = require('./sample-locate.js');
const { isAudioName, walkAudioFiles } = require('@poptart/osc-engine/samples');

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-locate-'));
const put = (dir, rel, text) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const dropped = (text, name = 'kick.wav') => ({ name, size: Buffer.byteLength(text), sha256: sha(text) });

test('a Spotlight hit is taken only when the size and bytes match', async () => {
  const dir = freshDir();
  const right = put(dir, 'a/kick.wav', 'RIFF-right');
  const wrong = put(dir, 'b/kick.wav', 'RIFF-wrong'); // same name and size, other bytes
  const shorter = put(dir, 'c/kick.wav', 'RIFF'); // same name, other size
  const findByName = async (name) => { assert.strictEqual(name, 'kick.wav'); return [shorter, wrong, right]; };
  const found = await locateDroppedFile({ ...dropped('RIFF-right'), isAudioName, findByName });
  assert.strictEqual(found, right);
});

test('the copy inside the sample library wins over the same file elsewhere', async () => {
  const dir = freshDir();
  const lib = put(dir, 'library/drums/kick.wav', 'RIFF-x');
  const dl = put(dir, 'dl/kick.wav', 'RIFF-x');
  const findByName = async () => [dl, lib];
  const found = await locateDroppedFile({ ...dropped('RIFF-x'), samplesRoot: path.join(dir, 'library'), isAudioName, findByName });
  assert.strictEqual(found, lib);
  // Without a library claim the shorter path is the original, not a cache's deeper copy.
  assert.deepStrictEqual(rankPaths([lib, dl], null), [dl, lib]);
});

test('with nothing from Spotlight, the search roots are walked for the name', async () => {
  const dir = freshDir();
  const home = path.join(dir, 'home');
  const splice = put(home, 'Splice/sounds/packs/x/snare.wav', 'RIFF-s');
  put(home, 'Downloads/snare.wav', 'RIFF-other');
  const found = await locateDroppedFile({
    ...dropped('RIFF-s', 'snare.wav'), samplesRoot: path.join(dir, 'nolib'), home, isAudioName,
    findByName: async () => [], walk: walkAudioFiles,
  });
  assert.strictEqual(found, splice);
  // A hint folder (where the pack panel was browsing) is walked before the home folders.
  const hinted = put(dir, 'elsewhere/deep/snare.wav', 'RIFF-h');
  const viaHint = await locateDroppedFile({
    ...dropped('RIFF-h', 'snare.wav'), hints: [path.join(dir, 'elsewhere')], home, isAudioName,
    findByName: async () => [], walk: walkAudioFiles,
  });
  assert.strictEqual(viaHint, hinted);
});

test('a file that is nowhere on the disk is null, never a guess', async () => {
  const dir = freshDir();
  const home = path.join(dir, 'home');
  put(home, 'Downloads/kick.wav', 'RIFF-other');
  const found = await locateDroppedFile({
    ...dropped('RIFF-gone'), home, isAudioName, findByName: async () => [path.join(home, 'Downloads/kick.wav')], walk: walkAudioFiles,
  });
  assert.strictEqual(found, null);
});

test('the name is a basename; only audio the sampler plays is looked for; the request is checked', async () => {
  const dir = freshDir();
  const right = put(dir, 'kick.wav', 'RIFF-r');
  let asked = null;
  const findByName = async (name) => { asked = name; return [right]; };
  const found = await locateDroppedFile({ ...dropped('RIFF-r', '../../kick.wav'), isAudioName, findByName });
  assert.strictEqual(found, right);
  assert.strictEqual(asked, 'kick.wav');
  await assert.rejects(locateDroppedFile({ ...dropped('x', 'loop.ogg'), isAudioName, findByName }), /not a sample/);
  await assert.rejects(locateDroppedFile({ ...dropped('x', '..'), isAudioName, findByName }), /usable name/);
  await assert.rejects(locateDroppedFile({ name: 'kick.wav', size: 0, sha256: sha('x'), isAudioName, findByName }), /file size/);
  await assert.rejects(locateDroppedFile({ name: 'kick.wav', size: 3, sha256: 'nope', isAudioName, findByName }), /file hash/);
});

test('search roots: only folders that exist, each once, library and hints first', () => {
  const dir = freshDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const roots = searchRoots({ samplesRoot: path.join(dir, 'lib'), hints: [path.join(dir, 'lib'), path.join(dir, 'missing')], home });
  assert.deepStrictEqual(roots, [path.join(dir, 'lib'), path.join(home, 'Downloads')]);
});

test('a dropped path is taken as it is when it names an audio file that exists', async () => {
  const dir = freshDir();
  const kick = put(dir, 'packs/x/kick.wav', 'RIFF');
  assert.strictEqual(await verifyDroppedPath(kick, { isAudioName }), kick);
  assert.strictEqual(await verifyDroppedPath(path.join(dir, 'packs/x/gone.wav'), { isAudioName }), null);
  fs.mkdirSync(path.join(dir, 'folder.wav')); // a folder is not a file, whatever it is called
  assert.strictEqual(await verifyDroppedPath(path.join(dir, 'folder.wav'), { isAudioName }), null);
  await assert.rejects(verifyDroppedPath('packs/x/kick.wav', { isAudioName }), /absolute/);
  await assert.rejects(verifyDroppedPath(path.join(dir, 'packs/x/notes.txt'), { isAudioName }), /not a sample/);
});
