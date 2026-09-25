// The browser's storage: the same things poptart keeps on disk, kept in a key-value store.
//
// The test that matters most here is the last group - the one that runs the browser's blob
// handling and the desktop's over the same inputs and fails if they disagree. The two builds
// share a file format by decision rather than by construction, and a decision that nothing
// checks is a decision that quietly stops being true.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { memoryStore } from './public/web/kv.mjs';
import { createStorage, nativeBpmOf, snapshotId, wipFallbackLabel } from './public/web/storage.mjs';
import { createBlobs, blobId, findBlobs, hasBlobs, referencedIds } from './public/web/blobs.mjs';

const require = createRequire(import.meta.url);
const meta = require('./public/pattern-meta.js');

// The desktop implementation, pointed at a scratch directory so requiring it cannot touch a real
// store. It reads the environment once, at require time, so this has to come first.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-blobs-'));
process.env.POPTART_BLOB_DIR = scratch;
const desktopBlobs = require('./blobs.js');

const fresh = () => {
  const store = memoryStore();
  return { store, storage: createStorage(store, { meta }) };
};

// ---- saved patterns ---------------------------------------------------------------------------

test('a pattern is written, read back, renamed and deleted', async () => {
  const { storage } = fresh();
  await storage.writePattern('kick', 's("bd*4")');
  assert.equal(await storage.readPattern('kick'), 's("bd*4")');
  await storage.renamePattern('kick', 'kick2');
  assert.equal(await storage.readPattern('kick'), null);
  assert.equal(await storage.readPattern('kick2'), 's("bd*4")');
  await storage.deletePattern('kick2');
  assert.equal(await storage.readPattern('kick2'), null);
});

test('a name that would not be one path segment is refused', async () => {
  const { storage } = fresh();
  for (const bad of ['../escape', 'a/b', '.hidden', '', '  ']) {
    await assert.rejects(() => storage.writePattern(bad, 'x'), /pattern name/, `${JSON.stringify(bad)} should be refused`);
  }
});

test('renaming onto a name already taken is refused rather than overwriting it', async () => {
  const { storage } = fresh();
  await storage.writePattern('a', '1');
  await storage.writePattern('b', '2');
  await assert.rejects(() => storage.renamePattern('a', 'b'), /already exists/);
  assert.equal(await storage.readPattern('a'), '1', 'and the original is left where it was');
});

test('a session id has to name the month its date actually falls in', async () => {
  const { storage } = fresh();
  await storage.writeWip('2026-08/2026-08-02-143205', 'x');
  assert.equal(await storage.readWip('2026-08/2026-08-02-143205'), 'x');
  for (const bad of ['2026-08/2026-09-02-143205', '../../etc/passwd', '2026-08', 'nonsense']) {
    await assert.rejects(() => storage.writeWip(bad, 'x'), /work-in-progress id/);
  }
});

test('sessions do not appear among the saved patterns, though they share a prefix', async () => {
  const { storage } = fresh();
  await storage.writePattern('song', 'a');
  await storage.writeWip('2026-08/2026-08-02-143205', 'b');
  const saved = await storage.listPatterns();
  assert.deepEqual(saved.map((e) => e.name), ['song']);
  const wip = await storage.listWip();
  assert.deepEqual(wip.map((e) => e.name), ['2026-08-02-143205']);
  assert.deepEqual(wip.map((e) => e.month), ['2026-08'], 'the month the files tab groups sessions under');
});

// ---- the files tab ------------------------------------------------------------------------------

test('a listing carries what a pattern says about itself and is newest first', async () => {
  const store = memoryStore();
  let clock = 1000;
  const storage = createStorage(store, { meta, now: () => (clock += 1000) });
  await storage.writePattern('first', '// @title Older\nsetbpm(120)\n');
  await storage.writePattern('second', '// @title Newer\n// @by someone\nsetbpm(140)\n');

  const { patterns: rows } = await storage.listAll();
  assert.deepEqual(rows.map((r) => r.name), ['second', 'first']);
  assert.equal(rows[0].title, 'Newer');
  assert.equal(rows[0].by, 'someone');
  assert.equal(rows[0].bpm, 140);
  assert.equal(rows[0].code, undefined, 'a listing must not carry every pattern in full');
});

test('the native tempo is the last plain setbpm, and a patterned one has none', () => {
  assert.equal(nativeBpmOf('setbpm(120)\nsetbpm(140)'), 140);
  assert.equal(nativeBpmOf('setbpm("140")'), 140);
  assert.equal(nativeBpmOf('setbpm("<120 140>")'), null);
  assert.equal(nativeBpmOf('nothing here'), null);
});

test('a session with nothing to call itself is labeled by when it was', () => {
  assert.equal(wipFallbackLabel('2026-08-02-143205'), `${new Date(2026, 7, 2).toLocaleDateString([], { month: 'short', day: 'numeric' })}, 14:32`);
  assert.equal(wipFallbackLabel('nonsense'), 'nonsense');
});

// ---- history --------------------------------------------------------------------------------

test('a snapshot is content addressed, so checkpointing the same buffer twice stores it once', async () => {
  const { store, storage } = fresh();
  const a = await storage.putSnapshot('the same buffer');
  const b = await storage.putSnapshot('the same buffer');
  assert.equal(a, b);
  assert.equal((await store.keys('snapshots/')).length, 1);
  assert.equal(await storage.getSnapshot(a), 'the same buffer');
});

test('an id that is not one is not looked up', async () => {
  const { storage } = fresh();
  assert.equal(await storage.getSnapshot('../../etc/passwd'), null);
  assert.equal(await storage.getSnapshot('nope'), null);
});

test('pruning keeps the newest and drops the oldest, which is the one thing a history must do', async () => {
  const store = memoryStore();
  let clock = 0;
  const storage = createStorage(store, { meta, now: () => (clock += 1000) });
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await storage.putSnapshot(`buffer ${i}`));
  const dropped = await storage.pruneSnapshots(3);
  assert.equal(dropped, 3);
  assert.equal(await storage.getSnapshot(ids[5]), 'buffer 5', 'the newest survives');
  assert.equal(await storage.getSnapshot(ids[0]), null, 'the oldest goes');
});

test('the history is pruned as it grows, without anybody asking', async () => {
  const store = memoryStore();
  let clock = 0;
  const storage = createStorage(store, { meta, now: () => (clock += 1000), maxSnapshots: 3 });
  for (let i = 0; i < 60; i++) await storage.putSnapshot(`buffer ${i}`);
  const kept = (await store.keys('snapshots/')).length;
  assert.ok(kept < 60, 'the history should not grow without bound');
  assert.ok(kept >= 3, `and it should keep at least the cap, it kept ${kept}`);
  assert.equal(await storage.getSnapshot(await storage.putSnapshot('buffer 59')), 'buffer 59', 'the newest is still there');
});

// ---- carrying work out and back in -------------------------------------------------------------

test('an export carries everything, including the state a pattern needs to sound right', async () => {
  const { store, storage } = fresh();
  const blobs = createBlobs(store);
  await storage.writePattern('song', 'synth("x", { state: "@abc123abc123" })');
  await blobs.putBlob(`H4sI${'A'.repeat(80)}`);
  const bundle = await storage.exportAll();
  assert.equal(bundle.format, 'poptart-store-1');
  assert.ok(bundle.files['patterns/song.js']);
  assert.equal(Object.keys(bundle.files).filter((k) => k.startsWith('blobs/')).length, 1);
});

test('an import merges without trampling what is already there, unless it is told to', async () => {
  const { storage } = fresh();
  await storage.writePattern('song', 'mine');
  const bundle = { format: 'poptart-store-1', files: { 'patterns/song.js': { text: 'theirs' } } };
  assert.deepEqual(await storage.importAll(bundle), { written: 0, skipped: 1 });
  assert.equal(await storage.readPattern('song'), 'mine');
  assert.deepEqual(await storage.importAll(bundle, { overwrite: true }), { written: 1, skipped: 0 });
  assert.equal(await storage.readPattern('song'), 'theirs');
});

test('an import cannot write outside the layout, and is refused if it is not an export at all', async () => {
  const { store, storage } = fresh();
  const result = await storage.importAll({
    format: 'poptart-store-1',
    files: { '../../etc/passwd': { text: 'x' }, '/absolute': { text: 'x' } },
  });
  assert.equal(result.written, 0);
  assert.equal((await store.keys('')).length, 0);
  await assert.rejects(() => storage.importAll({ format: 'something-else' }), /not a poptart export/);
});

// ---- the two builds' blob handling has to agree --------------------------------------------------

const STATE = `H4sIAAAAAAAA${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(2)}=`;

test('a content id is the same twelve characters on both sides', async () => {
  assert.equal(await blobId(STATE), desktopBlobs.blobId(STATE));
  assert.equal(await blobId(''), desktopBlobs.blobId(''));
  assert.equal(await blobId('unicode: café 🎛'), desktopBlobs.blobId('unicode: café 🎛'));
});

test('the scan takes a real captured state and leaves everything that only looks like one', () => {
  const code = [
    `synth("a", { state: "${STATE}" })`,
    '// a comment mentioning H4sI in passing',
    '"H4sIshort"',                                     // past the header but far too short
    `fx("b", { state: "${STATE}" })`,
  ].join('\n');
  const found = [...findBlobs(code)];
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => f.state === STATE));
  // The desktop does not export its scanner, so the two are held together through dehydrate
  // below - which is the behavior that actually has to match, rather than its internals.
});

test('dehydrating produces the same code and the same handles on both sides', async () => {
  const code = `synth("a", { state: "${STATE}" })\nfx("b", { state: "${STATE}" })\n`;
  const store = memoryStore();
  const browser = await createBlobs(store).dehydrate(code);
  const desktop = await desktopBlobs.dehydrate(code);
  assert.equal(browser.code, desktop.code, 'the buffer both builds end up with has to be identical');
  assert.equal(browser.stored, desktop.stored);
  assert.ok(browser.code.includes(`"@${await blobId(STATE)}"`));
});

test('hydrating puts the same bytes back', async () => {
  const code = `synth("a", { state: "${STATE}" })\n`;
  const store = memoryStore();
  const blobs = createBlobs(store);
  const { code: light } = await blobs.dehydrate(code);
  const { code: full, missing } = await blobs.hydrate(light);
  assert.equal(full, code);
  assert.deepEqual(missing, []);
});

test('a handle nothing can resolve is left standing rather than dropped', async () => {
  const blobs = createBlobs(memoryStore());
  const { code, missing } = await blobs.hydrate('synth("a", { state: "@abc123abc123" })');
  assert.ok(code.includes('"@abc123abc123"'), 'a handle can be found again; an empty string is a sound that is gone');
  assert.deepEqual(missing, ['abc123abc123']);
});

test('the handle scan agrees with the desktop, in both directions', () => {
  const code = 'a "@0123456789ab" b "@ffffffffffff" c "@nothex______"';
  assert.deepEqual([...referencedIds(code)], [...desktopBlobs.referencedIds(code)]);
  assert.equal(hasBlobs(code), desktopBlobs.hasBlobs(code));
  assert.equal(hasBlobs('nothing here'), desktopBlobs.hasBlobs('nothing here'));
});

test('storing the same state twice is one record and the same handle', async () => {
  const store = memoryStore();
  const blobs = createBlobs(store);
  const first = await blobs.putBlob(STATE);
  const second = await blobs.putBlob(STATE);
  assert.equal(first, second);
  assert.equal((await store.keys('blobs/')).length, 1);
  assert.equal(await blobs.getBlob(first), STATE);
});

test('a handle that is not the shape ids come in never becomes a key', async () => {
  const blobs = createBlobs(memoryStore());
  assert.equal(await blobs.getBlob('@../../etc/passwd'), null);
  assert.equal(await blobs.getBlob('@short'), null);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// --- audio in the export ----------------------------------------------------------------------

test('an export with audio carries the added packs\' files, and an import puts them back beside what is there', async () => {
  const fromStore = memoryStore();
  const from = createStorage(fromStore, { meta });
  const wav = (n) => Uint8Array.from({ length: 64 }, (_, i) => (i * n) % 256).buffer;
  await fromStore.put('samples/files/manifest.json', { files: [{ file: 'kick.wav', bytes: 64 }], mtime: 1 });
  await fromStore.put('samples/files/kick.wav', { bytes: wav(3), mtime: 1 });
  await fromStore.put('samples/rec/manifest.json', { files: [{ file: 'bass.wav', bytes: 64 }], mtime: 1 });
  await fromStore.put('samples/rec/bass.wav', { bytes: wav(5), mtime: 1 });
  await fromStore.put('samples/pt_kit/kick.wav', { bytes: wav(7), mtime: 1 }); // a download: stays out

  assert.equal((await from.exportAll()).audio, undefined, 'text only unless asked');
  const bundle = JSON.parse(JSON.stringify(await from.exportAll({ audio: true })));
  assert.deepEqual(Object.keys(bundle.audio.bytes).sort(), ['files/kick.wav', 'rec/bass.wav']);

  const toStore = memoryStore();
  await toStore.put('samples/files/manifest.json', { files: [{ file: 'snare.wav', bytes: 64 }], mtime: 1 });
  await toStore.put('samples/files/snare.wav', { bytes: wav(9), mtime: 1 });
  const to = createStorage(toStore, { meta });
  const result = await to.importAll(bundle);
  assert.deepEqual(result.audio, { written: 2, skipped: 0 });
  assert.deepEqual((await toStore.get('samples/files/manifest.json')).files.map((f) => f.file), ['snare.wav', 'kick.wav'], 'merged after what was here, so its indexes stand');
  assert.deepEqual(new Uint8Array((await toStore.get('samples/rec/bass.wav')).bytes), new Uint8Array(wav(5)), 'byte for byte');
  // Again: everything is already here, so nothing is written over.
  assert.deepEqual((await to.importAll(bundle)).audio, { written: 0, skipped: 2 });
});

// ---- snippets ---------------------------------------------------------------------------------

test('a snippet is saved as the editor posts it, and listed with its body and what it carries', async () => {
  const snippetFormat = require('./pinned-defs.js');
  const storage = createStorage(memoryStore(), { meta, snippetFormat });
  const posted = {
    name: 'acid',
    title: 'acid bass',
    tags: ['bass', '#303'],
    body: 'bass: pianoroll("acid").synth("Wavetable")',
    defs: [{ code: '_roll("acid", "36,0,2 48,2,2", { grid: 16 })' }],
  };
  await storage.saveSnippet(posted);
  const [row] = await storage.listSnippets();
  assert.equal(row.name, 'acid');
  assert.equal(row.title, 'acid bass');
  assert.deepEqual(row.tags, ['bass', '303']);
  assert.equal(row.body, 'bass: pianoroll("acid").synth("Wavetable")');
  assert.deepEqual(row.carries.map((c) => [c.kind, c.id]), [['roll', 'acid']]);
  assert.equal(row.code, undefined, 'the whole file is for searching, not for the list');
  // The file is the one the desktop's snippets.js writes for the same post.
  assert.equal(await storage.readSnippet('acid'), require('./snippets.js').composeSnippet(posted));
});
