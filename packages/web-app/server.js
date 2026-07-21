'use strict';

// Plain Node HTTP server replacing the old Electron shell (app/main.js) - serves the browser UI
// from public/ and exposes the same operations the old IPC handlers did, now as HTTP endpoints.
// All request/reply here (no push updates needed yet), so plain HTTP is enough - no WebSocket
// dependency required for what this currently does.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { MappedEngine } = require('./param-mapping');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// CodeMirror (v5: plain script files, no build step) is served under /vendor/codemirror/
// straight out of node_modules - see resolveStaticPath().
const CODEMIRROR_DIR = path.dirname(require.resolve('codemirror/package.json'));

let patternCore = null; // loaded via dynamic import() since it's an ESM package
let engine = null; // raw OscEngine (introspection/record endpoints talk to this directly)
let mappedEngine = null; // alias + unit-conversion wrapper (see param-mapping.js) - what the scheduler drives
let engineError = null;
let scheduler = null;

async function loadEngine() {
  try {
    const { OscEngine } = require('@poptart/osc-engine');
    const e = new OscEngine();
    await e.start(48000, 256);
    return e;
  } catch (err) {
    engineError = err.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error(
      '[poptart] osc-engine failed to start - is SuperCollider (sclang, with VSTPlugin~) installed and on PATH? see README.',
      err,
    );
    return null;
  }
}

async function init() {
  patternCore = await import('@poptart/pattern-core');
  engine = await loadEngine();
  if (engine) {
    mappedEngine = new MappedEngine(engine);
    scheduler = new patternCore.Scheduler(mappedEngine, { cps: 0.5, trackId: 'default' });
  }
}

// ---------------------------------------------------------------------------------------------
// API handlers - one per old ipcMain.handle() call in app/main.js, same request/response shapes.
// ---------------------------------------------------------------------------------------------

const routes = {
  'GET /api/status': async () => ({
    status: 200,
    body: { loaded: !!engine, error: engineError },
  }),

  'POST /api/scanPlugins': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.scanPlugins(body.extraPaths ?? []) };
  },

  'GET /api/knownPlugins': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getKnownPlugins() };
  },

  'POST /api/evaluate': async (body) => {
    if (!engine || !scheduler) throw new Error(engineError ?? 'engine not loaded');

    // Same MVP evaluation contract as the old app/main.js: `code` is a single JS expression that
    // evaluates to a Sig, built from the names below (matches the brief's own example exactly).
    const { n, note, mini, sine, saw, tri, square, env } = patternCore;
    // eslint-disable-next-line no-new-func
    const build = new Function('n', 'note', 'mini', 'sine', 'saw', 'tri', 'square', 'env', `return (\n${body.code}\n);`);
    const pattern = build(n, note, mini, sine, saw, tri, square, env);

    if (!(pattern instanceof patternCore.Sig)) {
      throw new Error('code must evaluate to a pattern (e.g. n("0 2 3").scale("F minor").s("Serum 2"))');
    }

    // The wrapper needs to know which plugin sits in each slot to pick the right mapping file.
    mappedEngine.setChain([pattern.instrument, ...pattern.fxChain]);
    scheduler.setPattern(pattern);
    scheduler.start();

    return {
      status: 200,
      body: {
        instrument: pattern.instrument,
        fxChain: pattern.fxChain,
        paramNames: Object.keys(pattern.paramSignals),
      },
    };
  },

  'POST /api/stop': async () => {
    scheduler?.stop();
    return { status: 200, body: {} };
  },

  // Introspection: real parameter names of the plugin in a track slot. Body: { trackId, slot }.
  'POST /api/params': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getParams(body.trackId ?? 'default', body.slot ?? 0) };
  },

  // Parameter lists for every plugin in the currently-evaluated chain, for the editor's
  // autocomplete and params panel. Loading a plugin is fire-and-forget (the eval response
  // doesn't wait for it), so a slot whose plugin is still opening is retried for a while
  // before giving up - the client calls this in the background right after an eval.
  'GET /api/chainParams': async () => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const slots = [];
    for (let slot = 0; slot < mappedEngine.chain.length; slot++) {
      const plugin = mappedEngine.chain[slot];
      if (!plugin) continue;
      if (!paramsByPlugin.has(plugin)) {
        try {
          paramsByPlugin.set(plugin, await getParamsWhenLoaded('default', slot));
        } catch (err) {
          slots.push({ slot, plugin, params: [], error: err.message ?? String(err) });
          continue;
        }
      }
      slots.push({ slot, plugin, params: paramsByPlugin.get(plugin) });
    }
    return { status: 200, body: { slots } };
  },

  // Pop open the native editor window of the plugin in a chain slot (design your supersaw in
  // Serum's own UI, then livecode the modulation). Body: { trackId, slot }.
  'POST /api/showEditor': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    engine.showPluginEditor(body.trackId ?? 'default', body.slot ?? 0);
    return { status: 200, body: {} };
  },

  // Bounce the master bus to a WAV. Body: { path, seconds }.
  'POST /api/record': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.record(body.path, body.seconds ?? 4) };
  },
};

// Full parameter lists keyed by plugin name - Serum 2's is 2,621 entries and round-trips
// through sclang via a temp file, so fetch it once per plugin, not once per eval.
const paramsByPlugin = new Map();

// Plugin loading is a fire-and-forget OSC send, so right after an eval getParams can race the
// plugin's own (potentially slow - Serum takes seconds) open. Poll until it answers.
async function getParamsWhenLoaded(trackId, slot, { tries = 30, delayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await engine.getParams(trackId, slot);
    } catch (err) {
      const stillOpening = /no plugin loaded/i.test(err.message ?? '');
      if (!stillOpening || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Plumbing: static file serving + JSON body parsing + route dispatch.
// ---------------------------------------------------------------------------------------------

function resolveStaticPath(urlPath) {
  const vendorPrefix = '/vendor/codemirror/';
  const root = urlPath.startsWith(vendorPrefix) ? CODEMIRROR_DIR : PUBLIC_DIR;
  const rel = urlPath.startsWith(vendorPrefix) ? urlPath.slice(vendorPrefix.length) : urlPath;
  const filePath = path.join(root, rel);
  return filePath.startsWith(root) ? filePath : null;
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = resolveStaticPath(urlPath);

  if (!filePath) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const routeKey = `${req.method} ${req.url}`;
  const handler = routes[routeKey];

  if (!handler) {
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(404).end('not found');
    return;
  }

  try {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const { status, body: responseBody } = await handler(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message ?? String(err) }));
  }
});

init().then(() => {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[poptart] listening on http://localhost:${PORT}`);
  });
});

process.on('SIGINT', () => {
  engine?.stop();
  process.exit(0);
});
