'use strict';

// The sample map's HTTP surface: the routes server.js mounts under /api/sampleMap, built over
// an osc-engine SampleIndex. Kept out of server.js so the handlers can be exercised with a
// fake index and a plain settings object (see sample-map-api.test.js).
//
// The map is a SOURCING tool: every answer here is a file path the client writes into a
// `_pack()` definition, and nothing at pattern time ever consults it (see sample-map.js).
//
// Builds run in the background and the client POLLS /api/sampleMap/status while one is on -
// a build is rare, user-initiated and a minute long at most, so two requests a second for its
// duration is nothing, and it spares the page another long-lived stream.

const { SampleIndex } = require('@poptart/osc-engine/sample-index');
const { samplesRoot } = require('@poptart/osc-engine/samples');

/**
 * @param {object} deps
 * @param {object} deps.settings - the server's live settings object (mapSources lives on it)
 * @param {() => void} deps.saveSettings
 * @param {SampleIndex} [deps.index] - injectable for tests
 * @param {(msg: string) => void} [deps.log]
 */
function createSampleMapApi({ settings, saveSettings, index = new SampleIndex(), log = () => {} }) {
  const sources = () => (Array.isArray(settings.mapSources) ? settings.mapSources.map(String) : []);

  /** Kick off a refresh without waiting for it; the status route reports on it. */
  function refreshInBackground({ force = false } = {}) {
    if (!sources().length) return null;
    const p = index.refresh({ force });
    p.then(
      (r) => log(`[poptart] sample map: ${r.total} samples (${r.analyzed} analyzed, ${r.removed} removed)`),
      (err) => log(`[poptart] sample map build failed: ${err?.message ?? err}`),
    );
    return p;
  }

  /**
   * Boot: read the cache so the map is there immediately, then bring it up to date in the
   * background. Never awaited by the caller - a library scan must not delay the engine.
   */
  function start() {
    index.load();
    index.setSources(sources());
    return refreshInBackground();
  }

  const status = () => ({ ...index.status, sources: index.sources });

  const routes = {
    // Everything the panel draws. Large (a few hundred KB at library scale) but a single
    // request per panel open, and on localhost.
    'GET /api/sampleMap': async () => ({
      status: 200,
      body: { ...index.snapshot(), status: status() },
    }),

    'GET /api/sampleMap/status': async () => ({ status: 200, body: status() }),

    // The folders the map covers, plus the samples root as the obvious first suggestion (it is
    // NOT included by default - the user decides what the analysis sees).
    'GET /api/sampleMap/sources': async () => ({
      status: 200,
      body: { sources: sources(), suggested: samplesRoot() },
    }),

    // Body: { sources: string[] }. Persisted, applied, and a rebuild started; the response is
    // the status the client then polls.
    'POST /api/sampleMap/sources': async (body) => {
      const list = Array.isArray(body?.sources) ? body.sources.map((s) => String(s).trim()).filter(Boolean) : [];
      settings.mapSources = list;
      saveSettings();
      index.setSources(list);
      if (!list.length) {
        // No sources means no map: drop the derived map now rather than leaving a stale one up.
        index.map = null;
        index.status.count = 0;
        index.save();
      } else refreshInBackground();
      return { status: 200, body: status() };
    },

    // Body: { force?: boolean } - force re-analyzes every file (after a feature change it
    // happens on its own; this is for "something looks wrong").
    'POST /api/sampleMap/rebuild': async (body) => {
      refreshInBackground({ force: !!body?.force });
      return { status: 200, body: status() };
    },

    // Query: path (absolute), k. Nearest first. Empty for a file the map doesn't know, with
    // `indexed: false` so the panel can say so instead of showing nothing.
    'GET /api/sampleMap/neighbors': async (query) => {
      const file = String(query.path ?? '');
      const k = Math.max(1, Math.min(50, Number(query.k) || 15));
      const point = index.pointOf(file);
      return { status: 200, body: { indexed: !!point, point, neighbors: point ? index.neighbors(file, k) : [] } };
    },

    'GET /api/sampleMap/point': async (query) => ({
      status: 200,
      body: { point: index.pointOf(String(query.path ?? '')) },
    }),

    // Body: { kit: string[], types?: string[], sources?: number[], exclude?: string[], typical?: boolean }.
    // The sample farthest from everything in the kit; null when nothing qualifies.
    'POST /api/sampleMap/unique': async (body) => {
      const kit = Array.isArray(body?.kit) ? body.kit.map(String) : [];
      const opts = {};
      if (Array.isArray(body?.types)) opts.types = body.types;
      if (Array.isArray(body?.sources)) opts.sources = body.sources.map(Number);
      if (Array.isArray(body?.exclude)) opts.exclude = body.exclude.map(String);
      if (body?.typical === false) opts.typical = false;
      const file = index.unique(kit, opts);
      return { status: 200, body: { path: file, point: file ? index.pointOf(file) : null } };
    },

    // Body: { kit: string[] }. Every slot hopped to one of its near neighbors.
    'POST /api/sampleMap/reshuffle': async (body) => {
      const kit = Array.isArray(body?.kit) ? body.kit.map(String) : [];
      const out = index.reshuffle(kit);
      return { status: 200, body: { kit: out, points: out.map((p) => index.pointOf(p)) } };
    },
  };

  return { routes, start, index };
}

module.exports = { createSampleMapApi };
