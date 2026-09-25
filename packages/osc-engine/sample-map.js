'use strict';

// The sample map on the desktop: the shared maths (sample-map-core.mjs - see its header for the
// pipeline) plus the one thing only this side does, reading the head of a WAV off the disk.

const fs = require('node:fs');

const { decodeWavRaw } = require('./wav');
const core = require('./sample-map-core.mjs');

const { HEAD_SECONDS, mixdownHead } = core;

// Enough bytes for HEAD_SECONDS of the widest format worth planning for (96k stereo float) plus
// headers. Reading only the head is what keeps indexing a 16GB library a matter of seconds of
// disk rather than minutes: most of that size is in a few hundred long files.
const HEAD_BYTES = 4 * 1024 * 1024;

/**
 * The first HEAD_SECONDS of a WAV as a mono mixdown. Returns { sampleRate, samples, totalSeconds }
 * or null for anything wav.js can't decode. `totalSeconds` comes from the header, so it is the
 * whole file's length even though only the head was read.
 */
function readAudioHead(filePath, { seconds = HEAD_SECONDS } = {}) {
  let buf;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      buf = Buffer.allocUnsafe(Math.min(size, HEAD_BYTES));
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, got);
        if (!n) break;
        got += n;
      }
      buf = buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const raw = decodeWavRaw(buf);
  if (!raw) return null;
  return mixdownHead(raw, seconds);
}

module.exports = { ...core, readAudioHead };
