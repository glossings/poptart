'use strict';

// A sample's length from its header alone (audio-header.js) - what the track list shows for a
// sampler track - for the three formats it reads, and null for the rest.

const test = require('node:test');
const assert = require('node:assert/strict');

const { audioHeaderOf } = require('./audio-header');
const { encodeWav } = require('./wav');

test('a WAV is read from its fmt and data chunks, the data size trusted only when filled in', () => {
  const wav = encodeWav({ sampleRate: 48000, channels: 2, data: new Float32Array(48000 * 2 * 3) }); // 3 s stereo
  const info = audioHeaderOf(wav.subarray(0, 200), wav.length); // only the head is read
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.equal(info.duration, 3);
  // a recorder that never wrote the size back: the data runs to the end of the file
  const unsized = Buffer.from(wav);
  unsized.writeUInt32LE(0, unsized.indexOf('data') + 4);
  assert.equal(audioHeaderOf(unsized.subarray(0, 200), unsized.length).duration, 3);
});

test('an AIFF is read from COMM, its rate an 80-bit float', () => {
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(1, 0); // channels
  comm.writeUInt32BE(88200, 2); // frames
  comm.writeUInt16BE(16, 6); // bits
  // 44100 as an extended float: exponent 16383+15, mantissa 44100 << 48
  comm.writeUInt16BE(16383 + 15, 8);
  comm.writeUInt32BE(44100 * 2 ** 16, 10);
  const head = Buffer.concat([
    Buffer.from('FORM'), Buffer.alloc(4), Buffer.from('AIFF'),
    Buffer.from('COMM'), Buffer.from([0, 0, 0, 18]), comm,
  ]);
  const info = audioHeaderOf(head);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.duration, 2);
});

test('a FLAC is read from STREAMINFO; anything else is not guessed at', () => {
  const si = Buffer.alloc(34);
  // rate 44100 (20 bits), 2 channels (stored as 1), 16 bits (stored as 15), 132300 frames
  const rate = 44100;
  si[10] = (rate >> 12) & 0xff;
  si[11] = (rate >> 4) & 0xff;
  si[12] = ((rate & 0x0f) << 4) | (1 << 1) | 0;
  si[13] = (15 << 4) | 0;
  si.writeUInt32BE(132300, 14);
  const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), si]);
  const info = audioHeaderOf(flac);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.duration, 3);
  assert.equal(audioHeaderOf(Buffer.from('ID3\u0003 an mp3 begins like this')), null);
});
