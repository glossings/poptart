'use strict';

// A sample's length from its header alone - WAV, AIFF and FLAC - without decoding a frame of it.
// What the track list reads to say how long `s("loop:3")` is at the moment it is evaluated: the
// engine only learns a file's length once its pack has loaded into the server, which for a pack
// played for the first time is after the eval that names it.
//
// Reads the first HEAD_BYTES of the file and nothing more, so it is cheap enough to do on an
// evaluation: the chunks that precede the audio (fmt, a bext, a LIST of tags) are small, and a
// header that does not fit is answered with null rather than with a longer read.

const fs = require('node:fs');

const HEAD_BYTES = 64 * 1024;

function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return { buf: buf.subarray(0, n), size: fs.fstatSync(fd).size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** An 80-bit IEEE extended float (AIFF's sample rate), big-endian at `off`. */
function readExtended(buf, off) {
  const exp = ((buf[off] & 0x7f) << 8) | buf[off + 1];
  const hi = buf.readUInt32BE(off + 2);
  const lo = buf.readUInt32BE(off + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const sign = buf[off] & 0x80 ? -1 : 1;
  return sign * (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

function wavInfo(buf, fileSize) {
  let fmt = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), blockAlign: buf.readUInt16LE(body + 12) };
    } else if (id === 'data') {
      if (!fmt || !(fmt.blockAlign > 0) || !(fmt.sampleRate > 0)) return null;
      // A recorder that never went back to fill the size in leaves 0 or ~0: the data is then
      // whatever follows the header, to the end of the file.
      const bytes = size === 0 || size === 0xffffffff ? fileSize - body : Math.min(size, fileSize - body);
      const frames = Math.floor(bytes / fmt.blockAlign);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, duration: frames / fmt.sampleRate };
    }
    off = body + size + (size % 2);
  }
  return null;
}

function aiffInfo(buf) {
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === 'COMM' && body + 18 <= buf.length) {
      const channels = buf.readUInt16BE(body);
      const frames = buf.readUInt32BE(body + 2);
      const sampleRate = readExtended(buf, body + 8);
      if (!(sampleRate > 0)) return null;
      return { sampleRate, channels, frames, duration: frames / sampleRate };
    }
    off = body + size + (size % 2);
  }
  return null;
}

function flacInfo(buf) {
  // STREAMINFO is always the first metadata block: 4 bytes of block header after the marker, then
  // 34 bytes whose bits 80..143 carry the rate (20), channels-1 (3), bits-1 (5) and frames (36).
  if (buf.length < 8 + 34 || (buf[4] & 0x7f) !== 0) return null;
  const b = 8;
  const sampleRate = (buf[b + 10] << 12) | (buf[b + 11] << 4) | (buf[b + 12] >> 4);
  const channels = ((buf[b + 12] >> 1) & 0x07) + 1;
  const frames = (buf[b + 13] & 0x0f) * 2 ** 32 + buf.readUInt32BE(b + 14);
  if (!(sampleRate > 0) || !(frames > 0)) return null; // 0 frames = "unknown" in a FLAC header
  return { sampleRate, channels, frames, duration: frames / sampleRate };
}

/** The bytes-only half, for the tests: `buf` is the head of a file `fileSize` long. */
function audioHeaderOf(buf, fileSize = buf.length) {
  if (!buf || buf.length < 12) return null;
  const tag = buf.toString('ascii', 0, 4);
  if (tag === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return wavInfo(buf, fileSize);
  if (tag === 'FORM' && /^AIF[FC]$/.test(buf.toString('ascii', 8, 12))) return aiffInfo(buf);
  if (tag === 'fLaC') return flacInfo(buf);
  return null;
}

/**
 * { sampleRate, channels, frames, duration (seconds) } from a file's header, or null for a format
 * this does not read (mp3, ogg, ...) or a header it cannot make sense of.
 */
function readAudioHeader(filePath) {
  const head = readHead(filePath);
  return head ? audioHeaderOf(head.buf, head.size) : null;
}

module.exports = { readAudioHeader, audioHeaderOf, HEAD_BYTES };
