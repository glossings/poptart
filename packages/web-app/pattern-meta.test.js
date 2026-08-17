'use strict';

// Pattern metadata parsing + search (public/pattern-meta.js). Both sides of the app depend on
// this agreeing with itself - the server labels and filters the files tab with it, the editor
// titles the browser tab with it - so the cases that matter are: tags are found anywhere in the
// file, only inside comments, and a search term reaches every field it claims to.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMeta, deriveLabel, displayLabel, matchesQuery, patternNameProblem,
} = require('./public/pattern-meta.js');

test('reads @title / @by / @tags from line comments', () => {
  const meta = parseMeta([
    '// @title kick drift',
    '// @by aria',
    '// @tags techno, generative',
    'bass: note("c2")',
  ].join('\n'));
  assert.equal(meta.title, 'kick drift');
  assert.equal(meta.by, 'aria');
  assert.deepEqual(meta.tags, ['techno', 'generative']);
});

test('finds tags anywhere in the file, not just a header block', () => {
  const meta = parseMeta([
    'bass: note("c2")',
    '',
    'lead: n("0 3").scale("F minor") // @tags melodic',
    '',
    '/* @title late night',
    ' * @by aria',
    ' */',
  ].join('\n'));
  assert.equal(meta.title, 'late night');
  assert.equal(meta.by, 'aria');
  assert.deepEqual(meta.tags, ['melodic']);
});

test('several tags share a line, each value stopping at the next @', () => {
  const meta = parseMeta('// @title kick drift @by aria @tags techno');
  assert.equal(meta.title, 'kick drift');
  assert.equal(meta.by, 'aria');
  assert.deepEqual(meta.tags, ['techno']);
});

test('a value never runs past the end of its line', () => {
  const meta = parseMeta('/* @title drift\n   still the comment, not the title */');
  assert.equal(meta.title, 'drift');
});

test('ignores @ outside comments', () => {
  const meta = parseMeta('bass: s("@title not a title").note("c2")');
  assert.equal(meta.title, '');
  assert.deepEqual(meta.tags, []);
});

test("a // inside a string doesn't start a comment", () => {
  const meta = parseMeta('bass: s("http://example.com/@title nope")\n// @title real');
  assert.equal(meta.title, 'real');
});

test('an email in a comment is not a tag', () => {
  const meta = parseMeta('// @by ariamine94@gmail.com');
  assert.equal(meta.by, 'ariamine94@gmail.com');
  assert.deepEqual(Object.keys(meta.extra), []);
});

test('aliases: @name / @author / @tag', () => {
  const meta = parseMeta('// @name drift\n// @author aria\n// @tag ambient');
  assert.equal(meta.title, 'drift');
  assert.equal(meta.by, 'aria');
  assert.deepEqual(meta.tags, ['ambient']);
});

test('repeated @tags accumulate and dedupe; a repeated @title keeps the first', () => {
  const meta = parseMeta('// @title first @tags a, b\n// @title second @tags b, c');
  assert.equal(meta.title, 'first');
  assert.deepEqual(meta.tags, ['a', 'b', 'c']);
});

test('tags normalize: lowercased, # stripped, split on commas or spaces', () => {
  assert.deepEqual(parseMeta('// @tags #Techno, LoFi  drums').tags, ['techno', 'lofi', 'drums']);
});

test('unknown keys land in extra', () => {
  assert.deepEqual(parseMeta('// @bpm 174 @url https://x.test').extra, { bpm: '174', url: 'https://x.test' });
});

test('a bare @key with no value is not a tag', () => {
  const meta = parseMeta('// @title\n// see @tags');
  assert.equal(meta.title, '');
  assert.deepEqual(meta.tags, []);
});

test('deriveLabel takes the first labelled block, minus any mute/solo prefix', () => {
  assert.equal(deriveLabel('bass: note("c2")\nlead: n("0")'), 'bass');
  assert.equal(deriveLabel('_drums: s("bd")'), 'drums');
  assert.equal(deriveLabel('Slead: n("0")'), 'lead');
  assert.equal(deriveLabel('// bass: note("c2")\nlead: n("0")'), 'lead'); // commented out
  assert.equal(deriveLabel('setbpm(120)'), '');
});

test('deriveLabel skips $: setup blocks - they are not names', () => {
  assert.equal(deriveLabel('$: setbpm(120)\nkick: s("bd")'), 'kick');
  assert.equal(deriveLabel('$: setbpm(120)'), '');
});

test('displayLabel: a name the user gave beats a label guessed from the code', () => {
  const code = 'kick: s("bd")';
  // the whole point: a pattern saved as "night-drive" reads as "night-drive", not "kick"
  assert.equal(displayLabel({ title: '', name: 'night-drive', code }), 'night-drive');
  assert.equal(displayLabel({ title: 'drift', name: 'night-drive', code }), 'drift'); // @title wins
});

test('displayLabel only borrows a block label when asked, for something with no name', () => {
  const code = 'kick: s("bd")';
  assert.equal(displayLabel({ code, fallback: 'Aug 2, 14:32' }), 'Aug 2, 14:32');
  assert.equal(displayLabel({ code, fallback: 'Aug 2, 14:32', borrowBlockLabel: true }), 'kick');
  assert.equal(displayLabel({ code: 'setbpm(120)', fallback: 'Aug 2, 14:32', borrowBlockLabel: true }), 'Aug 2, 14:32');
  assert.equal(displayLabel({}), 'untitled');
});

const entry = {
  name: 'night-drive',
  title: 'kick drift',
  by: 'aria',
  tags: ['techno', 'generative'],
  code: 'bass: note("c2 eb2").s("Serum 2")',
};

test('an empty query matches everything', () => {
  assert.equal(matchesQuery(entry, ''), true);
  assert.equal(matchesQuery(entry, '   '), true);
});

test('a bare term reaches name, title, author, tags and the code itself', () => {
  for (const q of ['night', 'drift', 'aria', 'generative', 'serum']) {
    assert.equal(matchesQuery(entry, q), true, `expected "${q}" to match`);
  }
  assert.equal(matchesQuery(entry, 'nothinghere'), false);
});

test('terms are ANDed', () => {
  assert.equal(matchesQuery(entry, 'drift techno'), true);
  assert.equal(matchesQuery(entry, 'drift house'), false);
});

test('tag: and by: restrict a term to one field', () => {
  assert.equal(matchesQuery(entry, 'tag:techno'), true);
  assert.equal(matchesQuery(entry, 'tag:serum'), false); // in the code, not in the tags
  assert.equal(matchesQuery(entry, 'by:aria'), true);
  assert.equal(matchesQuery(entry, 'by:someone'), false);
});

test('a half-typed tag: does not blank the list', () => {
  assert.equal(matchesQuery(entry, 'tag:'), true);
  assert.equal(matchesQuery(entry, 'by:'), true);
});

test('missing fields are tolerated', () => {
  assert.equal(matchesQuery({ name: 'x' }, 'x'), true);
  assert.equal(matchesQuery({}, 'x'), false);
});

// The naming dialog disables its button on whatever this returns, and patternFilePath throws on
// it - so a name the editor accepts has to be one the server will take.
test('a usable pattern name has no problem to report', () => {
  assert.equal(patternNameProblem('acid-3'), null);
  assert.equal(patternNameProblem('  spaced out  '), null); // trimmed, like the save route does
  assert.equal(patternNameProblem('dots.in.the.middle'), null);
});

test('names that cannot be file names are refused with a reason', () => {
  assert.match(patternNameProblem(''), /give it a name/);
  assert.match(patternNameProblem('   '), /give it a name/);
  assert.match(patternNameProblem(null), /give it a name/);
  assert.match(patternNameProblem('.hidden'), /cannot start/);
  assert.match(patternNameProblem('sub/dir'), /slashes/);
  assert.match(patternNameProblem('back\\slash'), /slashes/);
  assert.match(patternNameProblem('x'.repeat(129)), /too long/);
});
