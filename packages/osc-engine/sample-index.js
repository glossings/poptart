'use strict';

// The sample index: the durable half of the sample map (sample-map.js is the maths). It owns
// the list of SOURCE folders the user chose to include, keeps one feature vector per audio file
// under them in a cache on disk, and derives the map - projection, neighbors, layout, groups,
// labels - from whatever is currently indexed.
//
// Sources are the user's decision, made in the settings, and nothing is analyzed that isn't
// under one. The samples root is not implied: it is offered as a first source, not assumed.
//
// Refreshing is incremental: files are keyed by absolute path and re-analyzed only when their
// mtime/size changes or the feature definition does (FEATURE_VERSION). A removed source's
// vectors stay in the cache, so adding it back is instant; only the derived map is filtered to
// the current sources. The map itself is recomputed whenever the file set changes - it is a
// couple of seconds at library scale, and recomputing keeps it honest rather than patching new
// points into an old projection.
//
// Analysis runs on the analysis worker in batches (analysis.js's mapFeatures) so the note
// scheduler never waits on it; the index reports progress as it goes so the UI can show a bar.
// Non-WAV files that scsynth can play (aiff, flac) go through the same afconvert cache the song
// decks use (songs.js) so the JS-side reader sees a WAV.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sm = require('./sample-map');
const { walkAudioFiles } = require('./samples');
const { resolveSongFile } = require('./songs');
const analysis = require('./analysis');

const CACHE_FORMAT = 1;
const BATCH = 32; // files per worker message
const NEIGHBORS = 15;

function defaultCacheFile() {
  return path.join(os.homedir(), '.poptart', 'cache', 'sample-map.json');
}

const b64 = {
  encode: (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64'),
  decode: (s) => {
    const buf = Buffer.from(s, 'base64');
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  },
};

class SampleIndex {
  /**
   * @param {object} [opts]
   * @param {string} [opts.cacheFile]
   * @param {(paths: string[]) => Promise<Array<{features: Float32Array, seconds: number}|null>>} [opts.analyze]
   *   injectable for tests (the default is the worker)
   * @param {(file: string) => Promise<string>} [opts.toWav] - path a WAV reader can open, for
   *   aiff/flac; injectable for tests
   * @param {(vectors: Float32Array[], paths: string[]) => Promise<object>} [opts.derive] -
   *   sample-map.js's deriveMap; the default runs it on the worker, tests run it inline
   */
  constructor({ cacheFile = defaultCacheFile(), analyze = analysis.mapFeatures, toWav, walk = walkAudioFiles, derive = analysis.mapDerive } = {}) {
    this.cacheFile = cacheFile;
    this._analyze = analyze;
    this._deriveFn = derive;
    this._toWav = toWav ?? (async (file) => (await resolveSongFile(file, { wav: true })).path);
    this._walk = walk;
    this.sources = [];
    /** @type {Map<string, {path, source, mtime, size, seconds, version, features: Float32Array}>} */
    this.entries = new Map();
    this.map = null; // derived, see _derive
    this.status = { building: false, phase: 'idle', done: 0, total: 0, count: 0, error: null };
    this._refreshing = null;
    this._dirty = false;
  }

  // -------------------------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------------------------

  /** Read the cache. Returns true if there was one to read. The map comes back with it. */
  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      return false;
    }
    if (raw?.format !== CACHE_FORMAT) return false;
    this.sources = Array.isArray(raw.sources) ? raw.sources.map(String) : [];
    this.entries = new Map();
    for (const e of raw.entries ?? []) {
      if (!e?.path) continue;
      // null features = a file that couldn't be decoded; kept so it isn't retried every refresh.
      const features = typeof e.features === 'string' ? b64.decode(e.features) : null;
      if (features && features.length !== sm.FEATURE_LENGTH) continue; // a different layout; re-analyze
      this.entries.set(e.path, { ...e, features });
    }
    this.map = raw.map ? decodeMap(raw.map) : null;
    if (this.map && !this._mapMatches()) this.map = null;
    this.status.count = this.map?.paths.length ?? 0;
    return true;
  }

  save() {
    const out = {
      format: CACHE_FORMAT,
      featureVersion: sm.FEATURE_VERSION,
      sources: this.sources,
      entries: [...this.entries.values()].map((e) => ({ ...e, features: e.features ? b64.encode(e.features) : null })),
      map: this.map ? encodeMap(this.map) : null,
    };
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const part = `${this.cacheFile}.part`;
    fs.writeFileSync(part, JSON.stringify(out));
    fs.renameSync(part, this.cacheFile);
    this._dirty = false;
  }

  // -------------------------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------------------------

  /** Replace the source list. Absolute, de-duplicated, order kept (it is the map's color order). */
  setSources(dirs) {
    const seen = new Set();
    this.sources = [];
    for (const d of dirs ?? []) {
      const abs = path.resolve(String(d));
      if (seen.has(abs)) continue;
      seen.add(abs);
      this.sources.push(abs);
    }
    if (this.map && !this._mapMatches()) this.map = null;
    this._dirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------------------------

  /**
   * Bring the index up to date with the sources on disk and rebuild the map if anything
   * changed (or `force`). One refresh runs at a time; a call during one joins it.
   * @param {{ onProgress?: (s: object) => void, force?: boolean }} [opts]
   * @returns {Promise<{ analyzed: number, removed: number, total: number }>}
   */
  refresh({ onProgress, force = false } = {}) {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._refresh({ onProgress, force }).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _refresh({ onProgress, force }) {
    const report = (phase, done, total) => {
      Object.assign(this.status, { building: phase !== 'done', phase, done, total });
      onProgress?.({ ...this.status });
    };
    this.status.error = null;
    try {
      report('scan', 0, 0);
      const found = await this._scan();
      const wanted = new Set(found.keys());

      // What needs analyzing: new, changed, or from an older feature definition.
      const todo = [];
      for (const [abs, info] of found) {
        const have = this.entries.get(abs);
        if (force || !have || have.mtime !== info.mtime || have.size !== info.size || have.version !== sm.FEATURE_VERSION) todo.push(info);
        else if (have.source !== info.source) { have.source = info.source; this._dirty = true; } // same file, now reached via another source
      }
      report('analyze', 0, todo.length);
      let analyzed = 0;
      for (let at = 0; at < todo.length; at += BATCH) {
        const batch = todo.slice(at, at + BATCH);
        const wavPaths = await Promise.all(batch.map((info) => this._wavPathFor(info.path)));
        const results = await this._analyze(wavPaths.map((p) => p ?? ''));
        batch.forEach((info, i) => {
          // A conversion that failed (afconvert missing, cache dir unwritable) is not the
          // file's fault: leave no entry, so the next refresh tries again.
          if (!wavPaths[i]) return;
          const r = results[i];
          if (!r) {
            // An undecodable WAV stays out of the index but is not retried every refresh:
            // remember the file as seen, with no vector, so the walk is the only cost it carries.
            this.entries.set(info.path, { ...info, version: sm.FEATURE_VERSION, seconds: 0, features: null });
            return;
          }
          this.entries.set(info.path, { ...info, version: sm.FEATURE_VERSION, seconds: r.seconds, features: Float32Array.from(r.features) });
          analyzed++;
        });
        report('analyze', Math.min(todo.length, at + batch.length), todo.length);
      }

      // Files that vanished from under a current source leave the index entirely - a stale
      // vector for a missing file would still be offered by "unique" and "swap".
      let removed = 0;
      for (const [abs, e] of this.entries) {
        if (this._underSources(abs) && !wanted.has(abs)) { this.entries.delete(abs); removed++; }
      }

      const changed = force || analyzed > 0 || removed > 0 || !this.map || !this._mapMatches();
      if (changed) {
        report('place', 0, 1);
        this.map = await this._derive();
        this._dirty = true;
      }
      this.status.count = this.map?.paths.length ?? 0;
      if (this._dirty) this.save();
      report('done', 1, 1);
      return { analyzed, removed, total: this.status.count };
    } catch (err) {
      this.status.error = err?.message ?? String(err);
      report('done', 1, 1);
      throw err;
    }
  }

  /** Every audio file under the current sources: abs path -> { path, source, mtime, size }. */
  async _scan() {
    const found = new Map();
    for (const source of this.sources) {
      const { files } = await this._walk(source, { limit: 100000 });
      for (const rel of files) {
        const abs = path.join(source, rel);
        if (found.has(abs)) continue;
        let st;
        try {
          st = await fs.promises.stat(abs);
        } catch {
          continue;
        }
        found.set(abs, { path: abs, source, mtime: Math.round(st.mtimeMs), size: st.size });
      }
    }
    return found;
  }

  async _wavPathFor(file) {
    if (path.extname(file).toLowerCase() === '.wav') return file;
    try {
      return await this._toWav(file);
    } catch {
      return null;
    }
  }

  _underSources(abs) {
    return this.sources.some((s) => abs === s || abs.startsWith(s + path.sep));
  }

  /** The entries the map is built from, in source order then path order. */
  _current() {
    const out = [];
    for (const source of this.sources) {
      const here = [];
      for (const e of this.entries.values()) {
        if (e.source === source && e.features && this._underSources(e.path)) here.push(e);
      }
      here.sort((a, b) => a.path.localeCompare(b.path));
      out.push(...here);
    }
    return out;
  }

  _mapMatches() {
    if (!this.map) return false;
    const cur = this._current();
    if (cur.length !== this.map.paths.length) return false;
    return cur.every((e, i) => e.path === this.map.paths[i]);
  }

  // -------------------------------------------------------------------------------------------
  // The map
  // -------------------------------------------------------------------------------------------

  // The map from the current entries: sample-map.js's deriveMap, on the worker by default (it
  // is seconds of CPU), with this index's bookkeeping - paths, sources, lengths - alongside.
  async _derive() {
    const entries = this._current();
    const paths = entries.map((e) => e.path);
    const derived = await this._deriveFn(entries.map((e) => e.features), paths, { k: NEIGHBORS });
    return {
      paths,
      sources: entries.map((e) => e.source),
      seconds: entries.map((e) => e.seconds),
      ...derived,
    };
  }

  _indexOf(file) {
    if (!this.map) return -1;
    this.map._index ??= new Map(this.map.paths.map((p, i) => [p, i]));
    return this.map._index.get(path.resolve(String(file))) ?? -1;
  }

  /** What the client draws: every point with its position, type, group and source. */
  snapshot() {
    const m = this.map;
    if (!m) return { sources: this.sources, clusterLabels: [], points: [] };
    return {
      sources: this.sources,
      clusterLabels: m.clusterLabels,
      points: m.paths.map((p, i) => ({
        path: p,
        x: round3(m.xy[i * 2]),
        y: round3(m.xy[i * 2 + 1]),
        label: m.labels[i],
        cluster: m.clusters[i],
        seconds: round3(m.seconds[i]),
        source: this.sources.indexOf(m.sources[i]),
      })),
    };
  }

  /** One point's record, or null if the file isn't on the map. */
  pointOf(file) {
    const i = this._indexOf(file);
    if (i < 0) return null;
    const m = this.map;
    return { path: m.paths[i], label: m.labels[i], cluster: m.clusters[i], seconds: m.seconds[i], source: m.sources[i] };
  }

  /**
   * The nearest neighbors of a file on the map, nearest first, as [{ path, dist, label }].
   * Empty for a file that isn't indexed - the caller says so rather than guessing.
   */
  neighbors(file, k = NEIGHBORS) {
    const i = this._indexOf(file);
    if (i < 0 || !this.map.neighbors[i]) return [];
    const { index, dist } = this.map.neighbors[i];
    const out = [];
    for (let t = 0; t < Math.min(k, index.length); t++) {
      if (index[t] < 0) break;
      out.push({ path: this.map.paths[index[t]], dist: round3(dist[t]), label: this.map.labels[index[t]] });
    }
    return out;
  }

  /**
   * The sample farthest (in feature space) from everything already in the kit - the "give me a
   * unique one" action. `types` / `sources` narrow the candidates (a kit that only wants
   * one-shots can exclude loops); kit members and `exclude` never come back.
   *
   * `typical` (default on) keeps the search to well-supported samples - those whose
   * neighborhood is no wider than the map's median. Farthest-point sampling otherwise hands
   * back the library's oddities first (the one gamelan hit, the bullwhip), because an outlier
   * is by definition far from everything; a kit wants the farthest sound that is still a
   * representative of something.
   * @returns {string | null}
   */
  unique(kitPaths, { types = null, sources = null, exclude = [], typical = true } = {}) {
    const m = this.map;
    if (!m || !m.points.length) return null;
    const chosen = kitPaths.map((p) => this._indexOf(p)).filter((i) => i >= 0);
    const skip = new Set([...exclude.map((p) => this._indexOf(p)), ...chosen]);
    const support = typical ? this._support() : null;
    const candidates = [];
    for (let i = 0; i < m.paths.length; i++) {
      if (types && !types.includes(m.labels[i])) continue;
      if (sources && !sources.includes(this.sources.indexOf(m.sources[i]))) continue;
      if (support && support.radius[i] > support.median) continue;
      candidates.push(i);
    }
    const best = sm.farthestFrom(m.points, chosen, { candidates, exclude: skip });
    return best >= 0 ? m.paths[best] : null;
  }

  /** Each point's neighborhood radius (distance to its farthest kept neighbor) and the median. */
  _support() {
    const m = this.map;
    if (!m._support) {
      const radius = Float32Array.from(m.neighbors, ({ dist }) => (dist.length ? dist[dist.length - 1] : 0));
      const sorted = Float32Array.from(radius).sort();
      m._support = { radius, median: sorted.length ? sorted[sorted.length >> 1] : 0 };
    }
    return m._support;
  }

  /**
   * Every kit slot hopped to one of its own near neighbors - same roles, different flavour.
   * A slot whose file isn't indexed, or whose neighbors are all already in the kit, keeps its
   * file. `rng` is injectable so a test can pin the outcome.
   * @returns {string[]}
   */
  reshuffle(kitPaths, { k = 8, rng = Math.random } = {}) {
    const taken = new Set(kitPaths.map((p) => path.resolve(String(p))));
    return kitPaths.map((p) => {
      const options = this.neighbors(p, k).map((n) => n.path).filter((q) => !taken.has(q));
      if (!options.length) return p;
      const pick = options[Math.floor(rng() * options.length)];
      taken.add(pick);
      return pick;
    });
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function encodeMap(m) {
  return {
    paths: m.paths,
    sources: m.sources,
    seconds: m.seconds,
    points: m.points.map((p) => b64.encode(p)),
    xy: b64.encode(m.xy),
    neighbors: m.neighbors.map((n) => ({ index: Array.from(n.index), dist: Array.from(n.dist).map(round3) })),
    clusters: Array.from(m.clusters),
    labels: m.labels,
    clusterLabels: m.clusterLabels,
    prepared: m.prepared && {
      mean: b64.encode(m.prepared.mean),
      scale: b64.encode(m.prepared.scale),
      basis: m.prepared.basis.map((b) => b64.encode(b)),
    },
  };
}

function decodeMap(raw) {
  try {
    return {
      paths: raw.paths,
      sources: raw.sources,
      seconds: raw.seconds,
      points: raw.points.map((p) => b64.decode(p)),
      xy: b64.decode(raw.xy),
      neighbors: raw.neighbors.map((n) => ({ index: Int32Array.from(n.index), dist: Float32Array.from(n.dist) })),
      clusters: Int32Array.from(raw.clusters),
      labels: raw.labels,
      clusterLabels: raw.clusterLabels,
      prepared: raw.prepared && {
        mean: b64.decode(raw.prepared.mean),
        scale: b64.decode(raw.prepared.scale),
        basis: raw.prepared.basis.map((b) => b64.decode(b)),
      },
    };
  } catch {
    return null;
  }
}

module.exports = { SampleIndex, defaultCacheFile };
