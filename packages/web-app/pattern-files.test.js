'use strict';

// Pattern file storage (pattern-files.js), driven against a temp POPTART_PATTERNS_DIR - no
// server, no engine. Two things matter here: a request can only ever name a file inside the
// patterns folder (the WIP id is the only input that names a subdirectory), and the listings
// carry the metadata + label the files tab renders from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-patterns-'));
process.env.POPTART_PATTERNS_DIR = DIR; // read at require time, so set it first

const {
  patternFilePath,
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipFallbackLabel,
  wipOlderThan,
  pruneWipSessions,
} = require('./pattern-files');

function write(rel, code) {
  const file = path.join(DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

test('patternFilePath keeps a name to one segment inside the patterns dir', () => {
  assert.equal(patternFilePath('drift'), path.join(DIR, 'drift.js'));
  assert.equal(patternFilePath('  drift  '), path.join(DIR, 'drift.js'));
  for (const bad of ['', '   ', '.hidden', '../escape', 'sub/drift', 'sub\\drift', 'x'.repeat(129)]) {
    assert.throws(() => patternFilePath(bad), /plain file name/, `expected "${bad}" to be refused`);
  }
});

test('wipFilePath accepts only a month/session id, under wip/', () => {
  assert.equal(
    wipFilePath('2026-08/2026-08-02-143205'),
    path.join(DIR, 'wip', '2026-08', '2026-08-02-143205.js'),
  );
});

test('wipFilePath refuses anything that could name another directory', () => {
  const bad = [
    '',
    '2026-08',                        // no session
    '2026-08/2026-08-02',             // no time
    '2026-08/../../etc/passwd',
    '../2026-08/2026-08-02-143205',
    '2026-08/2026-09-02-143205',      // session's month isn't the folder it claims
    '2026-8/2026-8-2-1432',           // unpadded
    '2026-08/2026-08-02-1432051',     // too many digits
    'wip/2026-08/2026-08-02-143205',
  ];
  for (const id of bad) {
    assert.throws(() => wipFilePath(id), /work-in-progress id/, `expected "${id}" to be refused`);
  }
});

test('listSavedPatterns reads metadata out of each file and labels it', () => {
  write('night-drive.js', '// @title kick drift\n// @by aria @tags techno, generative\nbass: note("c2")');
  write('untitled-two.js', 'lead: n("0 3").scale("F minor")');
  write('notes.txt', 'not a pattern');

  const byName = Object.fromEntries(listSavedPatterns().map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['night-drive', 'untitled-two']);

  assert.equal(byName['night-drive'].label, 'kick drift'); // @title wins
  assert.equal(byName['night-drive'].by, 'aria');
  assert.deepEqual(byName['night-drive'].tags, ['techno', 'generative']);
  assert.equal(byName['night-drive'].kind, 'saved');
  assert.ok(byName['night-drive'].mtime > 0);

  // No @title: it reads as the name it was saved under, NOT as a label guessed from its code
  // ("lead" here) - the user typed that name, so it's the one thing we know they meant.
  assert.equal(byName['untitled-two'].label, 'untitled-two');
});

test('listSavedPatterns includes the code, so a caller can search file contents', () => {
  assert.match(listSavedPatterns().find((p) => p.name === 'night-drive').code, /note\("c2"\)/);
});

test('listWipPatterns groups sessions by month and falls back to a time-of-day label', () => {
  write('wip/2026-07/2026-07-28-221000.js', 'drums: s("bd sd")');
  write('wip/2026-08/2026-08-02-143205.js', '// @title late night\nbass: note("c2")');
  write('wip/notamonth/2026-08-02-143205.js', 'ignored: s("bd")');

  const wip = listWipPatterns();
  assert.deepEqual(wip.map((w) => w.id).sort(), [
    '2026-07/2026-07-28-221000',
    '2026-08/2026-08-02-143205',
  ]);

  const july = wip.find((w) => w.month === '2026-07');
  assert.equal(july.kind, 'wip');
  assert.equal(july.label, 'drums'); // borrowed from the block label

  const august = wip.find((w) => w.month === '2026-08');
  assert.equal(august.label, 'late night');
});

test('a session with nothing to borrow a name from reads as its date and time', () => {
  assert.match(wipFallbackLabel('2026-08-02-143205'), /^Aug 2, 14:32$/);
  assert.equal(wipFallbackLabel('nonsense'), 'nonsense');
});

test('listings are empty, not an error, when nothing has been saved', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-empty-'));
  const saved = process.env.POPTART_PATTERNS_DIR;
  try {
    // The module caches its dirs at require time, so check the no-directory path the same way
    // the routes hit it: a fresh module instance pointed at a directory with nothing in it.
    process.env.POPTART_PATTERNS_DIR = path.join(empty, 'never-created');
    delete require.cache[require.resolve('./pattern-files')];
    const fresh = require('./pattern-files');
    assert.deepEqual(fresh.listSavedPatterns(), []);
    assert.deepEqual(fresh.listWipPatterns(), []);
  } finally {
    process.env.POPTART_PATTERNS_DIR = saved;
    delete require.cache[require.resolve('./pattern-files')];
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// --- session retention ---
// Off by default and only ever as long as the settings tab was told: a session file is the only
// copy of work that was never given a name. What makes it worth offering at all is that each one
// pins the captured plugin states it mentions (see blobs.js).

const DAY = 24 * 60 * 60 * 1000;

// A session file last touched `days` ago.
function aged(id, days, code = 'lead: n("0 2")') {
  write(`wip/${id}.js`, code);
  const when = new Date(Date.now() - days * DAY);
  fs.utimesSync(wipFilePath(id), when, when);
  return id;
}

test('with no policy there is nothing old, whatever is on disk', () => {
  aged('2020-01/2020-01-01-000000', 4000);
  for (const months of [0, null, undefined, -3, 'nonsense']) {
    assert.deepEqual(wipOlderThan(months).ids, [], `months=${months}`);
  }
});

test('a policy names the sessions past it, and only those', () => {
  const old = aged('2024-01/2024-01-01-000000', 400);
  const recent = aged('2026-08/2026-08-18-120000', 1);
  const { ids, bytes } = wipOlderThan(3);
  assert.ok(ids.includes(old));
  assert.ok(!ids.includes(recent), 'yesterday is not three months ago');
  assert.ok(bytes > 0, 'and it says what they weigh, so the dialog can price it');
});

test('pruning deletes exactly those and leaves the rest', () => {
  const old = aged('2023-05/2023-05-05-050505', 500);
  const recent = aged('2026-08/2026-08-19-010101', 0);
  const { deleted } = pruneWipSessions(1);
  assert.ok(deleted >= 1);
  assert.ok(!fs.existsSync(wipFilePath(old)));
  assert.ok(fs.existsSync(wipFilePath(recent)));
});

test('pruning with no policy deletes nothing', () => {
  const old = aged('2022-02/2022-02-02-020202', 900);
  assert.deepEqual(pruneWipSessions(0), { deleted: 0, freed: 0 });
  assert.ok(fs.existsSync(wipFilePath(old)));
});
