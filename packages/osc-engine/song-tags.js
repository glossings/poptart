'use strict';

// A song file's own tags (title, artist, album, tempo, key), read off the disk. The parsing is
// song-tags-core.mjs, which the browser build runs too; this is the part that opens the file and
// answers each read the core asks for. All sync and bounded - a handful of header-sized reads,
// never the audio - so the song/load route can call it inline.

const fs = require('node:fs');
const { readTagsSync, parseId3, noTags } = require('./song-tags-core.mjs');

/**
 * Read a song file's tags: { title, artist, album, bpm, key }, each null when absent or
 * implausible. Never throws - an unreadable or unrecognized file is simply untagged.
 */
function readSongTags(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    return readTagsSync(size, (at, n) => {
      const buf = Buffer.alloc(Math.max(0, n));
      const got = fs.readSync(fd, buf, 0, buf.length, at);
      return new Uint8Array(buf.buffer, buf.byteOffset, got);
    });
  } catch {
    return noTags();
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

module.exports = { readSongTags, parseId3: (buf) => parseId3(new Uint8Array(buf.buffer, buf.byteOffset, buf.length)) };
