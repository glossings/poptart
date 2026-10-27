// The music folder: where the DJ decks' songs come from, read where they live.
//
// The desktop's decks load from the disk and browse it from ~/Music. A page cannot be handed a
// path, but it can be handed a folder: `showDirectoryPicker` gives a handle the page may keep in
// IndexedDB and read files through, with the browser asking once per visit (or never again, where
// somebody chose "allow on every visit"). Nothing is copied - a song is read from the folder when
// it is loaded onto a deck, exactly as the desktop reads it off the disk, so a music library costs
// this browser's storage nothing. Chrome and Edge have the picker; elsewhere the ordinary folder
// chooser hands over the files for as long as the page is open, and the folder is chosen again on
// the next visit. A music library is too big to offer to copy, so unlike the sample folder there
// is no "keep a copy".
//
// A song's path here is `/music/<its path inside the folder>`, which is what a playlist item and
// a deck load carry, so the organize window's disk view walks it like a directory tree.

/** The formats the desktop's decks play (osc-engine's songs.js), plus the two every browser decodes. */
export const SONG_AUDIO = /\.(wav|aif|aiff|flac|mp3|m4a|aac|caf|ogg|opus)$/i;
/** Where the chosen folder's handle is kept. */
export const MUSIC_FOLDER_KEY = 'settings/music-folder';
/** The root songs are named under. */
export const MUSIC_ROOT = '/music';
// The desktop's walk of a song folder stops at this many files and this deep (see samples.js's
// walkAudioFiles), and so does this one, so a tree reads the same in both.
const WALK_LIMIT = 20000;
const WALK_DEPTH = 12;

const skipped = (name) => name.startsWith('.') || name === '__MACOSX';
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Every playable file under a directory handle, as path -> handle, the paths relative to it. */
export async function walkSongs(dir, { limit = WALK_LIMIT, maxDepth = WALK_DEPTH } = {}) {
  const files = new Map();
  let truncated = false;
  const walk = async (handle, prefix, depth) => {
    if (truncated) return;
    if (depth > maxDepth) { truncated = true; return; }
    for await (const [name, entry] of handle.entries()) {
      if (truncated) return;
      if (skipped(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') await walk(entry, path, depth + 1);
      else if (SONG_AUDIO.test(name)) {
        if (files.size >= limit) { truncated = true; return; }
        files.set(path, entry);
      }
    }
  };
  await walk(dir, '', 0);
  return { files, truncated };
}

/** The files an ordinary folder chooser handed over, as the same map, its own folder's name off the front. */
export function songsFromList(list, { limit = WALK_LIMIT } = {}) {
  const files = new Map();
  let name = '';
  let truncated = false;
  for (const file of list) {
    const relative = String(file.webkitRelativePath || file.name);
    const cut = relative.indexOf('/');
    if (cut > 0 && !name) name = relative.slice(0, cut);
    const path = cut > 0 ? relative.slice(cut + 1) : relative;
    if (!SONG_AUDIO.test(path) || path.split('/').some(skipped)) continue;
    if (files.size >= limit) { truncated = true; break; }
    files.set(path, file);
  }
  return { files, name, truncated };
}

/** `/music/a/b.mp3` -> `a/b.mp3`, or null for a path that is not under the folder. */
export function relativeOf(path) {
  const text = String(path ?? '');
  if (text === MUSIC_ROOT) return '';
  return text.startsWith(`${MUSIC_ROOT}/`) ? text.slice(MUSIC_ROOT.length + 1) : null;
}

/**
 * The folder and the permission to read it. `status()` is what the settings row draws: 'none'
 * before a folder is chosen, 'reading' while it is walked, 'ready' once it is, 'prompt' when a
 * kept folder needs a click before the browser lets the page read it again, and 'session' for a
 * folder that came through the ordinary chooser and is gone on the next visit.
 */
export function createMusicFolder({ store = null, warn = () => {}, say = () => {} } = {}) {
  let handle = null;
  let files = new Map();
  let state = 'none';
  let name = '';
  let truncated = false;

  function install(found, folder) {
    files = found.files;
    truncated = found.truncated;
    name = folder;
    say(`music folder: ${folder} - ${files.size} song${files.size === 1 ? '' : 's'}${truncated ? ` (the first ${files.size}: the folder has more)` : ''}`);
  }

  async function scan() {
    state = 'reading';
    try {
      install(await walkSongs(handle), handle.name);
      state = 'ready';
    } catch (err) {
      state = 'prompt';
      warn(`[songs] ${handle.name} could not be read - ${err.message ?? err}`);
    }
  }

  async function permitted(ask) {
    const opts = { mode: 'read' };
    if ((await handle.queryPermission?.(opts)) === 'granted') return true;
    return ask && (await handle.requestPermission?.(opts)) === 'granted';
  }

  const need = () => {
    if (state === 'prompt') throw new Error(`the music folder "${name}" needs a click before this page reads it again - settings, "allow again"`);
    if (!files.size && state !== 'ready' && state !== 'session') throw new Error('no music folder is chosen - choose one in the settings tab, under music folder');
  };

  return {
    async restore() {
      const held = store ? await store.get(MUSIC_FOLDER_KEY).catch(() => null) : null;
      if (!held?.handle) return;
      handle = held.handle;
      name = handle.name;
      if (await permitted(false).catch(() => false)) await scan();
      else state = 'prompt';
    },
    /** Takes a folder: a directory handle, kept for the next visit, or a chooser's files for this one. */
    async choose(source) {
      if (source?.kind === 'directory') {
        handle = source;
        if (store) await store.put(MUSIC_FOLDER_KEY, { handle, name: handle.name }).catch((err) => warn(`[songs] the folder will have to be chosen again next visit - ${err.message ?? err}`));
        await scan();
        return;
      }
      const found = songsFromList(source ?? []);
      handle = null;
      if (store) await store.delete?.(MUSIC_FOLDER_KEY).catch(() => {});
      install(found, found.name);
      state = 'session';
    },
    /** Asks the browser for the kept folder again - from a click, the only time it may ask. */
    async reconnect() {
      if (!handle) return false;
      if (!(await permitted(true).catch(() => false))) return false;
      await scan();
      return true;
    },
    async rescan() {
      if (handle && (await permitted(false).catch(() => false))) await scan();
    },
    async forget() {
      files = new Map();
      handle = null;
      name = '';
      truncated = false;
      state = 'none';
      if (store) await store.delete?.(MUSIC_FOLDER_KEY).catch(() => {});
    },
    status: () => ({ state, name, songs: files.size, truncated }),

    /** One directory of the folder, the desktop's browseSongDir shape: subfolders first, then songs. */
    browse(dir) {
      need();
      const rel = relativeOf(dir || MUSIC_ROOT) ?? '';
      const prefix = rel ? `${rel}/` : '';
      const dirs = new Set();
      const here = [];
      for (const path of files.keys()) {
        if (prefix && !path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const cut = rest.indexOf('/');
        if (cut >= 0) dirs.add(rest.slice(0, cut));
        else here.push(rest);
      }
      if (rel && !dirs.size && !here.length) throw new Error(`can't read directory: ${dir}`);
      const at = (n) => (rel ? `${MUSIC_ROOT}/${rel}/${n}` : `${MUSIC_ROOT}/${n}`);
      const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      return {
        dir: rel ? `${MUSIC_ROOT}/${rel}` : MUSIC_ROOT,
        parent: rel ? (parentRel ? `${MUSIC_ROOT}/${parentRel}` : MUSIC_ROOT) : null,
        entries: [
          ...[...dirs].sort(byName).map((n) => ({ name: n, path: at(n), dir: true })),
          ...here.sort(byName).map((n) => ({ name: n, path: at(n), dir: false })),
        ],
      };
    },

    /** Every song under a folder of it, relative to that folder - the organize window's tree search. */
    walk(dir) {
      need();
      const rel = relativeOf(dir || MUSIC_ROOT) ?? '';
      const prefix = rel ? `${rel}/` : '';
      const out = [];
      for (const path of files.keys()) if (!prefix || path.startsWith(prefix)) out.push(path.slice(prefix.length));
      return { path: rel ? `${MUSIC_ROOT}/${rel}` : MUSIC_ROOT, files: out.sort(byName), truncated };
    },

    has: (path) => files.has(relativeOf(path) ?? ''),

    /**
     * Where in the folder a file somebody dropped lives, by its name and size - a page is never
     * told a dropped file's path. Null when no song in the folder matches.
     */
    async find(name, size) {
      need();
      for (const [rel, entry] of files) {
        if (rel.slice(rel.lastIndexOf('/') + 1) !== name) continue;
        const file = typeof entry.getFile === 'function' ? await entry.getFile().catch(() => null) : entry;
        if (file && (size == null || file.size === size)) return `${MUSIC_ROOT}/${rel}`;
      }
      return null;
    },

    /** The file behind a song's path, read from the folder now. */
    async file(path) {
      need();
      const rel = relativeOf(path);
      const entry = rel != null ? files.get(rel) : null;
      if (!entry) throw new Error(`${path} is not in the music folder${name ? ` "${name}"` : ''}`);
      return typeof entry.getFile === 'function' ? entry.getFile() : entry;
    },
  };
}
