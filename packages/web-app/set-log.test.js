'use strict';

// DJ set tracklists (set-log.js): one Markdown file per set, grouped by month like the WIP
// sessions, renamed with the set's length when it ends, and expired with the same retention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-sets-'));
process.env.POPTART_PATTERNS_DIR = DIR; // read at require time, so set it first

const { formatSetLog, writeSetLog, setFileName, pruneSetLogs, SETS_DIR, elapsedOf, lengthOf } = require('./set-log');

const start = new Date(2026, 9, 6, 21, 30, 5); // Tue 6 Oct 2026, 21:30:05 local
const at = (min, sec = 0) => start.getTime() + (min * 60 + sec) * 1000;
const set = () => ({
  started: start,
  file: null,
  entries: [
    { at: at(4, 12), deck: 'b', kind: 'livecode', title: 'techno/stomper', subtitle: 'Stomper', bpm: 128, key: 'F minor' },
    { at: at(0), deck: 'a', kind: 'song', title: 'Dauwd – Kolido', bpm: 124, key: '8A' },
    { at: at(72, 30), deck: 'a', kind: 'song', title: 'A | B', bpm: 132.95, key: null },
  ],
});

test('the tracklist reads in order, with elapsed and clock times, and says what each track is', () => {
  const md = formatSetLog(set(), new Date(at(78)));
  const lines = md.split('\n');
  assert.equal(lines[0], '# DJ set · Tue 6 Oct 2026 · 21:30–22:48 (1h 18m)');
  const rows = lines.filter((l) => /^\| \d/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| 0:00 \| 21:30 \| A \| Dauwd – Kolido \| song \| 124 \| 8A \|$/);
  assert.match(rows[1], /^\| 4:12 \| 21:34 \| B \| techno\/stomper — Stomper \| livecode \| 128 \| F minor \|$/);
  assert.match(rows[2], /^\| 1:12:30 \| 22:42 \| A \| A \\\| B \| song \| 133 \|  \|$/, 'a pipe in a title is escaped; bpm rounded to a tenth');
});

test('a set still going says so', () => {
  assert.match(formatSetLog(set()).split('\n')[0], /21:30–, in progress$/);
});

test('the file lives in its month, and gains the length when the set ends', () => {
  const s = set();
  const live = writeSetLog(s);
  assert.equal(live, path.join(SETS_DIR, '2026-10', '2026-10-06-213005.md'));
  const done = writeSetLog(s, new Date(at(78)));
  assert.equal(done, path.join(SETS_DIR, '2026-10', '2026-10-06-213005 1h18m.md'));
  assert.ok(!fs.existsSync(live), 'the in-progress file was renamed, not left beside it');
  assert.equal(setFileName(start, new Date(at(48))), '2026-10-06-213005 48m.md');
});

test('the WIP retention clears old tracklists, and their emptied month', () => {
  const old = path.join(SETS_DIR, '2025-01', '2025-01-10-200000 1h00m.md');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '# old');
  const longAgo = new Date(2025, 0, 10);
  fs.utimesSync(old, longAgo, longAgo);
  assert.deepEqual(pruneSetLogs(0), { deleted: 0, freed: 0 }, 'off means keep everything');
  const r = pruneSetLogs(6);
  assert.equal(r.deleted, 1);
  assert.ok(!fs.existsSync(path.dirname(old)));
  assert.ok(fs.readdirSync(path.join(SETS_DIR, '2026-10')).length >= 1, 'recent sets stay');
});

test('time formats', () => {
  assert.equal(elapsedOf(0), '0:00');
  assert.equal(elapsedOf(3_725_000), '1:02:05');
  assert.equal(lengthOf(47 * 60000), '47m');
  assert.equal(lengthOf(125 * 60000), '2h 05m');
});
