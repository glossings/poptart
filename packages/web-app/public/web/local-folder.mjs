// A folder on this computer, read as sample packs where it lives.
//
// The desktop's sample library is a folder whose subfolders are packs. A page cannot be handed a
// path, but it can be handed the folder itself: `showDirectoryPicker` gives a handle the page may
// keep - in IndexedDB, across visits - and read files through, with the browser asking once per
// visit (or never again, where somebody chose "allow on every visit"). Nothing is copied: a file
// is read from the folder when a pattern first plays its pack, exactly as the desktop reads it
// off the disk, so a library of gigabytes costs this browser's storage nothing.
//
// A browser without that API still has the ordinary folder chooser, which hands over the files
// for as long as the page is open. The same packs are made from those, and the settings row offers
// to keep a copy: only there, only when asked, and with the size said first - a copy of a sample
// library is the one thing here that costs this browser's storage what the library weighs.
//
// Packs are named the way samples() names a repository's folders (remote-packs.mjs): by folder,
// each taking the shortest tail of its path no other folder shares, so `808/Kicks` and
// `909/Kicks` are `808_kicks` and `909_kicks` and a lone `Snares` is `snares`.

import { AUDIO, isReservedPack, packName, packsFromTree } from './remote-packs.mjs';

/** Where the chosen folder's handle is kept. Not text, so the backup export passes over it. */
export const FOLDER_KEY = 'settings/sample-folder';
/** Where a kept copy's files are, by their path in the folder. */
const COPY_PREFIX = 'samples/folder/';
/** The most files read from one folder: past this the packs hold the first ones found. */
export const MAX_FOLDER_FILES = 20000;

/** Whether a folder or file name is one a scan passes over: hidden, or macOS's zip debris. */
const skipped = (name) => name.startsWith('.') || name === '__MACOSX';

/**
 * Every audio file under a directory handle, as path -> file handle, the paths relative to it.
 * Stops at `limit` files and says so.
 */
export async function walkDirectory(dir, { limit = MAX_FOLDER_FILES } = {}) {
  const files = new Map();
  let truncated = false;
  const walk = async (handle, prefix) => {
    for await (const [name, entry] of handle.entries()) {
      if (truncated) return;
      if (skipped(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') await walk(entry, path);
      else if (AUDIO.test(name)) {
        if (files.size >= limit) { truncated = true; return; }
        files.set(path, entry);
      }
    }
  };
  await walk(dir, '');
  return { files, truncated };
}

/**
 * The files an ordinary folder chooser handed over, as the same map - File objects in place of
 * handles, the chosen folder's own name taken off the front of each path. Returns that name too.
 */
export function filesFromList(list, { limit = MAX_FOLDER_FILES } = {}) {
  const files = new Map();
  let name = '';
  let truncated = false;
  for (const file of list) {
    const relative = String(file.webkitRelativePath || file.name);
    const cut = relative.indexOf('/');
    if (cut > 0 && !name) name = relative.slice(0, cut);
    const path = cut > 0 ? relative.slice(cut + 1) : relative;
    if (!AUDIO.test(path) || path.split('/').some(skipped)) continue;
    if (files.size >= limit) { truncated = true; break; }
    files.set(path, file);
  }
  return { files, name, truncated };
}

/**
 * A folder's files as sample-store manifests. `folder` is the chosen folder's name, which names
 * the files sitting directly in it and goes in front of a subfolder named like one of poptart's
 * own packs.
 */
export function folderManifests(paths, { folder }) {
  const title = folder || 'your folder';
  return packsFromTree(paths, { rootName: folder || 'folder' }).map((p) => {
    const id = isReservedPack(p.name) ? packName(`${folder || 'folder'}_${p.name}`) : p.name;
    return {
      id,
      title: `${id} - ${title}`,
      description: title,
      kind: 'drums',
      local: true,
      files: p.files.map((file) => ({
        file,
        name: file.split('/').pop().replace(/\.[^.]+$/, ''),
        rootNote: null,
        loop: null,
      })),
    };
  });
}

/**
 * The folder, its packs and the permission to read it.
 *
 * `status()` is what the settings row draws: `state` is 'none' before a folder is chosen,
 * 'ready' once its packs are in, 'reading' while it is walked, 'prompt' when a kept folder needs
 * a click before the browser lets the page read it again, 'session' for a folder that came
 * through the ordinary chooser and is gone on the next visit, 'copying' while such a folder is
 * copied in, and 'copied' once it has been.
 */
export function createLocalFolder({ store = null, samples, onPacks = () => {}, warn = () => {}, say = () => {} }) {
  let handle = null;
  let files = new Map();       // path -> FileSystemFileHandle | File
  let active = [];             // manifests
  let state = 'none';
  let name = '';
  let truncated = false;
  let copied = [];             // the paths a kept copy holds, to delete it by
  let progress = { done: 0, total: 0 };

  /** A file's bytes, read from the folder each time a pack is loaded - or from its kept copy. */
  async function read(manifest, file) {
    const entry = files.get(file);
    if (!entry) throw new Error(`${file} is not in ${name || 'the folder'} any more`);
    if (entry.stored) {
      const held = await store.get(entry.stored);
      if (!held?.bytes) throw new Error(`the copy of ${file} is gone from this browser`);
      return held.bytes;
    }
    const blob = typeof entry.getFile === 'function' ? await entry.getFile() : entry;
    return blob.arrayBuffer();
  }

  async function dropCopy(paths = copied) {
    for (const p of paths) await store?.delete?.(`${COPY_PREFIX}${p}`).catch(() => {});
    if (paths === copied) copied = [];
  }

  function install(found, folder) {
    for (const m of active) samples.forget?.(m.id);
    files = found.files;
    truncated = found.truncated;
    name = folder;
    active = folderManifests([...files.keys()], { folder });
    samples.register(active, null, { read });
    onPacks(active);
    const count = active.reduce((n, m) => n + m.files.length, 0);
    say(`sample folder: ${folder} - ${active.length} pack${active.length === 1 ? '' : 's'}, ${count} files${truncated ? ` (the first ${count}: the folder has more)` : ''}`);
  }

  async function scan() {
    state = 'reading';
    try {
      install(await walkDirectory(handle), handle.name);
      state = 'ready';
    } catch (err) {
      state = 'prompt';
      warn(`[samples] ${handle.name} could not be read - ${err.message ?? err}`);
    }
  }

  async function permitted(ask) {
    const opts = { mode: 'read' };
    if ((await handle.queryPermission?.(opts)) === 'granted') return true;
    return ask && (await handle.requestPermission?.(opts)) === 'granted';
  }

  return {
    /** Reads the folder chosen on an earlier visit, if the browser still lets the page read it. */
    async restore() {
      const held = store ? await store.get(FOLDER_KEY).catch(() => null) : null;
      if (Array.isArray(held?.copied)) {
        copied = held.copied;
        install({ files: new Map(copied.map((p) => [p, { stored: `${COPY_PREFIX}${p}` }])), truncated: !!held.truncated }, held.name ?? '');
        state = 'copied';
        return;
      }
      if (!held?.handle) return;
      handle = held.handle;
      name = handle.name;
      if (await permitted(false).catch(() => false)) await scan();
      else state = 'prompt';
    },
    /**
     * Takes a folder: a directory handle, kept for the next visit, or the files an ordinary
     * folder chooser handed over, for this one.
     */
    async choose(source) {
      // A new folder replaces the last one, and a copy kept of that one with it.
      if (copied.length) await dropCopy();
      if (source?.kind === 'directory') {
        handle = source;
        if (store) await store.put(FOLDER_KEY, { handle, name: handle.name }).catch((err) => warn(`[samples] the folder will have to be chosen again next visit - ${err.message ?? err}`));
        await scan();
        return;
      }
      const found = filesFromList(source ?? []);
      handle = null;
      if (store) await store.delete?.(FOLDER_KEY).catch(() => {});
      install(found, found.name);
      state = 'session';
    },
    /**
     * Copies a folder that came through the ordinary chooser into this browser's store, so it is
     * there on the next visit. All of it or none: a store that fills up halfway has the part it
     * took back out again, and the folder is still here for this visit.
     */
    async keepCopy() {
      if (state !== 'session' || !store) return false;
      const paths = [...files.keys()];
      const done = [];
      state = 'copying';
      progress = { done: 0, total: paths.length };
      try {
        for (const p of paths) {
          await store.put(`${COPY_PREFIX}${p}`, { bytes: await files.get(p).arrayBuffer(), mtime: Date.now() });
          done.push(p);
          progress.done = done.length;
        }
        await store.put(FOLDER_KEY, { name, copied: paths, truncated });
      } catch (err) {
        await dropCopy(done);
        state = 'session';
        throw new Error(`no copy was kept - the browser stopped taking files after ${done.length} of ${paths.length} (${err.message ?? err})`);
      }
      copied = paths;
      for (const p of paths) files.set(p, { stored: `${COPY_PREFIX}${p}` });
      state = 'copied';
      return true;
    },
    /** Asks the browser for the kept folder again - from a click, which is the only time it may ask. */
    async reconnect() {
      if (!handle) return false;
      if (!(await permitted(true).catch(() => false))) return false;
      await scan();
      return true;
    },
    /** Reads the folder again, for files added to it since. */
    async rescan() {
      if (handle && (await permitted(false).catch(() => false))) await scan();
    },
    /** Lets the folder go: its packs leave the list and the handle is not kept. */
    async forget() {
      if (copied.length) await dropCopy();
      for (const m of active) samples.forget?.(m.id);
      active = [];
      files = new Map();
      handle = null;
      name = '';
      truncated = false;
      state = 'none';
      if (store) await store.delete?.(FOLDER_KEY).catch(() => {});
    },
    status: () => ({
      state,
      name,
      packs: active.length,
      files: active.reduce((n, m) => n + m.files.length, 0),
      truncated,
      // What a copy would weigh, for the offer to keep one (only the chooser's files know).
      bytes: [...files.values()].reduce((n, f) => n + (Number(f.size) || 0), 0),
      progress: state === 'copying' ? { ...progress } : null,
    }),
    /** The folder's packs, as the host lists packs. */
    packs: () => active.map((manifest) => ({ manifest, urlFor: null })),
    read,
  };
}
