'use strict';

// The organize window's search box, which narrows TWO lists: the saved-songs list on the right
// and the open playlist's own contents in the middle. The second is the point - a set of forty
// tracks is otherwise unsearchable, which is exactly when you need to find one in it.
//
// A playlist row is one of two different things (a saved pattern's name, or a file item that
// carries its own title/bpm/path), and neither is the shape the saved-songs list matches, so
// what is pinned here is that one typed word means the same thing whichever kind of row it
// lands on - and the cases where the row has less to go on than the search would like: a file
// with no title, a saved song deleted out from under the set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// client.js is a browser script, so the matchers are read out of the source and given their own
// dependencies - the same trick the server-side tests use for server.js.
const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
const NAMES = ['orgQueryHits', 'orgMatches', 'orgItemMatches'];

function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}
function grabArrow(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  assert.ok(m, `const ${name} not found in client.js - this test needs updating`);
  return m[0];
}
// eslint-disable-next-line no-new-func
const makeOrg = new Function('orgQuery', 'orgSongs', `
  ${grabArrow('libItemIsFile')}
  ${grabArrow('libFileTitle')}
  ${NAMES.map(grabFn).join('\n')}
  return { ${NAMES.join(', ')} };
`);

const SAVED = [
  { name: 'damson', title: 'Damson Grudge', tags: ['techno', 'karenn'], bpm: 136 },
  { name: 'sketch2', title: '', tags: [], bpm: 90 },
];
const file = (p, extra = {}) => ({ kind: 'file', path: p, ...extra });
// `orgQuery` is already trimmed and lowercased where it is set, so tests pass it that way.
const org = (q) => makeOrg(q, SAVED);

test('every word has to hit something - the search is an AND', () => {
  const m = org('damson techno');
  assert.equal(m.orgMatches(SAVED[0]), true);
  assert.equal(org('damson house').orgMatches(SAVED[0]), false);
});

test('a word hits the name, the title, a tag or the bpm', () => {
  assert.equal(org('grudge').orgMatches(SAVED[0]), true); // title
  assert.equal(org('karenn').orgMatches(SAVED[0]), true); // tag
  assert.equal(org('136').orgMatches(SAVED[0]), true); // bpm
  assert.equal(org('sketch').orgMatches(SAVED[1]), true); // name, and no title to speak of
});

test('tag: looks ONLY at tags', () => {
  assert.equal(org('tag:techno').orgMatches(SAVED[0]), true);
  assert.equal(org('tag:damson').orgMatches(SAVED[0]), false); // that's the name, not a tag
});

test('an empty search keeps everything, in both lists', () => {
  assert.equal(org('').orgMatches(SAVED[0]), true);
  assert.equal(org('').orgItemMatches(file('/m/x.wav')), true);
  assert.equal(org('').orgItemMatches('anything at all'), true);
});

// --- the playlist's own rows ---

test('a playlist row that names a saved song matches on that song\'s full facts', () => {
  assert.equal(org('karenn').orgItemMatches('damson'), true); // its tag, via the save
  assert.equal(org('136').orgItemMatches('damson'), true);
  assert.equal(org('house').orgItemMatches('damson'), false);
});

test('a file row matches on its title and its bpm', () => {
  const it = file('/music/sets/track01.aiff', { title: 'Bleep Test', bpm: 128 });
  assert.equal(org('bleep').orgItemMatches(it), true);
  assert.equal(org('128').orgItemMatches(it), true);
  assert.equal(org('bleep 128').orgItemMatches(it), true);
  assert.equal(org('bloop').orgItemMatches(it), false);
});

test('a file row also matches on its PATH - the folder is often all you remember', () => {
  const it = file('/music/warehouse rips/a1.wav', { title: 'A1' });
  assert.equal(org('warehouse').orgItemMatches(it), true);
  assert.equal(org('rips a1').orgItemMatches(it), true);
});

test('an untitled file falls back to its filename, as the row itself displays it', () => {
  const it = file('/music/Untitled Bounce.wav');
  assert.equal(org('untitled').orgItemMatches(it), true);
  assert.equal(org('bounce').orgItemMatches(it), true);
  assert.equal(org('.wav').orgItemMatches(it), true); // still in the path, if not the title
});

test('a saved song deleted out from under the set still matches by the name the row holds', () => {
  // The row stays - the playlist is the user's document - so it has to stay findable too.
  assert.equal(org('ghost').orgItemMatches('ghost-take'), true);
  assert.equal(org('damson').orgItemMatches('ghost-take'), false);
});

test('the contents pane keeps true indices: filtered rows are left out, not renumbered', () => {
  // What the renderer does with a non-match, pinned as source: `return` out of the forEach body
  // rather than filtering the array, so `i` stays the row's real place in the set and the
  // position badge, the arrows, a drop and a removal all still mean what they say.
  const body = SRC.slice(SRC.indexOf('function orgRenderItems('));
  const loop = body.slice(body.indexOf('p.items.forEach('));
  assert.match(loop.slice(0, 600), /if \(!orgItemMatches\(item\)\) return;/);
  assert.ok(!/p\.items\.filter\(/.test(body.slice(0, body.indexOf('\n}'))),
    'orgRenderItems must not filter the array - that would renumber every row below the hidden ones');
});
