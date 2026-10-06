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
  savedPatternNames,
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipFallbackLabel,
  wipOlderThan,
  pruneWipSessions,
  nativeBpmOf,
  readLibrary,
  writeLibrary,
  importTracks,
  editTrack,
  setTrackFacts,
  setTrackAnchor,
  forgetTracks,
} = require('./pattern-files');

function write(rel, code) {
  const file = path.join(DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

test('patternFilePath builds a path inside the patterns dir, folders and all', () => {
  assert.equal(patternFilePath('drift'), path.join(DIR, 'drift.js'));
  assert.equal(patternFilePath('  drift  '), path.join(DIR, 'drift.js'));
  // A name may name folders - that is how a save is filed - and each segment is trimmed.
  assert.equal(patternFilePath('techno/drift'), path.join(DIR, 'techno', 'drift.js'));
  assert.equal(patternFilePath(' techno / drift '), path.join(DIR, 'techno', 'drift.js'));
  assert.equal(patternFilePath('a/b/c/drift'), path.join(DIR, 'a', 'b', 'c', 'drift.js'));
});

test('patternFilePath refuses a name that could climb out of the patterns dir', () => {
  const bad = [
    '', '   ',
    '.hidden',
    '../escape',
    'sub/../../escape',
    'sub/.hidden',
    'techno/',              // trailing slash: a mis-typed name, not a folder
    '/techno/drift',        // leading slash likewise
    'techno//drift',
    'sub\\drift',           // one separator, on every platform
    'x'.repeat(256),
    `${'a/'.repeat(17)}drift`, // deeper than the segment cap
  ];
  for (const name of bad) {
    assert.throws(() => patternFilePath(name), /pattern name/, `expected "${name}" to be refused`);
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

// A save may be filed in a folder, and the name carries the folders ("techno/stomper") - it is
// one string, so a playlist holding it needs no second notion of where it lives. Cleans up after
// itself: the listing tests around it assert on exactly what they put there.
test('savedPatternNames walks subfolders, skipping sessions and dot-folders', () => {
  const made = [
    write(path.join('zz-set', 'stomper.js'), '// @title stomper\nbass: note("c1")'),
    write(path.join('zz-set', 'deep', 'buried.js'), '// buried'),
    write(path.join('zz-set', 'notes.txt'), 'not a pattern'),
    write(path.join('.zz-hidden', 'secret.js'), '// skipped'),
    write(path.join('wip', '2026-01', '2026-01-01-010101.js'), '// a session'),
  ];
  try {
    const names = savedPatternNames();
    assert.ok(names.includes('zz-set/stomper'), 'a nested save is found');
    assert.ok(names.includes('zz-set/deep/buried'), 'nesting goes deeper than one level');
    assert.ok(!names.some((n) => n.startsWith('wip/')), 'sessions are their own kind, not saves');
    assert.ok(!names.some((n) => n.includes('zz-hidden')), 'a dot-folder stays out of the library');
    assert.ok(!names.some((n) => n.endsWith('notes')), 'only .js files are patterns');

    const byName = Object.fromEntries(listSavedPatterns().map((p) => [p.name, p]));
    assert.equal(byName['zz-set/stomper'].folder, 'zz-set', 'the row says where it is filed');
    assert.equal(byName['zz-set/deep/buried'].folder, 'zz-set/deep');
    assert.equal(byName['night-drive'].folder, undefined, 'a top-level save has no folder');
    assert.equal(byName['zz-set/stomper'].label, 'stomper', '@title still wins for a nested save');
  } finally {
    for (const file of made) fs.rmSync(file, { force: true });
    fs.rmSync(path.join(DIR, 'zz-set'), { recursive: true, force: true });
    fs.rmSync(path.join(DIR, '.zz-hidden'), { recursive: true, force: true });
    fs.rmSync(path.join(DIR, 'wip', '2026-01'), { recursive: true, force: true });
  }
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

// --- native bpm (read from the source at list time, never stored) ---

test('nativeBpmOf reads the last plain-number setbpm, quoted or not', () => {
  assert.equal(nativeBpmOf('setbpm(120)'), 120);
  assert.equal(nativeBpmOf('setbpm(120)\nsetbpm("140")'), 140, 'the last one is the one an eval leaves in force');
  assert.equal(nativeBpmOf('setbpm(87.5)'), 87.5);
});

// Declaring nothing is declaring 120: that is the tempo the transport opens at, so it is what
// the save plays at, and it is what the desk has always read a silent buffer as (deckNativeBpm).
// Only a SIGNAL tempo is unknown - there is no single number to report for it.
test('a buffer that never says a tempo reads as 120, and a signal tempo as unknown', () => {
  assert.equal(nativeBpmOf('kick: s("bd*4")'), 120, 'no tempo declared is the default tempo');
  assert.equal(nativeBpmOf(''), 120);
  assert.equal(nativeBpmOf('setbpm("<120 140>")'), null, 'a signal tempo has no single native bpm');
  assert.equal(nativeBpmOf('setbpm(lfo(0.1).range(120, 140))'), null);
  // Someone else's function is not a tempo declaration, so these buffers declare nothing at all.
  assert.equal(nativeBpmOf('mysetbpm(99)'), 120, 'someone else\'s function is not a tempo');
  assert.equal(nativeBpmOf('x.setbpm(99)'), 120, 'a method is not the host builder');
});

test('listings carry the native bpm', () => {
  write('tempoed.js', 'setbpm(133)\nkick: s("bd*4")');
  const entry = listSavedPatterns().find((p) => p.name === 'tempoed');
  assert.equal(entry.bpm, 133);
});

// --- the library (playlists; one library.json beside the pattern files) ---

test('an empty or unreadable library reads as an empty one', () => {
  const empty = { version: 2, tracks: [], playlists: [], active: null, saves: {} };
  assert.deepEqual(readLibrary(), empty);
  write('library.json', 'not json at all {');
  assert.deepEqual(readLibrary(), empty);
});

test('writeLibrary normalizes and round-trips', () => {
  const kept = writeLibrary({
    playlists: [
      { id: 'set1', name: 'friday', items: ['a', 'b', 'a', 42, null] }, // repeats stay, junk goes
      { name: 'untitled-shape', items: 'nope' }, // no id -> minted; bad items -> empty
      { notAName: true }, // no name -> dropped
    ],
    active: 'set1',
    extra: 'ignored',
  });
  assert.equal(kept.version, 2);
  assert.equal(kept.playlists.length, 2);
  assert.deepEqual(kept.playlists[0], { id: 'set1', name: 'friday', items: ['a', 'b', 'a'] });
  assert.ok(kept.playlists[1].id, 'a playlist without an id is given one');
  assert.deepEqual(kept.playlists[1].items, []);
  assert.equal(kept.active, 'set1');
  assert.deepEqual(readLibrary(), kept, 'what was kept is what a later read sees');
});

// A set holds a reference; the facts live on the track record. What goes IN is the hydrated
// shape the UI reads and posts back ({ kind: 'file', path, ... }), and a path with no record yet
// is imported on the spot - which is what makes every gesture that uses a file also file it.
test('a file item is collapsed to a track reference and hydrated back', () => {
  const kept = writeLibrary({
    playlists: [{
      id: 'set1',
      name: 'friday',
      items: [
        'a-save',
        { kind: 'file', path: '/music/one.mp3', title: ' One ', bpm: '124', key: 'Am', junk: 'no' },
        { kind: 'file', path: '/music/two.wav' }, // the bare minimum: kind + path
        { kind: 'file', path: '   ' }, // no path -> dropped
        { kind: 'file', path: '/x.mp3', bpm: 9000, key: '  ' }, // silly bpm / blank key -> absent
        { kind: 'nope', path: '/x.mp3' }, // unknown kind -> dropped
        { path: '/x.mp3' }, // no kind -> dropped
      ],
    }],
    active: 'set1',
  });

  assert.equal(kept.tracks.length, 3, 'three distinct paths became three tracks');
  const byPath = Object.fromEntries(kept.tracks.map((t) => [t.path, t]));
  assert.equal(byPath['/music/one.mp3'].title, 'One', 'the item\'s facts moved onto the record');
  assert.equal(byPath['/music/one.mp3'].bpm, 124);
  assert.equal(byPath['/music/one.mp3'].key, 'Am');
  assert.equal(byPath['/music/one.mp3'].junk, undefined, 'junk fields do not ride along');
  assert.equal(byPath['/music/two.wav'].title, 'two', 'an untitled file is called its file name');
  assert.equal(byPath['/x.mp3'].bpm, undefined, 'a silly tempo is no tempo');
  assert.equal(byPath['/x.mp3'].key, undefined, 'a blank key is no key');
  assert.ok(byPath['/x.mp3'].added > 0, 'a track records when it was added');

  const items = kept.playlists[0].items;
  assert.equal(items.length, 4);
  assert.equal(items[0], 'a-save', 'a named save stays a bare string');
  assert.equal(items[1].kind, 'file', 'a track reads back in the shape the decks speak');
  assert.equal(items[1].path, '/music/one.mp3');
  assert.equal(items[1].title, 'One');
  assert.equal(items[1].trackId, byPath['/music/one.mp3'].id, 'the row can find its record again');
  assert.equal(items[1].id, undefined, 'the record\'s id rides as trackId, not as the item\'s own');

  assert.deepEqual(readLibrary(), kept, 'the collapse round-trips');
  // On disk it is a reference, not a copy of the facts - that is the point of the collection.
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'library.json'), 'utf8'));
  assert.deepEqual(raw.playlists[0].items[1], { kind: 'track', id: byPath['/music/one.mp3'].id });
});

test('one file in two sets is one track, and editing it is one edit', () => {
  const kept = writeLibrary({
    tracks: [], // stated, because a document with no tracks key keeps the collection on disk
    playlists: [
      { id: 'a', name: 'friday', items: [{ kind: 'file', path: '/music/same.mp3', title: 'Same' }] },
      { id: 'b', name: 'saturday', items: [{ kind: 'file', path: '/music/same.mp3' }] },
    ],
  });
  assert.equal(kept.tracks.length, 1, 'the same path is the same track');
  const id = kept.tracks[0].id;
  assert.equal(kept.playlists[0].items[0].trackId, id);
  assert.equal(kept.playlists[1].items[0].trackId, id);
  assert.equal(kept.playlists[1].items[0].title, 'Same', 'both sets read the one record');

  // The browser edits the record, not the row: the correction shows up in every set at once.
  const edited = writeLibrary({ ...kept, tracks: [{ ...kept.tracks[0], bpm: 128 }] });
  assert.equal(edited.playlists[0].items[0].bpm, 128);
  assert.equal(edited.playlists[1].items[0].bpm, 128);
});

test('a track nothing plays is still in the collection', () => {
  const kept = writeLibrary({
    tracks: [{ id: 't1', path: '/music/lonely.mp3', title: 'Lonely' }],
    playlists: [],
  });
  assert.equal(kept.tracks.length, 1, 'importing is not queueing - the collection stands alone');
  assert.deepEqual(readLibrary().tracks, kept.tracks);
});

// A reference whose record is gone is the one slot that CANNOT be kept as missing: the record
// held the path and the title, so a dangling id says nothing about what the song was and gives
// the user nothing to repair. It drops, which is why removing a track from the collection has to
// say how many sets play it before it goes (a deleted FILE is different - its record and its row
// both stay, and render as missing).
test('a reference to a track that is gone drops out of its playlist', () => {
  const kept = writeLibrary({
    tracks: [],
    playlists: [{ id: 'a', name: 'friday', items: [{ kind: 'track', id: 'vanished' }] }],
  });
  assert.deepEqual(kept.playlists[0].items, []);

  // Same for a library edited by hand: it reads as a shorter set, never as a throw.
  write('library.json', JSON.stringify({
    version: 2,
    tracks: [],
    playlists: [{ id: 'a', name: 'friday', items: [{ kind: 'track', id: 'vanished' }, 'a-save'] }],
    active: null,
  }));
  assert.deepEqual(readLibrary().playlists[0].items, ['a-save']);
});

test('a duplicated track id or path resolves to one record', () => {
  const kept = writeLibrary({
    tracks: [
      { id: 'dup', path: '/music/first.mp3', title: 'First', bpm: 120 },
      { id: 'dup', path: '/music/second.mp3', title: 'Second' }, // same id, another file
      { id: 'other', path: '/music/first.mp3', title: 'Also first' }, // same file, another id
    ],
    playlists: [{ id: 'a', name: 'friday', items: [{ kind: 'track', id: 'other' }] }],
  });
  const paths = kept.tracks.map((t) => t.path).sort();
  assert.deepEqual(paths, ['/music/first.mp3', '/music/second.mp3'], 'one record per file');
  assert.equal(kept.tracks.find((t) => t.path === '/music/first.mp3').title, 'First',
    'the first record for a path wins - a later bare one never overwrites a corrected one');
  // The loser's id still resolves, so a set pointing at it keeps playing the right file.
  assert.equal(kept.playlists[0].items[0].path, '/music/first.mp3');
});

test('playlists carry a folder, flat on disk', () => {
  const kept = writeLibrary({
    playlists: [
      { id: 'a', name: 'friday', folder: ' club / 2026 ' },
      { id: 'b', name: 'loose', folder: '   ' }, // blank -> no folder
      { id: 'c', name: 'odd', folder: '//x//' },
    ],
  });
  assert.equal(kept.playlists[0].folder, 'club/2026');
  assert.equal(kept.playlists[1].folder, undefined);
  assert.equal(kept.playlists[2].folder, 'x');
});

// The intake. Tag reading is injected, so this is plain filesystem work with no audio file.
test('importTracks adds a file once and fills only gaps on re-import', () => {
  writeLibrary({ tracks: [], playlists: [] });
  const tags = {
    '/music/tagged.mp3': { title: 'Real Title', artist: 'Someone', bpm: 128, key: 'Am' },
    '/music/bare.wav': {},
  };
  const readTags = (p) => tags[p] ?? {};

  const first = importTracks(['/music/tagged.mp3', '/music/bare.wav'], { readTags });
  assert.equal(first.added.length, 2);
  assert.equal(first.already.length, 0);
  const byPath = Object.fromEntries(first.library.tracks.map((t) => [t.path, t]));
  assert.equal(byPath['/music/tagged.mp3'].title, 'Real Title', 'tags name the track');
  assert.equal(byPath['/music/tagged.mp3'].artist, 'Someone');
  assert.equal(byPath['/music/tagged.mp3'].bpm, 128);
  assert.equal(byPath['/music/bare.wav'].title, 'bare', 'an untagged file is called its file name');

  // Importing again is the no-op that lets any gesture fire it.
  const again = importTracks(['/music/tagged.mp3'], { readTags });
  assert.equal(again.added.length, 0);
  assert.equal(again.already.length, 1);
  assert.equal(again.library.tracks.length, 2, 'no second record for the same file');

  // A hand-corrected tempo outlives a re-import; a field the record lacks is filled.
  const corrected = writeLibrary({
    ...again.library,
    tracks: again.library.tracks.map((t) => (t.path === '/music/tagged.mp3' ? { ...t, bpm: 174 } : t)),
  });
  assert.equal(corrected.tracks.find((t) => t.path === '/music/tagged.mp3').bpm, 174);
  tags['/music/tagged.mp3'].album = 'An Album';
  const third = importTracks(['/music/tagged.mp3'], { readTags });
  const track = third.library.tracks.find((t) => t.path === '/music/tagged.mp3');
  assert.equal(track.bpm, 174, 'the tempo typed by hand is the better fact');
  assert.equal(track.album, 'An Album', 'a field the record lacked is filled from the tags');
});

test('importTracks survives a file whose tags cannot be read', () => {
  writeLibrary({ tracks: [], playlists: [] });
  const { library, added } = importTracks(['/music/broken.mp3'], {
    readTags: () => { throw new Error('unreadable'); },
  });
  assert.equal(added.length, 1, 'a tag read is advisory, never a failed import');
  assert.equal(library.tracks[0].title, 'broken');
});

// --- ratings, hand edits, rescans and what analysis is allowed to write ----------------------

test('a rating is 1 to 5 stars, or absent', () => {
  const kept = writeLibrary({
    tracks: [
      { id: 'a', path: '/m/a.mp3', rating: 4 },
      { id: 'b', path: '/m/b.mp3', rating: 3.6 }, // rounded
      { id: 'c', path: '/m/c.mp3', rating: 0 }, // unrated, not zero stars
      { id: 'd', path: '/m/d.mp3', rating: 9 },
      { id: 'e', path: '/m/e.mp3', rating: 'lots' },
    ],
    playlists: [],
  });
  const by = Object.fromEntries(kept.tracks.map((t) => [t.id, t.rating]));
  assert.deepEqual(by, { a: 4, b: 4, c: undefined, d: undefined, e: undefined });
});

test('editTrack marks what it set as typed by hand', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3', title: 'One' }], playlists: [] });
  const lib = editTrack('t', { artist: 'Someone', bpm: 128 });
  const t = lib.tracks[0];
  assert.equal(t.artist, 'Someone');
  assert.equal(t.bpm, 128);
  assert.deepEqual(t.byHand, ['artist', 'bpm'], 'both are now the user\'s word');
});

test('editTrack clears a field, and a cleared title falls back to the file name', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3', title: 'One', artist: 'Someone' }], playlists: [] });
  const lib = editTrack('t', { artist: '', title: null });
  assert.equal(lib.tracks[0].artist, undefined);
  assert.equal(lib.tracks[0].title, 'one', 'the file name stands in');
});

test('editTrack rates several tracks in one call, and 0 unrates', () => {
  writeLibrary({
    tracks: [{ id: 'a', path: '/m/a.mp3' }, { id: 'b', path: '/m/b.mp3' }],
    playlists: [],
  });
  let lib = editTrack(['a', 'b'], { rating: 5 });
  assert.deepEqual(lib.tracks.map((t) => t.rating), [5, 5]);
  lib = editTrack(['a'], { rating: 0 });
  assert.equal(lib.tracks.find((t) => t.id === 'a').rating, undefined);
  assert.equal(lib.tracks.find((t) => t.id === 'b').rating, 5);
  // A rating is nobody's but the listener's, so it is never claimed as a tag field.
  assert.equal(lib.tracks.find((t) => t.id === 'b').byHand, undefined);
});

test('editTrack answers null for a track that is not there', () => {
  writeLibrary({ tracks: [], playlists: [] });
  assert.equal(editTrack('nope', { rating: 3 }), null);
});

test('a rescan takes the file\'s word, except where the user typed one', () => {
  writeLibrary({ tracks: [], playlists: [] });
  const tags = { '/m/one.mp3': { title: 'Old Title', artist: 'Old Artist', bpm: 120 } };
  const readTags = (p) => tags[p] ?? {};
  importTracks(['/m/one.mp3'], { readTags });

  // The user fixes the tempo by hand; the file is then retagged in some other app.
  editTrack(readLibrary().tracks[0].id, { bpm: 174 });
  tags['/m/one.mp3'] = { title: 'New Title', artist: 'New Artist', bpm: 125, key: 'Am' };

  // A plain re-import cannot correct any of it - those fields are no longer gaps.
  let t = importTracks(['/m/one.mp3'], { readTags }).library.tracks[0];
  assert.equal(t.title, 'Old Title', 'gap filling leaves a wrong value alone');
  assert.equal(t.key, 'Am', '...but still fills what was missing');

  // A rescan does, and still keeps the tempo that was typed.
  t = importTracks(['/m/one.mp3'], { readTags, mode: 'rescan' }).library.tracks[0];
  assert.equal(t.title, 'New Title');
  assert.equal(t.artist, 'New Artist');
  assert.equal(t.bpm, 174, 'the tempo typed by hand outlives a rescan');
});

test('a rescan never empties a field the file has stopped mentioning', () => {
  writeLibrary({ tracks: [], playlists: [] });
  const readTags = () => ({ title: 'One', artist: 'Someone', album: 'An Album' });
  importTracks(['/m/one.mp3'], { readTags });
  // An absent tag and a deleted tag both arrive as null, so clearing on absence would throw good
  // metadata away every time a file happened to be tagged thinly. A rescan adds and corrects.
  const t = importTracks(['/m/one.mp3'], { readTags: () => ({ title: 'One v2' }), mode: 'rescan' })
    .library.tracks[0];
  assert.equal(t.title, 'One v2', 'what the file says is taken');
  assert.equal(t.artist, 'Someone', 'what it no longer says is kept');
  assert.equal(t.album, 'An Album');
});

test('a hand-placed beatgrid anchor lives on the record, and only a sane one', () => {
  const kept = writeLibrary({
    tracks: [
      { id: 'a', path: '/m/a.mp3', anchorSec: 8.251 },
      { id: 'b', path: '/m/b.mp3', anchorSec: -2 },
      { id: 'c', path: '/m/c.mp3', anchorSec: 'start' },
    ],
    playlists: [{ id: 'p', name: 'set', items: [{ kind: 'track', id: 'a' }] }],
  });
  const by = Object.fromEntries(kept.tracks.map((t) => [t.id, t.anchorSec]));
  assert.equal(by.a, 8.251);
  assert.equal(by.b, undefined, 'a negative anchor is junk, not a fact');
  assert.equal(by.c, undefined);
  // The hydrated playlist row carries it too - the decks read rows, not records.
  assert.equal(kept.playlists[0].items[0].anchorSec, 8.251);
});

test('setTrackAnchor writes, forgets, and refuses what makes no sense', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3' }], playlists: [] });
  assert.ok(setTrackAnchor('/m/one.mp3', 3.5));
  assert.equal(readLibrary().tracks[0].anchorSec, 3.5);
  assert.equal(setTrackAnchor('/m/one.mp3', -1), null, 'a bad anchor is refused...');
  assert.equal(readLibrary().tracks[0].anchorSec, 3.5, '...and the stored one survives the refusal');
  assert.ok(setTrackAnchor('/m/one.mp3', null), 'null forgets it (the re-analyze gesture)');
  assert.equal(readLibrary().tracks[0].anchorSec, undefined);
  assert.equal(setTrackAnchor('/m/one.mp3', null), null, 'forgetting nothing is a no-op, not a file write');
  assert.equal(setTrackAnchor('/m/missing.mp3', 1), null, 'a file with no record has nowhere to hold one');
});

test('a rescan leaves the anchor alone - no tag could ever hold one', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3', title: 'One' }], playlists: [] });
  setTrackAnchor('/m/one.mp3', 12.01);
  const { library } = importTracks(['/m/one.mp3'], {
    readTags: () => ({ title: 'Retagged', bpm: 130 }),
    mode: 'rescan',
  });
  const t = library.tracks.find((x) => x.path === '/m/one.mp3');
  assert.equal(t.title, 'Retagged', 'the rescan did run');
  assert.equal(t.anchorSec, 12.01, 'the hand-placed grid is not the tags\' to replace');
});

test('analysis fills a tempo the file never stated, and never one it did', () => {
  writeLibrary({ tracks: [], playlists: [] });
  // One file with a tempo tag, one without.
  const tags = {
    '/m/tagged.mp3': { title: 'Tagged', bpm: 128 },
    '/m/bare.mp3': { title: 'Bare' },
  };
  importTracks(Object.keys(tags), { readTags: (p) => tags[p] });

  setTrackFacts('/m/tagged.mp3', { bpm: 127.98, key: 'Am' });
  setTrackFacts('/m/bare.mp3', { bpm: 124.5, key: 'Fm' });
  const by = Object.fromEntries(readLibrary().tracks.map((t) => [t.path, t]));

  assert.equal(by['/m/tagged.mp3'].bpm, 128, "the file's own tempo is trusted over a measurement");
  assert.equal(by['/m/tagged.mp3'].key, 'Am', '...but the key it never stated is filled in');
  assert.deepEqual(by['/m/tagged.mp3'].detected, ['key'], 'and only that one reads as an estimate');
  assert.equal(by['/m/bare.mp3'].bpm, 124.5, 'an untagged tempo is measured');
  assert.deepEqual(by['/m/bare.mp3'].detected, ['bpm', 'key']);
  assert.ok(by['/m/bare.mp3'].analyzed > 0, 'and the record remembers it was measured');
});

test('analysis leaves a hand-typed tempo alone, even when the record had none', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3', title: 'One' }], playlists: [] });
  editTrack('t', { bpm: 140 });
  setTrackFacts('/m/one.mp3', { bpm: 70.1 });
  assert.equal(readLibrary().tracks[0].bpm, 140);
});

test('a measurement that found nothing still marks the record, so it is not retried forever', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3' }], playlists: [] });
  setTrackFacts('/m/one.mp3', {});
  const t = readLibrary().tracks[0];
  assert.ok(t.analyzed > 0);
  assert.equal(t.bpm, undefined);
  assert.equal(t.detected, undefined);
});

test('a hand edit takes a field off the estimate list', () => {
  writeLibrary({ tracks: [{ id: 't', path: '/m/one.mp3' }], playlists: [] });
  setTrackFacts('/m/one.mp3', { bpm: 124.5, key: 'Fm' });
  const lib = editTrack('t', { bpm: 125 });
  assert.deepEqual(lib.tracks[0].detected, ['key'], 'the tempo is no longer a guess; the key still is');
});

test('forgetTracks takes records out of the collection and out of every set', () => {
  writeLibrary({
    tracks: [{ id: 'a', path: '/m/a.mp3' }, { id: 'b', path: '/m/b.mp3' }],
    playlists: [{
      id: 'p',
      name: 'friday',
      items: [{ kind: 'file', path: '/m/a.mp3' }, 'a-save', { kind: 'file', path: '/m/b.mp3' }],
    }],
  });
  const { library, forgot } = forgetTracks(['a']);
  assert.equal(forgot, 1);
  assert.deepEqual(library.tracks.map((t) => t.id), ['b']);
  // The slot goes with the record (a reference with no record says nothing), the save stays.
  assert.deepEqual(library.playlists[0].items.map((i) => (typeof i === 'string' ? i : i.path)),
    ['a-save', '/m/b.mp3']);
});

// The collection is the server's: a background pass writes tempos into records while the editor
// has the document open, so the editor posts playlists WITHOUT tracks and the write keeps its own.
test('a document posted with no tracks keeps the collection that is on disk', () => {
  writeLibrary({
    tracks: [{ id: 't', path: '/m/one.mp3', title: 'One', bpm: 128, rating: 5 }],
    playlists: [{ id: 'p', name: 'friday', items: [] }],
  });
  const posted = writeLibrary({ playlists: [{ id: 'p', name: 'renamed', items: [] }] });
  assert.equal(posted.playlists[0].name, 'renamed', 'the playlist edit landed');
  assert.equal(posted.tracks.length, 1, 'the collection survived');
  assert.equal(posted.tracks[0].bpm, 128);
  assert.equal(posted.tracks[0].rating, 5);
  // An EMPTY array is still a deliberate statement, and empties it.
  assert.deepEqual(writeLibrary({ tracks: [], playlists: [] }).tracks, []);
});

test('importTracks skips blanks and leaves the sets it is not about alone', () => {
  writeLibrary({ tracks: [], playlists: [{ id: 'a', name: 'friday', items: ['a-save'] }] });
  const { library, added } = importTracks(['', '   ', null, '/music/one.mp3'], { readTags: null });
  assert.equal(added.length, 1);
  assert.deepEqual(library.playlists[0].items, ['a-save']);
});

test('an active id that names no playlist clears to null', () => {
  const kept = writeLibrary({ playlists: [{ id: 'p', name: 'x', items: [] }], active: 'gone' });
  assert.equal(kept.active, null);
});
