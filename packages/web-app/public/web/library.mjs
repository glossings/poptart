// The music library in the page: the collection of tracks, the sets that play them, importing,
// measuring and editing - the desktop's /api/library routes, over the browser's store and its
// music folder.
//
// The document and every change to it are library-tracks.js, the desktop's own rules (see
// library-doc.mjs), so an import, an edit or a measurement means the same thing here as there.
// What is the browser's own:
//
//   - A track's path is its path in the music folder (`/music/...` - see music-folder.mjs), and
//     the files are read from that folder where they are. The records live in this browser's
//     store, beside the folder's handle.
//   - A file's tags are read in the page (osc-engine's song-tags-core.mjs, the desktop's reader),
//     a few header-sized slices of the file each.
//   - The measuring pass decodes each file with the browser's decoder and measures it on the
//     decks' analysis worker with the desktop's maths - and, like the desktop's, stands aside
//     while a deck is loading or playing a song, and says so.

/** The most files one import takes - the desktop's own bound (server.js, IMPORT_MAX). */
const IMPORT_MAX = 5000;
/** How long the pass waits before looking again, while a deck has the worker. The desktop's. */
const WAIT_MS = 3000;
/** Where anchors placed by hand were kept before they joined the track records. */
const OLD_ANCHORS_KEY = 'songs/anchors';

/**
 * @param deps.storage      the page's storage (storage.mjs) - readLibrary/writeLibrary/updateLibrary
 * @param deps.libraryTracks library-tracks.js
 * @param deps.folder       the music folder (music-folder.mjs), or null where there is none
 * @param deps.songs        the song source (song-load.mjs): tags(path), measure(path, opts)
 * @param deps.desk         what the pass asks of the desk: why it should wait, what is on a deck
 * @param deps.store        the page's key-value store, for the anchors kept before the records
 */
export function createLibrary({ storage, libraryTracks: lib, folder = null, songs = null, desk = null, store = null, log = () => {} }) {
  const pass = {
    queue: [],     // paths still to measure, in order
    done: 0,
    total: 0,
    now: null,     // the path being measured
    running: false,
    stopped: false,
    waiting: null, // why it is holding back, when it is
  };

  /** What the browser shows while a pass is on, or null when nothing is being measured. */
  function state() {
    // Nothing queued and nothing on the worker is no pass, even while a stopped one is still
    // sitting out its wait.
    if (!pass.now && !pass.queue.length) return null;
    return { done: pass.done, total: pass.total, now: pass.now, waiting: pass.waiting };
  }

  const exists = (p) => !!folder?.has?.(p);

  /** The paths still worth measuring, among these records: the desktop's rule, on files that are here. */
  const wanted = (tracks, opts) => lib.tracksToMeasure(tracks, opts).filter((t) => exists(t.path)).map((t) => t.path);

  function queue(paths) {
    const waiting = new Set(pass.queue);
    if (pass.now) waiting.add(pass.now);
    let added = 0;
    for (const p of paths) {
      if (typeof p !== 'string' || !p || waiting.has(p)) continue;
      pass.queue.push(p);
      waiting.add(p);
      added++;
    }
    if (!added) return 0;
    pass.total += added;
    pass.stopped = false;
    if (!pass.running) run();
    return added;
  }

  function stop() {
    const dropped = pass.queue.length;
    pass.queue = [];
    pass.stopped = true;
    pass.total = pass.done;
    return dropped;
  }

  async function run() {
    if (pass.running) return;
    pass.running = true;
    try {
      while (pass.queue.length && !pass.stopped) {
        const why = desk?.analysisWait?.() ?? null;
        if (why) {
          // The decks' own analysis comes first; the queue is kept, so the pass picks up where it
          // left off - and it says what it is waiting for, so a hold never reads as a stall.
          pass.waiting = why;
          await new Promise((r) => { setTimeout(r, WAIT_MS); });
          continue;
        }
        pass.waiting = null;
        const p = pass.queue.shift();
        pass.now = p;
        let facts = null;
        try {
          facts = await songs.measure(p);
        } catch {
          // A file that cannot be decoded is not a failure of the pass - marked, and passed over.
        }
        await setFacts(p, facts ? { bpm: facts.bpm, key: facts.key } : {});
        pass.done++;
      }
    } finally {
      pass.running = false;
      pass.now = null;
      pass.waiting = null;
      if (!pass.queue.length) {
        pass.done = 0;
        pass.total = 0;
      }
    }
  }

  /** What a deck or the pass measured, onto the record: it only fills what nothing else stated. */
  async function setFacts(p, facts) {
    const { result } = await storage.updateLibrary((doc) => lib.applyTrackFacts(doc, p, facts) ?? false);
    return result;
  }

  /** Each path's own tags, where its record still has a gap the tags could fill (or a rescan asks). */
  async function tagsFor(paths, mode) {
    const doc = await storage.readLibrary();
    const byPath = new Map(doc.tracks.map((t) => [t.path, t]));
    const out = new Map();
    for (const p of paths) {
      const seen = byPath.get(p);
      if (seen && mode !== 'rescan' && lib.trackHasNoGaps(seen)) continue;
      // eslint-disable-next-line no-await-in-loop
      out.set(p, (await songs?.tags?.(p).catch?.(() => null)) ?? {});
    }
    return out;
  }

  /** Paths into the collection, with what each file's tags say. Returns { library, added, already }. */
  async function importPaths(paths, { mode = 'fill' } = {}) {
    const tags = await tagsFor(paths, mode);
    const { library, result } = await storage.updateLibrary((doc) => lib.importInto(doc, paths, {
      tagsOf: (p) => tags.get(p) ?? {},
      mode,
    }));
    return { library, added: result.added, already: result.already };
  }

  /** One used file filed in the collection, quietly - every gesture that uses a track imports it. */
  async function ensure(p) {
    if (!p) return;
    await importPaths([p]).catch(() => {});
  }

  /** The record of a path, or null. */
  async function recordOf(p) {
    const doc = await storage.readLibrary();
    return doc.tracks.find((t) => t.path === p) ?? null;
  }

  /** The anchors kept before they joined the records: moved onto them once, then let go. */
  async function adoptOldAnchors() {
    const held = await store?.get?.(OLD_ANCHORS_KEY).catch?.(() => null);
    if (!held || typeof held !== 'object') return;
    const paths = Object.keys(held);
    if (paths.length) {
      await storage.updateLibrary((doc) => {
        lib.importInto(doc, paths);
        for (const p of paths) lib.applyTrackAnchor(doc, p, held[p]);
      });
    }
    await store.delete?.(OLD_ANCHORS_KEY).catch?.(() => {});
  }

  /** The library as the editor reads it: the document, the pass, and tonight's played marks. */
  async function body(library = null) {
    return {
      ...(library ?? await storage.readLibrary()),
      analyzing: state(),
      ...(desk?.playedNow?.() ?? { playedSession: [], playedSaves: [], onDeck: {} }),
    };
  }

  const routes = {
    'GET /api/library': async () => body(),
    'POST /api/library': async (doc) => ({ ...(await storage.writeLibrary(doc)), analyzing: state() }),

    // Body: { paths: [...] } and/or { dirs: [...] } (or { dir }), plus { mode: 'rescan' } -> { library, added, already }.
    // The intake: music-folder files into the collection, each one's own tags read for what it can
    // say about itself; what it did not say is measured, in the background.
    'POST /api/library/import': async (b) => {
      let paths = Array.isArray(b?.paths) ? b.paths.map(String) : [];
      const dirs = [...(Array.isArray(b?.dirs) ? b.dirs : []), ...(b?.dir ? [b.dir] : [])];
      for (const dir of dirs) {
        if (!folder) throw new Error('no music folder is chosen - choose one in settings, under music folder');
        const walked = folder.walk(String(dir));
        paths = paths.concat(walked.files.map((f) => `${walked.path}/${f}`));
      }
      paths = [...new Set(paths)];
      if (paths.length > IMPORT_MAX) throw new Error(`that is more than ${IMPORT_MAX} files - import a folder at a time`);
      const mode = b?.mode === 'rescan' ? 'rescan' : 'fill';
      const { library, added, already } = await importPaths(paths, { mode });
      const touched = mode === 'rescan' ? [...added, ...already] : added;
      const queued = queue(wanted(touched));
      return { library, added: added.length, already: already.length, queued, analyzing: state() };
    },

    // Body: { files: [{ name, size }] } -> { paths }: where each dropped file is in the music
    // folder (null for one that is not in it), so a drop can load or import it by its path.
    'POST /api/library/locate': async (b) => {
      if (!folder) throw new Error('no music folder is chosen - choose one in settings, under music folder');
      const asked = Array.isArray(b?.files) ? b.files : [];
      const paths = [];
      for (const f of asked) paths.push(await folder.find(String(f?.name ?? ''), Number.isFinite(f?.size) ? f.size : null));
      return { paths };
    },

    // Body: { ids?, force? } -> { queued, analyzing }. Measures tempo and key for tracks whose
    // files never stated them; `force` measures again what has been tried.
    'POST /api/library/analyze': async (b) => {
      const doc = await storage.readLibrary();
      const ids = Array.isArray(b?.ids) ? b.ids.map(String) : [];
      const tracks = ids.length ? doc.tracks.filter((t) => ids.includes(t.id)) : doc.tracks;
      return { queued: queue(wanted(tracks, { force: !!b?.force })), analyzing: state() };
    },
    'POST /api/library/analyze/stop': async () => ({ dropped: stop(), analyzing: state() }),

    // Body: { id | ids, fields: { title?, artist?, album?, bpm?, key?, rating? } } -> { library }.
    'POST /api/library/track': async (b) => {
      const { library, result } = await storage.updateLibrary((doc) => (lib.editTracks(doc, b?.ids ?? b?.id, b?.fields ?? {}).length ? true : false));
      if (!result) throw new Error('no such track');
      return { library, analyzing: state() };
    },

    // Body: { ids } -> { library, forgot }. Out of the collection and every set; the files stay.
    'POST /api/library/forget': async (b) => {
      const { library, result } = await storage.updateLibrary((doc) => lib.forgetFrom(doc, b?.ids));
      return { library, forgot: result, analyzing: state() };
    },
  };

  return {
    routes,
    state,
    ensure,
    recordOf,
    setFacts,
    async restore() {
      await adoptOldAnchors().catch((err) => log(`[library] ${err.message ?? err}`));
    },
    /** A beatgrid anchor placed by hand (null clears it), kept on the track's record. */
    async rememberAnchor(p, sec) {
      await ensure(p);
      await storage.updateLibrary((doc) => lib.applyTrackAnchor(doc, p, sec) ?? false);
    },
    /** A key typed by hand on a deck (null clears it), kept on the record as typed by hand. */
    async rememberKey(p, key) {
      await ensure(p);
      await storage.updateLibrary((doc) => {
        const track = doc.tracks.find((t) => t.path === p);
        return track ? lib.editTracks(doc, track.id, { key: key ?? null }).length > 0 : false;
      });
    },
    /** A tempo typed by hand on a deck (null clears it), kept on the record as typed by hand. */
    async rememberBpm(p, bpm) {
      await ensure(p);
      await storage.updateLibrary((doc) => {
        if (bpm == null) return lib.clearTrackTempo(doc, p) ?? false;
        const track = doc.tracks.find((t) => t.path === p);
        return track ? lib.editTracks(doc, track.id, { bpm }).length > 0 : false;
      });
    },
  };
}
