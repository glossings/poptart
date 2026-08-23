'use strict';

// s() / se() / sr() all reach the engine as one "source ref" string, and _resolveSource is what
// turns that back into files. The point of the design is that a one-file source is just a pack of
// one, so everything downstream (buffers, slices, begin/end, fit) is shared - these tests pin the
// resolution rule and the one place it deliberately differs: a missing exact file or recording is
// retried, because `sr("bass")` is routinely written before the bounce that creates it exists.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAMPLES = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-samples-'));
const RECORDINGS = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-recs-'));
process.env.POPTART_SAMPLES_DIR = SAMPLES;
process.env.POPTART_RECORDINGS_DIR = RECORDINGS;

const { OscEngine } = require('./index.js');
const { resolveSampleFile, browseSamples, expandPackEntries } = require('./samples.js');

function put(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
}

const engine = () => new OscEngine({ sclangPath: '/usr/bin/false' });

test('a bare ref is a pack - a folder of files, in filename order', () => {
  put(SAMPLES, 'drums/b.wav');
  put(SAMPLES, 'drums/a.wav');
  const { paths } = engine()._resolveSource('drums');
  assert.deepStrictEqual(paths.map((p) => path.basename(p)), ['a.wav', 'b.wav']);
});

test('"file:" resolves one exact file under the samples root', () => {
  const file = put(SAMPLES, 'drums/kick 01.wav');
  const { paths } = engine()._resolveSource('file:drums/kick 01.wav');
  assert.deepStrictEqual(paths, [file]);
});

test('"sp:" resolves a named pack the host pushed - files and folders, relative or absolute', () => {
  const a = put(SAMPLES, 'kit/a.wav');
  put(SAMPLES, 'hats/hh2.wav');
  put(SAMPLES, 'hats/hh1.wav');
  put(SAMPLES, 'hats/readme.txt'); // not audio - skipped, not an error
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-elsewhere-'));
  const b = put(outside, 'snare 02.wav');
  const e = engine();
  // Unknown until the host says otherwise - and retryable, since the definition may be evaluated
  // a moment after the pattern that names it.
  assert.strictEqual(e._resolveSource('sp:kit').paths, null);
  assert.strictEqual(e._resolveSource('sp:kit').stable, false);
  e.defineSamplePacks({ kit: ['kit/a.wav', b, 'hats', 'missing.wav'] });
  const { paths } = e._resolveSource('sp:kit');
  assert.deepStrictEqual(paths, [a, b, path.join(SAMPLES, 'hats/hh1.wav'), path.join(SAMPLES, 'hats/hh2.wav')]);
  // Empty is a named-but-unfilled pack: nothing to play, retryable.
  e.defineSamplePacks({ kit: [] });
  assert.strictEqual(e._resolveSource('sp:kit').paths, null);
  // Forgotten when the host stops mentioning it.
  e.defineSamplePacks({});
  assert.strictEqual(e._namedPacks.has('kit'), false);
});

test('redefining a named pack drops its loaded cache only when the entries changed', () => {
  const e = engine();
  e.defineSamplePacks({ kit: ['a.wav'] });
  e._packs.set('sp:kit', { status: 'ready', files: [] });
  e.defineSamplePacks({ kit: ['a.wav'] });
  assert.ok(e._packs.has('sp:kit'), 'same entries keep the buffers');
  e.defineSamplePacks({ kit: ['a.wav', 'b.wav'] });
  assert.ok(!e._packs.has('sp:kit'), 'new entries reload');
  e.defineSamplePacks({});
  assert.ok(!e._packs.has('sp:kit'), 'a forgotten pack releases its cache');
  assert.deepStrictEqual(expandPackEntries(['', null, 'nope/nothing.wav']), []);
});

test('"rec:" resolves one recording by name, whatever month it is filed under', () => {
  const file = put(RECORDINGS, '2026-08/bass.wav');
  const { paths } = engine()._resolveSource('rec:bass');
  assert.deepStrictEqual(paths, [file]);
});

test('a missing source resolves to nothing rather than throwing', () => {
  for (const ref of ['nosuchpack', 'file:nope.wav', 'rec:nope']) {
    const { paths } = engine()._resolveSource(ref);
    assert.ok(!paths || paths.length === 0, `${ref} resolves to nothing`);
  }
});

test('an exact file cannot escape the samples root', () => {
  // A pattern value reaches this directly, so "../" must not turn the sampler into a file browser.
  put(SAMPLES, 'inside.wav');
  assert.strictEqual(resolveSampleFile('../etc/passwd.wav'), null);
  assert.strictEqual(resolveSampleFile('/etc/passwd.wav'), null);
  assert.ok(resolveSampleFile('inside.wav'));
});

test('only audio extensions resolve', () => {
  put(SAMPLES, 'notes.txt');
  assert.strictEqual(resolveSampleFile('notes.txt'), null);
});

test('packs are cached as failed, exact files and recordings are retried', () => {
  // A pack folder does not appear mid-session; a recording does, the moment a bounce finishes.
  const e = engine();
  e._send = () => {};
  e._request = () => new Promise(() => {}); // never settles - the entry stays 'loading'

  assert.strictEqual(e._ensurePack('gone').stable, true);
  assert.strictEqual(e._ensurePack('rec:later').stable, false);

  // The pack keeps its cached failure...
  assert.strictEqual(e._ensurePack('gone').status, 'error');
  // ...while the recording, once it exists, is picked up on the next look past the retry window.
  put(RECORDINGS, '2026-08/later.wav');
  e._packs.get('rec:later').triedAt = 0; // pretend the retry interval has elapsed
  assert.strictEqual(e._ensurePack('rec:later').status, 'loading', 'found it and started loading');
});

test('browseSamples lists one folder: subfolders and audio files, sorted', () => {
  put(SAMPLES, 'browse/z.wav');
  put(SAMPLES, 'browse/a.wav');
  put(SAMPLES, 'browse/sub/x.wav');
  put(SAMPLES, 'browse/readme.txt');
  const listing = browseSamples('browse');
  assert.deepStrictEqual(listing.files, ['a.wav', 'z.wav']);
  assert.deepStrictEqual(listing.dirs, ['sub']);
});

test('browseSamples refuses to list outside the root', () => {
  assert.strictEqual(browseSamples('../..'), null);
});
