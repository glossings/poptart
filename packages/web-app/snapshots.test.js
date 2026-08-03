'use strict';

// Snapshot store (snapshots.js), driven against a temp POPTART_SNAPSHOT_DIR - no server, no
// engine. What matters here: an id off a URL hash can never name a file outside the store,
// identical buffers dedupe to one snapshot, and pruning keeps the states you most recently
// used rather than the ones that happen to sort first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-snapshots-'));
process.env.POPTART_SNAPSHOT_DIR = DIR; // read at require time, so set it first

const { snapshotId, snapshotPath, putSnapshot, getSnapshot, pruneSnapshots } = require('./snapshots');

test('an id is a stable function of the code', () => {
  const code = 'a: n("0 3").synth("Serum 2")';
  assert.equal(snapshotId(code), snapshotId(code));
  assert.notEqual(snapshotId(code), snapshotId(`${code} `));
  assert.match(snapshotId(code), /^[0-9a-f]{12}$/);
});

test('only a well-formed id can name a file, and it stays in the store', () => {
  const id = snapshotId('x');
  assert.equal(path.dirname(snapshotPath(id)), DIR);
  for (const bad of ['../../etc/passwd', 'abc', '', null, undefined, 'ABCDEF012345', 'abcdef01234/', '../abcdef01234']) {
    assert.throws(() => snapshotPath(bad), /not a snapshot id/);
  }
});

test('a stored buffer comes back verbatim', async () => {
  const code = 'lead: n("0 3 5").synth("Serum 2", { state: "AAAA+/==" })\n// ünïcödé ✨\n';
  const id = await putSnapshot(code);
  assert.equal(await getSnapshot(id), code);
});

test('an unknown id reads as null rather than throwing', async () => {
  assert.equal(await getSnapshot('000000000000'), null);
  assert.equal(await getSnapshot('nonsense'), null);
});

test('re-storing an unchanged buffer reuses its snapshot', async () => {
  const code = `dedupe ${Date.now()}`;
  const a = await putSnapshot(code);
  const before = fs.readdirSync(DIR).length;
  const b = await putSnapshot(code);
  assert.equal(a, b);
  assert.equal(fs.readdirSync(DIR).length, before);
});

test('pruning keeps the most recently used, not the oldest-written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-prune-'));
  process.env.POPTART_SNAPSHOT_DIR = dir;
  delete require.cache[require.resolve('./snapshots')];
  const snaps = require('./snapshots');

  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await snaps.putSnapshot(`patch ${i}`));
  // Age them explicitly: written oldest-first, but the FIRST one is the one just re-used.
  ids.forEach((id, i) => {
    const t = new Date(Date.now() - (ids.length - i) * 60000);
    fs.utimesSync(path.join(dir, `${id}.js`), t, t);
  });
  await snaps.putSnapshot('patch 0'); // touches it back to now

  assert.equal(await snaps.pruneSnapshots(3), 2);
  const left = fs.readdirSync(dir).map((f) => path.basename(f, '.js'));
  assert.equal(left.length, 3);
  assert.ok(left.includes(ids[0]), 'the re-used snapshot survives');
  assert.ok(left.includes(ids[4]) && left.includes(ids[3]), 'the newest survive');

  delete require.cache[require.resolve('./snapshots')];
  process.env.POPTART_SNAPSHOT_DIR = DIR;
});

test('pruning a store under the limit does nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-prune2-'));
  process.env.POPTART_SNAPSHOT_DIR = dir;
  delete require.cache[require.resolve('./snapshots')];
  const snaps = require('./snapshots');

  await snaps.putSnapshot('one');
  assert.equal(await snaps.pruneSnapshots(500), 0);
  assert.equal(await snaps.pruneSnapshots(1), 0);
  assert.equal(fs.readdirSync(dir).length, 1);

  delete require.cache[require.resolve('./snapshots')];
  process.env.POPTART_SNAPSHOT_DIR = DIR;
});
