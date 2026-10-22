'use strict';

// Replays (replays.js, format in public/replay-log.js): one file per night of by-hand evals, a
// night carried on across restarts, repeats left out, kept ones never expired, and the captured
// states a replay names held out of the sweep however long the night was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-replays-'));
process.env.POPTART_PATTERNS_DIR = DIR; // read at require time, so set it first
process.env.POPTART_BLOB_DIR = path.join(DIR, 'blobs');

const R = require('./public/replay-log.js');
const blobs = require('./blobs.js');
const { createReplayStore } = require('./replays');

const night = new Date(2026, 9, 22, 21, 30, 12).getTime(); // Thu 22 Oct 2026, 21:30:12 local
const min = (m) => night + m * 60000;
let n = 0;
const fresh = () => {
  const dir = path.join(DIR, `r${n++}`);
  return { dir, store: (clock = () => night) => createReplayStore({ dir, now: clock, referencedIds: blobs.referencedIds }) };
};

test('an id is the start stamp under its month, and nothing else passes', () => {
  assert.equal(R.replayIdFor(night), '2026-10/2026-10-22-213012');
  assert.ok(R.replayIdOk('2026-10/2026-10-22-213012'));
  assert.ok(!R.replayIdOk('2026-09/2026-10-22-213012')); // the month has to be the date's
  assert.ok(!R.replayIdOk('../../etc/passwd'));
});

test('by-hand evals land in one night, in order; an update that changes nothing is left out', async () => {
  const { store } = fresh();
  const s = store();
  assert.deepEqual(await s.record({ at: min(0), deck: 'a', code: 'a: s("bd*4")', start: true, name: 'kick' }), { id: '2026-10/2026-10-22-213012', recorded: true });
  assert.equal((await s.record({ at: min(1), deck: 'a', code: 'a: s("bd*4")', start: false })).recorded, false);
  // ...but play pressed again is a moment of its own, same code or not
  assert.equal((await s.record({ at: min(2), deck: 'a', code: 'a: s("bd*4")', start: true })).recorded, true);
  await s.record({ at: min(3), deck: 'b', code: 'b: s("hh*8")', start: true });
  await s.record({ at: min(5), deck: 'a', code: 'a: s("bd*2")', start: false });
  const [row] = await s.list();
  assert.equal(row.count, 4);
  assert.deepEqual(row.decks, ['a', 'b']);
  assert.deepEqual(row.names, ['kick']);
  assert.equal(row.started, min(0));
  assert.equal(row.ended, min(5));
  assert.equal(row.live, true);
  const { entries } = await s.load(row.id);
  assert.deepEqual(entries.map((e) => [e.deck, e.code]), [
    ['a', 'a: s("bd*4")'], ['a', 'a: s("bd*4")'], ['b', 'b: s("hh*8")'], ['a', 'a: s("bd*2")'],
  ]);
});

test('a restart mid-set carries the night on; a long enough break starts the next one', async () => {
  const { store } = fresh();
  await store().record({ at: min(0), deck: 'a', code: 'x', start: true });
  // the app went down and came back twenty minutes later: the same night, and it remembers what
  // deck A already holds, so an update with that code is still a repeat
  const again = store();
  assert.equal((await again.record({ at: min(20), deck: 'a', code: 'x' })).recorded, false);
  const after = await again.record({ at: min(21), deck: 'a', code: 'y' });
  assert.equal(after.id, R.replayIdFor(min(0)));
  // a gap longer than REPLAY_GAP_MS: tomorrow's set is its own replay
  const later = min(21) + R.REPLAY_GAP_MS + 1000;
  const next = await again.record({ at: later, deck: 'a', code: 'y', start: true });
  assert.equal(next.id, R.replayIdFor(later));
  assert.equal((await again.list()).length, 2);
});

test('a line torn by a crash costs that line, not the night', async () => {
  const { store, dir } = fresh();
  const s = store();
  const { id } = await s.record({ at: min(0), deck: 'a', code: 'one', start: true });
  await s.record({ at: min(1), deck: 'a', code: 'two' });
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), '{"at": 123, "deck": "a", "co');
  assert.deepEqual((await store().load(id)).entries.map((e) => e.code), ['one', 'two']);
});

test('the scrubber reads what each deck held at any point', () => {
  const entries = [
    { at: 10, deck: 'a', code: 'a1' },
    { at: 20, deck: 'b', code: 'b1' },
    { at: 30, deck: 'a', code: 'a2' },
  ].map((e) => R.replayEntry(e));
  assert.equal(R.replayIndexAt(entries, 5), -1);
  assert.equal(R.replayIndexAt(entries, 20), 1);
  assert.equal(R.replayIndexAt(entries, 29), 1);
  assert.equal(R.replayIndexAt(entries, 99), 2);
  const held = (i) => Object.fromEntries(Object.entries(R.replayDecksAt(entries, i)).map(([d, e]) => [d, e?.code ?? null]));
  assert.deepEqual(held(0), { a: 'a1', b: null });
  assert.deepEqual(held(1), { a: 'a1', b: 'b1' });
  assert.deepEqual(held(2), { a: 'a2', b: 'b1' });
});

test('replays without a star expire after their days; a starred one and the live one never do', async () => {
  const { store, dir } = fresh();
  const s = store();
  const day = 24 * 3600 * 1000;
  const old = await s.record({ at: min(0) - 40 * day, deck: 'a', code: 'old', start: true });
  const starred = await s.record({ at: min(0) - 39 * day + R.REPLAY_GAP_MS, deck: 'a', code: 'starred', start: true });
  const recent = await s.record({ at: min(0) - 2 * day, deck: 'a', code: 'recent', start: true });
  // file times are what age a replay on disk
  for (const [r, ago] of [[old, 40], [starred, 39], [recent, 2]]) {
    const t = new Date(min(0) - ago * day);
    fs.utimesSync(path.join(dir, `${r.id}.jsonl`), t, t);
  }
  s.setKept(starred.id, true);
  assert.deepEqual(s.olderThan(30, min(0)).ids, [old.id]);
  assert.equal(s.prune(30, min(0)).deleted, 1);
  const left = (await s.list()).map((r) => [r.id, r.kept]);
  assert.deepEqual(left.sort(), [[recent.id, false], [starred.id, true]].sort());
  // and deleting one by hand takes its star with it
  s.remove(starred.id);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'kept.json'), 'utf8')).includes(starred.id));
});

test('a replay holds its captured states out of the sweep, even one too big for the sweep to read', async () => {
  const { store, dir } = fresh();
  const s = store();
  const handle = await blobs.putBlob('a captured device state');
  const id = handle.slice(1); // `@<id>`; in code it is written as the string "@<id>"
  // a night long enough that its file is past the sweep's read limit
  const filler = `// ${'x'.repeat(256 * 1024)}`;
  const { id: rid } = await s.record({ at: min(0), deck: 'a', code: `a: synth("Serum 2").preset("${handle}")`, start: true });
  for (let k = 1; k <= 10; k++) await s.record({ at: min(k), deck: 'a', code: `${filler}\n// ${k}` });
  assert.ok(fs.statSync(path.join(dir, `${rid}.jsonl`)).size > 2 * 1024 * 1024);
  assert.ok(fs.readFileSync(path.join(dir, `${rid}.states`), 'utf8').includes(`"@${id}"`));
  const swept = await blobs.sweepBlobs({ scanDirs: [dir], keepMs: 0 });
  assert.equal(swept.deleted, 0);
  assert.equal(await blobs.getBlob(handle), 'a captured device state');
});

test('only evals made by hand are recorded, on both decks, and looking at a replay never autosaves', () => {
  const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
  assert.match(CLIENT, /if \(byHand\) replayRecord\('a', code, start, currentSavedName\);/);
  assert.match(CLIENT, /if \(byHand\) replayRecord\('b', code, start, deckBFileName\);/);
  assert.equal(CLIENT.match(/replayRecord\(/g).length, 3, 'replayRecord is called from somewhere other than the two evals');
  // the replay's own evals pass no byHand, so they are never recorded into tonight's replay
  assert.match(CLIENT, /const replayEval = \(deck, start\) => \(deck === 'b' \? evalDeckB\(start\) : evaluate\(start\)\);/);
  assert.match(CLIENT, /async function saveWip\(\) \{\n  clearTimeout\(wipTimer\);\n  if \(replayHoldsBuffers\) return;/);
});
