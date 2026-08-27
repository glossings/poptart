'use strict';

// The snippet store (snippets.js), driven against a temp POPTART_SNIPPETS_DIR - no server, no
// engine. Two things matter here: a request can only ever name a file inside the snippets folder,
// and the body/sidecar split has to agree with the way defsEdit writes a definitions block - that
// split is what makes a snippet carry its rolls and presets instead of losing them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-snippets-'));
process.env.POPTART_SNIPPETS_DIR = DIR; // read at require time, so set it first

const {
  snippetFilePath,
  splitSnippet,
  composeSnippet,
  snippetEntry,
  listSnippets,
  readSnippet,
  writeSnippet,
  deleteSnippet,
  renameSnippet,
} = require('./snippets');

const write = (name, code) => fs.writeFileSync(path.join(DIR, `${name}.js`), code, 'utf8');

test('snippetFilePath keeps a name to one segment inside the snippets dir', () => {
  assert.equal(snippetFilePath('acid bass'), path.join(DIR, 'acid bass.js'));
  assert.equal(snippetFilePath('  acid bass  '), path.join(DIR, 'acid bass.js'));
  for (const bad of ['', '   ', '.hidden', '../escape', 'sub/x', 'sub\\x', 'x'.repeat(129)]) {
    assert.throws(() => snippetFilePath(bad), /plain file name/, `expected "${bad}" to be refused`);
  }
});

test('splitSnippet takes the trailing definitions run as the sidecar', () => {
  const { body, carries } = splitSnippet([
    '// @title acid bass',
    '',
    'bass: pianoroll("bass").synth("Serum 2").preset("growl")',
    '',
    '_roll("bass", "36,0,4 47,9,3", { grid: 16 })',
    '_preset("growl", "Serum 2", "@8c1d2e3f4a5b")',
    '',
  ].join('\n'));
  assert.match(body, /bass: pianoroll\("bass"\)/);
  assert.doesNotMatch(body, /_roll|_preset/);
  assert.deepEqual(carries.map((c) => [c.kind, c.id, c.scope]), [
    ['roll', 'bass', ''],
    ['preset', 'growl', 'Serum 2'],
  ]);
  assert.equal(carries[0].code, '_roll("bass", "36,0,4 47,9,3", { grid: 16 })');
});

test('splitSnippet carries a run separated by blank lines, semicolons and comments', () => {
  const { body, carries } = splitSnippet([
    'lead: pianoroll("lead")',
    '',
    '_roll("lead", "60,0,4");',
    '// the shape it swells with',
    '',
    '_shape("swell", "0,0 1,1")',
  ].join('\n'));
  assert.equal(body, 'lead: pianoroll("lead")');
  assert.deepEqual(carries.map((c) => c.id), ['lead', 'swell']);
});

test('splitSnippet leaves a definition with code below it in the body', () => {
  // Not a trailing run: something is played after it, so it is code to read, not a sidecar.
  const code = ['_roll("a", "60,0,4")', 'lead: pianoroll("a")'].join('\n');
  const { body, carries } = splitSnippet(code);
  assert.equal(body, code);
  assert.deepEqual(carries, []);
});

test('splitSnippet handles a body with no definitions, and definitions with no body', () => {
  assert.deepEqual(splitSnippet('drums: s("bd*4")'), { body: 'drums: s("bd*4")', carries: [] });
  const only = splitSnippet('_pack("kit", ["a.wav"])');
  assert.equal(only.body, '');
  assert.deepEqual(only.carries.map((c) => c.id), ['kit']);
});

test('composeSnippet writes a file splitSnippet reads back unchanged', () => {
  const code = composeSnippet({
    title: 'acid bass',
    tags: ['#303', 'Bass', '303'],
    body: 'bass: pianoroll("bass")',
    defs: [{ code: '_roll("bass", "36,0,4")' }],
  });
  assert.match(code, /^\/\/ @title acid bass\n\/\/ @tags 303 bass\n/);
  const back = splitSnippet(code);
  assert.equal(back.body, 'bass: pianoroll("bass")');
  assert.deepEqual(back.carries.map((c) => c.id), ['bass']);
});

// parseMeta scans a WHOLE buffer, so a `// @tags 303` riding along in the body would land in the
// pattern the snippet was inserted into and quietly become that pattern's tags.
test('the body leaves the @title/@tags header behind, but keeps an ordinary comment', () => {
  assert.equal(splitSnippet('// @title x\n// @tags a b\n\nbass: s("bd")').body, 'bass: s("bd")');
  assert.equal(
    splitSnippet('// @tags a\n// the 303 line\nbass: s("bd")').body,
    '// the 303 line\nbass: s("bd")',
  );
  // A metadata line further down is the player's own text, not a header - left alone.
  assert.equal(splitSnippet('bass: s("bd") // @tags a').body, 'bass: s("bd") // @tags a');
});

test('composeSnippet leaves out the header a snippet has nothing to put in', () => {
  assert.equal(composeSnippet({ body: 'x: s("bd")' }), 'x: s("bd")\n');
});

test('an entry carries its label, tags and sidecar; the listing searches them', () => {
  write('acid bass', composeSnippet({
    title: 'acid bass',
    tags: ['303', 'bass'],
    body: 'bass: pianoroll("bass")',
    defs: [{ code: '_roll("bass", "36,0,4")' }],
  }));
  write('dub delay', composeSnippet({ tags: ['fx'], body: '.fx("ValhallaDelay")' }));

  const one = snippetEntry('acid bass');
  assert.equal(one.label, 'acid bass');
  assert.deepEqual(one.tags, ['303', 'bass']);
  assert.deepEqual(one.carries.map((c) => c.id), ['bass']);

  assert.deepEqual(listSnippets('').map((s) => s.name).sort(), ['acid bass', 'dub delay']);
  assert.deepEqual(listSnippets('tag:303').map((s) => s.name), ['acid bass']);
  assert.deepEqual(listSnippets('valhalla').map((s) => s.name), ['dub delay']); // the code itself
  assert.deepEqual(listSnippets('nothing here'), []);
});

test('a snippet with no @title reads as its file name', () => {
  write('plain', 'x: s("bd")');
  assert.equal(snippetEntry('plain').label, 'plain');
});

test('write, read, rename and delete', () => {
  writeSnippet('kept', 'x: s("bd")');
  assert.equal(readSnippet('kept'), 'x: s("bd")');
  writeSnippet('kept', 'x: s("sd")'); // save overwrites silently
  assert.equal(readSnippet('kept'), 'x: s("sd")');

  renameSnippet('kept', 'moved');
  assert.equal(readSnippet('moved'), 'x: s("sd")');
  assert.throws(() => readSnippet('kept'), /no snippet named/);

  writeSnippet('other', 'y: s("hh")');
  assert.throws(() => renameSnippet('other', 'moved'), /already exists/);
  renameSnippet('moved', 'moved'); // renaming onto itself is a no-op, not a collision
  assert.equal(readSnippet('moved'), 'x: s("sd")');

  deleteSnippet('moved');
  assert.throws(() => deleteSnippet('moved'), /no snippet named/);
});

// Last, because it takes the folder away: the browser opens before anything has ever been saved,
// and a missing folder has to read as "no snippets yet" rather than as an error in the overlay.
test('listSnippets is empty rather than throwing when the folder does not exist', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  assert.deepEqual(listSnippets(''), []);
  assert.throws(() => readSnippet('anything'), /no snippet named/);
  writeSnippet('first', 'x: s("bd")'); // and saving makes the folder on the way past
  assert.deepEqual(listSnippets('').map((s) => s.name), ['first']);
});

// The whole journey, minus the DOM: a selection is composed into a file, read back apart, and
// planned into a buffer that already has a roll of the same name. Each half is tested on its own
// above and in snippet-code.test.js; this is the seam between them.
test('a snippet round-trips from the buffer it was cut from into a different one', () => {
  const { planInjection } = require('./public/snippet-code.js');

  // 1. what the save dialog would post, for a selection of one track
  const file = composeSnippet({
    tags: ['303'],
    body: 'bass: pianoroll("bass").synth("Serum 2").preset("growl")',
    defs: [
      { code: '_roll("bass", "36,0,4 47,9,3", { grid: 16 })' },
      { code: '_preset("growl", "Serum 2", "@8c1d2e3f4a5b")' },
    ],
  });
  writeSnippet('acid bass', file);

  // 2. what the browser hands back
  const entry = snippetEntry('acid bass');
  assert.equal(entry.body, 'bass: pianoroll("bass").synth("Serum 2").preset("growl")');
  assert.deepEqual(entry.carries.map((c) => `${c.kind}:${c.id}`), ['roll:bass', 'preset:growl']);

  // 3. dropped into a buffer that already has a DIFFERENT bass, and a bass: block
  const body = entry.body;
  const at = body.indexOf('"bass"') + 1;
  const plan = planInjection({
    body,
    carried: entry.carries,
    idCalls: [{ kind: 'roll', from: at, to: at + 4, scope: '' }],
    bufferDefs: [{ kind: 'roll', id: 'bass', scope: '', code: '_roll("bass", "24,0,8")' }],
    labels: ['bass', 'drums'],
  });
  assert.equal(plan.body, 'bass2: pianoroll("bass2").synth("Serum 2").preset("growl")');
  assert.deepEqual(plan.defs.map((d) => d.code), [
    '_roll("bass2", "36,0,4 47,9,3", { grid: 16 })',
    '_preset("growl", "Serum 2", "@8c1d2e3f4a5b")', // no clash, so its name and program stand
  ]);
  assert.deepEqual(plan.renames.map((r) => `${r.kind} ${r.from}->${r.to}`), ['roll bass->bass2', 'label bass->bass2']);
});
