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

// --- what a save is called ---------------------------------------------------------------------
//
// A livecode save is listed under the name it was SAVED AS. Its @title is not the name, because
// a run of versions declares one title between them: "my song v1", "my song v2" and "my song v3"
// all say @title "My Song", and a column of three identical words tells you nothing. The title
// stays searchable, which is the half of it that is easy to drop.

test('a save is listed under the name it was saved as, not its @title', () => {
  const o = org('');
  const damson = o.orgSavedRow(SAVED[0]);
  assert.equal(damson.name, 'damson', 'the saved name, not "Damson Grudge"');
  assert.equal(damson.savedTitle, 'Damson Grudge', 'the declared title still rides the row');
  // The folder has a column of its own here, so the name column holds only the leaf.
  assert.equal(o.orgSavedRow(SAVED[2]).name, 'stomper');
  assert.equal(o.orgSavedRow(SAVED[2]).folder, 'techno');
  // ...and a set's own row for the same save says the same thing.
  assert.equal(o.orgItemRow('damson', 0).name, 'damson');
  assert.equal(o.orgItemRow('techno/stomper', 1).name, 'stomper');
});

test('a save is still found by the title it declares, which the name no longer shows', () => {
  const o = org('grudge');
  assert.equal(o.orgRowMatches(o.orgSavedRow(SAVED[0])), true);
  assert.equal(o.orgRowMatches(o.orgItemRow('damson', 0)), true, 'and through a set, too');
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

// --- the table's own geometry ------------------------------------------------------------------
//
// Two separate failures, both of them "the column is there and you still can't read it".
//
// A tempo is a NUMBER, so ellipsizing it is worse than useless: "170…" is wider than the "170" it
// hides and says less than either it or "170.25". So the bpm column carries three measurements of
// its own - the width it opens at, the width below which it gives up the hundredths, and the width
// no drag may take it past - and they have to stay in that order or one of them does nothing.
//
// And the headers float. They are declared `position: sticky`, which is easy to lose, because the
// grip inside a header also wants a positioned header and `position: relative` is the reflex -
// restating it under the same selector further down the file is exactly what un-stuck them.

const CSS = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');

test('a tempo drops its hundredths rather than being cut short', () => {
  const { orgBpmText } = org('');
  assert.equal(orgBpmText(170.25), '170.25');
  assert.equal(orgBpmText(170.25, true), '170', 'the whole beat, not four characters and a stub');
  // A whole tempo has nothing to give up, so it reads the same either way.
  assert.equal(orgBpmText(128), '128');
  assert.equal(orgBpmText(128, true), '128');
  // Rounded, not truncated: 169.8 is a 170 track.
  assert.equal(orgBpmText(169.8, true), '170');
  assert.equal(orgBpmText(null, true), '');
});

test('the bpm column opens wide enough for a measured tempo, and cannot be dragged under one', () => {
  const { ORG_COLUMNS } = org('');
  const bpm = ORG_COLUMNS.bpm;
  assert.ok(bpm.w > bpm.minFull, 'the column opens too narrow to show what it is holding');
  assert.ok(bpm.minFull > bpm.min, 'there is no width at which the short form is what shows');
  // Measured in a browser: "170.25" is 43.4px of 12px mono, in a cell with 8px of padding a side.
  assert.ok(bpm.w >= 60, `${bpm.w}px cannot hold six mono characters and its padding`);
});

test('a column with a short form declares the width it needs, and the other way round', () => {
  const { ORG_COLUMNS } = org('');
  for (const [name, spec] of Object.entries(ORG_COLUMNS)) {
    assert.equal(!!spec.short, spec.minFull != null,
      `${name}: a short form with no width to trigger it (or a width with no short form) is dead code`);
  }
});

test('the organize headers are sticky, and nothing later takes it back', () => {
  const rules = [...CSS.matchAll(/#orgTable thead th\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length > 0, '#orgTable thead th is not styled - this test needs updating');
  const positions = rules.flatMap((body) => [...body.matchAll(/position:\s*([a-z-]+)/g)].map((m) => m[1]));
  assert.deepEqual(positions, ['sticky'],
    'the header cells take exactly one position, and it is sticky - a second rule under the same '
    + 'selector wins by order, which is how they came to scroll away with the rows');
});

// --- the filter: what will mix with the record that is playing --------------------------------
//
// Two questions, asked on every page of the browser: can the pitch fader pull this tempo into
// line, and will this key sit under the one in the air. The tempo window has to include half and
// double time - a 70 and a 140 are the same tempo to a DJ, and a list that left those out would
// read as broken rather than as selective - and the key rule is Camelot arithmetic, which is the
// whole reason keys are converted onto the wheel instead of compared as names.

const filt = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
  const grab = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
    let depth = 0;
    let end = src.indexOf('{', at);
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return src.slice(at, end);
  };
  const line = (name) => {
    const m = src.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
    assert.ok(m, `const ${name} not found in client.js - this test needs updating`);
    return m[0];
  };
  const block = (name) => {
    const at = src.indexOf(`const ${name} = {`);
    assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
    const end = src.indexOf('\n};', at);
    assert.ok(end > at, `${name} is not shaped as expected - this test needs updating`);
    return src.slice(at, end + 3);
  };
  // eslint-disable-next-line no-new-func
  return new Function('orgFilt', 'orgFiltTol', `
    ${line('ORG_PITCH_CLASS')}
    ${line('orgCamelotHour')}
    ${block('ORG_KEY_MOVES')}
    ${grab('orgCamelot')}
    ${grab('orgKeyMatches')}
    ${grab('orgBpmRelated')}
    ${grab('orgRowPasses')}
    return { orgCamelot, orgKeyMatches, orgBpmRelated, orgRowPasses };
  `);
})();

const { orgBpmRelated, orgCamelot, orgKeyMatches } = filt({ bpm: false, key: 'off' }, () => 6);

test('a tempo inside the fader\'s range is related; outside it is not', () => {
  const tol = 0.06; // the ±6% the deck opens at
  assert.equal(orgBpmRelated(128, 128, tol), true);
  assert.equal(orgBpmRelated(132, 128, tol), true, '+3% is a nudge of the fader');
  assert.equal(orgBpmRelated(124, 128, tol), true);
  assert.equal(orgBpmRelated(140, 128, tol), false, '+9% is past the throw');
  assert.equal(orgBpmRelated(100, 128, tol), false);
});

test('half and double time count, because they are the same tempo', () => {
  const tol = 0.06;
  assert.equal(orgBpmRelated(70, 140, tol), true, 'a 70 under a 140 is half-time');
  assert.equal(orgBpmRelated(140, 70, tol), true, '...and the other way round');
  assert.equal(orgBpmRelated(172, 86, tol), true);
  // Still bounded at those tempos: a third of it is not a tempo you can reach.
  assert.equal(orgBpmRelated(47, 140, tol), false);
});

test('a wider range really is wider', () => {
  assert.equal(orgBpmRelated(140, 128, 0.06), false);
  assert.equal(orgBpmRelated(140, 128, 0.16), true, 'the ±16 switch reaches it');
});

test('a track with no tempo is related to nothing, and neither is a deck without one', () => {
  assert.equal(orgBpmRelated(null, 128, 0.06), false);
  assert.equal(orgBpmRelated(0, 128, 0.06), false);
  assert.equal(orgBpmRelated(128, null, 0.06), false);
  assert.equal(orgBpmRelated(128, 0, 0.06), false);
});

// --- keys onto the Camelot wheel ---------------------------------------------------------------
//
// The anchors worth pinning: 8B is C major and 8A its relative minor, A minor - both at hour 8,
// which is what makes "same number, other letter" mean "relative major/minor". One hour on is a
// fifth up, so 9B is G and 9A is E minor.

test('the wheel is anchored where every Camelot chart anchors it', () => {
  assert.deepEqual(orgCamelot('C'), { num: 8, minor: false });
  assert.deepEqual(orgCamelot('Am'), { num: 8, minor: true }, 'A minor shares C major\'s hour');
  assert.deepEqual(orgCamelot('G'), { num: 9, minor: false }, 'one hour on is a fifth up');
  assert.deepEqual(orgCamelot('Em'), { num: 9, minor: true });
  assert.deepEqual(orgCamelot('F'), { num: 7, minor: false }, 'and one hour back is a fifth down');
  assert.deepEqual(orgCamelot('Dm'), { num: 7, minor: true });
});

test('the three spellings a key tag arrives in all read the same', () => {
  // A plain name, sharp or flat, with or without a mode word.
  assert.deepEqual(orgCamelot('F#m'), { num: 11, minor: true });
  assert.deepEqual(orgCamelot('Gbm'), orgCamelot('F#m'), 'the same key spelled flat');
  assert.deepEqual(orgCamelot('Bbm'), { num: 3, minor: true });
  assert.deepEqual(orgCamelot('A minor'), orgCamelot('Am'));
  assert.deepEqual(orgCamelot('Abmaj'), orgCamelot('Ab'));
  assert.deepEqual(orgCamelot('CM'), orgCamelot('C'), 'an upper-case M is major, where m is minor');
  // A Camelot code, which is the wheel position outright...
  assert.deepEqual(orgCamelot('8A'), { num: 8, minor: true });
  assert.deepEqual(orgCamelot('11B'), { num: 11, minor: false });
  // ...and Open Key notation, the same twelve hours rotated so 1d is C major.
  assert.deepEqual(orgCamelot('1d'), orgCamelot('C'));
  assert.deepEqual(orgCamelot('1m'), orgCamelot('Am'));
});

test('a tag with no position on the wheel is no position, not a guess', () => {
  for (const bad of ['', null, undefined, 'H', 'Cdorian', 'Am7', 'instrumental', '13A', '0A']) {
    assert.equal(orgCamelot(bad), null, `"${bad}" should have no wheel position`);
  }
});

test('harmonic mixing is the four keys every chart names, and nothing else', () => {
  const ok = (k) => orgKeyMatches(k, 'Am', 'harmonic');
  assert.equal(ok('Am'), true, 'the same key');
  assert.equal(ok('Em'), true, 'one hour on - the fifth');
  assert.equal(ok('Dm'), true, 'one hour back');
  assert.equal(ok('C'), true, 'the relative major, at the same hour');
  assert.equal(ok('Bm'), false, 'two hours is an energy move, not a compatible key');
  assert.equal(ok('Bbm'), false);
  assert.equal(ok('G'), false, 'the major a fifth on is not at this hour');
});

test('the energy moves are the lifts, and they are opt-in', () => {
  assert.equal(orgKeyMatches('Bbm', 'Am', 'harmonic'), false);
  assert.equal(orgKeyMatches('Bbm', 'Am', 'energy'), true, 'a semitone up is the energy boost');
  assert.equal(orgKeyMatches('Abm', 'Am', 'energy'), true, 'and a semitone down');
  assert.equal(orgKeyMatches('Bm', 'Am', 'energy'), true, 'a whole tone up');
  // Still a selection: the energy set is wider, not everything.
  assert.equal(orgKeyMatches('Ebm', 'Am', 'energy'), false);
});

test('the same-key rule takes only the identical key, and off takes everything', () => {
  assert.equal(orgKeyMatches('Am', 'Am', 'same'), true);
  assert.equal(orgKeyMatches('8A', 'Am', 'same'), true, 'the same key, spelled as a code');
  assert.equal(orgKeyMatches('C', 'Am', 'same'), false, 'not even the relative major');
  assert.equal(orgKeyMatches('anything', 'Am', 'off'), true);
  assert.equal(orgKeyMatches('', '', 'off'), true);
});

test('a key the wheel cannot place matches nothing, either side of the question', () => {
  assert.equal(orgKeyMatches('', 'Am', 'harmonic'), false, 'an untagged track is not compatible');
  assert.equal(orgKeyMatches('Am', '', 'harmonic'), false, 'and neither is a deck with no key');
});

// --- the row filter ----------------------------------------------------------------------------
//
// What the two questions do to one row. The cases that are easy to get wrong: a row is judged on
// the facts it HAS (no key is not "compatible"), a folder is a place rather than an entry and so
// is never filtered away, and the record the filter is pointed at is not a candidate to follow
// itself.

const REF = { bpm: 128, key: 'Am', path: '/m/now.mp3', title: 'Now' };
const passes = (filter, row, ref = REF) =>
  filt(filter, () => filter.tol ?? 6).orgRowPasses(row, ref);

test('the tempo filter keeps what the fader can reach and drops what it cannot', () => {
  const on = { bpm: true, key: 'off' };
  assert.equal(passes(on, { bpm: 130, path: '/m/a.mp3' }), true);
  assert.equal(passes(on, { bpm: 64, path: '/m/b.mp3' }), true, 'half-time is the same tempo');
  assert.equal(passes(on, { bpm: 145, path: '/m/c.mp3' }), false);
  assert.equal(passes(on, { bpm: null, path: '/m/d.mp3' }), false, 'an unknown tempo is not a match');
});

test('the key filter drops a row that has no key to judge', () => {
  const on = { bpm: false, key: 'harmonic' };
  assert.equal(passes(on, { musKey: 'C', path: '/m/a.mp3' }), true);
  assert.equal(passes(on, { musKey: 'Ebm', path: '/m/b.mp3' }), false);
  // A livecode save has no key at all - so a key filter is a question it cannot answer.
  assert.equal(passes(on, { musKey: '', kind: 'saved' }), false);
});

test('both filters on means both have to pass', () => {
  const both = { bpm: true, key: 'harmonic' };
  assert.equal(passes(both, { bpm: 130, musKey: 'Em', path: '/m/a.mp3' }), true);
  assert.equal(passes(both, { bpm: 130, musKey: 'Ebm', path: '/m/b.mp3' }), false, 'wrong key');
  assert.equal(passes(both, { bpm: 145, musKey: 'Em', path: '/m/c.mp3' }), false, 'wrong tempo');
});

test('a folder is never filtered away, and the deck\'s own record never survives', () => {
  const on = { bpm: true, key: 'harmonic' };
  assert.equal(passes(on, { kind: 'dir', name: 'techno' }), true,
    'a folder is a place, not an entry - filtering it away would wall off the tree');
  assert.equal(passes(on, { bpm: 128, musKey: 'Am', path: REF.path }), false,
    'the record being mixed out of is not a candidate to follow itself');
});

test('with no deck to measure against, the filter shows nothing rather than everything', () => {
  // The alternative - quietly showing the whole crate - would read as the filter being off.
  assert.equal(passes({ bpm: true, key: 'off' }, { bpm: 128, path: '/m/a.mp3' }, null), false);
});

// --- editing a selection ------------------------------------------------------------------------
//
// One edit, typed into one row's cells, lands on every selected track. What makes that safe is
// that an UNCHANGED field is not an instruction: fixing the artist on twelve files that all came
// in wrong writes the artist twelve times and leaves each record's own title alone. Writing every
// field instead would stamp the edited row's title over the other eleven, which is the failure
// this is shaped to prevent.

const { orgEditChanges } = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
  const at = src.indexOf('function orgEditChanges(');
  assert.ok(at > 0, 'orgEditChanges not found in client.js - this test needs updating');
  let depth = 0;
  let end = src.indexOf('{', at);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, end)}\nreturn { orgEditChanges };`)();
})();

const WAS = { title: 'Bleep Test', artist: 'Someone', album: 'An Album', bpm: '128', key: 'Am' };
const typedAs = (over) => Object.entries({ ...WAS, ...over }).map(([field, text]) => ({ field, text }));

test('only the field that was changed is written', () => {
  const { fields, refused } = orgEditChanges(typedAs({ artist: 'Karenn' }), WAS);
  assert.deepEqual(fields, { artist: 'Karenn' },
    'the title, album, tempo and key were not touched, so they are not instructions');
  assert.equal(refused, '');
});

test('a commit that changed nothing asks for nothing', () => {
  assert.deepEqual(orgEditChanges(typedAs({}), WAS).fields, {});
});

test('several changed fields all travel', () => {
  const { fields } = orgEditChanges(typedAs({ artist: 'Karenn', album: 'Grapefruit', key: 'Cm' }), WAS);
  assert.deepEqual(fields, { artist: 'Karenn', album: 'Grapefruit', key: 'Cm' });
});

test('clearing a field is a change, and says so as null', () => {
  assert.deepEqual(orgEditChanges(typedAs({ album: '' }), WAS).fields, { album: null });
  // The title cleared is not nothing: the server falls it back to the file's own name.
  assert.deepEqual(orgEditChanges(typedAs({ title: '' }), WAS).fields, { title: null });
});

test('a retyped title IS written - the guard is "unchanged", not "never the title"', () => {
  // Deliberately renaming a selection has to work; it is only the untouched title that stays put.
  assert.deepEqual(orgEditChanges(typedAs({ title: 'Bleep Test 2' }), WAS).fields,
    { title: 'Bleep Test 2' });
});

test('a tempo is taken as a number, and a bad one is refused without losing the rest', () => {
  const ok = orgEditChanges(typedAs({ bpm: '140' }), WAS);
  assert.deepEqual(ok.fields, { bpm: 140 }, 'a number, not the typed string');
  const bad = orgEditChanges(typedAs({ bpm: '900', artist: 'Karenn' }), WAS);
  assert.deepEqual(bad.fields, { artist: 'Karenn' }, 'the corrected artist still lands');
  assert.match(bad.refused, /20 to 400/);
  assert.deepEqual(orgEditChanges(typedAs({ bpm: 'fast' }), WAS).fields, {});
  // ...and a blank tempo is a clear, not a refusal.
  assert.deepEqual(orgEditChanges(typedAs({ bpm: '' }), WAS).fields, { bpm: null });
});

test('a field with nothing to start from counts as changed once something is typed', () => {
  // An untagged import: artist was blank, so `was` has no entry for it at all.
  assert.deepEqual(orgEditChanges([{ field: 'artist', text: 'Karenn' }], {}), 
    { fields: { artist: 'Karenn' }, refused: '' });
  assert.deepEqual(orgEditChanges([{ field: 'artist', text: '' }], {}).fields, {},
    'blank over blank is still untouched');
});
