// The package's public surface, exercised through the barrel the way a page imports it.
//
// Every other test in this package imports the file a thing lives in, which is the right way to
// test behavior and the wrong way to catch a barrel that does not load. A re-export forwards a
// name without binding it locally, so a function here can reference a name the module does not
// have and nothing fails until a browser runs it.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as webEngine from './src/index.mjs';

/** The shortest valid module: the magic number and the version, and no sections at all. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const serving = (bytes = EMPTY_WASM) => async () => ({
  ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => bytes.buffer.slice(),
});

test('every name the barrel promises is actually on it', () => {
  for (const name of ['DEVICES', 'WASM_DEVICES', 'catalog', 'WebAudioEngine', 'PUBLIC_PATHS']) {
    assert.ok(webEngine[name] !== undefined, `${name} is missing from the public surface`);
  }
  assert.equal(typeof webEngine.loadDeviceBinaries, 'function');
  assert.equal(typeof webEngine.loadWorklets, 'function');
});

test('loading the binaries compiles one module per ported device', async () => {
  const asked = [];
  const { modules, problems } = await webEngine.loadDeviceBinaries('devices', async (url) => {
    asked.push(url);
    return serving()();
  });

  assert.deepEqual(problems, []);
  assert.equal(modules.size, webEngine.WASM_DEVICES.length);
  assert.ok(modules.size > 0, 'the catalog ships ported devices, so this should not be vacuous');
  for (const { id, file } of webEngine.WASM_DEVICES) {
    assert.ok(modules.get(id) instanceof WebAssembly.Module, `${id} did not compile`);
    assert.ok(asked.includes(`devices/${file}`), `${id} was not fetched from the devices folder`);
  }
});

test('a binary that will not load costs that one device and is reported', async () => {
  const [first, ...rest] = webEngine.WASM_DEVICES;
  const { modules, problems } = await webEngine.loadDeviceBinaries('devices', async (url) => {
    if (url.endsWith(`/${first.file}`)) return { ok: false, status: 404, statusText: 'Not Found' };
    return serving()();
  });

  assert.equal(modules.has(first.id), false);
  assert.equal(modules.size, rest.length);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`^${first.id} did not load`));
  assert.match(problems[0], /404/);
});

test('the worklets are all loaded before anything is built, from one folder', async () => {
  const added = [];
  await webEngine.loadWorklets({ audioWorklet: { addModule: async (url) => { added.push(url); } } });
  assert.deepEqual(added, webEngine.WORKLET_FILES.map((f) => `${webEngine.PUBLIC_PATHS.worklets}/${f}`));
});
