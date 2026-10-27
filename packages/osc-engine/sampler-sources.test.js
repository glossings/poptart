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
const { resolveSampleFile, browseSamples, expandPackEntries, sampleKey, sliceEntryFor } = require('./samples.js');

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

// --- how a slice set names a file (see samples.js sampleKey / sliceEntryFor) --------------------
//
// A set of markers only means anything on the sample it was drawn on, so it is keyed by one. The
// key has to read as the file, survive being written into a pattern someone else opens, and be the
// SAME string on both ends - the editor files markers under the key the server hands it, and the
// engine looks them up under the key it computes from the file it resolved.

test('a sample is keyed by its path under the library, so a set travels with the library', () => {
  const file = put(SAMPLES, 'breaks/amen brother.wav');
  assert.strictEqual(sampleKey(file), 'breaks/amen brother.wav');
});

test('a bounce is keyed in sr()\'s own namespace, and a stray file by its name', () => {
  const rec = put(RECORDINGS, '2026-09/bass.wav');
  assert.strictEqual(sampleKey(rec), 'rec:2026-09/bass.wav');
  assert.strictEqual(sampleKey('/somewhere/else/loop.wav'), 'loop.wav');
});

test('a set draws only on the files it has markers for - every other sample keeps its own chops', () => {
  const amen = put(SAMPLES, 'breaks/amen.wav');
  const think = put(SAMPLES, 'breaks/think.wav');
  const set = { 'breaks/amen.wav': [0, 0.5] };
  assert.deepStrictEqual(sliceEntryFor(set, amen).marks, [0, 0.5]);
  assert.strictEqual(sliceEntryFor(set, think), null, 'null = chop on this one\'s own transients');
});

test('a set written as a bare list is one map, for whatever plays', () => {
  const amen = put(SAMPLES, 'breaks/amen.wav');
  assert.deepStrictEqual(sliceEntryFor([0, 0.25], amen).marks, [0, 0.25]);
  assert.strictEqual(sliceEntryFor([], amen), null);
  assert.strictEqual(sliceEntryFor(null, amen), null);
});

test('an entry carries that sample\'s fit beside its markers, and only that sample\'s', () => {
  // Four breaks under one name, each fitted its own way - which one .fit() on the chain can't say.
  const amen = put(SAMPLES, 'breaks/amen.wav');
  const think = put(SAMPLES, 'breaks/think.wav');
  const set = { 'breaks/amen.wav': { fit: 2, marks: [0, 0.5] }, 'breaks/think.wav': [0, 0.25] };
  assert.strictEqual(sliceEntryFor(set, amen).fit, 2);
  assert.strictEqual(sliceEntryFor(set, think).fit, null, 'this one is not fitted at all');
  // A fit with no markers is still an entry; a fit of nothing is not.
  assert.deepStrictEqual(sliceEntryFor({ 'breaks/amen.wav': { fit: 'auto' } }, amen), { marks: null, fit: 'auto' });
  assert.strictEqual(sliceEntryFor({ 'breaks/amen.wav': { fit: 0 } }, amen), null);
});

test('a pack poptart ships plays where the library has none of that name', () => {
  const { setBuiltInPacksRoot } = require('./samples.js');
  const BUILT_IN = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-builtin-'));
  put(BUILT_IN, 'pt_kit/kick.wav');
  put(BUILT_IN, 'pt_keys/bell.wav');
  put(SAMPLES, 'pt_keys/mine.wav');
  setBuiltInPacksRoot(BUILT_IN);
  try {
    assert.deepStrictEqual(engine()._resolveSource('pt_kit').paths, [path.join(BUILT_IN, 'pt_kit', 'kick.wav')]);
    assert.deepStrictEqual(engine()._resolveSource('pt_keys').paths, [path.join(SAMPLES, 'pt_keys', 'mine.wav')], 'the library comes first');
    assert.strictEqual(engine()._resolveSource('../pt_kit').paths, null, 'a name, not a path');
  } finally {
    setBuiltInPacksRoot(null);
  }
  assert.strictEqual(engine()._resolveSource('pt_kit').paths, null);
});

// The packs the app ships, exactly as the host points the engine at them (web-app/server.js).
const SHIPPED = path.join(__dirname, '..', 'web-engine', 'public', 'packs');

test('the short drum names are pt_kit\'s files, the same ones the browser build plays', () => {
  const { setBuiltInPacksRoot, builtInPacks } = require('./samples.js');
  const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-lib-'));
  const was = process.env.POPTART_SAMPLES_DIR;
  process.env.POPTART_SAMPLES_DIR = LIB;
  setBuiltInPacksRoot(SHIPPED);
  try {
    const kit = engine()._resolveSource('pt_kit').paths;
    assert.deepStrictEqual(kit.map((p) => path.basename(p)), ['kick.wav', 'snare.wav', 'rim.wav', 'clap.wav', 'hat.wav', 'hatopen.wav', 'tomlo.wav', 'tomhi.wav'], 'in the manifest\'s order: pt_kit:0 is the kick');
    const expected = { bd: 'kick.wav', sd: 'snare.wav', rim: 'rim.wav', cp: 'clap.wav', hh: 'hat.wav', oh: 'hatopen.wav', lt: 'tomlo.wav', ht: 'tomhi.wav' };
    for (const [name, file] of Object.entries(expected)) {
      assert.deepStrictEqual(engine()._resolveSource(name).paths, [path.join(SHIPPED, 'pt_kit', file)], `${name} is pt_kit's ${file}`);
    }
    assert.strictEqual(engine()._resolveSource('mt').paths, null, 'pt_kit has no mid tom');
    const listed = Object.fromEntries(builtInPacks().map((p) => [p.name, p.files.map((f) => path.basename(f))]));
    assert.deepStrictEqual(listed.bd, ['kick.wav'], 'the sounds tab lists them');
    assert.strictEqual(listed.pt_kit[0], 'kick.wav');

    // A library folder of the name plays in its place, as it does for a built-in pack.
    const mine = put(LIB, 'bd/my kick.wav');
    assert.deepStrictEqual(engine()._resolveSource('bd').paths, [mine]);
    assert.deepStrictEqual(engine()._resolveSource('sd').paths, [path.join(SHIPPED, 'pt_kit', 'snare.wav')]);
  } finally {
    setBuiltInPacksRoot(null);
    process.env.POPTART_SAMPLES_DIR = was;
  }
});

test('.bank() plays "<bank>_<name>" where the library has it, and otherwise warns once and plays the name', () => {
  const { setBuiltInPacksRoot } = require('./samples.js');
  const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-lib-'));
  const was = process.env.POPTART_SAMPLES_DIR;
  process.env.POPTART_SAMPLES_DIR = LIB;
  setBuiltInPacksRoot(SHIPPED);
  const warn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(String(line));
  try {
    put(LIB, 'mine_bd/a.wav');
    const e = engine();
    const asked = [];
    e._ensurePack = (ref) => { asked.push(ref); return { status: 'loading', files: [] }; };
    e.playSample('t', 'bd', { bank: 'mine', index: 3 }, 0, 1);
    e.playSample('t', 'bd', { bank: '808' }, 1, 2);
    e.playSample('t', 'bd', { bank: '808' }, 2, 3);
    e.playSample('t', 'sp:bd', { bank: 'mine' }, 3, 4);
    e.playSample('t', 'bd', {}, 4, 5);
    assert.deepStrictEqual(asked, ['mine_bd', 'bd', 'bd', 'sp:bd', 'bd']);
    assert.strictEqual(warnings.filter((w) => w.includes('"808_bd"')).length, 1, 'warned once');
    assert.deepStrictEqual(engine()._resolveSource('bd').paths, [path.join(SHIPPED, 'pt_kit', 'kick.wav')], 'and the fallback is pt_kit\'s kick');
  } finally {
    console.warn = warn;
    setBuiltInPacksRoot(null);
    process.env.POPTART_SAMPLES_DIR = was;
  }
});
