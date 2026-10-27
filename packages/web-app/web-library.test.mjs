// The music library in the page (public/web/library.mjs): importing from the music folder with
// each file's own tags, the measuring pass, edits by hand and by the decks, forgetting - over the
// page's storage and the desktop's own library rules (library-tracks.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { memoryStore } from './public/web/kv.mjs';
import { createStorage } from './public/web/storage.mjs';
import { createLibrary } from './public/web/library.mjs';
import { libraryTracks } from './public/web/library-doc.mjs';

const require = createRequire(import.meta.url);
const meta = require('./public/pattern-meta.js');

/** A music folder of these paths, as music-folder.mjs answers for one. */
function fakeFolder(paths) {
  const set = new Set(paths);
  return {
    has: (p) => set.has(p),
    find: async (name) => [...set].find((p) => p.endsWith(`/${name}`)) ?? null,
    walk: (dir) => {
      const prefix = `${dir.replace(/\/$/, '')}/`;
      return { path: dir, files: [...set].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)) };
    },
  };
}

/** The song source: tags and measurements by path, and which paths were read. */
function fakeSongs({ tags = {}, facts = {} } = {}) {
  const read = [];
  const measured = [];
  return {
    read,
    measured,
    tags: async (p) => { read.push(p); return tags[p] ?? {}; },
    measure: async (p) => {
      measured.push(p);
      if (facts[p] === 'broken') throw new Error('cannot decode');
      return facts[p] ?? {};
    },
  };
}

function makeLibrary({ paths = [], tags, facts, desk = null } = {}) {
  const store = memoryStore();
  const storage = createStorage(store, { meta });
  const songs = fakeSongs({ tags, facts });
  const library = createLibrary({ storage, libraryTracks, folder: fakeFolder(paths), songs, desk, store });
  const call = (route, body) => library.routes[route](body);
  return { store, storage, songs, library, call };
}

/** Until the measuring pass has nothing left. */
async function passDone(library) {
  for (let i = 0; i < 1000 && library.state(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(library.state(), null, 'the pass finished');
}

const byPath = (doc) => Object.fromEntries(doc.tracks.map((t) => [t.path, t]));

test('a folder imports with what each file says about itself, and the rest is measured', async () => {
  const rig = makeLibrary({
    paths: ['/music/set/a.mp3', '/music/set/b.wav', '/music/other.wav'],
    tags: { '/music/set/a.mp3': { title: 'Night Drive', artist: 'Someone', album: 'Late', bpm: 128, key: 'Am' } },
    facts: { '/music/set/b.wav': { bpm: 122.5, key: 'Cm' } },
  });
  const res = await rig.call('POST /api/library/import', { dir: '/music/set' });
  assert.equal(res.added, 2);
  assert.equal(res.queued, 1, 'only the file whose tags left gaps is measured');
  const added = byPath(res.library);
  assert.equal(added['/music/set/a.mp3'].title, 'Night Drive');
  assert.equal(added['/music/set/a.mp3'].bpm, 128);
  assert.equal(added['/music/set/b.wav'].title, 'b');
  await passDone(rig.library);
  const doc = byPath(await rig.call('GET /api/library'));
  assert.equal(doc['/music/set/b.wav'].bpm, 122.5);
  assert.deepEqual(doc['/music/set/b.wav'].detected, ['bpm', 'key']);
  assert.ok(doc['/music/set/b.wav'].analyzed > 0);
  assert.equal(doc['/music/set/a.mp3'].detected, undefined, 'a tagged tempo is the file\'s word, not an estimate');
  // Importing again finds them and reads no tags for records with nothing missing.
  rig.songs.read.length = 0;
  const again = await rig.call('POST /api/library/import', { paths: ['/music/set/a.mp3'] });
  assert.deepEqual([again.added, again.already], [0, 1]);
  assert.deepEqual(rig.songs.read, []);
});

test('several folders and loose files import in one request, each file once', async () => {
  const rig = makeLibrary({ paths: ['/music/x/1.wav', '/music/x/deep/2.wav', '/music/y/3.wav', '/music/z/4.wav', '/music/top.wav'] });
  const res = await rig.call('POST /api/library/import', { dirs: ['/music/x', '/music/y'], paths: ['/music/top.wav', '/music/y/3.wav'] });
  assert.equal(res.added, 4);
  assert.deepEqual(Object.keys(byPath(res.library)).sort(), ['/music/top.wav', '/music/x/1.wav', '/music/x/deep/2.wav', '/music/y/3.wav']);
});

test('dropped files are located in the music folder, and one from outside it comes back empty', async () => {
  const rig = makeLibrary({ paths: ['/music/x/song.wav'] });
  const { paths } = await rig.call('POST /api/library/locate', { files: [{ name: 'song.wav', size: 10 }, { name: 'away.wav', size: 3 }] });
  assert.deepEqual(paths, ['/music/x/song.wav', null]);
});

test('a library import with no music folder says where to choose one', async () => {
  const storage = createStorage(memoryStore(), { meta });
  const library = createLibrary({ storage, libraryTracks });
  await assert.rejects(() => library.routes['POST /api/library/import']({ dir: '/music' }), /music folder/);
});

test('the pass is shown while it runs, waits on a deck that needs the worker, and stops when told', async () => {
  let busy = 'a deck is loading';
  const rig = makeLibrary({
    paths: ['/music/1.wav', '/music/2.wav', '/music/3.wav'],
    facts: { '/music/2.wav': 'broken' },
    desk: { analysisWait: () => busy },
  });
  await rig.call('POST /api/library/import', { paths: ['/music/1.wav', '/music/2.wav', '/music/3.wav'] });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(rig.library.state(), { done: 0, total: 3, now: null, waiting: 'a deck is loading' });
  assert.equal((await rig.call('GET /api/library')).analyzing.total, 3, 'the editor reads it with the library');
  const stopped = await rig.call('POST /api/library/analyze/stop');
  assert.equal(stopped.dropped, 3);
  busy = null;
  await passDone(rig.library);
  assert.deepEqual(rig.songs.measured, []);
  // Asked for again: a file that will not decode is marked as tried, so it is not retried forever.
  const res = await rig.call('POST /api/library/analyze', {});
  assert.equal(res.queued, 3);
  await passDone(rig.library);
  const doc = byPath(await rig.call('GET /api/library'));
  assert.ok(doc['/music/2.wav'].analyzed > 0);
  assert.equal((await rig.call('POST /api/library/analyze', {})).queued, 0);
  assert.equal((await rig.call('POST /api/library/analyze', { force: true })).queued, 3);
  await passDone(rig.library);
});

test('a track edited by hand keeps its edit, and forgetting it takes it out of every set', async () => {
  const rig = makeLibrary({ paths: ['/music/a.wav', '/music/b.wav'] });
  const { library } = await rig.call('POST /api/library/import', { paths: ['/music/a.wav', '/music/b.wav'] });
  await passDone(rig.library);
  const [a, b] = library.tracks;
  const edited = await rig.call('POST /api/library/track', { id: a.id, fields: { bpm: 97, rating: 4 } });
  const rec = edited.library.tracks.find((t) => t.id === a.id);
  assert.equal(rec.bpm, 97);
  assert.deepEqual(rec.byHand, ['bpm']);
  await assert.rejects(() => rig.call('POST /api/library/track', { id: 'nobody', fields: { bpm: 1 } }), /no such track/);
  await rig.storage.writeLibrary({ playlists: [{ name: 'tonight', items: [{ kind: 'track', id: a.id }, { kind: 'track', id: b.id }] }] });
  const gone = await rig.call('POST /api/library/forget', { ids: [a.id] });
  assert.equal(gone.forgot, 1);
  assert.deepEqual(gone.library.tracks.map((t) => t.id), [b.id]);
  assert.deepEqual(gone.library.playlists[0].items.map((it) => it.trackId), [b.id]);
});

test('a deck\'s tempo, key and anchor are kept on the track\'s one record', async () => {
  const rig = makeLibrary({ paths: ['/music/a.wav'] });
  // Concurrent, as a deck sends them: each one lands, none overwrites another.
  await Promise.all([
    rig.library.rememberBpm('/music/a.wav', 123.5),
    rig.library.rememberAnchor('/music/a.wav', 0.25),
    rig.library.rememberKey('/music/a.wav', 'F#m'),
  ]);
  let rec = await rig.library.recordOf('/music/a.wav');
  assert.equal(rec.bpm, 123.5);
  assert.equal(rec.anchorSec, 0.25);
  assert.equal(rec.key, 'F#m');
  assert.deepEqual(rec.byHand, ['bpm', 'key']);
  // Cleared: no tempo, none by hand - measuring is welcome to fill it again.
  await rig.library.rememberBpm('/music/a.wav', null);
  await rig.library.rememberAnchor('/music/a.wav', null);
  rec = await rig.library.recordOf('/music/a.wav');
  assert.equal(rec.bpm, undefined);
  assert.equal(rec.anchorSec, undefined);
  assert.deepEqual(rec.byHand, ['key']);
  assert.equal(rec.analyzed, undefined);
  // What a deck measures fills a gap only.
  await rig.library.setFacts('/music/a.wav', { bpm: 126, key: 'Am' });
  rec = await rig.library.recordOf('/music/a.wav');
  assert.equal(rec.bpm, 126);
  assert.equal(rec.key, 'F#m', 'the key typed by hand stands');
});

test('anchors kept before the records are moved onto them once', async () => {
  const rig = makeLibrary({ paths: ['/music/a.wav'] });
  await rig.store.put('songs/anchors', { '/music/a.wav': 1.5 });
  await rig.library.restore();
  assert.equal((await rig.library.recordOf('/music/a.wav')).anchorSec, 1.5);
  assert.equal(await rig.store.get('songs/anchors'), null);
  await rig.library.restore();
  assert.equal((await rig.storage.readLibrary()).tracks.length, 1);
});

test('the library document is changed one writer at a time', async () => {
  const storage = createStorage(memoryStore(), { meta });
  await storage.updateLibrary((doc) => { libraryTracks.importInto(doc, ['/music/a.wav']); });
  const order = [];
  await Promise.all([
    storage.updateLibrary(async (doc) => { order.push('slow in'); await new Promise((r) => setTimeout(r, 20)); doc.tracks[0].rating = 3; order.push('slow out'); }),
    storage.updateLibrary((doc) => { order.push('quick'); libraryTracks.applyTrackAnchor(doc, '/music/a.wav', 2); }),
    // The editor's own post, with no collection: its playlists, and the records kept as they are.
    storage.writeLibrary({ playlists: [{ name: 'p', items: [] }] }),
  ]);
  assert.deepEqual(order, ['slow in', 'slow out', 'quick']);
  const doc = await storage.readLibrary();
  assert.equal(doc.tracks[0].rating, 3);
  assert.equal(doc.tracks[0].anchorSec, 2);
  assert.equal(doc.playlists[0].name, 'p');
  // An answer of false writes nothing.
  const { result } = await storage.updateLibrary((d) => { d.tracks = []; return false; });
  assert.equal(result, false);
  assert.equal((await storage.readLibrary()).tracks.length, 1);
});

test('a set\'s tracklist is written at the desktop\'s path, renamed when it ends', async () => {
  const store = memoryStore();
  const storage = createStorage(store, { meta, setLog: require('./public/set-log-format.js') });
  const started = new Date(2026, 9, 26, 22, 0);
  const set = { started, entries: [{ at: started.getTime() + 60000, deck: 'a', title: 'Night Drive', artist: 'Someone', bpm: 128, key: 'Am' }] };
  const first = await storage.writeSetLog(set);
  assert.match(first, /^patterns\/sets\/2026-10\/.+\.md$/);
  assert.match((await store.get(first)).text, /Night Drive/);
  const last = await storage.writeSetLog(set, new Date(started.getTime() + 3600000));
  assert.notEqual(last, first, 'a finished set\'s name carries its length');
  assert.equal(await store.get(first), null);
  assert.equal(set.file, last);
});
