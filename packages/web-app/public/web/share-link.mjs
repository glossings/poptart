// Share links: a whole pattern in the part of the URL after `#`.
//
// The fragment never reaches a server, so a link needs nothing hosted behind it - it IS the
// pattern. What limits it is the browser's cap on a URL (2MB in Chrome), and a pattern is
// kilobytes: a collection of saved songs measured a median of 1.6k characters as a link and a
// largest of 17k, once compressed.
//
// Compressed with deflate-raw, which every browser has built in (CompressionStream), and written
// as URL-safe base64 behind `z=`. The other spellings a hash can have - `s=<id>`, a snapshot on
// this machine, and a bare base64 buffer - are client.js's.
//
// Captured device states are unpacked before compressing. A preset is JSON written as base64
// (encodeState in the web engine), and base64 hides the repetition deflate feeds on: the same
// parameter names in every preset, the same digits in every value. So each one is decoded to its
// JSON, held beside the code, and written back as the same base64 when the link is opened -
// byte for byte the literal that went out, which is checked on the way out rather than assumed.
//
// What cannot travel is left where it stands. Files added to this browser (`files:`, the `wt:`
// wavetable folder, `rec:` recordings) and captured desktop plugin states (`@handles` into this
// browser's store) are references to bytes the link does not carry; they stay in the code as
// names, and on the other end they are a sound that is not there - the engine says so and keeps
// playing - until that browser has a file by the same name. localOnly lists them so both ends
// can be told.

export const SHARE_PREFIX = 'z=';

/** Chrome refuses to navigate to a URL longer than this. */
export const MAX_URL = 2 * 1024 * 1024;

// A captured state in the code: a double-quoted base64 literal of a JSON object. `{"` encodes to
// "ey", and every literal found is decoded and re-encoded before it counts, so the prefix only
// has to find candidates. Scanned by hand rather than with a regex for the reason blobs.mjs
// gives: a quantifier over a literal with no upper bound overflows the regex stack on a big one.
const STATE_START = /"ey/g;
const MIN_STATE = 16;

// Stands in for a state inside the shared code. NUL cannot be typed into the editor, so the code
// around it can never contain one of its own.
const MARK = '\u0000';
const MARK_RE = /\u0000(\d+)\u0000/g;

const isB64 = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

function bytesToBinary(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function binaryToBytes(binary) {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A state's JSON to the base64 a preset definition holds - the web engine's encodeState. */
const stateToB64 = (json) => btoa(bytesToBinary(new TextEncoder().encode(json)));

/** The JSON behind a base64 literal, or null when it is not one this module can put back exactly. */
function b64ToState(b64) {
  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(binaryToBytes(atob(b64)));
    if (!json.startsWith('{')) return null;
    JSON.parse(json);
  } catch {
    return null;
  }
  return stateToB64(json) === b64 ? json : null;
}

/** Every captured state written out in `code`, as { start, end, json } over the literal's body. */
function* findStates(code) {
  STATE_START.lastIndex = 0;
  let m;
  while ((m = STATE_START.exec(code)) !== null) {
    const start = m.index + 1;
    let end = start + 2;
    while (end < code.length && isB64(code.charCodeAt(end))) end += 1;
    STATE_START.lastIndex = end;
    if (code[end] !== '"' || end - start < MIN_STATE) continue;
    const json = b64ToState(code.slice(start, end));
    if (json !== null) yield { start, end, json };
  }
}

/** `code` with each captured state swapped for a marker, and the states' JSON, each once. */
export function unpackStates(code) {
  const text = String(code ?? '');
  const states = [];
  const index = new Map();
  const parts = [];
  let at = 0;
  for (const { start, end, json } of findStates(text)) {
    if (!index.has(json)) {
      index.set(json, states.length);
      states.push(json);
    }
    parts.push(text.slice(at, start), `${MARK}${index.get(json)}${MARK}`);
    at = end;
  }
  parts.push(text.slice(at));
  return { code: parts.join(''), states };
}

/** And back: the markers written out as the base64 literals they stood for. */
export function packStates(code, states) {
  return String(code).replace(MARK_RE, (whole, i) => {
    const json = states[Number(i)];
    if (typeof json !== 'string') throw new Error(`the link names a device state it does not carry (#${i})`);
    return stateToB64(json);
  });
}

async function through(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const toBase64Url = (bytes) => btoa(bytesToBinary(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text) => binaryToBytes(atob(text.replace(/-/g, '+').replace(/_/g, '/')));

/** The pattern as a URL fragment, without the `#`. */
export async function encodeShareHash(code) {
  const payload = JSON.stringify(unpackStates(code));
  const bytes = await through(new TextEncoder().encode(payload), new CompressionStream('deflate-raw'));
  return SHARE_PREFIX + toBase64Url(bytes);
}

/** The pattern a `z=` fragment holds. Throws on one that does not decode - a link cut short. */
export async function decodeShareHash(hash) {
  const body = String(hash ?? '').replace(/^#/, '');
  if (!body.startsWith(SHARE_PREFIX)) throw new Error('not a share link');
  const bytes = await through(fromBase64Url(body.slice(SHARE_PREFIX.length)), new DecompressionStream('deflate-raw'));
  const { code, states } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (typeof code !== 'string' || !Array.isArray(states)) throw new Error('the link does not hold a pattern');
  return packStates(code, states);
}

// A reference into one of the packs this browser fills itself. Ends where a mini-notation token
// or a string does.
const ADDED_REF = /(?<![\w-])((?:files|wt|rec):[^\s"'`,<>[\]{}|()*!?@]+)/g;
// sr("name") plays a recording by its bare name.
const SR_CALL = /\bsr\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const HANDLE = /"@([0-9a-f]{12})"/g;

/**
 * What a link of `code` names but does not carry: `files`, the references to files added to this
 * browser (in the code or in a device state), and `handles`, how many captured desktop plugin
 * states it points at. Null when it carries everything.
 */
export function localOnly(code) {
  const text = String(code ?? '');
  const { code: bare, states } = unpackStates(text);
  const files = new Set();
  for (const src of [bare, ...states]) {
    for (const m of src.matchAll(ADDED_REF)) files.add(m[1]);
  }
  for (const m of bare.matchAll(SR_CALL)) {
    for (const name of m[2].split(/[\s,<>[\]{}|!*/?@:]+/).filter(Boolean)) files.add(`rec:${name}`);
  }
  const handles = new Set([...bare.matchAll(HANDLE)].map((m) => m[1])).size;
  if (!files.size && !handles) return null;
  return { files: [...files], handles };
}
