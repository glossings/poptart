// The DJ decks' music folder (public/web/music-folder.mjs) and how a song is made playable
// (public/web/song-load.mjs's packing), against stand-ins for the browser's file handles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMusicFolder, relativeOf, songsFromList, walkSongs, MUSIC_FOLDER_KEY } from './public/web/music-folder.mjs';
import { packPlanes } from './public/web/song-load.mjs';

/**
 * A store that keeps what it is given as it is. The page's store is IndexedDB, which keeps a
 * directory handle as one; the in-memory store a test would otherwise use clones values, and a
 * stand-in handle (an object with methods) cannot be cloned.
 */
function handleStore() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}

/** A directory handle over a tree of { name: subtree | contents }. */
function dirHandle(name, tree) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, v] of Object.entries(tree)) {
        if (typeof v === 'string') yield [n, { kind: 'file', name: n, getFile: async () => ({ name: n, text: v, size: v.length }) }];
        else yield [n, dirHandle(n, v)];
      }
    },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
  };
}

const TREE = {
  'Intro.mp3': 'a',
  'notes.txt': 'not a song',
  '.hidden.wav': 'skipped',
  House: { 'Deep One.wav': 'b', 'deeper.flac': 'c', Old: { 'tune.aiff': 'd' } },
  Techno: { 'Pound.m4a': 'e' },
};

test('a walk finds the songs and only the songs, hidden files left alone', async () => {
  const { files, truncated } = await walkSongs(dirHandle('Music', TREE));
  assert.deepEqual([...files.keys()].sort(), ['House/Deep One.wav', 'House/Old/tune.aiff', 'House/deeper.flac', 'Intro.mp3', 'Techno/Pound.m4a']);
  assert.equal(truncated, false);
  const capped = await walkSongs(dirHandle('Music', TREE), { limit: 2 });
  assert.equal(capped.files.size, 2);
  assert.equal(capped.truncated, true, 'a cut-short walk says so');
});

test('the folder browses one directory at a time, the desktop\'s listing shape', async () => {
  const folder = createMusicFolder();
  await folder.choose(dirHandle('Music', TREE));
  assert.equal(folder.status().state, 'ready');
  const top = folder.browse('/music');
  assert.equal(top.dir, '/music');
  assert.equal(top.parent, null);
  assert.deepEqual(top.entries.map((e) => [e.name, e.dir]), [['House', true], ['Techno', true], ['Intro.mp3', false]]);
  const house = folder.browse('/music/House');
  assert.equal(house.parent, '/music');
  assert.deepEqual(house.entries.map((e) => e.path), ['/music/House/Old', '/music/House/Deep One.wav', '/music/House/deeper.flac']);
  assert.throws(() => folder.browse('/music/Nowhere'), /can't read directory/);
  assert.deepEqual(folder.walk('/music/House').files, ['Deep One.wav', 'deeper.flac', 'Old/tune.aiff']);
  assert.equal((await folder.file('/music/Techno/Pound.m4a')).name, 'Pound.m4a');
  await assert.rejects(() => folder.file('/music/nope.wav'), /not in the music folder/);
  assert.equal(folder.has('/music/Intro.mp3'), true);
});

test('a dropped file is found in the folder by its name and size, and one from elsewhere is not', async () => {
  const folder = createMusicFolder();
  await folder.choose(dirHandle('Music', { A: { 'same.wav': 'xx' }, B: { 'same.wav': 'yyyy' }, 'solo.mp3': 'z' }));
  assert.equal(await folder.find('same.wav', 4), '/music/B/same.wav', 'the size tells two files of one name apart');
  assert.equal(await folder.find('solo.mp3', 1), '/music/solo.mp3');
  assert.equal(await folder.find('solo.mp3', 9), null, 'a file of that name but another size is someone else\'s');
  assert.equal(await folder.find('elsewhere.wav', 1), null);
});

test('a kept folder is read again on the next visit without being chosen again', async () => {
  const store = handleStore();
  const first = createMusicFolder({ store });
  const handle = dirHandle('Music', TREE);
  await first.choose(handle);
  assert.equal((await store.get(MUSIC_FOLDER_KEY)).handle, handle, 'the handle is kept, not the files');
  const next = createMusicFolder({ store });
  await next.restore();
  assert.equal(next.status().songs, 5);
});

test('a folder the browser wants asked about again waits for a click, and says so', async () => {
  const store = handleStore();
  const handle = { ...dirHandle('Music', TREE), queryPermission: async () => 'prompt' };
  await store.put(MUSIC_FOLDER_KEY, { handle, name: 'Music' });
  const folder = createMusicFolder({ store });
  await folder.restore();
  assert.equal(folder.status().state, 'prompt');
  await assert.rejects(() => folder.file('/music/Intro.mp3'), /needs a click/);
  assert.equal(await folder.reconnect(), true);
  assert.equal(folder.status().state, 'ready');
});

test('a chooser\'s files last the visit, and nothing is chosen until something is', async () => {
  const folder = createMusicFolder();
  await assert.rejects(() => folder.file('/music/x.wav'), /no music folder is chosen/);
  const files = [
    { name: 'a.wav', webkitRelativePath: 'Crate/a.wav' },
    { name: 'b.txt', webkitRelativePath: 'Crate/b.txt' },
    { name: 'c.mp3', webkitRelativePath: 'Crate/sub/c.mp3' },
  ];
  assert.deepEqual([...songsFromList(files).files.keys()], ['a.wav', 'sub/c.mp3']);
  await folder.choose(files);
  assert.equal(folder.status().state, 'session');
  assert.equal(folder.status().name, 'Crate');
  assert.equal(relativeOf('/music/sub/c.mp3'), 'sub/c.mp3');
  assert.equal(relativeOf('/elsewhere/c.mp3'), null);
});

test('a decoded song is packed to 16-bit planes, clamped, in slices with the page let go between', async () => {
  const left = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const right = new Float32Array([0.25, 0, 0, 0, 0, 0, 0]);
  const buffer = { length: 7, numberOfChannels: 2, getChannelData: (c) => (c ? right : left) };
  let pauses = 0;
  const planes = await packPlanes(buffer, { slice: 3, pause: async () => { pauses++; } });
  assert.deepEqual([...planes[0]], [0, 16384, -16383, 32767, -32767, 32767, -32768]);
  assert.equal(planes[1][0], 8192);
  assert.equal(pauses, 4, 'two pauses a channel: the page is never held for a whole song');
});
