'use strict';

// The tag reader behind /api/song/load's title/artist/album/bpm/key autofill (songs phase 4).
// Fixtures are built byte-by-byte here - real ID3/vorbis/mp4/RIFF structures, no sample files -
// so each format's parse is pinned exactly, including the encodings and the give-up paths.

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

// Every read answers with all five fields, so each expectation spells out only what the fixture
// actually carries and leans on this for the rest.
const NONE = { title: null, artist: null, album: null, bpm: null, key: null };

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

function id3v22Frame(id, text) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const head = Buffer.alloc(6);
  head.write(id, 0, 'latin1');
  head.writeUIntBE(payload.length, 3, 3);
  return Buffer.concat([head, payload]);
}

function id3Tag(major, frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, 0]), syncsafe(body.length), body]);
}

// A RIFF/FORM chunk, padded to an even length the way both containers require.
function riffChunk(id, payload, littleEndian = true) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  if (littleEndian) head.writeUInt32LE(payload.length, 4);
  else head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload, Buffer.alloc(payload.length % 2)]);
}

const zstr = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(1)]);

function mp4Box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function mp4Data(typeInd, payload) {
  return mp4Box('data', Buffer.concat([Buffer.from([0, 0, 0, typeInd, 0, 0, 0, 0]), payload]));
}

// moov/udta/meta/ilst around a ready-made item list, plus the ftyp that identifies the file.
function m4aFile(ilst) {
  const moov = mp4Box('moov', mp4Box('udta', mp4Box('meta', Buffer.concat([Buffer.alloc(4), mp4Box('ilst', ilst)]))));
  return Buffer.concat([mp4Box('ftyp', Buffer.from('M4A \0\0\0\0', 'latin1')), moov]);
}

function vorbisBlock(lines) {
  const comment = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32LE(lines.length, 0);
  const block = Buffer.concat([comment('poptart-test'), count, ...lines.map(comment)]);
  const head = Buffer.alloc(4);
  head[0] = 0x80 | 4; // last block, type 4
  head.writeUIntBE(block.length, 1, 3);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), head, block]);
}

test('ID3v2.3: TBPM and TKEY, latin1 and utf16', () => {
  const tag = id3Tag(3, [
    id3v23Frame('TIT2', 'Some Track'),
    id3v23Frame('TBPM', '128'),
    id3v23Frame('TKEY', 'F#m', 1),
  ]);
  const file = write('v23.mp3', Buffer.concat([tag, Buffer.alloc(64, 0xaa)]));
  assert.deepEqual(readSongTags(file), { ...NONE, title: 'Some Track', bpm: 128, key: 'F#m' });
});

test('ID3v2.3: title/artist/album, latin1 and utf16-with-BOM', () => {
  const tag = id3Tag(3, [
    id3v23Frame('TIT2', 'Night Bus'),
    id3v23Frame('TPE1', 'Two Rooms', 1),
    id3v23Frame('TALB', 'Late Transfers'),
  ]);
  assert.deepEqual(readSongTags(write('v23-text.mp3', tag)),
    { ...NONE, title: 'Night Bus', artist: 'Two Rooms', album: 'Late Transfers' });
});

test('ID3v2.4: syncsafe frame sizes, utf8, fractional bpm', () => {
  const tag = id3Tag(4, [id3v24Frame('TBPM', '174.5'), id3v24Frame('TKEY', 'Am')]);
  assert.deepEqual(readSongTags(write('v24.mp3', tag)), { ...NONE, bpm: 174.5, key: 'Am' });
});

test('ID3v2.4: utf8 title and artist survive non-ASCII', () => {
  const tag = id3Tag(4, [id3v24Frame('TIT2', 'Néon Dub'), id3v24Frame('TPE1', 'Ødegård')]);
  assert.deepEqual(readSongTags(write('v24-text.mp3', tag)), { ...NONE, title: 'Néon Dub', artist: 'Ødegård' });
});

test('ID3v2.2: three-byte ids (TT2/TP1/TAL/TBP/TKE)', () => {
  const tag = id3Tag(2, [
    id3v22Frame('TT2', 'Short Ids'),
    id3v22Frame('TP1', 'Old Writer'),
    id3v22Frame('TAL', 'Archive'),
    id3v22Frame('TBP', '92'),
    id3v22Frame('TKE', 'Eb'),
  ]);
  assert.deepEqual(readSongTags(write('v22.mp3', tag)),
    { title: 'Short Ids', artist: 'Old Writer', album: 'Archive', bpm: 92, key: 'Eb' });
});

test('a wav carries its tags in an id3 chunk', () => {
  const tag = id3Tag(3, [id3v23Frame('TBPM', '120'), id3v23Frame('TKEY', '8A')]);
  const fmt = mp4Box('fmt ', Buffer.alloc(16)); // any chunk-shaped filler (RIFF sizes are LE, but 16<256 reads the same)
  fmt.writeUInt32LE(16, 4);
  const id3chunk = Buffer.concat([Buffer.from('id3 ', 'latin1'), Buffer.alloc(4), tag]);
  id3chunk.writeUInt32LE(tag.length, 4);
  const riff = Buffer.concat([Buffer.from('RIFF....WAVE', 'latin1'), fmt, id3chunk]);
  assert.deepEqual(readSongTags(write('tagged.wav', riff)), { ...NONE, bpm: 120, key: '8A' });
});

test('wav: a LIST/INFO chunk supplies title/artist/album', () => {
  const info = Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    riffChunk('INAM', zstr('Desk Mix')),
    riffChunk('IART', zstr('Some Artist')),
    riffChunk('IPRD', zstr('An Album')),
  ]);
  const riff = Buffer.concat([
    Buffer.from('RIFF....WAVE', 'latin1'),
    riffChunk('fmt ', Buffer.alloc(16)),
    riffChunk('LIST', info),
  ]);
  assert.deepEqual(readSongTags(write('info.wav', riff)),
    { ...NONE, title: 'Desk Mix', artist: 'Some Artist', album: 'An Album' });
});

test('wav: with both an INFO list and an id3 chunk, id3 wins the overlap', () => {
  const tag = id3Tag(3, [id3v23Frame('TIT2', 'Deliberate Title'), id3v23Frame('TBPM', '124')]);
  const info = Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    riffChunk('INAM', zstr('Editor Title')),
    riffChunk('IART', zstr('Editor Artist')),
  ]);
  const expected = { ...NONE, title: 'Deliberate Title', artist: 'Editor Artist', bpm: 124 };
  const infoFirst = Buffer.concat([Buffer.from('RIFF....WAVE', 'latin1'), riffChunk('LIST', info), riffChunk('id3 ', tag)]);
  assert.deepEqual(readSongTags(write('both-info-first.wav', infoFirst)), expected);
  // Chunk order is the file writer's business, so neither order may change the answer.
  const id3First = Buffer.concat([Buffer.from('RIFF....WAVE', 'latin1'), riffChunk('id3 ', tag), riffChunk('LIST', info)]);
  assert.deepEqual(readSongTags(write('both-id3-first.wav', id3First)), expected);
});

test('aiff: NAME and AUTH chunks (big-endian sizes)', () => {
  const form = Buffer.concat([
    Buffer.from('FORM', 'latin1'), Buffer.alloc(4), Buffer.from('AIFF', 'latin1'),
    riffChunk('NAME', Buffer.from('Tape Loop', 'latin1'), false),
    riffChunk('AUTH', Buffer.from('Someone', 'latin1'), false),
  ]);
  assert.deepEqual(readSongTags(write('song.aiff', form)), { ...NONE, title: 'Tape Loop', artist: 'Someone' });
});

test('aiff: an id3 chunk outranks NAME', () => {
  const tag = id3Tag(3, [id3v23Frame('TIT2', 'Tagged Name'), id3v23Frame('TKEY', 'Dm')]);
  const form = Buffer.concat([
    Buffer.from('FORM', 'latin1'), Buffer.alloc(4), Buffer.from('AIFF', 'latin1'),
    riffChunk('NAME', Buffer.from('Chunk Name', 'latin1'), false),
    riffChunk('AUTH', Buffer.from('Someone', 'latin1'), false),
    riffChunk('ID3 ', tag, false),
  ]);
  assert.deepEqual(readSongTags(write('both.aiff', form)),
    { ...NONE, title: 'Tagged Name', artist: 'Someone', key: 'Dm' });
});

test('flac: vorbis comments (BPM + INITIALKEY, any case)', () => {
  const flac = vorbisBlock(['bpm=140', 'InitialKey=Gm']);
  assert.deepEqual(readSongTags(write('song.flac', flac)), { ...NONE, bpm: 140, key: 'Gm' });
});

test('flac: TITLE/ARTIST/ALBUM, and the first writer of a field wins', () => {
  const flac = vorbisBlock(['title=Slow Exit', 'ARTIST=Field Notes', 'Album=Collected', 'TITLE=Ignored Duplicate']);
  assert.deepEqual(readSongTags(write('text.flac', flac)),
    { ...NONE, title: 'Slow Exit', artist: 'Field Notes', album: 'Collected' });
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
  assert.deepEqual(readSongTags(write('song.m4a', m4aFile(ilst))), { ...NONE, bpm: 126, key: 'Bbm' });
});

test('m4a: the copyright-sign text atoms', () => {
  const ilst = Buffer.concat([
    mp4Box('\xa9nam', mp4Data(1, Buffer.from('Néon Dub', 'utf8'))),
    mp4Box('\xa9ART', mp4Data(1, Buffer.from('A Producer', 'utf8'))),
    mp4Box('\xa9alb', mp4Data(1, Buffer.from('Dub Works', 'utf8'))),
  ]);
  const file = write('text.m4a', m4aFile(ilst));
  // The ids really are byte 0xa9 on disk, not the two-byte utf8 encoding of the same sign.
  assert.equal(fs.readFileSync(file).includes(Buffer.from([0xa9, 0x6e, 0x61, 0x6d])), true);
  assert.deepEqual(readSongTags(file), { ...NONE, title: 'Néon Dub', artist: 'A Producer', album: 'Dub Works' });
});

test('text is trimmed, cut at its NUL padding, and capped', () => {
  const tag = id3Tag(3, [
    id3v23Frame('TIT2', 'A'.repeat(400)),
    id3v23Frame('TPE1', '  Padded Name\0\0\0'),
    id3v23Frame('TALB', ''),
  ]);
  const tags = readSongTags(write('long.mp3', tag));
  assert.equal(tags.title.length, 300);
  assert.equal(tags.artist, 'Padded Name');
  assert.equal(tags.album, null);
  // A chunk field whose declared size runs past its terminator keeps only the string.
  const info = Buffer.concat([Buffer.from('INFO', 'latin1'), riffChunk('INAM', Buffer.from('Clean\0\0\0\0', 'latin1'))]);
  const riff = Buffer.concat([Buffer.from('RIFF....WAVE', 'latin1'), riffChunk('LIST', info)]);
  assert.equal(readSongTags(write('padded.wav', riff)).title, 'Clean');
});

test('implausible values are noise, not answers', () => {
  const tag = id3Tag(3, [id3v23Frame('TBPM', '4200'), id3v23Frame('TKEY', 'not really a key at all')]);
  assert.deepEqual(readSongTags(write('junk-values.mp3', tag)), NONE);
});

test('untagged, unrecognized, missing: all read as all-null without throwing', () => {
  assert.deepEqual(readSongTags(write('plain.bin', Buffer.alloc(64, 7))), NONE);
  assert.deepEqual(readSongTags(write('tiny', Buffer.from('x'))), NONE);
  assert.deepEqual(readSongTags(path.join(TMP, 'gone.mp3')), NONE);
  // An id3 header whose declared size overruns the file: frames stop at the torn edge.
  const torn = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(100000)]);
  assert.deepEqual(readSongTags(write('torn.mp3', torn)), NONE);
});

test('parseId3 walks past unknown frames and stops at padding', () => {
  const tag = id3Tag(3, [id3v23Frame('TXXX', 'whatever'), id3v23Frame('TBPM', '99')]);
  const padded = Buffer.concat([tag, Buffer.alloc(32)]);
  // the padding is inside the declared size in real files; emulate by re-declaring
  const rebuilt = Buffer.concat([padded.subarray(0, 6), syncsafe(padded.length - 10), padded.subarray(10)]);
  assert.equal(parseId3(rebuilt).bpm, 99);
  assert.deepEqual(parseId3(Buffer.alloc(32)), NONE);
});
