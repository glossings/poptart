'use strict';

// The captured-state store: what a buffer carries in place of megabytes of plugin program, and
// that the round trip out to a file and back is lossless.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-blobs-'));
process.env.POPTART_BLOB_DIR = dir;
const blobs = require('./blobs.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A state as it comes off a plugin: gzip, base64'd, which is what makes "H4sI" a safe marker.
const state = (seed) => `H4sIAAAAAAAAE${'ABCdef012+/'.repeat(20)}${seed}`;

test('a captured state leaves the code and comes back verbatim', async () => {
  const code = `lead: n("0 2").synth("Serum 2", { state: "${state('a')}" })`;
  const { code: light, stored } = await blobs.dehydrate(code);
  assert.equal(stored, 1);
  assert.match(light, /\{ state: "@[0-9a-f]{12}" \}/);
  assert.ok(light.length < 120, `the buffer should be short, got ${light.length}`);
  const { code: full, missing } = await blobs.hydrate(light);
  assert.deepEqual(missing, []);
  assert.equal(full, code);
});

test('the same state in three places is stored once and reads back in all three', async () => {
  const s = state('b');
  const code = `a: x("${s}")\nb: y("${s}")\n// c: z("${s}")`;
  const { code: light, stored } = await blobs.dehydrate(code);
  assert.equal(stored, 1, 'one distinct state');
  assert.equal([...light.matchAll(/"@[0-9a-f]{12}"/g)].length, 3, 'three handles');
  assert.equal((await blobs.hydrate(light)).code, code);
});

test('a commented-out state travels too - it has to work when the comment comes off', async () => {
  const code = `// kick: s("bd").fx("OTT", { state: "${state('c')}" })`;
  const { code: light } = await blobs.dehydrate(code);
  assert.ok(!light.includes('H4sI'));
  assert.equal((await blobs.hydrate(light)).code, code);
});

test('the ids are content-addressed, so the same program is one file', async () => {
  const a = await blobs.putBlob(state('same'));
  const b = await blobs.putBlob(state('same'));
  assert.equal(a, b);
  assert.notEqual(a, await blobs.putBlob(state('other')));
  assert.match(a, /^@[0-9a-f]{12}$/);
});

test('nothing else in a patch looks like a state', async () => {
  const code = [
    'roll: pianoroll("60,0,4 64,4,4 67,8,8", { grid: 16, len: 16 })',
    'swell: lfo("0,0 0.5,1,-3 1,0")',
    'bass: n("0 2 3").s("sawtooth").gain(0.8)',
  ].join('\n');
  const { code: out, stored } = await blobs.dehydrate(code);
  assert.equal(stored, 0);
  assert.equal(out, code);
});

test('dehydrating code that is already handles is a no-op', async () => {
  const { code: light } = await blobs.dehydrate(`x("${state('d')}")`);
  const again = await blobs.dehydrate(light);
  assert.equal(again.stored, 0);
  assert.equal(again.code, light);
});

test('a handle this store has never seen is reported, not dropped', async () => {
  const { code, missing } = await blobs.hydrate('x("@000000000000")');
  assert.deepEqual(missing, ['000000000000']);
  assert.equal(code, 'x("@000000000000")', 'left as it stands, so it can be found again');
});

test('an id that could name a file outside the store is refused', async () => {
  assert.equal(await blobs.getBlob('../../etc/passwd'), null);
  assert.equal(await blobs.getBlob('@zzzzzzzzzzzz'), null);
  assert.equal(await blobs.getBlob(''), null);
});

test('hasBlobs answers the same way twice for the same string', () => {
  const code = `x("${state('e')}")`;
  assert.equal(blobs.hasBlobs(code), true);
  assert.equal(blobs.hasBlobs(code), true, 'a /g regex would have said false here');
  assert.equal(blobs.hasBlobs('n("0 2 3")'), false);
});

test('blobStats reports what the store is holding', async () => {
  await blobs.putBlob(state('stats'));
  const { files, bytes } = blobs.blobStats();
  assert.ok(files > 0);
  assert.ok(bytes > 0);
});

// --- collection ---
// Content addressing stops the same program being stored twice; it does nothing about a knob held
// for a minute, which is a hundred different programs. So the store is collected rather than
// capped: what nothing can still ask for goes, and nothing else does.

const { setTimeout: sleep } = require('node:timers/promises');

// Blobs are only swept once they're past the age floor, so tests that want to see a sweep work
// have to reach back past it.
const age = async (handle, ms) => {
  const file = path.join(dir, `${handle.replace('@', '')}.b64`);
  const when = new Date(Date.now() - ms);
  await fs.promises.utimes(file, when, when);
};

test('a state nothing mentions any more is collected', async () => {
  const handle = await blobs.putBlob(state('sweep-me'));
  await age(handle, 48 * 3600 * 1000);
  const { deleted } = await blobs.sweepBlobs({ scanDirs: [] });
  assert.ok(deleted >= 1);
  assert.equal(await blobs.getBlob(handle), null);
});

test('a state a wip session still mentions is kept, however old it is', async () => {
  const roots = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-roots-'));
  const handle = await blobs.putBlob(state('referenced'));
  await age(handle, 365 * 24 * 3600 * 1000);
  fs.mkdirSync(path.join(roots, '2026-08'), { recursive: true });
  fs.writeFileSync(path.join(roots, '2026-08', 'a.js'), `lead: synth("Serum 2", { state: "${handle}" })`);
  await blobs.sweepBlobs({ scanDirs: [roots] });
  assert.ok(await blobs.getBlob(handle), 'a session that still names it must keep it');
  fs.rmSync(roots, { recursive: true, force: true });
});

test('a state captured moments ago survives - nothing on disk has seen it yet', async () => {
  const handle = await blobs.putBlob(state('just-captured'));
  const { deleted } = await blobs.sweepBlobs({ scanDirs: [] });
  assert.ok(await blobs.getBlob(handle), `the age floor should have kept it (deleted ${deleted})`);
});

test('re-capturing a program the store already has keeps it young', async () => {
  const handle = await blobs.putBlob(state('touched'));
  await age(handle, 48 * 3600 * 1000);
  await sleep(5);
  await blobs.putBlob(state('touched')); // same program, captured again
  await blobs.sweepBlobs({ scanDirs: [] });
  assert.ok(await blobs.getBlob(handle));
});

test('alsoKeep holds a state alive that no file mentions', async () => {
  const handle = await blobs.putBlob(state('in-the-editor'));
  await age(handle, 48 * 3600 * 1000);
  await blobs.sweepBlobs({ scanDirs: [], alsoKeep: [handle.slice(1)] });
  assert.ok(await blobs.getBlob(handle));
});

test('the sweep does not read files too big to be buffers', async () => {
  // A pre-store autosave carries its states in full and mentions no handles - reading every one of
  // them would be gigabytes of IO for nothing.
  const roots = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-big-'));
  fs.writeFileSync(path.join(roots, 'old.js'), `x("${'A'.repeat(3 * 1024 * 1024)}")`);
  const handle = await blobs.putBlob(state('unrelated'));
  await age(handle, 48 * 3600 * 1000);
  const { deleted } = await blobs.sweepBlobs({ scanDirs: [roots] });
  assert.ok(deleted >= 1, 'the big file is skipped, so it holds nothing alive');
  fs.rmSync(roots, { recursive: true, force: true });
});

test('referencedIds finds every handle in a buffer, once each', () => {
  const ids = blobs.referencedIds('a("@aaaaaaaaaaaa") b("@bbbbbbbbbbbb") c("@aaaaaaaaaaaa") d("@nope")');
  assert.deepEqual([...ids].sort(), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
});
