// Captured device state, kept out of the buffer - the browser's half of blobs.js.
//
// The format is not ours to choose. A pattern saved on the desktop and opened here, or written
// here and opened there, has to mean the same thing, so the handle spelling, the scan that finds
// a state written out in full, and the twelve-character content id are all exactly what
// blobs.js does. A test drives both implementations over the same inputs and fails if they ever
// disagree, which is the only way a rule like "the format is shared" stays true.
//
// What IS different is where the bytes go: files on one side, a key-value store on the other.
// And what is not here at all is the sweep. On the desktop a month of playing leaves hundreds of
// megabytes of captured programs and the store has to give ground; here the browser already
// enforces a quota and clearing site data is one click, so a collector of our own would be a
// second opinion about the same bytes. See the web build entry in TODO.md.

const ID_RE = /^[0-9a-f]{12}$/;

// What a captured state looks like in the buffer: a string literal of base64. Base64 of a gzip
// header always begins "H4sI", so this cannot collide with the other long strings a pattern
// holds - note grids and shape data both carry commas and spaces.
//
// Found by scanning rather than with one regex, for the reason blobs.js gives: a quantifier over
// a state with no upper bound overflows the regex stack on a large one, and a real captured
// program can be megabytes.
const BLOB_START = /"H4sI/g;
const MIN_BLOB = 68;
const HANDLE_RE = /"@([0-9a-f]{12})"/g;

const isB64 = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

/** Every captured state written out in full in `text`, as { start, end, state } over its body. */
export function* findBlobs(text) {
  BLOB_START.lastIndex = 0;
  let m;
  while ((m = BLOB_START.exec(text)) !== null) {
    const start = m.index + 1;          // past the opening quote
    let end = start + 4;                // past "H4sI"
    while (end < text.length && isB64(text.charCodeAt(end))) end += 1;
    // Only a literal that ENDS here is one: base64 runs to its closing quote, and anything else
    // ("H4sI" opening a word in a comment, a truncated paste) is left where it stands.
    if (text[end] !== '"' || end - start < MIN_BLOB) {
      BLOB_START.lastIndex = m.index + 1;
      continue;
    }
    yield { start, end, state: text.slice(start, end) };
    BLOB_START.lastIndex = end + 1;
  }
}

/**
 * The content id of a state: the first twelve hex characters of its SHA-256.
 *
 * Asynchronous here where the desktop's is not, because the only hash a browser offers is. Every
 * caller was already asynchronous - they all end in a read or a write - so this costs nothing
 * beyond the await, and it produces the same twelve characters for the same bytes.
 */
export async function blobId(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

const keyFor = (id) => {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('not a blob id');
  return `blobs/${id}.b64`;
};

/** Every handle `text` mentions. Pure, and the same scan the desktop does. */
export function referencedIds(text) {
  const out = new Set();
  HANDLE_RE.lastIndex = 0;
  let m;
  while ((m = HANDLE_RE.exec(String(text ?? ''))) !== null) out.add(m[1]);
  return out;
}

/**
 * Does this code hold captured states written out IN FULL?
 *
 * Which is what decides whether loading it has any work to do - not whether it mentions handles,
 * which is the ordinary case and means there is nothing to store.
 */
export function hasBlobs(code) {
  return !findBlobs(String(code ?? '')).next().done;
}

export function createBlobs(store) {
  /** Stores one captured state and returns its handle, ready to write into code. */
  async function putBlob(text) {
    const id = await blobId(text);
    const key = keyFor(id);
    // Content-addressed, so a record that is already there already holds exactly this state.
    // Touched rather than rewritten: writing megabytes again is time that buys nothing, and the
    // touch is what says this state is in use now.
    const held = await store.get(key);
    if (held) await store.put(key, { ...held, mtime: Date.now() });
    else await store.put(key, { text: String(text), mtime: Date.now() });
    return `@${id}`;
  }

  /** The state behind a handle - `@<id>` or a bare id - or null if the store does not have it. */
  async function getBlob(handle) {
    const id = String(handle ?? '').replace(/^@/, '');
    if (!ID_RE.test(id)) return null;
    const held = await store.get(`blobs/${id}.b64`);
    return held?.text ?? null;
  }

  /**
   * Code on its way IN: every state written out in full is stored and replaced by its handle, so
   * the buffer never holds the bytes even once.
   */
  async function dehydrate(code) {
    const text = String(code ?? '');
    const found = [...findBlobs(text)];
    if (!found.length) return { code: text, stored: 0 };
    const handles = new Map();
    for (const { state } of found) {
      if (!handles.has(state)) handles.set(state, await putBlob(state));
    }
    // Assembled from the gaps rather than by replacing across the whole text: the pieces being
    // joined are kilobytes even when what came in was megabytes.
    const parts = [];
    let at = 0;
    for (const { start, end, state } of found) {
      parts.push(text.slice(at, start), handles.get(state));
      at = end;
    }
    parts.push(text.slice(at));
    return { code: parts.join(''), stored: handles.size };
  }

  /**
   * Code on its way OUT to a file somebody might open anywhere: handles replaced by the states
   * themselves, so what leaves is the whole patch.
   *
   * A handle this store cannot resolve is left standing rather than dropped. A `"@…"` in a file
   * is a sound that can be found again if its store turns up; an empty string is a sound that is
   * simply gone.
   */
  async function hydrate(code) {
    const text = String(code ?? '');
    const found = [...text.matchAll(HANDLE_RE)];
    if (!found.length) return { code: text, missing: [] };
    const states = new Map();
    const missing = [];
    for (const [, id] of found) {
      if (states.has(id)) continue;
      const state = await getBlob(id);
      if (state == null) missing.push(id);
      else states.set(id, state);
    }
    return {
      code: text.replace(HANDLE_RE, (whole, id) => (states.has(id) ? `"${states.get(id)}"` : whole)),
      missing,
    };
  }

  return { putBlob, getBlob, dehydrate, hydrate };
}
