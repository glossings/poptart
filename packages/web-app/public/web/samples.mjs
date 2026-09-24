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

/** Where a pack's audio is held once it has been decoded, keyed "<pack>/<index>". */
const keyOf = (pack, index) => `${pack}/${index}`;

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
  const failed = new Map();      // pack id -> why, so a broken pack is reported once
  const known = new Map();       // pack id -> { manifest, urlFor } for a pack that loads on demand

  /** The bytes of one file, from the cache if it is there and the network if it is not. */
  async function bytesFor(packId, file, url) {
    const cacheKey = `samples/${packId}/${file}`;
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
    if (store) await store.put(cacheKey, { bytes, mtime: Date.now() }).catch(() => {});
    return bytes;
  }

  /**
   * Loads and decodes one pack.
   *
   * Files are decoded one after another rather than all at once on purpose: a pack is tens of
   * files and decoding them in parallel competes with the audio thread for exactly as long as it
   * takes, which is audible as a stutter in whatever is already playing.
   */
  async function loadPack(manifest, { urlFor }) {
    let index = 0;
    for (const file of manifest.files) {
      try {
        const bytes = await bytesFor(manifest.id, file.file, urlFor(manifest.id, file.file));
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
        warn(`[samples] ${manifest.id}:${index} (${file.file}) did not load - ${err.message}`);
      }
      index += 1;
    }
    manifests.set(manifest.id, manifest);
  }

  /**
   * Makes sure a pack is in memory. Safe to call from anywhere and as often as you like: a pack
   * already loading returns the same promise rather than starting a second download of it.
   */
  function ensure(manifest, urlFor) {
    if (manifests.has(manifest.id)) return Promise.resolve(true);
    if (loading.has(manifest.id)) return loading.get(manifest.id);
    const work = loadPack(manifest, { urlFor })
      .then(() => true)
      .catch((err) => {
        failed.set(manifest.id, err.message);
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
    return true;
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
    if (store) {
      const held = await store.get(`samples/${pack}/${entry.file}`).catch(() => null);
      if (held?.bytes) return held.bytes;
    }
    const lazy = known.get(pack);
    if (lazy?.urlFor && fetchImpl) {
      try { return await bytesFor(pack, entry.file, lazy.urlFor(pack, entry.file)); } catch { return null; }
    }
    return null;
  }

  /**
   * Makes packs loadable without loading them. The sourced library is tens of packs and hundreds
   * of megabytes, and a page that downloaded all of it on the chance a pattern names one would
   * never finish starting; instead the first ask for any of a pack's files starts that pack
   * loading, and the notes until it lands are the "source not ready" the engine already reports.
   */
  function register(list, urlFor) {
    for (const manifest of list) known.set(manifest.id, { manifest, urlFor });
  }

  return {
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
     * pack that already failed is not asked for again: with no network, every note of a pattern
     * would otherwise be one more download attempt.
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
      const lazy = known.get(pack);
      if (lazy && !manifests.has(pack) && !failed.has(pack)) ensure(lazy.manifest, lazy.urlFor);
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
      return ensure(lazy.manifest, lazy.urlFor);
    },
    register,
    put,
    loaded: () => [...manifests.keys()],
    problems: () => Object.fromEntries(failed),
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
