// Descriptive metadata out of a song file's own tags (songs phase 4): title/artist/album plus
// tempo and key, from ID3v2 (mp3, and the id3 chunk wav/aiff files carry), the container's own
// text chunks (RIFF LIST/INFO, AIFF NAME/AUTH), vorbis comments (flac), and the mp4 ilst atoms
// (m4a/aac). Bounded - a handful of header-sized reads, never the audio. Detection is by magic
// bytes, not extension: a "wav" that is really an mp3 tags like what it is.
//
// Every field is always present and null when absent, so callers can destructure without
// guarding for missing keys; tags are a convenience, and the deck's bpm stays user-editable
// either way.
//
// Shared by both builds, as an ES module with no disk in it. The container walks are generators
// that YIELD each read they need - `[at, length]` - and are handed the bytes back, so the desktop
// (song-tags.js) drives them synchronously off a file descriptor and the browser build drives the
// same code asynchronously off a File, reading only what each header names in both.

/** The shape every parser in here returns, and what an untagged or unreadable file reads as. */
export const noTags = () => ({ title: null, artist: null, album: null, bpm: null, key: null });

// A parsed bpm has to be a plausible native tempo; TKEY-style keys are short ("F#m", "11B").
// Values outside that are tagging noise, and null (manual entry) beats noise.
function cleanBpm(n) {
  return Number.isFinite(n) && n >= 20 && n <= 400 ? n : null;
}
function cleanKey(s) {
  const key = String(s ?? '').trim();
  return key && key.length <= 12 ? key : null;
}

// Free text is whatever a tagger wrote, so it gets the least trust of the three: a NUL ends it
// (padding in fixed-width chunk fields, and the multi-value separator ID3v2.4 allows - the first
// value is the one we want), and the length cap keeps a corrupt or hostile frame from handing the
// UI a megabyte of "title".
const TEXT_CAP = 300;
function cleanText(s) {
  const raw = String(s ?? '');
  const z = raw.indexOf('\0');
  const text = (z < 0 ? raw : raw.slice(0, z)).trim();
  return text ? text.slice(0, TEXT_CAP).trim() : null;
}

// Merge a second read over a first, keeping whatever the second actually found. Used where one
// file can carry two tags at once and one of them is the more authoritative.
function overlay(base, over) {
  const out = { ...base };
  for (const field of Object.keys(out)) if (over[field] != null) out[field] = over[field];
  return out;
}

// --- reading bytes ---

const latin1 = (buf, from = 0, to = buf.length) => {
  let s = '';
  for (let i = from; i < Math.min(to, buf.length); i++) s += String.fromCharCode(buf[i]);
  return s;
};
const decode = (encoding, bytes) => new TextDecoder(encoding).decode(bytes);
const u32be = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b, at) => ((b[at + 3] << 24) >>> 0) + (b[at + 2] << 16) + (b[at + 1] << 8) + b[at];
const u24be = (b, at) => (b[at] << 16) + (b[at + 1] << 8) + b[at + 2];
const u16be = (b, at) => (b[at] << 8) + b[at + 1];
const u64be = (b, at) => u32be(b, at) * 2 ** 32 + u32be(b, at + 4);

// --- ID3v2 ---

const SYNCSAFE = (buf, at) => ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14) | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);

// Reverse the unsynchronisation stuffing (FF 00 -> FF) old writers apply to the whole tag.
function deUnsync(buf) {
  const out = new Uint8Array(buf.length);
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
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) text = decode('utf-16be', body.subarray(2));
    else {
      if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) body = body.subarray(2);
      text = decode('utf-16le', body);
    }
  } else if (enc === 2) {
    text = decode('utf-16be', body);
  } else {
    text = enc === 3 ? decode('utf-8', body) : latin1(body);
  }
  return text.replace(/\0+$/, '').trim();
}

// Which frame carries which field. v2.2 ids are three characters, everything later is four;
// the frame bodies are identical text frames either way.
const ID3_FIELDS_V22 = { TT2: 'title', TP1: 'artist', TAL: 'album', TBP: 'bpm', TKE: 'key' };
const ID3_FIELDS = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TBPM: 'bpm', TKEY: 'key' };

/** Parse an ID3v2 tag sitting at the start of `buf`. Returns the five-field shape, nulls when absent. */
export function parseId3(buf) {
  if (buf.length < 10 || latin1(buf, 0, 3) !== 'ID3') return noTags();
  const major = buf[3];
  const flags = buf[5];
  const tagSize = SYNCSAFE(buf, 6);
  let body = buf.subarray(10, 10 + tagSize);
  if (flags & 0x80) body = deUnsync(body); // whole-tag unsynchronisation (v2.2/2.3 era)
  let at = 0;
  if (flags & 0x40) { // extended header: v2.4 size is syncsafe and includes itself; v2.3 doesn't
    if (major >= 4) at += Math.max(4, SYNCSAFE(body, 0));
    else at += 4 + u32be(body, 0);
  }
  const fields = major === 2 ? ID3_FIELDS_V22 : ID3_FIELDS;
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  const out = noTags();
  // The loop runs to the end of the frames rather than stopping once it has what it came for:
  // with five fields in play an early exit would almost never fire, since few tags carry all of
  // them, so it bought nothing while quietly making a late duplicate frame unreachable.
  while (at + headLen <= body.length) {
    const id = latin1(body, at, at + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding (or a torn tag) - nothing further to read
    const size = major === 2 ? u24be(body, at + 3)
      : major === 4 ? SYNCSAFE(body, at + 4) : u32be(body, at + 4);
    if (size < 0 || at + headLen + size > body.length) break;
    let payload = body.subarray(at + headLen, at + headLen + size);
    if (major === 4 && (body[at + 9] & 0x02)) payload = deUnsync(payload); // frame-level unsync
    const field = fields[id];
    if (field) {
      const text = id3Text(payload);
      out[field] = field === 'bpm' ? cleanBpm(parseFloat(text))
        : field === 'key' ? cleanKey(text) : cleanText(text);
    }
    at += headLen + size;
  }
  return out;
}

// --- container walks: each read is yielded as [at, length], and the bytes come back ---

const ID3_READ_CAP = 2 * 1024 * 1024; // TBPM/TKEY sit early; never slurp a tag's art gallery

function* tagsFromId3At(at) {
  const head = yield [at, 10];
  if (head.length < 10 || latin1(head, 0, 3) !== 'ID3') return noTags();
  const size = Math.min(SYNCSAFE(head, 6), ID3_READ_CAP);
  return parseId3(yield [at, 10 + size]);
}

const TEXT_CHUNK_CAP = 4 * 1024; // one chunk's worth of text; cleanText trims it far shorter
const INFO_LIST_CAP = 64 * 1024; // an INFO list is a handful of short strings, never more

// RIFF LIST/INFO: 'INFO' then plain NUL-terminated latin1 chunks, by the usual convention
// INAM/IART/IPRD for title/artist/album. First writer of a field wins, as in a vorbis block.
function tagsFromRiffInfo(buf) {
  const out = noTags();
  if (buf.length < 4 || latin1(buf, 0, 4) !== 'INFO') return out;
  let at = 4;
  for (let hops = 0; hops < 512 && at + 8 <= buf.length; hops++) {
    const id = latin1(buf, at, at + 4);
    const size = u32le(buf, at + 4);
    const field = id === 'INAM' ? 'title' : id === 'IART' ? 'artist' : id === 'IPRD' ? 'album' : null;
    if (field && out[field] == null) out[field] = cleanText(latin1(buf, at + 8, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return out;
}

// RIFF (wav, little-endian sizes) and FORM (aiff, big-endian): scan chunks for an id3 chunk and
// for the container's own text chunks. Both can be present in one file - an editor writes
// LIST/INFO or NAME/AUTH, a tagger adds id3 - so collect both and let the id3 chunk win where
// they overlap: it is the richer, more deliberately written tag.
function* tagsFromChunks(end, littleEndian) {
  const out = noTags();
  let fromId3 = null;
  let at = 12;
  for (let hops = 0; hops < 512 && at + 8 <= end; hops++) {
    const head = yield [at, 8];
    if (head.length < 8) break;
    const id = latin1(head, 0, 4);
    const size = littleEndian ? u32le(head, 4) : u32be(head, 4);
    if (id.toLowerCase().trim() === 'id3') {
      fromId3 = yield* tagsFromId3At(at + 8);
    } else if (littleEndian && id === 'LIST') {
      const list = tagsFromRiffInfo(yield [at + 8, Math.min(size, INFO_LIST_CAP)]);
      for (const field of ['title', 'artist', 'album']) out[field] ??= list[field];
    } else if (!littleEndian && (id === 'NAME' || id === 'AUTH')) {
      const text = cleanText(latin1(yield [at + 8, Math.min(size, TEXT_CHUNK_CAP)]));
      if (id === 'NAME') out.title ??= text;
      else out.artist ??= text;
    }
    at += 8 + size + (size % 2); // chunks are word-aligned
  }
  return fromId3 ? overlay(out, fromId3) : out;
}

// FLAC metadata blocks: type 4 is the vorbis comment block.
function* tagsFromFlac() {
  let at = 4;
  for (let hops = 0; hops < 128; hops++) {
    const head = yield [at, 4];
    if (head.length < 4) break;
    const size = u24be(head, 1);
    if ((head[0] & 0x7f) === 4) return parseVorbisComments(yield [at + 4, Math.min(size, ID3_READ_CAP)]);
    if (head[0] & 0x80) break; // last-block flag
    at += 4 + size;
  }
  return noTags();
}

function parseVorbisComments(buf) {
  const out = noTags();
  try {
    let at = 4 + u32le(buf, 0); // vendor string
    const count = u32le(buf, at);
    at += 4;
    for (let i = 0; i < count && at + 4 <= buf.length; i++) {
      const len = u32le(buf, at);
      const line = decode('utf-8', buf.subarray(at + 4, at + 4 + len));
      at += 4 + len;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const name = line.slice(0, eq).toUpperCase();
      const value = line.slice(eq + 1);
      if (out.title == null && name === 'TITLE') out.title = cleanText(value);
      if (out.artist == null && name === 'ARTIST') out.artist = cleanText(value);
      if (out.album == null && name === 'ALBUM') out.album = cleanText(value);
      if (out.bpm == null && (name === 'BPM' || name === 'TEMPO')) out.bpm = cleanBpm(parseFloat(value));
      if (out.key == null && (name === 'INITIALKEY' || name === 'INITIAL_KEY' || name === 'KEY')) out.key = cleanKey(value);
    }
  } catch { /* a torn comment block reads as untagged */ }
  return out;
}

// MP4/M4A: find moov (top-level box walk), read it whole (small - it's the index, not the
// audio), then walk moov/udta/meta/ilst in memory. `meta` is a FULL box: 4 bytes of
// version/flags before its children.
function* tagsFromMp4(end) {
  let at = 0;
  for (let hops = 0; hops < 256 && at + 8 <= end; hops++) {
    const head = yield [at, 16];
    if (head.length < 8) break;
    let size = u32be(head, 0);
    const type = latin1(head, 4, 8);
    let dataAt = at + 8;
    if (size === 1 && head.length >= 16) {
      size = u64be(head, 8);
      dataAt = at + 16;
    } else if (size === 0) size = end - at;
    if (size < 8) break;
    if (type === 'moov') {
      const moov = yield [dataAt, Math.min(size - (dataAt - at), 8 * 1024 * 1024)];
      const udta = mp4Child(moov, 'udta');
      const meta = udta && mp4Child(udta, 'meta');
      const ilst = meta && mp4Child(meta.subarray(4), 'ilst'); // skip meta's version/flags
      return ilst ? tagsFromIlst(ilst) : noTags();
    }
    at += size;
  }
  return noTags();
}

function mp4Child(buf, want) {
  let at = 0;
  while (at + 8 <= buf.length) {
    const size = u32be(buf, at);
    if (size < 8) return null;
    if (latin1(buf, at + 4, at + 8) === want) return buf.subarray(at + 8, at + size);
    at += size;
  }
  return null;
}

function mp4DataPayload(item) {
  const data = mp4Child(item, 'data');
  return data && data.length >= 8 ? data.subarray(8) : null; // past type-indicator + locale
}

// The text atoms are named with a leading copyright sign, which is the single byte 0xa9 in the
// latin1 the atom ids are compared as - spelled with an escape here so the source cannot be
// mistaken for (or re-saved as) the two-byte UTF-8 encoding of the same character, which would
// never match a real file.
const MP4_TEXT_FIELDS = { '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album' };

function tagsFromIlst(ilst) {
  const out = noTags();
  let at = 0;
  while (at + 8 <= ilst.length) {
    const size = u32be(ilst, at);
    if (size < 8) break;
    const type = latin1(ilst, at + 4, at + 8);
    const item = ilst.subarray(at + 8, at + size);
    const textField = MP4_TEXT_FIELDS[type];
    if (textField) {
      const payload = mp4DataPayload(item);
      if (payload) out[textField] = cleanText(decode('utf-8', payload));
    } else if (type === 'tmpo') {
      const payload = mp4DataPayload(item);
      if (payload && payload.length >= 2) out.bpm = cleanBpm(u16be(payload, 0));
    } else if (type === '----') {
      const name = mp4Child(item, 'name');
      if (name && decode('utf-8', name.subarray(4)).toLowerCase() === 'initialkey') {
        const payload = mp4DataPayload(item);
        if (payload) out.key = cleanKey(decode('utf-8', payload));
      }
    }
    at += size;
  }
  return out;
}

/** The whole read of a file `size` bytes long, as yielded requests. */
export function* songTagsOf(size) {
  const magic = yield [0, 12];
  if (magic.length < 12) return noTags();
  const four = latin1(magic, 0, 4);
  if (four.startsWith('ID3')) return yield* tagsFromId3At(0);
  if (four === 'RIFF' && latin1(magic, 8, 12) === 'WAVE') return yield* tagsFromChunks(size, true);
  if (four === 'FORM') return yield* tagsFromChunks(size, false);
  if (four === 'fLaC') return yield* tagsFromFlac();
  if (latin1(magic, 4, 8) === 'ftyp') return yield* tagsFromMp4(size);
  return noTags();
}

/** Drives the read with `readAt(at, length) -> Uint8Array`. Never throws. */
export function readTagsSync(size, readAt) {
  try {
    const walk = songTagsOf(size);
    let step = walk.next();
    while (!step.done) step = walk.next(readAt(...step.value));
    return step.value;
  } catch {
    return noTags();
  }
}

/** The same with `readAt` answering a promise - a browser File, read a slice at a time. */
export async function readTagsAsync(size, readAt) {
  try {
    const walk = songTagsOf(size);
    let step = walk.next();
    while (!step.done) step = walk.next(await readAt(...step.value));
    return step.value;
  } catch {
    return noTags();
  }
}

/** A browser File's (or Blob's) tags, reading only the slices the headers name. */
export function readFileTags(file) {
  return readTagsAsync(file.size, async (at, n) => new Uint8Array(await file.slice(at, at + n).arrayBuffer()));
}
