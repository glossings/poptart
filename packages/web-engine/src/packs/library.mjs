// The sample library index: what packs exist, where their audio is, and what each file is.
//
// Two kinds of pack ship with the web build and they are delivered differently on purpose.
//
// The RENDERED packs (pt_kit, pt_keys) are generated from poptart's own DSP, are small, and are
// committed into this package. They are what makes a fresh page playable with no network at all,
// and they are the floor the rest of the system is allowed to fail through to.
//
// The SOURCED packs are recordings somebody else made and released. They are far too large to
// live in this repository - a clone should not carry a hundred megabytes of audio that most
// contributors never touch - and they are not ours to re-license, so they live in a separate
// repository of their own with their licenses beside them, and this index is how the app finds
// them. The app fetches the index, shows what is available, and downloads a pack's audio the
// first time something asks for it.
//
// THE INDEX IS DATA, NOT CODE. It is fetched from somewhere else at run time, which means it is
// exactly the kind of input that must not be trusted: every field is checked here before
// anything is built from it, paths are refused unless they are plain relative names, and a pack
// that fails validation is dropped with a reason rather than taken on faith. See validateIndex.

import { PACK_PREFIX, validateManifest } from './manifest.mjs';

/** The index format's name. A future format changes this rather than adding optional fields. */
export const INDEX_FORMAT = 'poptart-packs-1';

/**
 * Where the sourced packs are served from.
 *
 * A CDN in front of a public repository rather than a host of our own: it costs nothing, it
 * cannot run up a bill on a busy day, and it sends the cross-origin headers that decodeAudioData
 * needs without anything being configured. The reference is PINNED to a tag rather than to a
 * branch, because a tagged URL is cached permanently and a branch URL is not - and because a
 * pack that changes underneath a saved song is a song that stops sounding the way it was written.
 *
 * It is one string so that moving the packs - to another CDN, to a folder on the same site, to a
 * local copy while working offline - is one edit and needs no change anywhere else.
 */
export const DEFAULT_PACK_BASE = 'https://cdn.jsdelivr.net/gh/glossings/poptart-packs@v1';

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * A path a pack may serve.
 *
 * Refused: anything absolute, anything with a parent segment, anything with a backslash, and
 * anything with a scheme. The index comes off the network, and "the pack said so" is not a
 * reason to fetch an arbitrary URL or to walk out of the pack's own folder.
 */
export function isSafeRelativePath(path) {
  const text = String(path ?? '');
  if (!text || text.length > 512) return false;
  if (text.startsWith('/') || text.startsWith('\\')) return false;
  if (text.includes('\\') || text.includes('//')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false;
  return !text.split('/').some((part) => part === '' || part === '.' || part === '..');
}

/**
 * Validates a fetched index and returns the packs that survived, with the reasons any were
 * dropped.
 *
 * It does NOT throw. A malformed entry in a list of thirty is a reason to lose that pack, not a
 * reason for the sample browser to be empty - and the reasons come back so the console can say
 * what happened instead of leaving somebody to wonder where a pack went.
 */
export function validateIndex(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return { packs: [], problems: ['the index is not an object'] };
  if (raw.format !== INDEX_FORMAT) {
    return { packs: [], problems: [`the index says it is "${raw.format}", and this build reads "${INDEX_FORMAT}"`] };
  }
  const list = Array.isArray(raw.packs) ? raw.packs : [];
  if (list.length === 0) problems.push('the index lists no packs');

  const packs = [];
  const seen = new Set();
  for (const entry of list) {
    const id = String(entry?.id ?? '').trim();
    try {
      // The per-pack shape is the same one the build validates, so a pack cannot be served with
      // a license the build would have refused. Read the manifest module for what that means.
      const manifest = validateManifest(entry);
      if (seen.has(manifest.id)) throw new Error(`"${manifest.id}" is listed twice`);
      for (const f of manifest.files) {
        if (!isSafeRelativePath(f.file)) throw new Error(`"${manifest.id}" has an unusable path: ${f.file}`);
      }
      seen.add(manifest.id);
      packs.push(Object.freeze({
        ...manifest,
        files: Object.freeze(manifest.files.map((f, index) => Object.freeze({ ...f, index }))),
        bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
      }));
    } catch (err) {
      problems.push(`${id ? `"${id}"` : 'a pack'} was dropped: ${err.message}`);
    }
  }
  return { packs, problems };
}

/** Where one file of one pack lives. */
export function fileUrl(base, packId, file) {
  if (!isSafeRelativePath(file)) throw new Error(`[packs] "${file}" is not a path a pack may serve`);
  if (!String(packId).startsWith(PACK_PREFIX)) throw new Error(`[packs] "${packId}" is not a shipped pack`);
  const root = String(base ?? '').replace(/\/+$/, '');
  return `${root}/${packId}/${file}`;
}

/**
 * The index the build writes, given the validated manifests and the bytes each pack weighs.
 *
 * `bytes` is here so the app can say what a download will cost before it starts one. A pack of
 * orchestral samples is tens of megabytes, and starting that on somebody's phone data without
 * saying so first is not a thing to do quietly.
 */
export function buildIndex(manifests, { generated = null, sizes = {} } = {}) {
  return {
    format: INDEX_FORMAT,
    generated: generated ?? new Date().toISOString().slice(0, 10),
    packs: manifests.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      kind: m.kind,
      bytes: sizes[m.id] ?? null,
      files: m.files.map((f) => ({
        file: f.file,
        name: f.name,
        license: f.license,
        source: f.source,
        by: f.by,
        ...(Number.isFinite(f.rootNote) ? { rootNote: f.rootNote } : {}),
        ...(f.loop ? { loop: { start: f.loop.start, end: f.loop.end } } : {}),
      })),
    })),
  };
}

/**
 * A short line naming everyone a pack has to credit, for the About screen.
 *
 * Public domain files are named too. Nothing requires it, but a pack whose credits read "nobody,
 * for nothing" is worse than useless to somebody trying to work out where a sound came from.
 */
export function creditLine(pack) {
  const people = [...new Set(pack.files.map((f) => f.by).filter(isText))];
  const licenses = [...new Set(pack.files.map((f) => f.license))].sort();
  const who = people.length ? people.join(', ') : 'no attribution required';
  return `${pack.title} - ${licenses.join(', ')} - ${who}`;
}
