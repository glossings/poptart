'use strict';

// The song-file browser behind the organize modal's "+ file" (songs phase 2): one-directory
// listings and the missing-file stat. Real filesystem work, against temp directories.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { browseSongDir, statSongPaths, defaultSongDir, walkSongFiles } = require('./song-files');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-songbrowse-'));
}

test('browseSongDir: directories first then playable files, both alphabetical; junk and dotfiles hidden', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'zsets'));
  fs.mkdirSync(path.join(dir, 'Albums'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  for (const f of ['b.mp3', 'A.wav', 'notes.txt', '.DS_Store', 'c.flac']) fs.writeFileSync(path.join(dir, f), 'x');
  const res = browseSongDir(dir);
  assert.equal(res.dir, dir);
  assert.equal(res.parent, path.dirname(dir));
  assert.deepEqual(res.entries.map((e) => [e.name, e.dir]), [
    ['Albums', true], ['zsets', true], ['A.wav', false], ['b.mp3', false], ['c.flac', false],
  ]);
  assert.equal(res.entries[2].path, path.join(dir, 'A.wav'));
});

test('browseSongDir: symlinks list as what they point at; dangling ones are skipped', () => {
  const dir = tmpdir();
  const real = tmpdir();
  fs.mkdirSync(path.join(real, 'sub'));
  fs.writeFileSync(path.join(real, 'tune.aiff'), 'x');
  fs.symlinkSync(path.join(real, 'sub'), path.join(dir, 'linkdir'));
  fs.symlinkSync(path.join(real, 'tune.aiff'), path.join(dir, 'link.aiff'));
  fs.symlinkSync(path.join(real, 'gone.mp3'), path.join(dir, 'dangling.mp3'));
  const res = browseSongDir(dir);
  assert.deepEqual(res.entries.map((e) => [e.name, e.dir]), [['linkdir', true], ['link.aiff', false]]);
});

test('browseSongDir: the filesystem root has no parent; an empty argument starts at the default', () => {
  assert.equal(browseSongDir(path.parse(process.cwd()).root).parent, null);
  assert.equal(browseSongDir('').dir, defaultSongDir());
});

test("browseSongDir: a clear error for a path that isn't a readable directory", () => {
  const dir = tmpdir();
  assert.throws(() => browseSongDir(path.join(dir, 'gone')), /can't read directory/);
  const f = path.join(dir, 'song.mp3');
  fs.writeFileSync(f, 'x');
  assert.throws(() => browseSongDir(f), /can't read directory/);
});

test('statSongPaths: existing files true; missing files and directories false; junk skipped', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'a.mp3');
  fs.writeFileSync(f, 'x');
  const gone = path.join(dir, 'gone.mp3');
  assert.deepEqual(statSongPaths([f, gone, dir, 42]), { [f]: true, [gone]: false, [dir]: false });
  assert.deepEqual(statSongPaths(null), {});
});

test('walkSongFiles: every playable file under the tree, mp3/m4a included, junk excluded', async () => {
  // The organize modal's folder adds and tree search (mirroring the pack browser's walk, which
  // only knows the sample formats - a song folder is mostly mp3s).
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'crates'));
  fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'b.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'crates', 'deep.m4a'), 'x');
  fs.writeFileSync(path.join(dir, 'crates', 'notes.txt'), 'x');
  const { files, truncated } = await walkSongFiles(dir);
  assert.deepEqual(files, ['a.mp3', 'b.wav', 'crates/deep.m4a'], 'relative paths, files here before subfolders');
  assert.equal(truncated, false);
});
