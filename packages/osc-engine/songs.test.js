'use strict';

// The song-deck file resolver: format classification and the afconvert decode cache. Pure
// path/cache logic with an injected exec - no real afconvert, no engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifySongFile, songCachePath, resolveSongFile } = require('./songs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-songs-'));
}

// An exec that "decodes" by writing a marker file where afconvert would, recording its calls.
function fakeExec(calls, { fail = false } = {}) {
  return (cmd, args, cb) => {
    calls.push({ cmd, args });
    if (fail) return cb(new Error('exit 1'), '', 'Error: kAudioFileUnsupportedDataFormatError');
    fs.writeFileSync(args[args.length - 1], 'decoded-audio');
    return cb(null, '', '');
  };
}

test('classifySongFile: native vs decode vs unsupported', () => {
  assert.equal(classifySongFile('/a/track.wav'), 'native');
  assert.equal(classifySongFile('/a/track.AIFF'), 'native');
  assert.equal(classifySongFile('/a/track.flac'), 'native');
  assert.equal(classifySongFile('/a/track.mp3'), 'native');
  assert.equal(classifySongFile('/a/track.aac'), 'decode');
  assert.equal(classifySongFile('/a/track.M4A'), 'decode');
  assert.equal(classifySongFile('/a/track.ogg'), null);
  assert.equal(classifySongFile('/a/notes.txt'), null);
  assert.equal(classifySongFile(''), null);
});

test('songCachePath: stable for the same file identity, new for a changed one', () => {
  const stat = { mtimeMs: 1000.4, size: 42 };
  const a = songCachePath('/music/a.mp3', stat, '/cache');
  assert.equal(a, songCachePath('/music/a.mp3', { mtimeMs: 1000.4, size: 42 }, '/cache'));
  assert.notEqual(a, songCachePath('/music/a.mp3', { mtimeMs: 2000, size: 42 }, '/cache'));
  assert.notEqual(a, songCachePath('/music/a.mp3', { mtimeMs: 1000.4, size: 43 }, '/cache'));
  assert.notEqual(a, songCachePath('/music/b.mp3', stat, '/cache'));
  // Compared as directories, not as string prefixes: on Windows path.join() turns the leading
  // '/' into '\', so the result starts with '\cache\' and a literal '/cache' prefix never matches.
  assert.equal(path.dirname(a), path.normalize('/cache'));
  assert.ok(a.endsWith('.wav'));
});

test('resolveSongFile: a native file passes through untouched', async () => {
  const dir = tmpdir();
  const src = path.join(dir, 'song.wav');
  fs.writeFileSync(src, 'riff');
  const calls = [];
  const res = await resolveSongFile(src, { exec: fakeExec(calls), cacheDir: dir });
  assert.deepEqual(res, { path: src, decoded: false, cached: false });
  assert.equal(calls.length, 0);
});

test('resolveSongFile with wav: only a real .wav passes through; aiff/flac/mp3 decode like m4a', async () => {
  // The waveform analysis (songs phase 3) reads with Node's own WAV parser, which scsynth's
  // wider "native" set (aiff, flac, mp3) would defeat - so wav mode narrows the pass-through.
  const dir = tmpdir();
  const cache = tmpdir();
  const wav = path.join(dir, 'song.wav');
  const aiff = path.join(dir, 'song.aiff');
  const mp3 = path.join(dir, 'song.mp3');
  fs.writeFileSync(wav, 'riff');
  fs.writeFileSync(aiff, 'form');
  fs.writeFileSync(mp3, 'mpeg');

  const calls = [];
  const direct = await resolveSongFile(wav, { exec: fakeExec(calls), cacheDir: cache, wav: true });
  assert.deepEqual(direct, { path: wav, decoded: false, cached: false });
  assert.equal(calls.length, 0);

  const res = await resolveSongFile(aiff, { exec: fakeExec(calls), cacheDir: cache, wav: true });
  assert.equal(calls.length, 1, 'the aiff took an afconvert pass');
  assert.ok(res.decoded);
  assert.ok(res.path.startsWith(cache) && res.path.endsWith('.wav'));

  // ...while the deck's own resolution still plays the aiff directly.
  const play = await resolveSongFile(aiff, { exec: fakeExec(calls), cacheDir: cache });
  assert.deepEqual(play, { path: aiff, decoded: false, cached: false });
  assert.equal(calls.length, 1);

  // mp3 is native to scsynth's libsndfile too: the deck plays it as-is, the wav pass decodes it.
  const mp3Play = await resolveSongFile(mp3, { exec: fakeExec(calls), cacheDir: cache });
  assert.deepEqual(mp3Play, { path: mp3, decoded: false, cached: false });
  assert.equal(calls.length, 1);
  const mp3Wav = await resolveSongFile(mp3, { exec: fakeExec(calls), cacheDir: cache, wav: true });
  assert.equal(calls.length, 2, 'the mp3 took an afconvert pass for the WAV reader');
  assert.ok(mp3Wav.decoded && mp3Wav.path.endsWith('.wav'));
});

test('resolveSongFile: decodes once, then hits the cache', async () => {
  const dir = tmpdir();
  const cache = path.join(dir, 'cache');
  const src = path.join(dir, 'song.m4a');
  fs.writeFileSync(src, 'mp4a');
  const calls = [];
  const first = await resolveSongFile(src, { exec: fakeExec(calls), cacheDir: cache });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'afconvert');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-f', 'WAVE', '-d', 'LEF32']);
  assert.equal(calls[0].args[4], src);
  assert.equal(first.decoded, true);
  assert.equal(first.cached, false);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'decoded-audio');
  assert.ok(!fs.existsSync(`${first.path}.part.wav`), 'temp decode renamed into place');

  const second = await resolveSongFile(src, { exec: fakeExec(calls), cacheDir: cache });
  assert.equal(calls.length, 1, 'cache hit decodes nothing');
  assert.deepEqual(second, { path: first.path, decoded: true, cached: true });
});

test('resolveSongFile: an edited source re-decodes (identity includes mtime/size)', async () => {
  const dir = tmpdir();
  const cache = path.join(dir, 'cache');
  const src = path.join(dir, 'song.m4a');
  fs.writeFileSync(src, 'mp4a');
  const calls = [];
  const first = await resolveSongFile(src, { exec: fakeExec(calls), cacheDir: cache });
  fs.writeFileSync(src, 'mp4a-re-exported-longer');
  const second = await resolveSongFile(src, { exec: fakeExec(calls), cacheDir: cache });
  assert.equal(calls.length, 2);
  assert.notEqual(second.path, first.path);
});

test('resolveSongFile: clear errors for missing files, non-files, and unsupported formats', async () => {
  const dir = tmpdir();
  await assert.rejects(resolveSongFile(path.join(dir, 'gone.wav')), /no such file/);
  await assert.rejects(resolveSongFile(dir), /not a file/);
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'hi');
  await assert.rejects(resolveSongFile(txt), /unsupported audio format/);
});

test('resolveSongFile: a failed decode surfaces stderr and leaves no cache entry', async () => {
  const dir = tmpdir();
  const cache = path.join(dir, 'cache');
  const src = path.join(dir, 'song.m4a');
  fs.writeFileSync(src, 'not-really-audio');
  const calls = [];
  await assert.rejects(
    resolveSongFile(src, { exec: fakeExec(calls, { fail: true }), cacheDir: cache }),
    /decoding song\.m4a failed: .*kAudioFileUnsupportedDataFormatError/,
  );
  assert.deepEqual(fs.readdirSync(cache), [], 'no half-written cache entry');
});
