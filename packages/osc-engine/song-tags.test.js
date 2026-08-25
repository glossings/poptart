'use strict';

// The tag reader behind /api/song/load's bpm/key autofill (songs phase 4). Fixtures are built
// byte-by-byte here - real ID3/vorbis/mp4 structures, no sample files - so each format's parse
// is pinned exactly, including the encodings and the give-up paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSongTags, parseId3 } = require('./song-tags');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-tags-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(name, buf) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, buf);
  return file;
}

// --- fixture builders ---

const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

function id3v23Frame(id, text, enc = 0) {
  const payload = Buffer.concat([Buffer.from([enc]),
    enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf8')]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function id3v24Frame(id, text) {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  syncsafe(payload.length).copy(head, 4);
  return Buffer.concat([head, payload]);
}

function id3Tag(major, frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, 0]), syncsafe(body.length), body]);
}

function mp4Box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function mp4Data(typeInd, payload) {
  return mp4Box('data', Buffer.concat([Buffer.from([0, 0, 0, typeInd, 0, 0, 0, 0]), payload]));
}

test('ID3v2.3: TBPM and TKEY, latin1 and utf16', () => {
  const tag = id3Tag(3, [
    id3v23Frame('TIT2', 'Some Track'),
    id3v23Frame('TBPM', '128'),
    id3v23Frame('TKEY', 'F#m', 1),
  ]);
  const file = write('v23.mp3', Buffer.concat([tag, Buffer.alloc(64, 0xaa)]));
  assert.deepEqual(readSongTags(file), { bpm: 128, key: 'F#m' });
});

test('ID3v2.4: syncsafe frame sizes, utf8, fractional bpm', () => {
  const tag = id3Tag(4, [id3v24Frame('TBPM', '174.5'), id3v24Frame('TKEY', 'Am')]);
  assert.deepEqual(readSongTags(write('v24.mp3', tag)), { bpm: 174.5, key: 'Am' });
});

test('ID3v2.2: three-byte ids (TBP/TKE)', () => {
  const frame = (id, text) => {
    const payload = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const head = Buffer.alloc(6);
    head.write(id, 0, 'latin1');
    head.writeUIntBE(payload.length, 3, 3);
    return Buffer.concat([head, payload]);
  };
  const tag = id3Tag(2, [frame('TBP', '92'), frame('TKE', 'Eb')]);
  assert.deepEqual(readSongTags(write('v22.mp3', tag)), { bpm: 92, key: 'Eb' });
});

test('a wav carries its tags in an id3 chunk', () => {
  const tag = id3Tag(3, [id3v23Frame('TBPM', '120'), id3v23Frame('TKEY', '8A')]);
  const fmt = mp4Box('fmt ', Buffer.alloc(16)); // any chunk-shaped filler (RIFF sizes are LE, but 16<256 reads the same)
  fmt.writeUInt32LE(16, 4);
  const id3chunk = Buffer.concat([Buffer.from('id3 ', 'latin1'), Buffer.alloc(4), tag]);
  id3chunk.writeUInt32LE(tag.length, 4);
  const riff = Buffer.concat([Buffer.from('RIFF....WAVE', 'latin1'), fmt, id3chunk]);
  assert.deepEqual(readSongTags(write('tagged.wav', riff)), { bpm: 120, key: '8A' });
});

test('flac: vorbis comments (BPM + INITIALKEY, any case)', () => {
  const comment = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const vendor = comment('poptart-test');
  const count = Buffer.alloc(4);
  count.writeUInt32LE(2, 0);
  const block = Buffer.concat([vendor, count, comment('bpm=140'), comment('InitialKey=Gm')]);
  const head = Buffer.alloc(4);
  head[0] = 0x80 | 4; // last block, type 4
  head.writeUIntBE(block.length, 1, 3);
  const flac = Buffer.concat([Buffer.from('fLaC', 'latin1'), head, block]);
  assert.deepEqual(readSongTags(write('song.flac', flac)), { bpm: 140, key: 'Gm' });
});

test('m4a: tmpo atom + freeform initialkey', () => {
  const tmpoPayload = Buffer.alloc(2);
  tmpoPayload.writeUInt16BE(126, 0);
  const ilst = Buffer.concat([
    mp4Box('tmpo', mp4Data(21, tmpoPayload)),
    mp4Box('----', Buffer.concat([
      mp4Box('mean', Buffer.concat([Buffer.alloc(4), Buffer.from('com.apple.iTunes')])),
      mp4Box('name', Buffer.concat([Buffer.alloc(4), Buffer.from('initialkey')])),
      mp4Data(1, Buffer.from('Bbm')),
    ])),
  ]);
  const moov = mp4Box('moov', mp4Box('udta', mp4Box('meta', Buffer.concat([Buffer.alloc(4), mp4Box('ilst', ilst)]))));
  const m4a = Buffer.concat([mp4Box('ftyp', Buffer.from('M4A \0\0\0\0', 'latin1')), moov]);
  assert.deepEqual(readSongTags(write('song.m4a', m4a)), { bpm: 126, key: 'Bbm' });
});

test('implausible values are noise, not answers', () => {
  const tag = id3Tag(3, [id3v23Frame('TBPM', '4200'), id3v23Frame('TKEY', 'not really a key at all')]);
  assert.deepEqual(readSongTags(write('junk-values.mp3', tag)), { bpm: null, key: null });
});

test('untagged, unrecognized, missing: all read as { null, null } without throwing', () => {
  assert.deepEqual(readSongTags(write('plain.bin', Buffer.alloc(64, 7))), { bpm: null, key: null });
  assert.deepEqual(readSongTags(write('tiny', Buffer.from('x'))), { bpm: null, key: null });
  assert.deepEqual(readSongTags(path.join(TMP, 'gone.mp3')), { bpm: null, key: null });
  // An id3 header whose declared size overruns the file: frames stop at the torn edge.
  const torn = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(100000)]);
  assert.deepEqual(readSongTags(write('torn.mp3', torn)), { bpm: null, key: null });
});

test('parseId3 walks past unknown frames and stops at padding', () => {
  const tag = id3Tag(3, [id3v23Frame('TXXX', 'whatever'), id3v23Frame('TBPM', '99')]);
  const padded = Buffer.concat([tag, Buffer.alloc(32)]);
  // the padding is inside the declared size in real files; emulate by re-declaring
  const rebuilt = Buffer.concat([padded.subarray(0, 6), syncsafe(padded.length - 10), padded.subarray(10)]);
  assert.equal(parseId3(rebuilt).bpm, 99);
});
