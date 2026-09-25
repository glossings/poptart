// Getting sample packs into the audio thread.
//
// The engine asks for a sample SYNCHRONOUSLY - `playSample` happens inside a scheduler tick,
// with a note already placed on the clock - so nothing can be fetched or decoded at the moment
// it is needed. A pack is therefore loaded ahead of time and held decoded in memory, and a pack
// that has not been loaded answers null, which the engine reports as "source not ready" and
// carries on from. That is the right failure: one quiet line and a missing sound, rather than a
// stall in the thread that is also playing everything else.
//
// Three places a pack can come from, in the order they are tried:
//
//   1. The packs rendered from poptart's own DSP, committed and served beside the app. They make
//      a fresh page playable with no network at all, which is the floor everything else is
//      allowed to fail through to.
//   2. The sourced packs, from the index described in web-engine's library module. Downloaded
//      once and kept, so the second visit costs nothing.
//   3. Whatever somebody drops on the window.
//
// Downloaded audio is kept as the bytes that arrived rather than as decoded audio: decoded audio
// is several times larger, it is tied to the sample rate of the context that decoded it, and
// decoding again on the next visit costs milliseconds.

import { parseOrigin } from './remote-packs.mjs';

/** Where a pack's audio is held once it has been decoded, keyed "<pack>/<index>". */
const keyOf = (pack, index) => `${pack}/${index}`;

/** How long a pack that failed to load is left alone before a note may try it again. */
export const RETRY_FAILED_MS = 60_000;

export function createSampleStore({
  context,
  store = null,
  base = '',
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  warn = () => {},
} = {}) {
  const decoded = new Map();     // "<pack>/<index>" -> { buffer, rootNote }
  const manifests = new Map();   // pack id -> its manifest
  const loading = new Map();     // pack id -> the promise that is loading it, so two asks are one
  const failed = new Map();      // pack id -> { why, at }, so a broken pack is reported once
  const known = new Map();       // pack id -> { manifest, urlFor } for a pack that loads on demand

  // Where a file's bytes are kept. By pack and file for the packs this app ships, whose ids are
  // its own; a pack from somewhere else (samples(), remote-packs.mjs) names a prefix of its own
  // instead, since two repositories can both have a "bd" folder holding a "1.wav".
  const cacheKeyOf = (manifest, file) =>
    manifest?.cachePrefix ? `${manifest.cachePrefix}/${file}` : `samples/${manifest?.id}/${file}`;

  // What each downloaded file weighs, by its cache key: kept beside the files so the settings row
  // can say how much a kind of download is using without reading hundreds of megabytes back out of
  // the store to measure them. Written a moment after the last change, not per file.
  const LEDGER_KEY = 'samples/downloads.json';
  let ledger = null;
  let ledgerRead = null;
  let ledgerTimer = null;
  // Read once, as one promise: two packs caching their first files together would otherwise each
  // make a ledger of their own, and whichever was assigned second would lose the other's entries.
  function ledgerNow() {
    ledgerRead ??= (async () => {
      const held = store ? await store.get(LEDGER_KEY).catch(() => null) : null;
      ledger = new Map(Object.entries(held?.sizes ?? {}));
      return ledger;
    })();
    return ledgerRead;
  }
  function saveLedger() {
    clearTimeout(ledgerTimer);
    ledgerTimer = setTimeout(() => {
      store?.put(LEDGER_KEY, { sizes: Object.fromEntries(ledger) }).catch(() => {});
    }, 500);
    ledgerTimer?.unref?.();
  }

  /** How much the downloads under a cache-key prefix weigh, and how many files that is. */
  async function downloaded(prefix) {
    const held = await ledgerNow();
    // The ledger against what is really kept: files cached before there was a ledger (or whose
    // entry was lost to a write that never landed) are sized and added, once, and entries whose
    // file has gone are dropped. Otherwise the row says "nothing" over files that are there, and
    // its forget button - which deletes what is stored, not what is listed - is never offered.
    if (store?.keys) {
      const keys = await store.keys(prefix).catch(() => null);
      if (keys) {
        const there = new Set(keys);
        let changed = false;
        for (const key of keys) {
          if (held.has(key)) continue;
          const value = await store.get(key).catch(() => null);
          const size = value?.bytes?.byteLength;
          if (!size) continue; // not a file: a repository's list of files, say
          held.set(key, size);
          changed = true;
        }
        for (const key of [...held.keys()]) {
          if (key.startsWith(prefix) && !there.has(key)) { held.delete(key); changed = true; }
        }
        if (changed) saveLedger();
      }
    }
    let bytes = 0;
    let files = 0;
    for (const [key, size] of held) {
      if (!key.startsWith(prefix)) continue;
      bytes += size;
      files += 1;
    }
    return { bytes, files };
  }

  /**
   * Deletes the downloads under a cache-key prefix. Whatever is already in memory keeps playing
   * until the page closes; after that a file is downloaded again the next time it is played.
   */
  async function forgetDownloads(prefix) {
    if (!store) return 0;
    const keys = await store.keys(prefix);
    for (const key of keys) await store.delete(key).catch(() => {});
    const held = await ledgerNow();
    for (const key of [...held.keys()]) if (key.startsWith(prefix)) held.delete(key);
    clearTimeout(ledgerTimer);
    await store.put(LEDGER_KEY, { sizes: Object.fromEntries(held) }).catch(() => {});
    return keys.length;
  }

  /** The bytes of one file, from the cache if it is there and the network if it is not. */
  async function bytesFor(manifest, file, url) {
    const cacheKey = cacheKeyOf(manifest, file);
    if (store) {
      const held = await store.get(cacheKey).catch(() => null);
      if (held?.bytes) return held.bytes;
    }
    if (!fetchImpl) throw new Error('there is no way to fetch from here');
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const bytes = await res.arrayBuffer();
    // Cached as it arrived. A failure to cache is not a failure to load: a private window has no
    // durable store and the pack still has to play.
    if (store) {
      const kept = await store.put(cacheKey, { bytes, mtime: Date.now() }).then(() => true, () => false);
      if (kept) {
        (await ledgerNow()).set(cacheKey, bytes.byteLength);
        saveLedger();
      }
    }
    return bytes;
  }

  /**
   * Loads and decodes one pack.
   *
   * Files are decoded one after another rather than all at once on purpose: a pack is tens of
   * files and decoding them in parallel competes with the audio thread for exactly as long as it
   * takes, which is audible as a stutter in whatever is already playing.
   */
  async function loadPack(manifest, { urlFor, read = null }) {
    let index = 0;
    const misses = [];
    for (const file of manifest.files) {
      try {
        // A pack with a reader of its own - a folder on this computer - is read where it lives,
        // never fetched and never kept (local-folder.mjs).
        const bytes = read ? await read(manifest, file.file) : await bytesFor(manifest, file.file, urlFor(manifest.id, file.file));
        // decodeAudioData detaches the buffer it is given, and the same bytes may be decoded
        // again after a context change, so it gets a copy.
        const audio = await context.decodeAudioData(bytes.slice(0));
        decoded.set(keyOf(manifest.id, index), {
          buffer: audio,
          rootNote: Number.isFinite(file.rootNote) ? file.rootNote : null,
          // A sustain loop, in frames, for a recording cut as a held note: what a note longer
          // than the recording loops through until it is let go.
          loop: file.loop && Number.isFinite(file.loop.start) && file.loop.end > file.loop.start ? { start: file.loop.start, end: file.loop.end } : null,
        });
      } catch (err) {
        misses.push({ index, file: file.file, why: err.message });
      }
      index += 1;
    }
    // Nothing at all came down: that is the pack failing, not a few bad files in it, and it is
    // recorded as that - so it is reported once, is not shown as downloaded, and can be tried
    // again later (see ensure). Recorded as loaded, it said "downloaded" with nothing in it and
    // was never asked for again.
    if (manifest.files.length && misses.length === manifest.files.length) {
      throw new Error(`none of its ${manifest.files.length} files loaded - ${misses[0].why}`);
    }
    for (const m of misses) warn(`[samples] ${manifest.id}:${m.index} (${m.file}) did not load - ${m.why}`);
    manifests.set(manifest.id, manifest);
  }

  /**
   * Whether a pack failed too recently to ask for again. Not forever: a failure is usually the
   * network, and a network comes back, so after RETRY_FAILED_MS the next note that names the
   * pack tries once more. Until then its notes are skipped rather than each starting a download.
   */
  function recentlyFailed(pack) {
    const f = failed.get(pack);
    return !!f && Date.now() - f.at < RETRY_FAILED_MS;
  }

  /**
   * Makes sure a pack is in memory. Safe to call from anywhere and as often as you like: a pack
   * already loading returns the same promise rather than starting a second download of it.
   */
  function ensure(manifest, urlFor, read = null) {
    if (manifests.has(manifest.id)) return Promise.resolve(true);
    if (loading.has(manifest.id)) return loading.get(manifest.id);
    const work = loadPack(manifest, { urlFor, read })
      .then(() => { failed.delete(manifest.id); return true; })
      .catch((err) => {
        failed.set(manifest.id, { why: err.message, at: Date.now() });
        warn(`[samples] ${manifest.id} did not load - ${err.message}`);
        return false;
      })
      .finally(() => loading.delete(manifest.id));
    loading.set(manifest.id, work);
    return work;
  }

  /** Puts one already-decoded buffer in, which is what a dropped file becomes. */
  function put(pack, index, buffer, rootNote = null) {
    decoded.set(keyOf(pack, index), { buffer, rootNote });
  }

  // ---- files somebody adds from the page ------------------------------------------------------
  //
  // Two packs, kept in this browser's store the same way: `files` is whatever was added one at a
  // time - a drop, a load button - and `wt` is a wavetable folder somebody pointed the app at.
  // They are apart because the Wavetable's table control lists `wt` and nothing else: a folder of
  // tables and a folder of drum hits are not the same list, and offering both as tables would be
  // a hundred kicks in a menu of waveforms.
  //
  // Each holds the bytes as they arrived plus a manifest listing them in the order they were
  // added, which is their index. A file is reached as "wt:3" or by its name, "wt:saw.wav" - the
  // engine resolves either.

  // `decode` says whether a pack's files are PLAYED. A sample is, so it is decoded on the way in
  // and the decoded audio is held: the engine asks for it inside a scheduler tick and cannot wait.
  // A wavetable is not - the synth cuts it from its own bytes, at its own rate, frame by frame -
  // so decoding one would be a second copy of every file in memory for nothing. That matters at
  // the size a wavetable folder actually is: a couple of thousand files, some of them megabytes.
  const ADDED_PACKS = Object.freeze({
    files: { title: 'Your files', kind: 'files', decode: true },
    wt: { title: 'Your wavetables', kind: 'wavetables', decode: false },
    // Bounces made in this browser, played by name with sr("name"): the desktop's recordings folder.
    rec: { title: 'Your recordings', kind: 'recordings', decode: true },
  });

  /** The manifests of the added packs, by id. */
  const added = new Map(Object.entries(ADDED_PACKS).map(([id, meta]) => [id, { id, ...meta, files: [] }]));

  const manifestKey = (pack) => `samples/${pack}/manifest.json`;

  /**
   * A name kept as the path it had inside the folder somebody chose - "Basic/saw.wav" rather
   * than "saw.wav".
   *
   * The subfolders ARE the organization of a wavetable library, and a couple of thousand files
   * flattened into one list is not a library, it is a haystack. So the path is the name: it is
   * what makes the names unique, what the browser groups by, and what a pattern writes.
   *
   * What is stripped is anything that would let a name climb out of its pack - a leading slash,
   * a `..` segment, a drive letter - because the name becomes a key in the store.
   */
  function safeRelativePath(name) {
    return String(name)
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
  }

  /** Reads the manifests of the added packs back out of the store, at boot. */
  async function loadFiles() {
    if (store) {
      for (const pack of added.keys()) {
        const held = await store.get(manifestKey(pack)).catch(() => null);
        if (held?.files) {
          added.set(pack, {
            ...added.get(pack),
            files: held.files.map((f) => ({ file: String(f.file), bytes: Number(f.bytes) || 0 })),
          });
        }
      }
      // The PLAYED packs' files are decoded again, in the background and one at a time: listing
      // them is not enough for a pattern naming one to sound, and a reload used to leave every
      // file somebody added silent until it was added again. Not awaited - a page with a few
      // hundred files should not wait on them to open.
      for (const [pack, meta] of Object.entries(ADDED_PACKS)) {
        if (meta.decode && added.get(pack)?.files.length) decodeStored(pack);
      }
    }
    stamp += 1;
    return [...added.values()];
  }

  /** Decodes an added pack's files from the store, skipping any already in memory. */
  async function decodeStored(pack) {
    if (!context || !store) return;
    const files = added.get(pack)?.files ?? [];
    for (let index = 0; index < files.length; index++) {
      if (decoded.has(keyOf(pack, index))) continue;
      try {
        const held = await store.get(`samples/${pack}/${files[index].file}`);
        if (!held?.bytes) continue;
        const audio = await context.decodeAudioData(held.bytes.slice(0));
        if (!decoded.has(keyOf(pack, index))) decoded.set(keyOf(pack, index), { buffer: audio, rootNote: null });
      } catch (err) {
        warn(`[samples] ${pack}:${index} (${files[index].file}) could not be decoded - ${err.message}`);
      }
    }
    manifests.set(pack, added.get(pack));
  }

  /**
   * How much of the store one of the added packs is using, and how many files that is.
   *
   * A file's size is written into the manifest when it is added, so this is normally a sum over
   * a list. A pack filled in before sizes were recorded has none, and those are read back once -
   * a pass over the store - and written into the manifest, so it is paid for once ever rather
   * than every time the settings tab is opened.
   */
  async function packSize(pack) {
    const manifest = added.get(pack);
    if (!manifest) return { count: 0, bytes: 0 };
    const missing = manifest.files.filter((f) => !Number.isFinite(Number(f.bytes)) || Number(f.bytes) <= 0);
    if (missing.length && store) {
      const files = [];
      for (const entry of manifest.files) {
        if (Number(entry.bytes) > 0) { files.push(entry); continue; }
        const held = await store.get(`samples/${pack}/${entry.file}`).catch(() => null);
        files.push({ ...entry, bytes: held?.bytes?.byteLength ?? 0 });
      }
      added.set(pack, { ...manifest, files });
      await store.put(manifestKey(pack), { files, mtime: Date.now() }).catch(() => {});
    }
    const now = added.get(pack);
    return {
      count: now.files.length,
      bytes: now.files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
    };
  }

  /**
   * Adds a file to one of those packs. The bytes are kept as they arrived and decoded on the way
   * in, so a pattern naming the file plays on the next tick; a name already in the list replaces
   * that file in place, so its index - and every pattern naming it - stands.
   */
  async function addFile(name, bytes, pack = 'files', opts = {}) {
    if (!added.has(pack)) throw new Error(`there is no "${pack}" pack to add a file to`);
    const raw = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const file = safeRelativePath(name);
    if (!file) throw new Error('a file needs a name');
    let manifest = added.get(pack);
    let index = manifest.files.findIndex((f) => f.file === file);
    if (index < 0) {
      manifest = { ...manifest, files: [...manifest.files, { file, bytes: raw.byteLength }] };
      added.set(pack, manifest);
      index = manifest.files.length - 1;
    } else {
      const files = [...manifest.files];
      files[index] = { ...files[index], bytes: raw.byteLength };
      manifest = { ...manifest, files };
      added.set(pack, manifest);
    }
    if (store) {
      await store.put(`samples/${pack}/${file}`, { bytes: raw, mtime: Date.now() }).catch(() => {});
      // The manifest is the WHOLE list, so writing it per file makes reading a folder quadratic:
      // two thousand files is two thousand writes of a list that is on average a thousand entries
      // long. A caller adding a batch defers it and calls flushPack once at the end; the bytes
      // above are already safe, and a manifest lost to a crash mid-import is one that describes
      // an import that did not finish anyway.
      if (opts.defer !== true) await store.put(manifestKey(pack), { files: manifest.files, mtime: Date.now() }).catch(() => {});
    }
    decoded.delete(keyOf(pack, index));
    if (context && ADDED_PACKS[pack].decode) {
      try {
        const audio = await context.decodeAudioData(raw.slice(0));
        decoded.set(keyOf(pack, index), { buffer: audio, rootNote: null });
      } catch (err) {
        warn(`[samples] ${file} could not be decoded as audio - ${err.message}`);
      }
    }
    manifests.set(pack, added.get(pack));
    stamp += 1;
    return { ref: `${pack}:${file}`, index, name: file };
  }

  /**
   * Writes an added pack's manifest once, for a caller that deferred it across a batch of adds.
   * Harmless to call when nothing was deferred, and the answer is the pack as it now stands.
   */
  async function flushPack(pack) {
    const manifest = added.get(pack);
    if (!manifest) return null;
    if (store) await store.put(manifestKey(pack), { files: manifest.files, mtime: Date.now() }).catch(() => {});
    manifests.set(pack, manifest);
    return manifest;
  }

  /** Empties one of the added packs - the "forget" beside a folder somebody chose. */
  async function clearPack(pack) {
    const manifest = added.get(pack);
    if (!manifest) return false;
    if (store) {
      for (const entry of manifest.files) await store.delete?.(`samples/${pack}/${entry.file}`).catch(() => {});
      await store.put(manifestKey(pack), { files: [], mtime: Date.now() }).catch(() => {});
    }
    manifest.files.forEach((_, i) => decoded.delete(keyOf(pack, i)));
    added.set(pack, { ...manifest, files: [] });
    manifests.set(pack, added.get(pack));
    stamp += 1;
    return true;
  }

  // ---- packs written as a list: _pack("kit", ["pt_kit/bd.wav", "808_kicks", …]) ----------------
  //
  // A named pack the store has no manifest of is a DEFINITION: a list of entries, each one file
  // of a pack ("pack/file") or a whole pack ("pack"), which is what the pack panel and the sample
  // map write. The language holds the list (`resolvePack`, set by the page); the store turns an
  // index into it into the file it names, the desktop's order - entries in order, a whole pack
  // spread out in its own order - with the index wrapping, as it does there.
  let resolvePack = null;
  let expanded = new Map();     // pack id -> { entries, stamp, files: [{ pack, index }] }
  let stamp = 0;                // bumped whenever what a definition can resolve to may have changed

  function viaDefinition(pack, index) {
    if (!resolvePack || manifestOf(pack)) return null;
    const entries = resolvePack(pack);
    if (!Array.isArray(entries) || !entries.length) return null;
    let held = expanded.get(pack);
    if (!held || held.entries !== entries || held.stamp !== stamp) {
      const files = [];
      for (const entry of entries) {
        // "/packs/pack/file" is the pack panel's spelling of the same entry (host.mjs, browseDir).
        const text = String(entry).replace(/^\/packs\//, '');
        // A file named by where it lives (remote-packs.mjs, originOf) plays whatever this page's
        // samples() lines have made the pack names mean - or whether there are any.
        const origin = originFile(text);
        if (origin) {
          files.push(origin);
          continue;
        }
        const cut = text.indexOf('/');
        const from = cut < 0 ? text : text.slice(0, cut);
        const manifest = from === pack ? null : manifestOf(from);
        if (!manifest) continue;
        if (cut < 0) manifest.files.forEach((_, i) => files.push({ pack: from, index: i }));
        else {
          const i = indexOf(from, text.slice(cut + 1));
          if (i != null) files.push({ pack: from, index: i });
        }
      }
      held = { entries, stamp, files };
      expanded.set(pack, held);
    }
    if (!held.files.length) return null;
    const n = held.files.length;
    return held.files[((Math.trunc(Number(index) || 0) % n) + n) % n];
  }

  /**
   * The file an origin names ("github:owner/repo@<commit>/path.wav"), as { pack, index }: a one-file
   * pack under the origin's own name, made the first time it is asked for, cached under the key
   * samples() keeps the same file under - so a kit and the samples() line share one download, and
   * "forget" in settings lets both go. Null for anything that is not an origin.
   */
  function originFile(text) {
    const at = parseOrigin(text);
    if (!at) return null;
    if (!manifestOf(text)) {
      const manifest = {
        id: text,
        title: at.file.split('/').pop(),
        description: text,
        kind: 'drums',
        cachePrefix: `remote/${at.base}`,
        base: at.base,
        files: [{ file: at.file, name: at.file.split('/').pop().replace(/\.[^.]+$/, ''), rootNote: null, loop: null }],
      };
      register([manifest], (_id, file) => (at.base ? `${at.base}${file.split('/').map(encodeURIComponent).join('/')}` : file));
    }
    return { pack: text, index: 0 };
  }

  /** The manifest a file of a pack sits in, from the added packs, what has loaded or what is known. */
  function manifestOf(pack) {
    return added.get(pack) ?? manifests.get(pack) ?? known.get(pack)?.manifest ?? null;
  }

  /** The index a key names in a pack: a number, or a file's name with or without its extension. */
  function indexOf(pack, key) {
    const manifest = manifestOf(pack);
    const text = String(key ?? '').trim();
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      return !manifest || n < manifest.files.length ? n : null;
    }
    if (!manifest) return null;
    const lower = text.toLowerCase();
    const bare = (f) => String(f).toLowerCase().replace(/\.[a-z0-9]+$/i, '');
    const i = manifest.files.findIndex((f) => String(f.file).toLowerCase() === lower || bare(f.file) === bare(lower));
    return i >= 0 ? i : null;
  }

  /** The bytes of one file as they arrived, for a device that reads a file whole - or null. */
  async function bytes(pack, index) {
    const manifest = manifestOf(pack);
    const entry = manifest?.files[index];
    if (!entry) return null;
    const lazy = known.get(pack);
    if (lazy?.read) {
      try { return await lazy.read(manifest, entry.file); } catch { return null; }
    }
    if (store) {
      const held = await store.get(cacheKeyOf(manifest, entry.file)).catch(() => null);
      if (held?.bytes) return held.bytes;
    }
    if (lazy?.urlFor && fetchImpl) {
      try { return await bytesFor(manifest, entry.file, lazy.urlFor(pack, entry.file)); } catch { return null; }
    }
    return null;
  }

  /**
   * Makes packs loadable without loading them. The sourced library is tens of packs and hundreds
   * of megabytes, and a page that downloaded all of it on the chance a pattern names one would
   * never finish starting; instead the first ask for any of a pack's files starts that pack
   * loading, and the notes until it lands are the "source not ready" the engine already reports.
   */
  function register(list, urlFor, { read = null } = {}) {
    for (const manifest of list) known.set(manifest.id, { manifest, urlFor, read });
    stamp += 1;
  }

  /**
   * Drops a registered pack and whatever of it is in memory, so a different pack can take its
   * name - a samples() source whose folder has the name another one already had. The bytes stay
   * cached under their own source (cacheKeyOf), so going back to the first costs no download.
   */
  function forget(pack) {
    const manifest = manifests.get(pack) ?? known.get(pack)?.manifest;
    for (let i = 0; i < (manifest?.files.length ?? 0); i++) decoded.delete(keyOf(pack, i));
    manifests.delete(pack);
    known.delete(pack);
    failed.delete(pack);
    stamp += 1;
  }

  return {
    downloaded,
    forgetDownloads,
    addFile,
    flushPack,
    clearPack,
    loadFiles,
    packSize,
    /** The manifests of the packs somebody added to, for the sounds tab and the table lists. */
    addedPacks: () => [...added.values()],
    addedPack: (pack) => added.get(pack) ?? null,
    indexOf,
    bytes,
    /**
     * What the engine calls, in the audio thread's own time. Synchronous, and null for anything
     * not loaded - see the note at the top of this file for why that is the right answer.
     *
     * A pack whose files are not decoded answers null here always, and that is not a failure:
     * a wavetable is never played as a sample, it is read from its bytes and cut into frames.
     *
     * A registered pack that is not in memory is started here and answered null this once. A
     * pack that failed is not asked for again until RETRY_FAILED_MS has passed: with no network,
     * every note of a pattern would otherwise be one more download attempt.
     */
    /**
     * A file in one of the added packs by its name, with or without the .wav - how sr("bass")
     * finds a bounce. Null for a name that is not there, or not decoded yet.
     */
    named(pack, name) {
      const manifest = added.get(pack);
      if (!manifest) return null;
      const want = String(name);
      const index = manifest.files.findIndex((f) => f.file === want || f.file === `${want}.wav`);
      return index < 0 ? null : decoded.get(keyOf(pack, index)) ?? null;
    },
    /**
     * The name a file goes by in a hand-drawn slice set: "pack/file" - the desktop keys a file by
     * its path under the samples folder, which for a pack is the same two parts.
     */
    fileKey(pack, index) {
      const via = viaDefinition(pack, index);
      if (via) return this.fileKey(via.pack, via.index);
      const manifest = manifests.get(pack) ?? added.get(pack);
      const file = manifest?.files?.[index]?.file;
      return file ? `${pack}/${file}` : null;
    },
    /** The names in an added pack, newest last, without their extension - sr("'s completion. */
    names(pack) {
      return (added.get(pack)?.files ?? []).map((f) => f.file.replace(/\.wav$/i, ''));
    },
    get(pack, index) {
      const held = decoded.get(keyOf(pack, index));
      if (held) return held;
      const via = viaDefinition(pack, index);
      if (via) return this.get(via.pack, via.index);
      const lazy = known.get(pack);
      if (lazy && !manifests.has(pack) && !recentlyFailed(pack)) ensure(lazy.manifest, lazy.urlFor, lazy.read);
      return null;
    },
    ensure,
    /**
     * Loads a pack and answers when its files are in memory - what something that CAN wait asks,
     * such as drawing a sample in the file picker. The engine never uses this: it asks inside a
     * scheduler tick and takes null for an answer.
     */
    async ready(pack) {
      if (manifests.has(pack)) return true;
      const lazy = known.get(pack);
      if (!lazy) return added.has(pack);
      return ensure(lazy.manifest, lazy.urlFor, lazy.read);
    },
    register,
    forget,
    /** How a named pack that is a written list is read: id -> its entries, or null. */
    setPackResolver(fn) {
      resolvePack = typeof fn === 'function' ? fn : null;
      stamp += 1;
    },
    /** The file a definition's index lands on, as { pack, index }, or null. */
    resolveEntry: (pack, index) => viaDefinition(pack, index),
    originFile,
    put,
    loaded: () => [...manifests.keys()],
    problems: () => Object.fromEntries([...failed].map(([id, f]) => [id, f.why])),
    /** Whether a pack is in memory, for the browser's "downloaded" mark. */
    has: (id) => manifests.has(id),
    /** How many of a pack's files actually decoded, which is not always all of them. */
    countOf: (id) => {
      const manifest = manifests.get(id);
      if (!manifest) return 0;
      let n = 0;
      for (let i = 0; i < manifest.files.length; i++) if (decoded.has(keyOf(id, i))) n += 1;
      return n;
    },
    base,
  };
}

/**
 * The definition line a pack becomes in the language, so `sp("pt_kit:2")` resolves.
 *
 * The order of a manifest's files IS the sample index, which is why a manifest refuses to list
 * the same file twice: inserting one would renumber everything after it and change what every
 * saved song using that pack plays.
 */
export function registerPacks(patternCore, manifests) {
  // Remembered, because the layer below is also the one the prebake clears wholesale every time
  // it runs (see restorePacks) - and it runs at every boot, pin and unpin.
  let known = registered.get(patternCore);
  if (!known) registered.set(patternCore, known = new Map());
  for (const manifest of manifests) known.set(manifest.id, manifest);
  filePacks(patternCore, manifests);
}

/** Every pack registerPacks has been handed, per pattern-core instance, by id. */
const registered = new WeakMap();

function filePacks(patternCore, manifests) {
  // In the library layer, the one the desktop's prebake fills: every evaluation clears the
  // buffer layer before it refills it from the buffer, and a pack filed there would be gone by
  // the first note of the first pattern to name it.
  patternCore.setRollLayer('prebake');
  try {
    for (const manifest of manifests) {
      patternCore._pack(manifest.id, manifest.files.map((f) => `${manifest.id}/${f.file}`));
    }
  } finally {
    patternCore.setRollLayer('buffer');
  }
}

/**
 * Files every registered pack again, after the prebake has cleared its layer.
 *
 * On the desktop a pack is a folder the engine finds by name, so clearing the prebake's
 * definitions leaves the shipped sounds alone. Here the shipped, library and added packs are
 * definitions in that same layer, and without this every prebake run - which is every boot -
 * emptied the pack list the editor completes and browses from. Run before the prebake's own
 * code, so a pack somebody defines under the same name still wins, as it would on the desktop.
 */
export function restorePacks(patternCore) {
  const known = registered.get(patternCore);
  if (known?.size) filePacks(patternCore, [...known.values()]);
}
