// AIFF in the page (public/web/audio-decode.mjs): the browser's own decoder can't read it in
// Chrome or Firefox, so it is read from its bytes - every sample format a library or an editor
// writes - and anything else still goes to the browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeAiff, decodeAudio } from './public/web/audio-decode.mjs';

// An 80-bit extended float, the way AIFF writes its sample rate.
function extended(value) {
  const out = new Uint8Array(10);
  const exponent = Math.floor(Math.log2(value));
  const mantissa = value / 2 ** exponent; // 1 <= m < 2
  const hi = Math.floor(mantissa * 2 ** 31);
  const v = new DataView(out.buffer);
  v.setUint16(0, exponent + 16383);
  v.setUint32(2, hi);
  v.setUint32(6, 0);
  return out;
}

/** An AIFF (or AIFF-C) file holding `channels`, written as `format` says. */
function aiff(channels, { rate = 48000, bits = 16, compression = null } = {}) {
  const frames = channels[0].length;
  const width = compression === 'fl32' ? 4 : Math.ceil(bits / 8);
  const data = new DataView(new ArrayBuffer(frames * channels.length * width));
  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const v = ch[i];
      if (compression === 'fl32') data.setFloat32(p, v);
      else if (width === 2) data.setInt16(p, Math.round(v * 32767), compression === 'sowt');
      else if (width === 3) {
        const n = Math.round(v * 8388607);
        data.setUint8(p, (n >> 16) & 0xff); data.setUint8(p + 1, (n >> 8) & 0xff); data.setUint8(p + 2, n & 0xff);
      }
      p += width;
    }
  }
  const aifc = compression != null;
  const commSize = aifc ? 24 : 18;
  const comm = new DataView(new ArrayBuffer(8 + commSize));
  const tag = (view, at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(comm, 0, 'COMM'); comm.setUint32(4, commSize);
  comm.setInt16(8, channels.length); comm.setUint32(10, frames); comm.setInt16(14, compression === 'fl32' ? 32 : bits);
  extended(rate).forEach((b, i) => comm.setUint8(16 + i, b));
  if (aifc) { tag(comm, 26, compression); comm.setUint8(30, 0); }
  const ssnd = new DataView(new ArrayBuffer(16));
  tag(ssnd, 0, 'SSND'); ssnd.setUint32(4, 8 + data.byteLength);
  const head = new DataView(new ArrayBuffer(12));
  const total = 4 + comm.byteLength + ssnd.byteLength + data.byteLength;
  tag(head, 0, 'FORM'); head.setUint32(4, total); tag(head, 8, aifc ? 'AIFC' : 'AIFF');
  const out = new Uint8Array(12 + total - 4);
  let at = 0;
  for (const part of [head, comm, ssnd, data]) { out.set(new Uint8Array(part.buffer), at); at += part.byteLength; }
  return out.buffer;
}

const tone = (n, f, a) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / 48000));
const left = tone(480, 440, 0.5);
const right = tone(480, 220, -0.25);
const near = (got, want, tol) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

test('AIFF and AIFF-C read back in every format a file is written in', () => {
  for (const [label, opts, tol] of [
    ['16-bit', { bits: 16 }, 1e-4],
    ['24-bit', { bits: 24 }, 1e-6],
    ['16-bit little-endian (sowt)', { bits: 16, compression: 'sowt' }, 1e-4],
    ['32-bit float', { compression: 'fl32' }, 1e-7],
  ]) {
    const r = decodeAiff(aiff([left, right], opts));
    assert.equal(r.sampleRate, 48000, label);
    assert.equal(r.frames, 480, label);
    assert.ok(near(r.channels[0], left, tol) && near(r.channels[1], right, tol), `${label} reads back as written`);
  }
  assert.equal(decodeAiff(aiff([left], { rate: 44100 })).sampleRate, 44100, 'the extended-float rate');
});

test('anything that is not AIFF is the browser\'s to decode', async () => {
  assert.equal(decodeAiff(new TextEncoder().encode('RIFF....WAVEfmt ').buffer), null);
  const asked = [];
  const context = { sampleRate: 48000, decodeAudioData: async (b) => { asked.push(b); return 'decoded'; } };
  const wav = new Uint8Array(64).buffer;
  assert.equal(await decodeAudio(context, wav), 'decoded');
  assert.equal(asked.length, 1);
});

test('an AIFF becomes an AudioBuffer without the browser\'s decoder', async () => {
  const made = [];
  const context = {
    sampleRate: 48000,
    decodeAudioData: async () => { throw new Error('should not be asked'); },
    createBuffer: (channels, frames, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      const buffer = { numberOfChannels: channels, length: frames, sampleRate: rate, copyToChannel: (d, c) => data[c].set(d), data };
      made.push(buffer);
      return buffer;
    },
  };
  const buffer = await decodeAudio(context, aiff([left, right]));
  assert.equal(buffer.numberOfChannels, 2);
  assert.ok(near(buffer.data[0], left, 1e-4));
});

test('a compressed AIFF-C says what it is rather than playing noise', () => {
  assert.throws(() => decodeAiff(aiff([left], { compression: 'ulaw' })), /compressed \("ulaw"\)/);
});
