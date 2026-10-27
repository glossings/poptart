// The sample library in the browser build: a folder on this computer, read as packs where it lives.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalFolder, filesFromList, folderManifests, walkDirectory, FOLDER_KEY } from './public/web/local-folder.mjs';
import * as patternCore from '@poptart/pattern-core';
import { createSampleStore, registerPacks, registerShortNames, shortNamePacks, unregisterPacks } from './public/web/samples.mjs';
import { createRequire } from 'node:module';

const shippedKit = createRequire(import.meta.url)('../web-engine/public/packs/pt_kit/manifest.json');

/** A stand-in for a FileSystemDirectoryHandle over { name: contents | {subfolder} }. */
function dirHandle(name, tree, { permission = 'granted' } = {}) {
  const asks = [];
  const make = (n, t) => ({
    kind: 'directory',
    name: n,
    async *entries() {
      for (const [k, v] of Object.entries(t)) {
        yield [k, typeof v === 'object' ? make(k, v) : {
          kind: 'file',
          name: k,
          getFile: async () => ({ arrayBuffer: async () => new TextEncoder().encode(v).buffer }),
        }];
      }
    },
  });
  const root = make(name, tree);
  root.queryPermission = async () => permission;
  root.requestPermission = async () => { asks.push('request'); permission = 'granted'; return permission; };
  root.asks = asks;
  return root;
}

/** A store that keeps values as they are, as IndexedDB keeps a handle (structured clone). */
function handleStore() {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
  };
}

function fakeSamples() {
  const registered = new Map();
  const forgotten = [];
  return {
    registered,
    forgotten,
    register: (list, urlFor, opts) => { for (const m of list) registered.set(m.id, { manifest: m, urlFor, read: opts?.read }); },
    forget: (id) => { forgotten.push(id); registered.delete(id); },
  };
}

const LIBRARY = {
  '808': { Kicks: { 'kick 10.wav': 'k10', 'kick 2.wav': 'k2' }, Snares: { 'sd.wav': 'sd' } },
  '909': { Kicks: { 'k.wav': '909k' } },
  'pt_kit': { 'x.wav': 'x' },
  '.git': { 'HEAD.wav': 'no' },
  'notes.txt': 'not audio',
  'loose.aif': 'loose',
};

test('a folder is walked for audio, hidden folders left out', async () => {
  const { files, truncated } = await walkDirectory(dirHandle('Samples', LIBRARY));
  assert.deepEqual([...files.keys()].sort(), ['808/Kicks/kick 10.wav', '808/Kicks/kick 2.wav', '808/Snares/sd.wav', '909/Kicks/k.wav', 'loose.aif', 'pt_kit/x.wav']);
  assert.equal(truncated, false);
  const capped = await walkDirectory(dirHandle('Samples', LIBRARY), { limit: 2 });
  assert.equal(capped.files.size, 2);
  assert.equal(capped.truncated, true);
});

test('packs are named by folder, as samples() names a repository\'s, and a folder with one of poptart\'s own names keeps it', () => {
  const manifests = folderManifests(['808/Kicks/kick 10.wav', '808/Kicks/kick 2.wav', '909/Kicks/k.wav', 'Snares/sd.wav', 'pt_kit/x.wav', 'bd/k.wav', 'files/f.wav', 'loose.aif'], { folder: 'My Samples' });
  assert.deepEqual(manifests.map((m) => m.id), ['808_kicks', '909_kicks', 'bd', 'files', 'my_samples', 'pt_kit', 'snares']);
  const kicks = manifests.find((m) => m.id === '808_kicks');
  assert.deepEqual(kicks.files.map((f) => f.file), ['808/Kicks/kick 2.wav', '808/Kicks/kick 10.wav'], 'in natural order');
  assert.equal(kicks.files[0].name, 'kick 2');
});

test('the ordinary folder chooser\'s files make the same packs, the folder\'s own name taken off', () => {
  const list = [
    { name: 'a.wav', webkitRelativePath: 'Drums/bd/a.wav' },
    { name: 'b.txt', webkitRelativePath: 'Drums/bd/b.txt' },
    { name: 'c.wav', webkitRelativePath: 'Drums/.hidden/c.wav' },
  ];
  const { files, name } = filesFromList(list);
  assert.equal(name, 'Drums');
  assert.deepEqual([...files.keys()], ['bd/a.wav']);
});

test('a chosen folder is kept, registered with a reader, and read where it lives', async () => {
  const store = handleStore();
  const samples = fakeSamples();
  const said = [];
  const filed = [];
  const folder = createLocalFolder({ store, samples, onPacks: (m) => filed.push(...m.map((x) => x.id)), say: (l) => said.push(l) });
  const handle = dirHandle('Samples', LIBRARY);
  await folder.choose(handle);
  assert.equal(store.map.get(FOLDER_KEY).handle, handle, 'the handle is kept for the next visit');
  assert.deepEqual(folder.status(), { state: 'ready', name: 'Samples', packs: 5, files: 6, truncated: false, bytes: 0, progress: null });
  assert.deepEqual(filed.sort(), ['808_kicks', '909_kicks', 'pt_kit', 'samples', 'snares']);
  const kicks = samples.registered.get('808_kicks');
  assert.equal(kicks.urlFor, null, 'nothing to fetch');
  const bytes = await kicks.read(kicks.manifest, '808/Kicks/kick 2.wav');
  assert.equal(new TextDecoder().decode(bytes), 'k2');
  assert.deepEqual(folder.packs().map((p) => p.manifest.id).sort(), filed);
  assert.ok(said.some((l) => /Samples - 5 packs, 6 files/.test(l)));
});

test('a folder kept from an earlier visit is read again when the browser allows it, and waits for a click when it does not', async () => {
  const store = handleStore();
  const allowed = dirHandle('Samples', LIBRARY);
  await store.put(FOLDER_KEY, { handle: allowed, name: 'Samples' });
  const a = createLocalFolder({ store, samples: fakeSamples() });
  await a.restore();
  assert.equal(a.status().state, 'ready');

  const asking = dirHandle('Samples', LIBRARY, { permission: 'prompt' });
  await store.put(FOLDER_KEY, { handle: asking, name: 'Samples' });
  const b = createLocalFolder({ store, samples: fakeSamples() });
  await b.restore();
  assert.equal(b.status().state, 'prompt');
  assert.deepEqual(b.packs(), [], 'nothing read without permission');
  assert.deepEqual(asking.asks, [], 'and not asked for without a click');
  assert.equal(await b.reconnect(), true);
  assert.equal(b.status().state, 'ready');
  assert.equal(b.packs().length, 5);
});

test('files from the ordinary chooser are for this visit only, and forgetting lets every pack go', async () => {
  const store = handleStore();
  const samples = fakeSamples();
  const folder = createLocalFolder({ store, samples });
  await folder.choose(dirHandle('Samples', LIBRARY));
  await folder.choose([{ name: 'a.wav', webkitRelativePath: 'Drums/bd/a.wav', arrayBuffer: async () => new ArrayBuffer(4) }]);
  assert.equal(folder.status().state, 'session');
  assert.equal(store.map.has(FOLDER_KEY), false, 'no handle to keep');
  assert.ok(samples.forgotten.includes('808_kicks'), 'the last folder\'s packs let go');
  assert.equal((await samples.registered.get('bd').read(null, 'bd/a.wav')).byteLength, 4);
  await folder.forget();
  assert.equal(folder.status().state, 'none');
  assert.deepEqual(folder.packs(), []);
  assert.ok(samples.forgotten.includes('bd'));
});

const chooserFiles = () => [
  { name: 'a.wav', size: 3, webkitRelativePath: 'Drums/bd/a.wav', arrayBuffer: async () => new TextEncoder().encode('bda').buffer },
  { name: 'b.wav', size: 5, webkitRelativePath: 'Drums/sd/b.wav', arrayBuffer: async () => new TextEncoder().encode('sdbbb').buffer },
];

test('a folder from the ordinary chooser can be kept as a copy, and is there on the next visit', async () => {
  const store = handleStore();
  const folder = createLocalFolder({ store, samples: fakeSamples() });
  await folder.choose(chooserFiles());
  assert.equal(folder.status().bytes, 8, 'the size is said before anything is copied');
  assert.equal(await folder.keepCopy(), true);
  assert.equal(folder.status().state, 'copied');

  const samples = fakeSamples();
  const next = createLocalFolder({ store, samples });
  await next.restore();
  assert.equal(next.status().state, 'copied');
  assert.equal(next.status().name, 'Drums');
  const sd = samples.registered.get('sd');
  assert.equal(new TextDecoder().decode(await sd.read(sd.manifest, 'sd/b.wav')), 'sdbbb');

  await next.forget();
  assert.deepEqual([...store.map.keys()], [], 'forgetting deletes the copy');
});

test('a copy the browser runs out of room for is taken back out, and the folder stays for the visit', async () => {
  const store = handleStore();
  let room = 1;
  const put = store.put;
  store.put = async (k, v) => { if (k.startsWith('samples/') && room-- <= 0) throw new Error('quota'); return put(k, v); };
  const folder = createLocalFolder({ store, samples: fakeSamples() });
  await folder.choose(chooserFiles());
  await assert.rejects(() => folder.keepCopy(), /after 1 of 2/);
  assert.equal(folder.status().state, 'session');
  assert.deepEqual([...store.map.keys()], [], 'nothing half-kept');
});

test('choosing another folder replaces a kept copy', async () => {
  const store = handleStore();
  const folder = createLocalFolder({ store, samples: fakeSamples() });
  await folder.choose(chooserFiles());
  await folder.keepCopy();
  await folder.choose(dirHandle('Samples', LIBRARY));
  assert.deepEqual([...store.map.keys()], [FOLDER_KEY], 'only the new folder\'s handle');
});

// A context whose "decoded audio" says which bytes it was decoded from.
const tagContext = { decodeAudioData: async (bytes) => ({ duration: 1, tag: new TextDecoder().decode(bytes) }) };
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a library folder named pt_kit, bd or files plays in place of the page\'s own, and they come back when it goes', async () => {
  const warnings = [];
  const shippedBytes = (id, file) => new TextEncoder().encode(`shipped ${id}/${file}`).buffer;
  const samples = createSampleStore({
    context: tagContext,
    fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => shippedBytes(...url.split('/').slice(-2)) }),
    warn: (line) => warnings.push(line),
  });
  const builtInUrl = (id, file) => `/web-engine/packs/${id}/${file}`;
  patternCore.clearRolls('prebake');
  const shorts = shortNamePacks([shippedKit]);
  registerPacks(patternCore, [shippedKit], { ships: true });
  registerShortNames(patternCore, shorts);
  samples.setPackResolver((id) => patternCore.lookupPack(id)?.files ?? null);
  samples.register([shippedKit], builtInUrl, { ships: true });
  await samples.ensure(shippedKit, builtInUrl);
  await samples.addFile('dropped.wav', new TextEncoder().encode('dropped'), 'files');
  try {
    assert.equal(samples.get('pt_kit', 0).buffer.tag, 'shipped pt_kit/kick.wav');
    assert.equal(samples.get('bd', 0).buffer.tag, 'shipped pt_kit/kick.wav');
    assert.equal(samples.get('files', 0).buffer.tag, 'dropped');

    const folder = createLocalFolder({
      samples,
      onPacks: (m) => registerPacks(patternCore, m),
      onForget: (ids) => unregisterPacks(patternCore, ids),
    });
    await folder.choose(dirHandle('Samples', { pt_kit: { 'a.wav': 'my kit' }, bd: { 'k.wav': 'my kick' }, files: { 'f.wav': 'my file' } }));
    assert.deepEqual(folder.packs().map((p) => p.manifest.id).sort(), ['bd', 'files', 'pt_kit'], 'the names are kept');

    // The first ask starts the folder's pack loading, as for any pack that loads on demand.
    for (const id of ['pt_kit', 'bd', 'files']) samples.get(id, 0);
    await settle();
    assert.equal(samples.get('pt_kit', 0).buffer.tag, 'my kit');
    assert.equal(samples.get('bd', 0).buffer.tag, 'my kick');
    assert.equal(samples.get('files', 0).buffer.tag, 'my file');
    assert.equal(samples.get('sd', 0), null, 'sd is pt_kit:1, and pt_kit is the folder\'s now - which has one file');
    assert.equal(samples.ownHidden('files'), true);
    assert.equal(warnings.filter((w) => w.includes('"files"')).length, 1, 'the console says once that the page\'s own pack is hidden');
    assert.equal(samples.named('rec', 'x'), null);

    // Dropping a file while the folder has the name keeps it for when the folder goes.
    await samples.addFile('second.wav', new TextEncoder().encode('second'), 'files');
    assert.equal(samples.get('files', 0).buffer.tag, 'my file');

    await folder.forget();
    for (const id of ['pt_kit', 'bd']) samples.get(id, 0);
    await settle();
    assert.equal(samples.get('pt_kit', 0).buffer.tag, 'shipped pt_kit/kick.wav');
    assert.equal(samples.get('bd', 0).buffer.tag, 'shipped pt_kit/kick.wav');
    assert.deepEqual(patternCore.lookupPack('bd')?.files, ['pt_kit/kick.wav']);
    assert.equal(samples.get('files', 0).buffer.tag, 'dropped');
    assert.equal(samples.get('files', 1).buffer.tag, 'second');
  } finally {
    registerShortNames(patternCore, []);
    patternCore.clearRolls('prebake');
  }
});
