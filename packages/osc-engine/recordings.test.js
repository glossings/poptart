'use strict';

// The recordings store, driven against a temp POPTART_RECORDINGS_DIR - no server, no engine.
// Two things carry the design: a minted name is unique across EVERY month (so `sr("bass")` never
// changes meaning once written into a pattern), and a name is spellable as a bare mini-notation
// atom (so referencing one needs no quoting).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-recordings-'));
process.env.POPTART_RECORDINGS_DIR = DIR; // read per call, but set before requiring anyway

const {
  recordingsRoot,
  monthFolder,
  sanitizeName,
  listRecordings,
  resolveRecording,
  mintName,
  newRecordingFile,
  captureFile,
} = require('./recordings');

// The atom characters mini.mjs accepts, minus the ones that mean something there: a name must
// survive being written bare inside s()/sr()'s mini string.
const MINI_SAFE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function write(month, name) {
  const dir = path.join(DIR, month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.wav`), 'x');
}

function clear() {
  for (const e of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, e), { recursive: true, force: true });
}

test('the root honours the environment override', () => {
  assert.equal(recordingsRoot(), DIR);
});

test('monthFolder is the YYYY-MM the recording belongs to', () => {
  assert.equal(monthFolder(new Date(2026, 7, 4)), '2026-08');
  assert.equal(monthFolder(new Date(2026, 0, 31)), '2026-01');
});

test('sanitizeName produces something spellable as a bare mini atom', () => {
  for (const raw of ['bass', 'my bass', 'lead/2', 'kick.wav', 'a:b', '  pad  ', '???', 'über']) {
    const name = sanitizeName(raw);
    assert.match(name, MINI_SAFE, `"${raw}" -> "${name}" must be a bare mini atom`);
  }
});

test('sanitizeName keeps an ordinary label untouched', () => {
  assert.equal(sanitizeName('bass'), 'bass');
  assert.equal(sanitizeName('sub_bass-2'), 'sub_bass-2');
});

test('sanitizeName avoids mini-notation reserved words and leading digits', () => {
  // r/i/p/round/floor/ceil are function names in mini, and a leading digit reads as a number.
  assert.notEqual(sanitizeName('r'), 'r');
  assert.notEqual(sanitizeName('floor'), 'floor');
  assert.match(sanitizeName('808'), /^t/);
});

test('sanitizeName never returns empty', () => {
  assert.ok(sanitizeName('').length > 0);
  assert.ok(sanitizeName('---').length > 0);
  assert.ok(sanitizeName(null).length > 0);
});

test('mintName is unique across every month, not just this one', () => {
  clear();
  write('2026-07', 'bass');
  write('2026-08', 'bass-2');
  // Both are taken, in different months - the next free name has to skip both.
  assert.equal(mintName('bass'), 'bass-3');
});

test('mintName returns the plain name when nothing has claimed it', () => {
  clear();
  assert.equal(mintName('lead'), 'lead');
});

test('resolveRecording finds a name in any month folder', () => {
  clear();
  write('2026-06', 'old');
  write('2026-08', 'new');
  assert.equal(resolveRecording('old'), path.join(DIR, '2026-06', 'old.wav'));
  assert.equal(resolveRecording('new'), path.join(DIR, '2026-08', 'new.wav'));
  assert.equal(resolveRecording('missing'), null);
});

test('resolveRecording refuses anything that is not a plain name', () => {
  clear();
  write('2026-08', 'bass');
  // A pattern value reaches this directly, so it must not be able to name a path.
  assert.equal(resolveRecording('../bass'), null);
  assert.equal(resolveRecording('2026-08/bass'), null);
  assert.equal(resolveRecording('.hidden'), null);
  assert.equal(resolveRecording(''), null);
});

test('listRecordings reports every take with its month, newest first', () => {
  clear();
  write('2026-06', 'a');
  write('2026-08', 'b');
  const items = listRecordings();
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map((r) => r.name)), new Set(['a', 'b']));
  assert.equal(items.find((r) => r.name === 'a').month, '2026-06');
});

test('listRecordings ignores non-month folders and non-audio files', () => {
  clear();
  write('2026-08', 'keep');
  fs.mkdirSync(path.join(DIR, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'notes', 'x.wav'), 'x');
  fs.writeFileSync(path.join(DIR, '2026-08', 'readme.txt'), 'x');
  assert.deepEqual(listRecordings().map((r) => r.name), ['keep']);
});

test('listRecordings is empty rather than throwing when nothing has been recorded', () => {
  clear();
  assert.deepEqual(listRecordings(), []);
});

test('newRecordingFile creates the month folder and sanitizes the name', () => {
  clear();
  const file = newRecordingFile('my take', new Date(2026, 7, 4));
  assert.equal(path.dirname(file), path.join(DIR, '2026-08'));
  assert.match(path.basename(file, '.wav'), MINI_SAFE);
  assert.ok(fs.existsSync(path.dirname(file)));
});

test('captureFile stays out of the recordings folder', () => {
  // A crashed bounce must not leave an untrimmed file sitting among the real takes.
  const file = captureFile('bass');
  assert.ok(!file.startsWith(DIR), `${file} should not be inside the recordings folder`);
  assert.match(file, /\.wav$/);
});
