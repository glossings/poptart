'use strict';

// A pack the host keeps as a list of files where they live (listed-packs.js) - the desktop's
// `files`, dropped audio played from its own place - and one file of any pack picked by name,
// s("files:loop.wav"), the way the browser build picks it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAMPLES = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-listed-'));
process.env.POPTART_SAMPLES_DIR = SAMPLES;

const { OscEngine } = require('./index.js');
const { listPackFiles } = require('./samples.js');
const { setListedPack, listedPackNames } = require('./listed-packs.js');
const { splitPackFileRef, pickPackFile } = require('./pack-file-ref.js');

function put(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
}

const engine = () => new OscEngine({ sclangPath: '/usr/bin/false' });
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-dropped-'));

test('a listed pack plays its files where they live, in list order, skipping what is gone', () => {
  const loop = put(elsewhere, 'loops/loop.wav');
  const kick = put(elsewhere, 'kick.wav');
  let list = [loop, kick, path.join(elsewhere, 'moved.wav'), 'relative.wav'];
  setListedPack('dropped', () => list);
  assert.ok(listedPackNames().includes('dropped'));
  assert.deepStrictEqual(listPackFiles('dropped'), [loop, kick]);
  // Read per lookup: a file added a moment ago is in the next load.
  const snare = put(elsewhere, 'snare.wav');
  list = [...list, snare];
  assert.deepStrictEqual(listPackFiles('dropped'), [loop, kick, snare]);
  setListedPack('dropped', null);
  assert.strictEqual(listPackFiles('dropped'), null);
});

test('a library folder of the same name plays in place of the list', () => {
  const listed = put(elsewhere, 'mine.wav');
  setListedPack('files', () => [listed]);
  assert.deepStrictEqual(listPackFiles('files'), [listed]);
  const own = put(SAMPLES, 'files/theirs.wav');
  assert.deepStrictEqual(listPackFiles('files'), [own]);
  fs.rmSync(path.join(SAMPLES, 'files'), { recursive: true });
  setListedPack('files', null);
});

test('"pack:file" names one file of a pack; the single-file sources keep their colons', () => {
  assert.deepStrictEqual(splitPackFileRef('files:loop.wav'), { pack: 'files', want: 'loop.wav' });
  assert.deepStrictEqual(splitPackFileRef('sp:kit:snare'), { pack: 'sp:kit', want: 'snare' });
  assert.strictEqual(splitPackFileRef('drums'), null);
  assert.strictEqual(splitPackFileRef('rec:take:2'), null);
  assert.strictEqual(splitPackFileRef('say:alex:hello'), null);
  assert.strictEqual(splitPackFileRef('file:a:b.wav'), null);
  const paths = ['/x/Kick.wav', '/x/loop.wav'];
  assert.strictEqual(pickPackFile(paths, 'loop.wav'), '/x/loop.wav');
  assert.strictEqual(pickPackFile(paths, 'kick'), '/x/Kick.wav');
  assert.strictEqual(pickPackFile(paths, '3'), '/x/loop.wav');
  assert.strictEqual(pickPackFile(paths, 'gone'), null);
  assert.strictEqual(pickPackFile(null, 'kick'), null);
});

test('a sampler note can play a file of a pack by its name - a listed pack or a folder', () => {
  const loop = put(elsewhere, 'named/loop.wav');
  setListedPack('files', () => [loop]);
  const e = engine();
  assert.deepStrictEqual(e._resolveSource('files:loop.wav').paths, [loop]);
  assert.deepStrictEqual(e._resolveSource('files:loop').paths, [loop]);
  const b = put(SAMPLES, 'breaks/amen.wav');
  put(SAMPLES, 'breaks/think.wav');
  assert.deepStrictEqual(e._resolveSource('breaks:amen').paths, [b]);
  // A miss is retried, since the file may join the pack after the pattern names it.
  const miss = e._resolveSource('files:later.wav');
  assert.strictEqual(miss.paths, null);
  assert.strictEqual(miss.stable, false);
  // A named pack's file by name too.
  e.defineSamplePacks({ kit: [b] });
  assert.deepStrictEqual(e._resolveSource('sp:kit:amen.wav').paths, [b]);
  setListedPack('files', null);
});

test("a listed pack's change drops its loaded cache and every source named in it", () => {
  const e = engine();
  e._packs.set('files', { status: 'ready', files: [] });
  e._packs.set('files:loop.wav', { status: 'error', stable: false });
  e._packs.set('filesystem', { status: 'ready', files: [] });
  e._warned.add('source:files:loop.wav');
  e.forgetSamplePack('files');
  assert.deepStrictEqual([...e._packs.keys()], ['filesystem']);
  assert.ok(!e._warned.has('source:files:loop.wav'));
});
