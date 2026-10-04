'use strict';

// The library browser's two pieces of pure logic: the search that narrows whatever source is
// open, and the comparator behind its sortable columns.
//
// Every source - the livecode saves, the imported track collection, a playlist, the disk - is
// turned into ONE row shape before any of this runs, which is what lets one table render all
// four. So what is pinned here is that a typed word means the same thing whichever kind of row
// it lands on, and the cases where a row has less to go on than the search or the sort would
// like: a track with no artist, an untagged tempo, a save deleted out from under a set.
//
// The column sort has two rules that outrank the column itself, and both are easy to break:
// folders lead (a folder is a place, not an entry), and a row with nothing in the sorted column
// sorts LAST either way - an unknown tempo is not a slow one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// client.js is a browser script, so the subjects are read out of the source and given their own
// dependencies - the same trick the server-side tests use for server.js.
const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

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
function grabBlock(startsWith, name) {
  const at = SRC.indexOf(startsWith);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  // up to the first line that closes the declaration at column 0
  const end = SRC.indexOf('\n};', at);
  assert.ok(end > at, `${name} is not shaped as expected - this test needs updating`);
  return SRC.slice(at, end + 3);
}

const FNS = ['orgRowMatches', 'orgRowCompare', 'orgSavedRow', 'orgTrackRow', 'orgItemRow',
  'orgBpmText', 'pathBasename'];

// eslint-disable-next-line no-new-func
const makeOrg = new Function('orgQuery', 'orgSongs', 'songFileExists', `
  ${grabArrow('stripExt')}
  ${grabArrow('libItemIsFile')}
  ${grabArrow('libFileTitle')}
  ${grabBlock('const ORG_COLUMNS = {', 'ORG_COLUMNS')}
  ${grabFn('orgWhenText')}
  ${FNS.map(grabFn).join('\n')}
  return { ${FNS.join(', ')}, ORG_COLUMNS };
`);

const SAVED = [
  { name: 'damson', title: 'Damson Grudge', tags: ['techno', 'karenn'], bpm: 136, mtime: 3 },
  { name: 'sketch2', title: '', tags: [], bpm: 90, mtime: 2 },
  { name: 'techno/stomper', title: '', folder: 'techno', tags: ['tool'], bpm: 140, mtime: 1 },
];

// `orgQuery` is already trimmed and lowercased where it is set, so tests pass it that way.
const org = (q = '', exists = {}) => makeOrg(q, SAVED, exists);
const file = (p, extra = {}) => ({ kind: 'file', path: p, ...extra });

// --- the search ------------------------------------------------------------------------------

test('every word has to hit something - the search is an AND', () => {
  const o = org('damson techno');
  assert.equal(o.orgRowMatches(o.orgSavedRow(SAVED[0])), true);
  const no = org('damson house');
  assert.equal(no.orgRowMatches(no.orgSavedRow(SAVED[0])), false);
});

test('a word hits the name, the title, a tag or the bpm', () => {
  const hits = (q, s) => { const o = org(q); return o.orgRowMatches(o.orgSavedRow(s)); };
  assert.equal(hits('grudge', SAVED[0]), true); // the title it gives itself
  assert.equal(hits('karenn', SAVED[0]), true); // a tag
  assert.equal(hits('136', SAVED[0]), true); // its tempo
  assert.equal(hits('sketch', SAVED[1]), true); // the name, with no title to speak of
});

test('a saved row matches on the folder it is filed in', () => {
  const o = org('techno');
  assert.equal(o.orgRowMatches(o.orgSavedRow(SAVED[2])), true);
  // The folder is part of the row, so searching for it finds what is filed there even when the
  // name itself says nothing about it.
  const stomper = o.orgSavedRow(SAVED[2]);
  assert.equal(stomper.name, 'stomper', 'a nested save reads as its leaf, with the folder its own column');
  assert.equal(stomper.folder, 'techno');
});

test('tag: looks ONLY at tags', () => {
  const yes = org('tag:techno');
  assert.equal(yes.orgRowMatches(yes.orgSavedRow(SAVED[0])), true);
  const no = org('tag:damson');
  assert.equal(no.orgRowMatches(no.orgSavedRow(SAVED[0])), false); // that is the name, not a tag
});

test('an empty search keeps everything, whatever the row is', () => {
  const o = org('');
  assert.equal(o.orgRowMatches(o.orgSavedRow(SAVED[0])), true);
  assert.equal(o.orgRowMatches(o.orgItemRow(file('/m/x.wav'), 0)), true);
  assert.equal(o.orgRowMatches(o.orgItemRow('anything at all', 1)), true);
  assert.equal(o.orgRowMatches(o.orgTrackRow({ id: 't', path: '/m/y.mp3', title: 'Y' })), true);
});

// --- a track's own facts ----------------------------------------------------------------------

test('a track row matches on its artist, album, key and path', () => {
  const t = { id: 't1', path: '/music/sets/track01.aiff', title: 'Bleep Test', artist: 'Someone', album: 'An Album', bpm: 128, key: 'Am', added: 10 };
  const hits = (q) => { const o = org(q); return o.orgRowMatches(o.orgTrackRow(t)); };
  assert.equal(hits('bleep'), true); // title
  assert.equal(hits('someone'), true); // artist
  assert.equal(hits('album'), true); // album
  assert.equal(hits('am'), true); // key
  assert.equal(hits('sets'), true); // a folder in its path is often all you remember
  assert.equal(hits('128'), true); // tempo
  assert.equal(hits('bleep 128'), true);
  assert.equal(hits('bloop'), false);
});

test('a track whose file is gone is marked missing, and still searchable', () => {
  const o = org('bleep', { '/m/gone.mp3': false });
  const row = o.orgTrackRow({ id: 't', path: '/m/gone.mp3', title: 'Bleep' });
  assert.equal(row.missing, true, 'the row says the file has moved or been deleted');
  assert.equal(o.orgRowMatches(row), true, 'a missing track is still found by name');
});

// --- a playlist's own rows --------------------------------------------------------------------

test('a playlist row that names a saved song matches on that song\'s full facts', () => {
  const hits = (q) => { const o = org(q); return o.orgRowMatches(o.orgItemRow('damson', 0)); };
  assert.equal(hits('karenn'), true); // its tag, via the save
  assert.equal(hits('136'), true);
  assert.equal(hits('house'), false);
});

test('a playlist row is keyed by its POSITION, not by what it holds', () => {
  const o = org('');
  // The same song twice in a set is two different rows - removing one must not take the other.
  const first = o.orgItemRow('damson', 0);
  const second = o.orgItemRow('damson', 4);
  assert.notEqual(first.key, second.key);
  assert.equal(first.at, 0);
  assert.equal(second.at, 4);
});

test('a playlist row whose save is gone keeps what the row says, and is marked missing', () => {
  const o = org('vanished');
  const row = o.orgItemRow('vanished-song', 0);
  assert.equal(row.missing, true);
  assert.equal(row.name, 'vanished-song', 'the row still says the name the set recorded');
  assert.equal(o.orgRowMatches(row), true);
});

test('a hydrated track in a set carries the record\'s facts onto the row', () => {
  const o = org('');
  const row = o.orgItemRow(file('/m/one.mp3', { title: 'One', artist: 'Two', bpm: 124, key: 'Am', trackId: 'x1' }), 2);
  assert.equal(row.kind, 'track');
  assert.equal(row.name, 'One');
  assert.equal(row.artist, 'Two');
  assert.equal(row.bpm, 124);
  assert.equal(row.musKey, 'Am');
  assert.equal(row.trackId, 'x1', 'the row can find the record again, to edit it');
});

test('a file item with no title falls back to its file name', () => {
  const o = org('');
  assert.equal(o.orgItemRow(file('/music/Deep Cut.aiff'), 0).name, 'Deep Cut');
});

// --- the column sort ---------------------------------------------------------------------------

const sortBy = (rows, col, dir) => {
  const o = org('');
  return [...rows].sort(o.orgRowCompare(o.ORG_COLUMNS[col], dir)).map((r) => r.name);
};

test('a text column sorts by name, case and digits read naturally', () => {
  const rows = [{ name: 'beta' }, { name: 'Alpha' }, { name: 'track10' }, { name: 'track2' }];
  assert.deepEqual(sortBy(rows, 'name', 1), ['Alpha', 'beta', 'track2', 'track10']);
  assert.deepEqual(sortBy(rows, 'name', -1), ['track10', 'track2', 'beta', 'Alpha']);
});

test('a number column sorts numerically, not as text', () => {
  const rows = [{ name: 'a', bpm: 90 }, { name: 'b', bpm: 140 }, { name: 'c', bpm: 128 }];
  assert.deepEqual(sortBy(rows, 'bpm', 1), ['a', 'c', 'b']);
  assert.deepEqual(sortBy(rows, 'bpm', -1), ['b', 'c', 'a']);
});

test('a row with nothing in the sorted column sorts last, both ways', () => {
  // An unknown tempo is not a slow one: burying it among the slow tracks is a lie the column
  // would be telling, so it goes to the end whichever way the arrow points.
  const rows = [{ name: 'fast', bpm: 150 }, { name: 'untagged', bpm: null }, { name: 'slow', bpm: 90 }];
  assert.deepEqual(sortBy(rows, 'bpm', 1), ['slow', 'fast', 'untagged']);
  assert.deepEqual(sortBy(rows, 'bpm', -1), ['fast', 'slow', 'untagged']);
  // Same for text that is merely absent.
  const noArtist = [{ name: 'a', artist: '' }, { name: 'b', artist: 'Zed' }];
  assert.deepEqual(sortBy(noArtist, 'artist', 1), ['b', 'a']);
  assert.deepEqual(sortBy(noArtist, 'artist', -1), ['b', 'a']);
});

test('folders lead, whatever the column and whichever way it points', () => {
  const rows = [
    { name: 'zz-file', kind: 'diskfile', bpm: 200 },
    { name: 'aa-folder', kind: 'dir' },
    { name: 'mm-file', kind: 'diskfile', bpm: 100 },
  ];
  assert.deepEqual(sortBy(rows, 'name', 1), ['aa-folder', 'mm-file', 'zz-file']);
  assert.deepEqual(sortBy(rows, 'name', -1), ['aa-folder', 'zz-file', 'mm-file']);
  // A folder has no tempo at all, and still leads rather than sorting last with the untagged.
  assert.deepEqual(sortBy(rows, 'bpm', -1), ['aa-folder', 'zz-file', 'mm-file']);
});

test('a set in its own order sorts by slot, with slot 0 first', () => {
  const rows = [{ name: 'third', at: 2 }, { name: 'first', at: 0 }, { name: 'second', at: 1 }];
  assert.deepEqual(sortBy(rows, 'n', 1), ['first', 'second', 'third']);
  assert.deepEqual(sortBy(rows, 'n', -1), ['third', 'second', 'first']);
});

test('the # column reads as the slot number, counting from one', () => {
  const o = org('');
  assert.equal(o.ORG_COLUMNS.n.text({ at: 0 }), 1);
  assert.equal(o.ORG_COLUMNS.n.text({ at: 11 }), 12);
  assert.equal(o.ORG_COLUMNS.n.text({}), '', 'a row outside a set has no slot to show');
});

test('an empty tempo or key column reads as blank, never as "null"', () => {
  const o = org('');
  assert.equal(o.ORG_COLUMNS.bpm.text({ bpm: null }), '');
  assert.equal(o.ORG_COLUMNS.bpm.text({ bpm: 128 }), '128');
  assert.equal(o.ORG_COLUMNS.key.text({}), '');
  assert.equal(o.ORG_COLUMNS.artist.text({}), '');
  assert.equal(o.ORG_COLUMNS.saved.text({ when: 0 }), '', 'a row with no date shows nothing');
  assert.equal(o.ORG_COLUMNS.rating.text({}), '', 'an unrated row shows nothing');
});

// A tempo's own shape says where it came from: a tag or a hand says a whole number, the beatgrid
// measures hundredths. Worth pinning because it is the only cue in the column itself.
test('a measured tempo keeps its decimals, a stated one reads whole', () => {
  const o = org('');
  assert.equal(o.orgBpmText(128), '128');
  assert.equal(o.orgBpmText(127.98), '127.98');
  assert.equal(o.orgBpmText(124.5), '124.5', 'a trailing zero is not printed');
  assert.equal(o.orgBpmText(null), '');
});

// --- the rating column -------------------------------------------------------------------------

test('a rating rides on the record, so a set and the collection show the same stars', () => {
  const o = org('');
  assert.equal(o.orgTrackRow({ id: 't', path: '/m/a.mp3', title: 'A', rating: 4 }).rating, 4);
  // The same track reached through a playlist slot reads the same, because the slot is hydrated
  // from that record rather than carrying a copy.
  const row = o.orgItemRow(file('/m/a.mp3', { title: 'A', rating: 4, trackId: 't' }), 0);
  assert.equal(row.rating, 4);
  assert.equal(row.trackId, 't', 'and the row can find the record to change it');
});

test('an unrated track has no rating at all, rather than zero stars', () => {
  const o = org('');
  assert.equal(o.orgTrackRow({ id: 't', path: '/m/a.mp3', title: 'A' }).rating, null);
});

test('rating sorts high to low with the unrated last, both ways', () => {
  const rows = [
    { name: 'three', rating: 3 },
    { name: 'unrated', rating: null },
    { name: 'five', rating: 5 },
  ];
  assert.deepEqual(sortBy(rows, 'rating', -1), ['five', 'three', 'unrated']);
  // Ascending still buries the unrated at the end - absent is not "worst", it is unknown.
  assert.deepEqual(sortBy(rows, 'rating', 1), ['three', 'five', 'unrated']);
});

test('a measured field is marked on the row, so it can read as an estimate', () => {
  const o = org('');
  const row = o.orgTrackRow({ id: 't', path: '/m/a.mp3', title: 'A', bpm: 124.5, detected: ['bpm'] });
  assert.deepEqual(row.detected, ['bpm']);
  const stated = o.orgTrackRow({ id: 'u', path: '/m/b.mp3', title: 'B', bpm: 128 });
  assert.deepEqual(stated.detected, [], 'a tagged tempo is not an estimate');
});
