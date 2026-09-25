// Packs that load when they are first asked for.
//
// The sourced library is tens of packs, so the page registers them and loads nothing. What has
// to hold is that the first ask for a pack starts it, that asking again while it is on its way
// does not start it again, and that a pack which cannot be fetched is not fetched once per note
// for as long as the pattern plays.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSampleStore, RETRY_FAILED_MS } from './public/web/samples.mjs';

const PACK = { id: 'pt_piano', title: 'Piano', kind: 'melodic', files: [{ file: 'a.wav', rootNote: 60 }, { file: 'b.wav' }] };
const urlFor = (id, file) => `https://cdn.invalid/${id}/${file}`;

function rig({ fail = false } = {}) {
  const asked = [];
  const warnings = [];
  const context = { decodeAudioData: async (bytes) => ({ length: bytes.byteLength }) };
  const fetchImpl = async (url) => {
    asked.push(url);
    if (fail) return { ok: false, status: 404, statusText: 'Not Found' };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  const samples = createSampleStore({ context, fetchImpl, warn: (line) => warnings.push(line) });
  return { samples, asked, warnings };
}

/** Waits for a condition that a chain of awaits somewhere else will make true. */
async function until(check, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

test('a registered pack is not downloaded until something asks for it', async () => {
  const { samples, asked } = rig();
  samples.register([PACK], urlFor);
  assert.deepEqual(asked, [], 'registering is not loading');

  assert.equal(samples.get('pt_piano', 0), null, 'the first ask is answered null and starts the load');
  assert.ok(await until(() => samples.has('pt_piano')));
  assert.deepEqual(asked, [urlFor('pt_piano', 'a.wav'), urlFor('pt_piano', 'b.wav')]);
  assert.equal(samples.get('pt_piano', 0).rootNote, 60, 'the root note rides along');
  assert.ok(samples.get('pt_piano', 1).buffer);
});

test('asking while a pack is on its way does not start it twice', async () => {
  const { samples, asked } = rig();
  samples.register([PACK], urlFor);
  samples.get('pt_piano', 0);
  samples.get('pt_piano', 1);
  samples.get('pt_piano', 0);
  assert.ok(await until(() => samples.has('pt_piano')));
  assert.equal(asked.length, PACK.files.length);
});

test('a pack nobody registered is null, and costs no request', () => {
  const { samples, asked } = rig();
  assert.equal(samples.get('nope', 0), null);
  assert.deepEqual(asked, []);
});

test('a pack whose files cannot be fetched is asked for once, not on every note', async () => {
  const { samples, asked, warnings } = rig({ fail: true });
  samples.register([PACK], urlFor);
  samples.get('pt_piano', 0);
  assert.ok(await until(() => warnings.length >= 1));
  for (let i = 0; i < 5; i++) samples.get('pt_piano', 0);
  await until(() => false, 5);
  assert.equal(asked.length, PACK.files.length, 'the failure is remembered');
  assert.equal(warnings.length, 1, 'one line for the pack, not one per file');
  assert.match(warnings[0], /pt_piano did not load - none of its 2 files loaded - 404/);
  assert.equal(samples.countOf('pt_piano'), 0);
  // Not downloaded: nothing came down, and the sounds tab must not say it did.
  assert.equal(samples.has('pt_piano'), false);
  assert.match(samples.problems().pt_piano, /none of its 2 files/);
});

test('a pack that failed is tried again once the retry wait has passed', async () => {
  const { samples, asked, warnings } = rig({ fail: true });
  samples.register([PACK], urlFor);
  samples.get('pt_piano', 0);
  assert.ok(await until(() => warnings.length >= 1));
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + RETRY_FAILED_MS + 1;
    samples.get('pt_piano', 0);
    assert.ok(await until(() => asked.length === 2 * PACK.files.length), 'the network may be back');
  } finally {
    Date.now = realNow;
  }
});

test('a pack with SOME files missing still loads, and names the ones that did not', async () => {
  const warnings = [];
  const context = { decodeAudioData: async (bytes) => ({ length: bytes.byteLength }) };
  const fetchImpl = async (url) => (url.endsWith('b.wav')
    ? { ok: false, status: 404, statusText: 'Not Found' }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  const samples = createSampleStore({ context, fetchImpl, warn: (line) => warnings.push(line) });
  samples.register([PACK], urlFor);
  samples.get('pt_piano', 0);
  assert.ok(await until(() => samples.has('pt_piano')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pt_piano:1 \(b\.wav\)/);
});

// ---- the files somebody adds from the page ----------------------------------------------------
//
// Two packs kept in this browser: `files` for what was added one at a time, `wt` for a wavetable
// folder read in from the settings tab. The rules that matter are that a name keeps its index
// (every pattern that uses it depends on that), that a device asking for a file whole gets the
// bytes as they arrived rather than decoded audio, and that both survive a reload.

import { memoryStore } from './public/web/kv.mjs';

const bytesOf = (text) => new TextEncoder().encode(text).buffer;

function addedRig(store = memoryStore()) {
  const warnings = [];
  const context = { decodeAudioData: async (bytes) => ({ length: bytes.byteLength }) };
  const samples = createSampleStore({ context, store, fetchImpl: null, warn: (l) => warnings.push(l) });
  return { samples, store, warnings };
}

test('a file added from the page is kept, decoded, and reached by name or by index', async () => {
  const { samples } = addedRig();
  const added = await samples.addFile('kick.wav', bytesOf('one'));
  assert.deepEqual({ ...added }, { ref: 'files:kick.wav', index: 0, name: 'kick.wav' });
  assert.ok(samples.get('files', 0).buffer, 'decoded on the way in, so the next tick can play it');
  assert.equal(samples.indexOf('files', 'kick.wav'), 0);
  assert.equal(samples.indexOf('files', 'kick'), 0, 'the extension is optional');
  assert.equal(samples.indexOf('files', 'KICK.WAV'), 0, 'and the spelling is not case sensitive');
  assert.equal(samples.indexOf('files', '0'), 0);
  assert.equal(samples.indexOf('files', 'nonesuch'), null);
});

test('adding the same name again replaces that file in place, so its index stands', async () => {
  const { samples } = addedRig();
  await samples.addFile('a.wav', bytesOf('one'));
  await samples.addFile('b.wav', bytesOf('two'));
  const again = await samples.addFile('a.wav', bytesOf('a longer one'));
  assert.equal(again.index, 0, 'not appended at the end');
  assert.equal(samples.addedPack('files').files.length, 2);
  assert.equal(samples.get('files', 0).buffer.length, bytesOf('a longer one').byteLength, 'and the new bytes are what plays');
  assert.equal(samples.indexOf('files', 'b.wav'), 1, 'the one after it is where it was');
});

test('the wavetable folder is a pack of its own, so tables and one-shots are separate lists', async () => {
  const { samples } = addedRig();
  await samples.addFile('kick.wav', bytesOf('a hit'));
  await samples.addFile('saw.wav', bytesOf('a table'), 'wt');
  await samples.addFile('square.wav', bytesOf('another'), 'wt');
  assert.deepEqual(samples.addedPack('files').files.map((f) => f.file), ['kick.wav']);
  assert.deepEqual(samples.addedPack('wt').files.map((f) => f.file), ['saw.wav', 'square.wav']);
  assert.equal(samples.indexOf('wt', 'square.wav'), 1);
  assert.deepEqual(samples.addedPacks().map((m) => m.id).sort(), ['files', 'rec', 'wt']);
  await assert.rejects(samples.addFile('x.wav', bytesOf('x'), 'nonesuch'), /no "nonesuch" pack/);
});

test('a device that reads a file whole gets the bytes as they arrived, not decoded audio', async () => {
  const { samples } = addedRig();
  await samples.addFile('table.wav', bytesOf('RIFFmadeup'), 'wt');
  const raw = await samples.bytes('wt', 0);
  assert.equal(new TextDecoder().decode(raw), 'RIFFmadeup', 'a wavetable is cut from its own frames');
  assert.equal(await samples.bytes('wt', 9), null, 'and a file that is not there is null, not a throw');
});

test('what was added is still there after a reload, and forgetting empties it', async () => {
  const store = memoryStore();
  const first = addedRig(store);
  await first.samples.addFile('saw.wav', bytesOf('a table'), 'wt');

  // A fresh page over the same store: the manifests are read back and the names still resolve.
  const second = addedRig(store);
  const packs = await second.samples.loadFiles();
  assert.deepEqual(packs.find((m) => m.id === 'wt').files.map((f) => f.file), ['saw.wav']);
  assert.equal(second.samples.indexOf('wt', 'saw.wav'), 0);
  assert.equal(new TextDecoder().decode(await second.samples.bytes('wt', 0)), 'a table');

  await second.samples.clearPack('wt');
  assert.deepEqual(second.samples.addedPack('wt').files, []);
  const third = addedRig(store);
  await third.samples.loadFiles();
  assert.deepEqual(third.samples.addedPack('wt').files, [], 'and it stays forgotten');
});

test('a sample that will not decode is still kept, and says so', async () => {
  const warnings = [];
  const context = { decodeAudioData: async () => { throw new Error('nope'); } };
  const other = createSampleStore({ context, store: memoryStore(), fetchImpl: null, warn: (l) => warnings.push(l) });
  await other.addFile('broken.wav', bytesOf('not audio'));
  assert.equal(other.indexOf('files', 'broken.wav'), 0, 'it is in the list');
  assert.ok(await other.bytes('files', 0), 'and its bytes are still there');
  assert.ok(warnings.some((w) => w.includes('broken.wav')), 'with a line saying it would not decode');
});

test('a wavetable is never decoded as audio, because nothing plays it as one', async () => {
  // The size this is really about: a wavetable folder is a couple of thousand files, and a
  // decoded copy of each would be the whole library a second time, in memory, for nothing - the
  // synth cuts a table from its own bytes.
  const decodedNames = [];
  const context = { decodeAudioData: async (bytes) => { decodedNames.push(bytes.byteLength); return { length: bytes.byteLength }; } };
  const samples = createSampleStore({ context, store: memoryStore(), fetchImpl: null, warn: () => {} });

  await samples.addFile('saw.wav', bytesOf('a table'), 'wt');
  assert.deepEqual(decodedNames, [], 'nothing was decoded');
  assert.equal(samples.get('wt', 0), null, 'and there is no decoded audio to hand out');
  assert.ok(await samples.bytes('wt', 0), 'the bytes are what a table is read from');

  // A sample still is, since the engine asks for one inside a tick and cannot wait for a decode.
  await samples.addFile('kick.wav', bytesOf('a hit'));
  assert.equal(decodedNames.length, 1);
  assert.ok(samples.get('files', 0).buffer);
});

test('a pack filled in before sizes were recorded is measured once and remembers', async () => {
  // What a library added by an older build looks like: a manifest with names and no sizes. Left
  // as it was, the settings row would report a folder of gigabytes as a kilobyte.
  const store = memoryStore();
  await store.put('samples/wt/saw.wav', { bytes: bytesOf('0123456789'), mtime: 1 });
  await store.put('samples/wt/manifest.json', { files: [{ file: 'saw.wav' }], mtime: 1 });

  const { samples } = addedRig(store);
  await samples.loadFiles();
  const measured = await samples.packSize('wt');
  assert.equal(measured.count, 1);
  assert.equal(measured.bytes, 10, 'read back out of the store');

  // Written into the manifest, so the pass over the store happens once rather than every time.
  const held = await store.get('samples/wt/manifest.json');
  assert.equal(held.files[0].bytes, 10);
  const again = addedRig(store);
  await again.samples.loadFiles();
  assert.equal((await again.samples.packSize('wt')).bytes, 10);
});

test('a pack with a reader of its own is read through it: nothing fetched, nothing kept', async () => {
  const asked = [];
  const kept = [];
  const read = [];
  const context = { decodeAudioData: async (bytes) => ({ length: bytes.byteLength }) };
  const store = { get: async () => null, put: async (k) => { kept.push(k); } };
  const samples = createSampleStore({ context, store, fetchImpl: async (url) => { asked.push(url); return { ok: false }; } });
  const local = { id: 'kicks', files: [{ file: 'Kicks/a.wav' }, { file: 'Kicks/b.wav' }] };
  samples.register([local], null, { read: async (manifest, file) => { read.push(file); return new ArrayBuffer(8); } });
  assert.equal(samples.get('kicks', 0), null);
  assert.ok(await until(() => samples.has('kicks')));
  assert.deepEqual(read, ['Kicks/a.wav', 'Kicks/b.wav']);
  assert.equal(samples.get('kicks', 1).buffer.length, 8);
  assert.equal((await samples.bytes('kicks', 0)).byteLength, 8, 'a device reading the file whole reads it there too');
  assert.deepEqual(asked, []);
  assert.deepEqual(kept, []);
});

test('a pack written as a list plays the files it names, whole packs spread out, the index wrapping', async () => {
  const context = { decodeAudioData: async (bytes) => ({ length: bytes.byteLength }) };
  const sizes = { 'a.wav': 1, 'b.wav': 2, 'c.wav': 3, 'k.wav': 4 };
  const fetchImpl = async (url) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(sizes[url.split('/').pop()]) });
  const samples = createSampleStore({ context, fetchImpl });
  samples.register([{ id: 'drums', files: [{ file: 'a.wav' }, { file: 'b.wav' }, { file: 'c.wav' }] }], urlFor);
  samples.register([{ id: 'kicks', files: [{ file: 'Deep/k.wav' }] }], (id, file) => `https://cdn.invalid/${id}/${file.split('/').pop()}`);
  const defs = { kit: ['kicks/Deep/k.wav', 'drums', 'nowhere/x.wav', 'drums/B'] };
  samples.setPackResolver((id) => defs[id] ?? null);
  assert.deepEqual([0, 1, 2, 3, 4, 5, -1].map((i) => samples.resolveEntry('kit', i)), [
    { pack: 'kicks', index: 0 }, { pack: 'drums', index: 0 }, { pack: 'drums', index: 1 }, { pack: 'drums', index: 2 },
    { pack: 'drums', index: 1 }, { pack: 'kicks', index: 0 }, { pack: 'drums', index: 1 },
  ]);
  assert.equal(samples.get('kit', 0), null, 'the first ask starts the pack it lands in');
  assert.ok(await until(() => samples.get('kit', 0)));
  assert.equal(samples.get('kit', 0).buffer.length, 4);
  assert.equal(samples.fileKey('kit', 0), 'kicks/Deep/k.wav', 'slices are looked up by the file it lands on');
  assert.equal(samples.resolveEntry('drums', 0), null, 'a real pack is itself, never a definition');
});

test('what was downloaded is measured by prefix without reading it back, and can be let go', async () => {
  const { memoryStore } = await import('./public/web/kv.mjs');
  const store = memoryStore();
  const context = { decodeAudioData: async (bytes) => ({ length: bytes.byteLength }) };
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(100) });
  const samples = createSampleStore({ context, store, fetchImpl });
  samples.register([{ id: 'bd', cachePrefix: 'remote/https://raw.invalid/kit/sha/', files: [{ file: 'bd/1.wav' }, { file: 'bd/2.wav' }] }], urlFor);
  samples.register([PACK], urlFor);
  samples.get('bd', 0);
  samples.get('pt_piano', 0);
  assert.ok(await until(() => samples.has('bd') && samples.has('pt_piano')));
  await store.put('remote/listing/github:kit', { at: 0, listing: {} });
  assert.deepEqual(await samples.downloaded('remote/'), { bytes: 200, files: 2 });

  await samples.forgetDownloads('remote/');
  assert.deepEqual(await samples.downloaded('remote/'), { bytes: 0, files: 0 });
  assert.deepEqual(await store.keys('remote/'), [], 'the files and the lists of them');
  assert.equal((await store.keys('samples/pt_piano/')).length, 2, 'the library\'s downloads are another prefix, and stay');
});
