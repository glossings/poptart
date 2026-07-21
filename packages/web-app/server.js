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
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// CodeMirror (v5: plain script files, no build step) is served under /vendor/codemirror/
// straight out of node_modules - see resolveStaticPath(). pattern-core's dependency-free ESM
// sources are served under /pattern-core/ so the browser can run the same mini-notation parser
// and label splitter the server uses (playback highlighting needs identical step math).
const CODEMIRROR_DIR = path.dirname(require.resolve('codemirror/package.json'));
const PATTERN_CORE_SRC_DIR = path.join(__dirname, '..', 'pattern-core', 'src');

const DEFAULT_CPS = 0.5; // 120 bpm at 4 beats/cycle - overridable from code via setbpm()

let patternCore = null; // loaded via dynamic import() since it's an ESM package
let engine = null; // raw OscEngine (introspection/record endpoints talk to this directly)
let mappedEngine = null; // alias + unit-conversion wrapper (see param-mapping.js) - what the scheduler drives
let engineError = null;
let transport = null; // shared tempo clock (pattern-core Transport) - all schedulers read it
const schedulers = new Map(); // pattern label -> Scheduler (one engine track per label)

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
  extendStringPrototype(patternCore);
  engine = await loadEngine();
  if (engine) {
    mappedEngine = new MappedEngine(engine);
    transport = new patternCore.Transport(() => engine.getTime(), { cps: DEFAULT_CPS });
  }
}

// Strudel-flavored ergonomics: let mini-notation strings be used directly as patterns in
// evaluated code - `"0 0.5 1 0.3".gte(0.5)`, `"0 3 5".add(12)`, `"200 800".range(...)`. Each
// method wraps the string in mini() and delegates. This deliberately shadows the dead Annex-B
// legacy String methods where names collide (.sub's "<sub>…</sub>" wrapper, nothing of value).
function extendStringPrototype(core) {
  const METHODS = [
    'add', 'sub', 'mul', 'div', 'mod', 'round', 'abs', 'floor', 'ceil', 'clamp',
    'gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'when', 'hold', 'scale', 'range', 'synth', 'fx', 'param',
    'gain', 'pan', 'vel',
  ];
  for (const m of METHODS) {
    Object.defineProperty(String.prototype, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(...args) {
        return core.mini(String(this))[m](...args);
      },
    });
  }
}

const BUILDER_NAMES = ['n', 'note', 'mini', 's', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'lfo', 'env'];

// What a `setbpm(...)` block evaluates to - lets /api/evaluate tell tempo-only blocks apart
// from actual patterns (blocks must otherwise evaluate to a Sig).
const TEMPO_BLOCK = Object.freeze({ poptartTempoBlock: true });

// setbpm is global (there's one transport), so it's a server-provided builder rather than a
// pattern-core export. Accepts a number or any signal - "120 140", sine(0.05).range(100, 160)...
function setbpm(value) {
  if (!transport) throw new Error(engineError ?? 'engine not loaded');
  transport.setBpm(typeof value === 'string' ? patternCore.mini(value) : value);
  return TEMPO_BLOCK;
}

// One block of editor code (see labels.mjs) -> a Sig (or TEMPO_BLOCK), evaluated with the
// builders in scope.
function buildPattern(code) {
  const names = [...BUILDER_NAMES, 'setbpm'];
  // eslint-disable-next-line no-new-func
  const build = new Function(...names, `return (\n${code}\n);`);
  const pattern = build(...BUILDER_NAMES.map((name) => patternCore[name]), setbpm);
  if (pattern !== TEMPO_BLOCK && !(pattern instanceof patternCore.Sig)) {
    throw new Error('must evaluate to a pattern (e.g. n("0 2 3").scale("F minor").synth("Serum 2"))');
  }
  return pattern;
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

  // `code` is the whole editor buffer: one or more labeled blocks (see pattern-core's
  // labels.mjs - `$:` anonymous, `name:` named, `_name:` muted, `Sname:` soloed), each
  // evaluating to a Sig and playing on its own engine track named after the label. Unlabeled
  // code is treated as a single anonymous block, so the original one-expression usage still
  // works.
  'POST /api/evaluate': async (body) => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');

    const blocks = patternCore.splitLabeledBlocks(body.code ?? '');
    if (blocks.length === 0) throw new Error('nothing to evaluate');

    const evaluated = blocks.map((b) => {
      try {
        return { ...b, sig: buildPattern(b.code) };
      } catch (err) {
        throw new Error(`${b.label}: ${err.message ?? err}`);
      }
    });
    // Tempo-only blocks (setbpm) act at eval time and don't become tracks.
    const built = evaluated.filter((b) => b.sig !== TEMPO_BLOCK);

    // Solo wins over everything except mute: if anything is soloed, only soloed patterns play.
    const anySolo = built.some((b) => b.soloed && !b.muted);
    const active = built.filter((b) => !b.muted && (!anySolo || b.soloed));

    // Stop tracks whose label disappeared (or that are now muted / un-soloed).
    for (const [label, sch] of schedulers) {
      if (!active.some((b) => b.label === label)) {
        sch.stop();
        schedulers.delete(label);
        mappedEngine.removeChain(label);
      }
    }

    for (const b of active) {
      // The wrapper needs to know which plugin sits in each slot to pick the right mapping file.
      mappedEngine.setChain(b.label, [b.sig.instrument, ...b.sig.fxChain]);
      let sch = schedulers.get(b.label);
      if (!sch) {
        sch = new patternCore.Scheduler(mappedEngine, { transport, trackId: b.label });
        schedulers.set(b.label, sch);
      }
      sch.setPattern(b.sig);
      sch.start();
    }

    return {
      status: 200,
      body: {
        cps: transport.cps,
        transport: transport.snapshot(),
        tracks: built.map((b) => ({
          label: b.label,
          muted: b.muted,
          soloed: b.soloed,
          active: active.includes(b),
          start: b.start,
          end: b.end,
          instrument: b.sig.instrument,
          fxChain: b.sig.fxChain,
          paramNames: Object.keys(b.sig.paramSignals),
        })),
      },
    };
  },

  'POST /api/stop': async () => {
    for (const sch of schedulers.values()) sch.stop();
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
    for (const [trackId, chain] of mappedEngine.chains) {
      for (let slot = 0; slot < chain.length; slot++) {
        const plugin = chain[slot];
        if (!plugin) continue;
        if (!paramsByPlugin.has(plugin)) {
          try {
            paramsByPlugin.set(plugin, await getParamsWhenLoaded(trackId, slot));
          } catch (err) {
            slots.push({ track: trackId, slot, plugin, params: [], error: err.message ?? String(err) });
            continue;
          }
        }
        slots.push({ track: trackId, slot, plugin, params: paramsByPlugin.get(plugin) });
      }
    }
    return { status: 200, body: { slots } };
  },

  // Capture the full state of the plugin in a chain slot as an opaque string, for the editor's
  // "pin" button to write into the code as synth/fx's `{ state }` argument. Body: { trackId, slot }.
  'POST /api/pluginState': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: { state: await engine.getPluginState(body.trackId ?? 'default', body.slot ?? 0) } };
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

const STATIC_ROOTS = [
  { prefix: '/vendor/codemirror/', root: CODEMIRROR_DIR },
  { prefix: '/pattern-core/', root: PATTERN_CORE_SRC_DIR },
];

function resolveStaticPath(urlPath) {
  const entry = STATIC_ROOTS.find((e) => urlPath.startsWith(e.prefix));
  const root = entry?.root ?? PUBLIC_DIR;
  const rel = entry ? urlPath.slice(entry.prefix.length) : urlPath;
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
