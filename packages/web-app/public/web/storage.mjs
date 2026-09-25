// Everything poptart keeps, kept in a browser.
//
// The desktop writes files under ~/.poptart: saved patterns, a month-foldered trail of autosaved
// sessions, history snapshots, snippets, the star library, captured device state. This is the
// same set of things under the same names, in a key-value store instead of a directory tree -
// so `patterns/kick.js` is a key here and a path there, and an export is a walk of one producing
// the other.
//
// KEEPING THE NAMES IS THE WHOLE TRICK. It is tempting to invent a flat schema for a database,
// and it would cost the one property that matters: a pattern written here opens there and the
// other way round, with no conversion step for anybody to get wrong. The format on both sides is
// plain JavaScript source with its metadata in its own comments, and that was already the rule -
// the file is the source of truth, copy it anywhere and it still means what it meant.
//
// The metadata helpers are handed in rather than imported. They live in a plain script the page
// already loads and the desktop server already requires, and passing the same module to both is
// what stops a pattern being labeled one way here and another way there.

import { normalizeLibrary } from './library-doc.mjs';

const PATTERNS = 'patterns/';
const WIP = 'patterns/wip/';
const SNIPPETS = 'snippets/';
const SNAPSHOTS = 'snapshots/';
const LIBRARY_KEY = 'patterns/library.json';
const PREBAKE_KEY = 'prebake/prebake.js';
const PINNED_KEY = 'prebake/pinned.js';

/** How many history snapshots are kept. The desktop's number, for the same reason. */
export const MAX_SNAPSHOTS = 500;

/**
 * How many NEW snapshots go by between prunes. A prune reads every snapshot's date, and the
 * store is asked for them one at a time, so doing it on every evaluation would be hundreds of
 * reads per keystroke-and-play; every so often bounds the history at the cap plus this.
 */
const PRUNE_EVERY = 25;

/** A work-in-progress id is "<month>/<session>", which is also its path. */
const WIP_ID_RE = /^(\d{4}-\d{2})\/(\d{4}-\d{2})-\d{2}-\d{6}$/;

const ID_RE = /^[0-9a-f]{12}$/;

/** The twelve-character content id a snapshot is filed under. */
export async function snapshotId(code) {
  const bytes = new TextEncoder().encode(String(code));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/**
 * A song's native tempo, read straight from its source: the LAST plain-number setbpm() in the
 * buffer is the one an evaluation leaves in force. Derived at list time rather than stored, so it
 * can never go stale against the pattern it describes.
 */
export function nativeBpmOf(code) {
  let bpm = null;
  for (const m of String(code).matchAll(/(?<![\w$.])setbpm\s*\(\s*["']?(\d+(?:\.\d+)?)["']?\s*\)/g)) {
    bpm = Number(m[1]);
  }
  return bpm;
}

/** "2026-08-02-143205" -> "Aug 2, 14:32", for a session with no title to show. */
export function wipFallbackLabel(session) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(session);
  if (!m) return session;
  const [, y, mo, d, hh, mm] = m;
  const when = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hh}:${mm}`;
}

/**
 * @param blobs the captured-device-state store (see blobs.mjs). Optional: without it a pattern
 *   is read and written exactly as it stands, which is what the tests that only care about
 *   naming and listing want. With it, code on its way OUT carries its state in full and code on
 *   its way IN is reduced to handles - the same two directions the desktop applies.
 */
/** The packs whose audio lives only in this browser, and so travels in an export. */
const AUDIO_PACKS = Object.freeze(['files', 'wt', 'rec']);

/** Bytes as base64, in chunks: one call over a large file would overflow the argument list. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

export function createStorage(store, { meta = globalThis, now = () => Date.now(), blobs = null, maxSnapshots = MAX_SNAPSHOTS } = {}) {
  const { parseMeta, displayLabel, patternNameProblem, matchesQuery } = meta;
  if (typeof patternNameProblem !== 'function') {
    throw new Error('[storage] the pattern metadata helpers are missing - pattern-meta.js has to load first');
  }

  const read = async (key) => (await store.get(key))?.text ?? null;
  const write = (key, text) => store.put(key, { text: String(text), mtime: now() });

  /** The key a saved pattern lives at. Names are one segment, exactly as they are on disk. */
  function patternKey(name) {
    const problem = patternNameProblem(name);
    if (problem) throw new Error(`pattern name: ${problem}`);
    return `${PATTERNS}${String(name).trim()}.js`;
  }

  /**
   * The key a session lives at.
   *
   * Checked strictly, and cross-checked so the month is the one the date actually belongs to.
   * This is the only place a caller gets to name a folder, and the id comes from a buffer
   * somebody can edit - so a malformed one is refused rather than normalized into something.
   */
  function wipKey(id) {
    const m = WIP_ID_RE.exec(String(id ?? '').trim());
    if (!m || m[1] !== m[2]) throw new Error('bad work-in-progress id (expected "YYYY-MM/YYYY-MM-DD-HHMMSS")');
    return `${WIP}${m[0]}.js`;
  }

  /** One row of the files tab: what a pattern says about itself, plus how the row should read. */
  async function entryFor(key, { kind, name, id, displayName, fallbackLabel, borrowBlockLabel }) {
    const record = await store.get(key);
    const code = record?.text ?? '';
    const parsed = parseMeta(code);
    return {
      kind,
      name,
      id,
      mtime: record?.mtime ?? 0,
      title: parsed.title,
      by: parsed.by,
      tags: parsed.tags,
      bpm: nativeBpmOf(code),
      label: displayLabel({ title: parsed.title, name: displayName, code, fallback: fallbackLabel, borrowBlockLabel }),
      code,
    };
  }

  async function listPatterns() {
    const keys = await store.keys(PATTERNS);
    const out = [];
    for (const key of keys) {
      if (!key.endsWith('.js') || key.startsWith(WIP)) continue;
      const name = key.slice(PATTERNS.length, -3);
      out.push(await entryFor(key, { kind: 'saved', name, id: name, displayName: name }));
    }
    return out;
  }

  async function listWip() {
    const keys = await store.keys(WIP);
    const out = [];
    for (const key of keys) {
      if (!key.endsWith('.js')) continue;
      const id = key.slice(WIP.length, -3);
      const cut = id.indexOf('/');
      const session = id.slice(cut + 1);
      const entry = await entryFor(key, {
        kind: 'wip',
        name: session,
        id,
        displayName: null,
        fallbackLabel: wipFallbackLabel(session),
        borrowBlockLabel: true,
      });
      // The month folder, which the files tab groups sessions under - as the desktop's listing
      // carries it. Without it the tab could not draw the list at all.
      entry.month = id.slice(0, cut);
      out.push(entry);
    }
    return out;
  }

  /**
   * The files tab's whole listing - saved patterns and sessions apart, since the tab draws them
   * apart - newest first, filtered the way the desktop filters it.
   */
  async function listAll(query = '') {
    const keep = (entries) => (query && typeof matchesQuery === 'function' ? entries.filter((e) => matchesQuery(e, query)) : entries)
      .sort((a, b) => b.mtime - a.mtime)
      // `code` rode along so the search could look at contents; it does not belong in a listing.
      .map(({ code, ...rest }) => rest);
    return { patterns: keep(await listPatterns()), wip: keep(await listWip()) };
  }

  /**
   * Snapshots are content-addressed, so the same buffer checkpointed twice is stored once and
   * the second is only a touch - which is what keeps the pruning below meaningful for a buffer
   * somebody keeps coming back to.
   */
  let sinceLastPrune = 0;
  async function putSnapshot(code) {
    const id = await snapshotId(code);
    const key = `${SNAPSHOTS}${id}.js`;
    const held = await store.get(key);
    if (held) {
      await store.put(key, { ...held, mtime: now() });
    } else {
      await write(key, code);
      // The desktop prunes on a timer after each save; here it is counted, since the store is
      // the only clock this needs and a timer is one more thing to stop when the page goes.
      if (++sinceLastPrune >= PRUNE_EVERY) {
        sinceLastPrune = 0;
        await pruneSnapshots(maxSnapshots);
      }
    }
    return id;
  }

  async function getSnapshot(id) {
    if (!ID_RE.test(String(id ?? ''))) return null;
    return read(`${SNAPSHOTS}${id}.js`);
  }

  /** Oldest first out, which is the one property a history has to have. */
  async function pruneSnapshots(keep = maxSnapshots) {
    const keys = await store.keys(SNAPSHOTS);
    if (keys.length <= keep) return 0;
    const dated = [];
    for (const key of keys) dated.push({ key, mtime: (await store.get(key))?.mtime ?? 0 });
    dated.sort((a, b) => b.mtime - a.mtime);
    const doomed = dated.slice(keep);
    for (const { key } of doomed) await store.delete(key);
    return doomed.length;
  }

  async function listSnippets(query = '') {
    const keys = await store.keys(SNIPPETS);
    const out = [];
    for (const key of keys) {
      if (!key.endsWith('.js')) continue;
      const name = key.slice(SNIPPETS.length, -3);
      out.push(await entryFor(key, { kind: 'snippet', name, id: name, displayName: name }));
    }
    const filtered = query && typeof matchesQuery === 'function' ? out.filter((e) => matchesQuery(e, query)) : out;
    return filtered.sort((a, b) => b.mtime - a.mtime).map(({ code, ...rest }) => rest);
  }

  /** Moves one record to another key, refusing to write over something already there. */
  async function rename(fromKey, toKey) {
    const held = await store.get(fromKey);
    if (!held) throw new Error('there is nothing by that name');
    if (await store.get(toKey)) throw new Error('something by that name already exists');
    await store.put(toKey, { ...held, mtime: now() });
    await store.delete(fromKey);
  }

  /**
   * Everything in the store, as one object.
   *
   * This is the export button, and on a public site with no accounts it is the only way somebody
   * takes their work with them. It is deliberately the whole store rather than a selection:
   * a pattern without the captured device state it references is a pattern that opens silent,
   * and deciding which parts matter is not a decision to make on somebody's behalf.
   */
  async function exportAll({ audio = false } = {}) {
    const files = {};
    for (const key of await store.keys('')) {
      const held = await store.get(key);
      if (held?.text != null) files[key] = { text: held.text, mtime: held.mtime ?? 0 };
    }
    const out = { format: 'poptart-store-1', exported: new Date().toISOString(), files };
    if (audio) out.audio = await exportAudio();
    return out;
  }

  /**
   * The audio this browser made or was given - the files added one at a time, a wavetable folder,
   * the recordings - as each pack's list and each file's bytes, base64. Not the library packs a
   * pattern downloaded: those have a home they can be fetched from again.
   */
  async function exportAudio() {
    const packs = {};
    const bytes = {};
    for (const pack of AUDIO_PACKS) {
      const manifest = await store.get(`samples/${pack}/manifest.json`);
      if (!manifest?.files?.length) continue;
      packs[pack] = { files: manifest.files };
      for (const f of manifest.files) {
        const held = await store.get(`samples/${pack}/${f.file}`);
        if (held?.bytes) bytes[`${pack}/${f.file}`] = toBase64(held.bytes);
      }
    }
    return { packs, bytes };
  }

  /** Puts an export's audio back: a pack's list merged with what is here, its files written. */
  async function importAudio(audio, overwrite) {
    let written = 0;
    let skipped = 0;
    for (const [pack, incoming] of Object.entries(audio?.packs ?? {})) {
      if (!AUDIO_PACKS.includes(pack) || !Array.isArray(incoming?.files)) continue;
      const key = `samples/${pack}/manifest.json`;
      const have = (await store.get(key))?.files ?? [];
      const names = new Set(have.map((f) => f.file));
      const merged = [...have];
      for (const f of incoming.files) {
        const file = String(f?.file ?? '');
        if (!file || file.includes('..') || file.startsWith('/')) { skipped += 1; continue; }
        const b64 = audio.bytes?.[`${pack}/${file}`];
        if (typeof b64 !== 'string') { skipped += 1; continue; }
        const exists = names.has(file);
        if (exists && !overwrite) { skipped += 1; continue; }
        const raw = fromBase64(b64);
        await store.put(`samples/${pack}/${file}`, { bytes: raw, mtime: now() });
        if (!exists) { merged.push({ file, bytes: raw.byteLength }); names.add(file); }
        written += 1;
      }
      await store.put(key, { files: merged, mtime: now() });
    }
    return { written, skipped };
  }

  /**
   * Puts an export back. Existing records are kept unless `overwrite` says otherwise, because
   * the common case is merging somebody else's work into a store that already has your own.
   */
  async function importAll(bundle, { overwrite = false } = {}) {
    if (bundle?.format !== 'poptart-store-1') throw new Error('that is not a poptart export');
    let written = 0;
    let skipped = 0;
    const audio = bundle.audio ? await importAudio(bundle.audio, overwrite) : null;
    for (const [key, value] of Object.entries(bundle.files ?? {})) {
      if (typeof value?.text !== 'string') continue;
      // A key out of a file somebody was handed: it names a record, and it is not allowed to
      // name anything outside the layout above.
      if (key.includes('..') || key.startsWith('/')) { skipped += 1; continue; }
      if (!overwrite && await store.get(key)) { skipped += 1; continue; }
      await store.put(key, { text: value.text, mtime: value.mtime ?? now() });
      written += 1;
    }
    return { written, skipped, ...(audio ? { audio } : {}) };
  }

  return {
    // saved patterns
    listPatterns,
    listWip,
    listAll,
    // Every one of these is async even where the work is not, so that a name this store refuses
    // comes back as a rejected promise rather than as a synchronous throw. A caller that awaits
    // handles both; a caller that only attaches a .catch() handles one, and which one it gets
    // would otherwise depend on whether the name happened to be valid.
    readPattern: async (name) => read(patternKey(name)),
    writePattern: async (name, code) => write(patternKey(name), code),
    deletePattern: async (name) => store.delete(patternKey(name)),
    renamePattern: async (from, to) => rename(patternKey(from), patternKey(to)),

    // the autosaved trail
    readWip: async (id) => read(wipKey(id)),
    writeWip: async (id, code) => write(wipKey(id), code),
    deleteWip: async (id) => store.delete(wipKey(id)),

    // the files tab's own ordering
    readLibrary: async () => {
      const text = await read(LIBRARY_KEY);
      try {
        return normalizeLibrary(text ? JSON.parse(text) : null);
      } catch {
        return normalizeLibrary(null); // unreadable - start empty rather than take the tab down
      }
    },
    /** Normalizes, writes, and returns what was kept, which the editor takes as its working copy. */
    writeLibrary: async (doc) => {
      const clean = normalizeLibrary(doc);
      await write(LIBRARY_KEY, JSON.stringify(clean, null, 2));
      return clean;
    },

    // snippets
    listSnippets,
    readSnippet: (name) => read(`${SNIPPETS}${String(name).trim()}.js`),
    writeSnippet: (name, code) => write(`${SNIPPETS}${String(name).trim()}.js`, code),
    deleteSnippet: (name) => store.delete(`${SNIPPETS}${String(name).trim()}.js`),
    renameSnippet: (from, to) => rename(`${SNIPPETS}${from}.js`, `${SNIPPETS}${to}.js`),

    // history
    putSnapshot,
    getSnapshot,
    pruneSnapshots,

    // the star library and the prebake
    readPrebake: () => read(PREBAKE_KEY),
    writePrebake: (code) => write(PREBAKE_KEY, code),
    readPinned: () => read(PINNED_KEY),
    writePinned: (code) => write(PINNED_KEY, code),

    exportAll,
    importAll,

    // Captured device state, in the two directions it travels. Code on its way OUT to a file
    // somebody might open anywhere carries its states in full; code on its way IN is reduced to
    // handles so the buffer never holds the bytes. Without a blob store both are the identity,
    // which is exactly right for a build that has never captured anything.
    hydrateForExport: async (code) => (blobs ? blobs.hydrate(code) : { code: String(code ?? ''), missing: [] }),
    dehydrateOnLoad: async (code) => (blobs ? blobs.dehydrate(code) : { code: String(code ?? ''), stored: 0 }),
    getBlob: async (id) => (blobs ? blobs.getBlob(id) : null),
  };
}
