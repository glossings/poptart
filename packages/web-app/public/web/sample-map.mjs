// The sample map in the browser build.
//
// The same map as the desktop's - the same features, projection, groups and queries, from the
// same module (osc-engine's sample-map-core.mjs) - over what a page has instead of folders: every
// pack it knows. The packs that ship, the sourced library, what samples() read from a repository,
// the sample folder and the files dropped on the window are all on it unless the settings say
// otherwise, so a kit can be built from any of them without choosing folders first.
//
// A point is named the way the pack panel names a file here: `/packs/<pack>/<file>`, which is the
// panel's `/packs` root plus the "pack/file" entry a `_pack()` list holds (see the sample store's
// definitions). A source is `/packs` - everything - or `/packs/<pack>`.
//
// Nothing is built until the map is first opened: a map over the sourced library means reading
// every file in it, and that is a download nobody should get for opening the editor. After that a
// file is analyzed once - its vector is kept in this browser's store under the name and origin of
// the pack it came from - and the map is derived again only when the set of files changes.
//
// The work that is seconds of CPU (the features, the layout) is the caller's to put somewhere -
// boot hands in a worker - so this file is the bookkeeping, and runs as happily in a test.

import { originOf } from './remote-packs.mjs';

export const ROOT = '/packs';
const CACHE_KEY = 'samplemap/cache';
const SETTINGS_KEY = 'settings/sample-map';
const CACHE_FORMAT = 1;
const NEIGHBORS = 15;
const BATCH = 16;
/**
 * How many files in a row may fail to be read before a build stops reading. A server that has
 * started refusing - a CDN turning a burst of requests away - refuses the rest too, and asking it
 * for every one of them is a few hundred more refusals and a longer wait for the same answer. The
 * map is built from what was read, and the next build asks again for the rest.
 */
const MAX_UNREAD_RUN = 8;
/** The packs that are not sounds to build a kit from: a wavetable folder, bounces of songs. */
const NOT_ON_MAP = new Set(['wt', 'rec']);

/** A decoded file's first seconds as mono, as the core's feature extraction reads it. */
export function monoHead(buffer, seconds) {
  const sampleRate = buffer.sampleRate;
  const n = Math.min(buffer.length, Math.round(seconds * sampleRate));
  const samples = new Float32Array(n);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) samples[i] += data[i] / channels;
  }
  return { sampleRate, samples, totalSeconds: buffer.length / sampleRate };
}

/** The point name of one file of a pack. */
export const pointPath = (pack, file) => `${ROOT}/${pack}/${file}`;

/** A point name back as its pack and file, or null. Takes the bare "pack/file" entry too. */
export function splitPoint(text) {
  let rest = String(text ?? '');
  if (rest.startsWith(`${ROOT}/`)) rest = rest.slice(ROOT.length + 1);
  else if (rest.startsWith('/')) return null;
  const cut = rest.indexOf('/');
  return cut > 0 ? { pack: rest.slice(0, cut), file: rest.slice(cut + 1) } : null;
}

/** Whether a point sits under a source: the root, or one pack. */
const under = (source, pack) => source === ROOT || source === `${ROOT}/${pack}`;

/**
 * @param {object} deps
 * @param {object} deps.core - sample-map-core.mjs
 * @param {object} [deps.store] - the page's key-value store, for the vectors, the map and the sources
 * @param {() => object[]} deps.packs - every pack's manifest, as the host lists them
 * @param {(pack: string, index: number) => Promise<ArrayBuffer|null>} deps.bytesOf
 * @param {(bytes: ArrayBuffer) => Promise<AudioBuffer>} deps.decode
 * @param {(heads: object[]) => Promise<Array<{features, seconds}|null>>} [deps.analyze]
 * @param {(vectors, paths, opts) => Promise<object>} [deps.derive]
 */
export function createWebSampleMap({ core, store = null, packs, bytesOf, decode, analyze, derive, log = () => {} }) {
  const run = {
    analyze: analyze ?? (async (heads) => heads.map((h) => (h ? { features: core.extractFeatures(h.samples, h.sampleRate, h.totalSeconds), seconds: h.totalSeconds } : null))),
    derive: derive ?? (async (vectors, paths, opts) => core.deriveMap(vectors, paths, opts)),
  };
  let sources = [ROOT];
  let entries = new Map();   // point path -> { path, source, sig, version, seconds, features|null }
  let map = null;
  let loaded = null;
  let refreshing = null;
  // `unread` is how many files the last build could not read, which the next one tries again.
  const status = { building: false, phase: 'idle', done: 0, total: 0, count: 0, error: null, unread: 0 };

  // What a file's analysis is good for: its pack's origin and the file's name in it. A library
  // pack at another commit, or a folder chosen again, is a different file under the same name.
  const sigOf = (manifest, file) => `${manifest.cachePrefix ?? manifest.base ?? manifest.description ?? manifest.id}|${manifest.version ?? ''}|${file}`;

  async function load() {
    loaded ??= (async () => {
      if (!store) return;
      const settings = await store.get(SETTINGS_KEY).catch(() => null);
      if (Array.isArray(settings?.sources)) sources = settings.sources.map(String);
      const raw = await store.get(CACHE_KEY).catch(() => null);
      if (raw?.format !== CACHE_FORMAT) return;
      for (const e of raw.entries ?? []) {
        const features = typeof e.features === 'string' ? core.base64ToF32(e.features) : null;
        if (features && features.length !== core.FEATURE_LENGTH) continue;
        entries.set(e.path, { ...e, features });
      }
      map = raw.map ? core.decodeMap(raw.map) : null;
      if (map && !matches(current())) map = null;
      status.count = map?.paths.length ?? 0;
    })();
    return loaded;
  }

  async function save() {
    if (!store) return;
    await store.put(CACHE_KEY, {
      format: CACHE_FORMAT,
      entries: [...entries.values()].map((e) => ({ ...e, features: e.features ? core.f32ToBase64(e.features) : null })),
      map: map ? core.encodeMap(map) : null,
    }).catch((err) => log(`[samples] the sample map could not be kept - ${err.message ?? err}`));
  }

  /** Every file the current sources cover: point path -> { path, source, sig, pack, index }. */
  function scan() {
    const found = new Map();
    for (const manifest of packs()) {
      if (NOT_ON_MAP.has(manifest.id)) continue;
      const source = sources.find((s) => under(s, manifest.id));
      if (!source) continue;
      // A samples() pack's files are placed by where they live (remote-packs.mjs, originOf), not by
      // the pack's name: two repositories' "bd" are two sets of sounds on the map, and a point added
      // to a kit is a file the kit can play without the samples() line.
      const remote = String(manifest.cachePrefix ?? '').startsWith('remote/');
      manifest.files.forEach((f, index) => {
        const origin = remote ? originOf(manifest.base, f.file) : null;
        const path = origin ? `${ROOT}/${origin}` : pointPath(manifest.id, f.file);
        if (!found.has(path)) found.set(path, { path, source, sig: sigOf(manifest, f.file), pack: manifest.id, index });
      });
    }
    return found;
  }

  /** The analyzed entries the map is built from, in source order then path order. */
  function current(found = scan()) {
    const out = [];
    for (const source of sources) {
      const here = [];
      for (const f of found.values()) {
        const e = entries.get(f.path);
        if (f.source === source && e?.features && e.sig === f.sig) here.push({ ...e, source });
      }
      here.sort((a, b) => a.path.localeCompare(b.path));
      out.push(...here);
    }
    return out;
  }

  function matches(cur) {
    return !!map && cur.length === map.paths.length && cur.every((e, i) => e.path === map.paths[i] && e.source === map.sources[i]);
  }

  /** Whether the map is behind the packs: a file to analyze, or a set of files it was not built from. */
  function stale() {
    const found = scan();
    for (const f of found.values()) {
      const e = entries.get(f.path);
      if (!e || e.sig !== f.sig || e.version !== core.FEATURE_VERSION) return true;
    }
    return !matches(current(found));
  }

  async function headOf(f) {
    const bytes = await bytesOf(f.pack, f.index);
    if (!bytes) throw new Error('not readable');
    return monoHead(await decode(bytes.slice(0)), core.HEAD_SECONDS);
  }

  async function build({ force }) {
    const report = (phase, done, total) => Object.assign(status, { building: phase !== 'done', phase, done, total });
    status.error = null;
    try {
      report('scan', 0, 0);
      await load();
      const found = scan();
      const todo = [...found.values()].filter((f) => {
        const e = entries.get(f.path);
        return force || !e || e.sig !== f.sig || e.version !== core.FEATURE_VERSION;
      });
      report('analyze', 0, todo.length);
      let analyzed = 0;
      let unreadRun = 0;
      let unreadTotal = 0;
      let at = 0;
      for (; at < todo.length && unreadRun < MAX_UNREAD_RUN; at += BATCH) {
        const batch = todo.slice(at, at + BATCH);
        // Read and decoded one at a time, as the sample store decodes: in parallel it competes
        // with the audio thread for as long as it takes.
        const heads = [];
        const unread = [];
        for (const f of batch) {
          if (unreadRun >= MAX_UNREAD_RUN) { heads.push(null); unread.push(true); continue; }
          try {
            heads.push(await headOf(f));
            unread.push(false);
            unreadRun = 0;
          } catch {
            heads.push(null);
            unread.push(true);
            unreadRun += 1;
          }
        }
        const results = await run.analyze(heads);
        batch.forEach((f, i) => {
          // A file that could not be READ (a network blip, a folder not allowed yet) leaves no
          // entry, so the next build tries it again; one that read but would not decode is kept
          // as seen, with no vector, so it is not tried every time.
          if (unread[i]) { unreadTotal += 1; return; }
          const r = results[i];
          entries.set(f.path, { path: f.path, source: f.source, sig: f.sig, version: core.FEATURE_VERSION, seconds: r?.seconds ?? 0, features: r ? Float32Array.from(r.features) : null });
          if (r) analyzed += 1;
        });
        report('analyze', Math.min(todo.length, at + batch.length), todo.length);
      }
      const unread = unreadTotal + Math.max(0, todo.length - at);
      status.unread = unread;
      if (unread) log(`sample map: ${unread} file${unread === 1 ? '' : 's'} could not be read${unreadRun >= MAX_UNREAD_RUN ? ' - their server stopped answering, so the map was built without them' : ''}. Rebuild to try again.`);
      const cur = current(found);
      if (force || analyzed > 0 || !matches(cur)) {
        report('place', 0, 1);
        const paths = cur.map((e) => e.path);
        const derived = await run.derive(cur.map((e) => e.features), paths, { k: NEIGHBORS });
        map = { paths, sources: cur.map((e) => e.source), seconds: cur.map((e) => e.seconds), ...derived };
      }
      status.count = map?.paths.length ?? 0;
      await save();
      report('done', 1, 1);
      return { analyzed, total: status.count };
    } catch (err) {
      status.error = err?.message ?? String(err);
      report('done', 1, 1);
      throw err;
    }
  }

  function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    refreshing = build({ force })
      .then((r) => { log(`sample map: ${r.total} sounds (${r.analyzed} analyzed)`); return r; })
      .catch((err) => { log(`[samples] the sample map build failed - ${err?.message ?? err}`); return null; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  const indexOf = (text) => {
    if (!map) return -1;
    map._index ??= new Map(map.paths.map((p, i) => [p, i]));
    const at = splitPoint(text);
    return at ? map._index.get(pointPath(at.pack, at.file)) ?? -1 : -1;
  };

  const statusNow = () => ({ ...status, sources: [...sources] });

  return {
    load,
    refresh,
    /** Builds in the background when the map is behind the packs, as it is first opened. */
    async ensure() {
      await load();
      if (!refreshing && sources.length && stale()) refresh();
      return statusNow();
    },
    status: statusNow,
    sources: () => [...sources],
    async setSources(list) {
      await load();
      const seen = new Set();
      sources = [];
      for (const s of list ?? []) {
        const text = String(s).trim().replace(/\/+$/, '');
        if (!text || seen.has(text) || !(text === ROOT || text.startsWith(`${ROOT}/`))) continue;
        seen.add(text);
        sources.push(text);
      }
      if (store) await store.put(SETTINGS_KEY, { sources }).catch(() => {});
      if (!sources.length) {
        map = null;
        status.count = 0;
        await save();
      } else refresh();
      return statusNow();
    },
    snapshot: () => core.mapSnapshot(map, sources),
    pointOf(text) {
      const i = indexOf(text);
      return i < 0 ? null : { path: map.paths[i], label: map.labels[i], cluster: map.clusters[i], seconds: map.seconds[i], source: map.sources[i] };
    },
    neighbors: (text, k = NEIGHBORS) => core.mapNeighbors(map, indexOf(text), k),
    unique(kit, { types = null, sources: sourceIndices = null, exclude = [], typical = true } = {}) {
      const chosen = kit.map(indexOf).filter((i) => i >= 0);
      const best = core.mapUnique(map, sources, chosen, { types, sourceIndices, skip: new Set(exclude.map(indexOf)), typical });
      return best >= 0 ? map.paths[best] : null;
    },
    reshuffle(kit, { k = 8, rng = Math.random } = {}) {
      const named = kit.map((p) => { const at = splitPoint(p); return at ? pointPath(at.pack, at.file) : String(p); });
      return core.mapReshuffle(named, (p) => this.neighbors(p, k), { rng });
    },
  };
}
