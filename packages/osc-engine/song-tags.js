'use strict';

// Tempo/key metadata out of a song file's own tags (songs phase 4): ID3v2 TBPM/TKEY (mp3, and
// the id3 chunk wav/aiff files carry), vorbis comments (flac), and the mp4 ilst atoms (m4a/aac).
// All sync and bounded - a handful of header-sized reads, never the audio - so the song/load
// route can call it inline. Detection is by magic bytes, not extension: a "wav" that is really
// an mp3 tags like what it is. Anything unreadable or untagged is { bpm: null, key: null } -
// tags are a convenience, and the deck's bpm stays user-editable either way.

const fs = require('node:fs');

// A parsed bpm has to be a plausible native tempo; TKEY-style keys are short ("F#m", "11B").
// Values outside that are tagging noise, and null (manual entry) beats noise.
function cleanBpm(n) {
  return Number.isFinite(n) && n >= 20 && n <= 400 ? n : null;
}
function cleanKey(s) {
  const key = String(s ?? '').trim();
  return key && key.length <= 12 ? key : null;
}

// --- ID3v2 ---

const SYNCSAFE = (buf, at) => ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14) | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);

// Reverse the unsynchronisation stuffing (FF 00 -> FF) old writers apply to the whole tag.
function deUnsync(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    out[n++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

// A text frame's payload: encoding byte, then the string. 0 latin1, 1 utf16 w/ BOM, 2 utf16be, 3 utf8.
function id3Text(payload) {
  if (!payload.length) return '';
  const enc = payload[0];
  let body = payload.subarray(1);
  let text;
  if (enc === 1) {
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
      body = body.subarray(2);
      text = Buffer.from(body).swap16().toString('utf16le');
    } else {
      if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) body = body.subarray(2);
      text = body.toString('utf16le');
    }
  } else if (enc === 2) {
    text = Buffer.from(body).swap16().toString('utf16le');
  } else {
    text = body.toString(enc === 3 ? 'utf8' : 'latin1');
  }
  return text.replace(/\0+$/, '').trim();
}

/** Parse an ID3v2 tag sitting at the start of `buf`. Returns { bpm, key } (nulls when absent). */
function parseId3(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return { bpm: null, key: null };
  const major = buf[3];
  const flags = buf[5];
  const tagSize = SYNCSAFE(buf, 6);
  let body = buf.subarray(10, 10 + tagSize);
  if (flags & 0x80) body = deUnsync(body); // whole-tag unsynchronisation (v2.2/2.3 era)
  let at = 0;
  if (flags & 0x40) { // extended header: v2.4 size is syncsafe and includes itself; v2.3 doesn't
    if (major >= 4) at += Math.max(4, SYNCSAFE(body, 0));
    else at += 4 + body.readUInt32BE(0);
  }
  const wantBpm = major === 2 ? 'TBP' : 'TBPM';
  const wantKey = major === 2 ? 'TKE' : 'TKEY';
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  let bpm = null;
  let key = null;
  while (at + headLen <= body.length) {
    const id = body.toString('latin1', at, at + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding (or a torn tag) - nothing further to read
    const size = major === 2 ? body.readUIntBE(at + 3, 3)
      : major === 4 ? SYNCSAFE(body, at + 4) : body.readUInt32BE(at + 4);
    if (size < 0 || at + headLen + size > body.length) break;
    let payload = body.subarray(at + headLen, at + headLen + size);
    if (major === 4 && (body[at + 9] & 0x02)) payload = deUnsync(payload); // frame-level unsync
    if (id === wantBpm) bpm = cleanBpm(parseFloat(id3Text(payload)));
    if (id === wantKey) key = cleanKey(id3Text(payload));
    if (bpm != null && key != null) break;
    at += headLen + size;
  }
  return { bpm, key };
}

// --- container walks (all on an open fd, reading only what each header names) ---

function readAt(fd, at, n) {
  const buf = Buffer.alloc(n);
  const got = fs.readSync(fd, buf, 0, n, at);
  return buf.subarray(0, got);
}

const ID3_READ_CAP = 2 * 1024 * 1024; // TBPM/TKEY sit early; never slurp a tag's art gallery

function tagsFromId3At(fd, at) {
  const head = readAt(fd, at, 10);
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return { bpm: null, key: null };
  const size = Math.min(SYNCSAFE(head, 6), ID3_READ_CAP);
  return parseId3(readAt(fd, at, 10 + size));
}

// RIFF (wav, little-endian sizes) and FORM (aiff, big-endian): scan chunks for an id3 chunk.
function tagsFromChunks(fd, littleEndian) {
  let at = 12;
  const end = fs.fstatSync(fd).size;
  for (let hops = 0; hops < 512 && at + 8 <= end; hops++) {
    const head = readAt(fd, at, 8);
    if (head.length < 8) break;
    const id = head.toString('latin1', 0, 4);
    const size = littleEndian ? head.readUInt32LE(4) : head.readUInt32BE(4);
    if (id.toLowerCase().trim() === 'id3') return tagsFromId3At(fd, at + 8);
    at += 8 + size + (size % 2); // chunks are word-aligned
  }
  return { bpm: null, key: null };
}

// FLAC metadata blocks: type 4 is the vorbis comment block.
function tagsFromFlac(fd) {
  let at = 4;
  for (let hops = 0; hops < 128; hops++) {
    const head = readAt(fd, at, 4);
    if (head.length < 4) break;
    const size = head.readUIntBE(1, 3);
    if ((head[0] & 0x7f) === 4) return parseVorbisComments(readAt(fd, at + 4, Math.min(size, ID3_READ_CAP)));
    if (head[0] & 0x80) break; // last-block flag
    at += 4 + size;
  }
  return { bpm: null, key: null };
}

function parseVorbisComments(buf) {
  let bpm = null;
  let key = null;
  try {
    let at = 4 + buf.readUInt32LE(0); // vendor string
    const count = buf.readUInt32LE(at);
    at += 4;
    for (let i = 0; i < count && at + 4 <= buf.length; i++) {
      const len = buf.readUInt32LE(at);
      const line = buf.toString('utf8', at + 4, at + 4 + len);
      at += 4 + len;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const name = line.slice(0, eq).toUpperCase();
      const value = line.slice(eq + 1);
      if (bpm == null && (name === 'BPM' || name === 'TEMPO')) bpm = cleanBpm(parseFloat(value));
      if (key == null && (name === 'INITIALKEY' || name === 'INITIAL_KEY' || name === 'KEY')) key = cleanKey(value);
    }
  } catch { /* a torn comment block reads as untagged */ }
  return { bpm, key };
}

// MP4/M4A: find moov (top-level box walk on the fd), read it whole (small - it's the index, not
// the audio), then walk moov/udta/meta/ilst in memory. `meta` is a FULL box: 4 bytes of
// version/flags before its children.
function tagsFromMp4(fd) {
  const end = fs.fstatSync(fd).size;
  let at = 0;
  for (let hops = 0; hops < 256 && at + 8 <= end; hops++) {
    const head = readAt(fd, at, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let dataAt = at + 8;
    if (size === 1 && head.length >= 16) {
      size = Number(head.readBigUInt64BE(8));
      dataAt = at + 16;
    } else if (size === 0) size = end - at;
    if (size < 8) break;
    if (type === 'moov') {
      const moov = readAt(fd, dataAt, Math.min(size - (dataAt - at), 8 * 1024 * 1024));
      const udta = mp4Child(moov, 'udta');
      const meta = udta && mp4Child(udta, 'meta');
      const ilst = meta && mp4Child(meta.subarray(4), 'ilst'); // skip meta's version/flags
      return ilst ? tagsFromIlst(ilst) : { bpm: null, key: null };
    }
    at += size;
  }
  return { bpm: null, key: null };
}

function mp4Child(buf, want) {
  let at = 0;
  while (at + 8 <= buf.length) {
    const size = buf.readUInt32BE(at);
    if (size < 8) return null;
    if (buf.toString('latin1', at + 4, at + 8) === want) return buf.subarray(at + 8, at + size);
    at += size;
  }
  return null;
}

function mp4DataPayload(item) {
  const data = mp4Child(item, 'data');
  return data && data.length >= 8 ? data.subarray(8) : null; // past type-indicator + locale
}

function tagsFromIlst(ilst) {
  let bpm = null;
  let key = null;
  let at = 0;
  while (at + 8 <= ilst.length) {
    const size = ilst.readUInt32BE(at);
    if (size < 8) break;
    const type = ilst.toString('latin1', at + 4, at + 8);
    const item = ilst.subarray(at + 8, at + size);
    if (type === 'tmpo') {
      const payload = mp4DataPayload(item);
      if (payload && payload.length >= 2) bpm = cleanBpm(payload.readUInt16BE(0));
    } else if (type === '----') {
      const name = mp4Child(item, 'name');
      if (name && name.subarray(4).toString('utf8').toLowerCase() === 'initialkey') {
        const payload = mp4DataPayload(item);
        if (payload) key = cleanKey(payload.toString('utf8'));
      }
    }
    at += size;
  }
  return { bpm, key };
}

/**
 * Read a song file's tempo/key tags: { bpm, key }, each null when absent or implausible.
 * Never throws - an unreadable or unrecognized file is simply untagged.
 */
function readSongTags(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const magic = readAt(fd, 0, 12);
    if (magic.length < 12) return { bpm: null, key: null };
    const four = magic.toString('latin1', 0, 4);
    if (four.startsWith('ID3')) return tagsFromId3At(fd, 0);
    if (four === 'RIFF' && magic.toString('latin1', 8, 12) === 'WAVE') return tagsFromChunks(fd, true);
    if (four === 'FORM') return tagsFromChunks(fd, false);
    if (four === 'fLaC') return tagsFromFlac(fd);
    if (magic.toString('latin1', 4, 8) === 'ftyp') return tagsFromMp4(fd);
    return { bpm: null, key: null };
  } catch {
    return { bpm: null, key: null };
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

module.exports = { readSongTags, parseId3 };
