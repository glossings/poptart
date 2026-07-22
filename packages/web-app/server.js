'use strict';

// Plain Node HTTP server replacing the old Electron shell (app/main.js) - serves the browser UI
// from public/ and exposes the same operations the old IPC handlers did, now as HTTP endpoints.
// All request/reply here (no push updates needed yet), so plain HTTP is enough - no WebSocket
// dependency required for what this currently does.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
    // Live CC events (forwarded from sclang once MIDI is enabled) feed pattern-core's
    // live-value store - what a Tier-1 midicc() signal samples.
    engine.onMidiIn = (device, channel, cc, value) => patternCore.feedMidiCC(device, channel, cc, value);
    // Live note edges from midikeys() routes - what an armed MIDI recording collects.
    engine.onMidiNoteIn = (trackId, note, vel, isOn) => handleMidiNoteIn(trackId, note, vel, isOn);
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
    'gain', 'pan', 'vel', 'as',
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

const BUILDER_NAMES = ['n', 'note', 'mini', 's', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'lfo', 'env', 'midicc', 'midikeys'];

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

// One block of editor code (see labels.mjs) -> its value, evaluated with the builders in
// scope. Evaluated via direct eval rather than wrapping the code in `return (...)` so a block
// may contain *statements*, not just one expression. eval's completion value (the last
// statement's value) is the block's result, so plain single-expression blocks behave exactly
// as before.
//
// The `label: pattern` paradigm is only for code that emits audio - a block may instead just
// declare things (`const kb = midikeys("Twister")` on an unlabeled line) and its top-level
// bindings stay visible to every block below it in the buffer. That sharing needs two tricks,
// because const/let declared inside a direct eval are scoped to that eval alone: top-level
// declarations are rewritten to `var` (which hoists into the wrapper function, where the
// harvest object literal can read it), and the harvested values are re-injected as extra
// parameters into each later block's wrapper. The typeof guard covers names the line-anchored
// regex picks up inside nested callbacks, which stay scoped there and never reach the wrapper.
function makeBlockEvaluator() {
  const defs = new Map(); // name -> value, accumulated down the buffer
  return function evalBlock(code) {
    const declNames = [
      ...new Set([...code.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])),
    ];
    const body = code.replace(/^([ \t]*)(?:const|let)(\s+)/gm, '$1var$2');
    const baseNames = [...BUILDER_NAMES, 'setbpm'].filter((n) => !defs.has(n)); // defs may shadow builders
    const baseValues = baseNames.map((n) => (n === 'setbpm' ? setbpm : patternCore[n]));
    const harvest = declNames
      .map((n) => `${JSON.stringify(n)}: (typeof ${n} === 'undefined' ? undefined : ${n})`)
      .join(', ');
    // eslint-disable-next-line no-new-func
    const build = new Function(
      ...baseNames,
      ...defs.keys(),
      '__blockCode',
      `var __value = eval(__blockCode); return { __value: __value, __defs: { ${harvest} } };`,
    );
    const { __value, __defs } = build(...baseValues, ...defs.values(), body);
    for (const [n, v] of Object.entries(__defs)) if (v !== undefined) defs.set(n, v);
    return __value;
  };
}

// Patterns evaluate lazily, so a bad value ("badnote" where a note name should be, a throwing
// signal) can first surface mid-playback rather than at eval. Force the first few cycles (and
// one continuous sample) here so those errors come back as an eval error the editor shows,
// instead of hitting the scheduler's timer. A few cycles because alternations (`<a b c>`) only
// visit each branch every N cycles - this catches the common cases, and the scheduler's own
// try/catch stops just the offending track for anything pathological beyond that.
const DRY_RUN_CYCLES = 8;

function dryRunPattern(sig) {
  const cps = transport?.cps ?? DEFAULT_CPS;
  const sigs = [
    sig,
    ...Object.values(sig.paramSignals),
    ...Object.values(sig.channel),
    ...(sig.velSig ? [sig.velSig] : []),
    ...Object.values(sig.sampler ?? {}).filter((v) => v instanceof patternCore.Sig),
  ];
  for (const s of sigs) {
    if (s.stepsForCycle) {
      for (let cycle = 0; cycle < DRY_RUN_CYCLES; cycle++) s.stepsForCycle(cycle);
    }
    s.sample(0, cps, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Pattern files - the editor's "files" tab saves/loads whole editor buffers as plain .js files
// under ~/.poptart/patterns (overridable via POPTART_PATTERNS_DIR), so they're ordinary files
// the user can also back up / edit / version outside poptart.
// ---------------------------------------------------------------------------------------------

const PATTERNS_DIR = process.env.POPTART_PATTERNS_DIR || path.join(os.homedir(), '.poptart', 'patterns');

// Names are used as filenames directly, so keep them to a single path segment.
function patternFilePath(name) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 128 || clean.startsWith('.') || /[/\\]/.test(clean)) {
    throw new Error('pattern name must be a plain file name (no slashes, not starting with ".")');
  }
  return path.join(PATTERNS_DIR, `${clean}.js`);
}

// ---------------------------------------------------------------------------------------------
// MIDI record - capture a midikeys() performance as mini-notation. sclang forwards every note
// edge of an active midikeys() route as /poptart/midiNoteIn (see poptart.scd's midiRoute
// handlers); arming a recording collects those between two cycle boundaries. Recording starts
// at the next 4-cycle phrase boundary - the wait until then is the count-in - and runs for
// `cycles` cycles. The editor polls /api/midiRecord/status and, on 'done', writes each track's
// pattern into the code in place of its kb()/midikeys() call (see client.js applyRecording).
// ---------------------------------------------------------------------------------------------

const PHRASE_CYCLES = 4;

let midiRec = null; // { phase: 'armed'|'recording'|'done', startCycle, endCycle, cycles, grid, held, events, results, timer }

function midiRecStatus() {
  if (!midiRec) return { phase: 'idle' };
  const { phase, startCycle, endCycle, cycles, grid, results } = midiRec;
  return { phase, startCycle, endCycle, cycles, grid, results, transport: transport.snapshot() };
}

function pushRecEvent(trackId, ev) {
  let list = midiRec.events.get(trackId);
  if (!list) midiRec.events.set(trackId, (list = []));
  list.push(ev);
}

// One live note edge. Held notes wait per track+note (a stack, so fast retriggers of the same
// key pair up correctly) until their note-off completes the event.
function handleMidiNoteIn(trackId, note, vel, isOn) {
  if (!midiRec || midiRec.phase === 'done') return;
  const rel = transport.cycleAt(engine.getTime()) - midiRec.startCycle;
  if (isOn && vel > 0) {
    // Slightly-early onsets (played into the count-in's last moment, meant for beat 1) snap to
    // the window start; anything earlier is count-in noodling and stays unrecorded.
    const preRoll = 0.5 / (midiRec.grid > 0 ? midiRec.grid : patternCore.UNQUANTIZED_GRID);
    if (rel < -preRoll || rel >= midiRec.cycles) return;
    let held = midiRec.held.get(trackId);
    if (!held) midiRec.held.set(trackId, (held = new Map()));
    let stack = held.get(note);
    if (!stack) held.set(note, (stack = []));
    stack.push({ note, vel, start: Math.max(0, rel) });
  } else {
    const ev = midiRec.held.get(trackId)?.get(note)?.pop();
    if (!ev) return; // off for a note that started before the window (or after it closed)
    pushRecEvent(trackId, { ...ev, end: Math.min(midiRec.cycles, Math.max(ev.start + 1e-3, rel)) });
  }
}

function midiRecTick() {
  if (!midiRec || midiRec.phase === 'done') return;
  const pos = transport.cycleAt(engine.getTime());
  if (midiRec.phase === 'armed' && pos >= midiRec.startCycle) midiRec.phase = 'recording';
  // Small overshoot so a note-off landing right on the end boundary completes its event first.
  if (pos >= midiRec.endCycle + 0.02) finalizeMidiRec();
}

function finalizeMidiRec() {
  clearInterval(midiRec.timer);
  midiRec.timer = null;
  // Keys still held when the window closes become events that ring to the end.
  for (const [trackId, held] of midiRec.held) {
    for (const stack of held.values()) {
      for (const ev of stack) pushRecEvent(trackId, { ...ev, end: midiRec.cycles });
    }
  }
  midiRec.held.clear();
  const results = [];
  for (const [label, events] of midiRec.events) {
    if (events.length === 0) continue;
    try {
      const { pattern, count } = patternCore.recordingToMini(events, {
        cycles: midiRec.cycles,
        grid: midiRec.grid,
        startCycle: midiRec.startCycle,
      });
      results.push({ label, pattern, count });
    } catch (err) {
      results.push({ label, error: err.message ?? String(err) });
    }
  }
  midiRec.results = results;
  midiRec.phase = 'done';
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

  'GET /api/midiDevices': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getMidiDevices() };
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

    const evalBlock = makeBlockEvaluator();
    const evaluated = blocks.map((b) => {
      try {
        const value = evalBlock(b.code);
        if (value instanceof patternCore.Sig) {
          dryRunPattern(value);
        } else if (value === undefined && b.label.startsWith('$')) {
          // Definitions-only block (const kb = midikeys("...")): binds names for the blocks
          // below, makes no sound, needs no label.
        } else if (value !== TEMPO_BLOCK) {
          throw new Error('must evaluate to a pattern (e.g. n("0 2 3").scale("F minor").synth("Serum 2"))');
        }
        return { ...b, sig: value };
      } catch (err) {
        throw new Error(`${b.label}: ${err.message ?? err}`);
      }
    });
    // Tempo-only and definitions-only blocks act at eval time and don't become tracks.
    const built = evaluated.filter((b) => b.sig instanceof patternCore.Sig);

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

    // Any midicc()/midikeys() seen at eval time needs MIDI input running engine-side. The
    // native paths (setParamCC/setMidiNotes) enable it themselves; this covers Tier-1-only
    // use (a cc signal inside arithmetic), whose JS-side sampling needs the /poptart/midiIn
    // feed. Idempotent, so re-sending every eval is fine.
    if (patternCore.midiInUse()) engine.enableMidi();

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

  // --- pattern files (the editor's "files" tab) ---

  'GET /api/patterns': async () => {
    let names = [];
    try {
      names = fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith('.js'));
    } catch {
      // directory doesn't exist yet - nothing saved
    }
    const patterns = names
      .map((f) => ({ name: f.slice(0, -3), mtime: fs.statSync(path.join(PATTERNS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return { status: 200, body: { patterns } };
  },

  // Body: { name, code }. Overwrites silently - "save" in a livecoding tool means "keep this".
  'POST /api/patterns/save': async (body) => {
    const file = patternFilePath(body.name);
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.writeFileSync(file, String(body.code ?? ''), 'utf8');
    return { status: 200, body: {} };
  },

  // Body: { name } -> { code }.
  'POST /api/patterns/load': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    return { status: 200, body: { code: fs.readFileSync(file, 'utf8') } };
  },

  // Body: { name }.
  'POST /api/patterns/delete': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    fs.unlinkSync(file);
    return { status: 200, body: {} };
  },

  // Body: { from, to }.
  'POST /api/patterns/rename': async (body) => {
    const from = patternFilePath(body.from);
    const to = patternFilePath(body.to);
    if (!fs.existsSync(from)) throw new Error(`no saved pattern named "${body.from}"`);
    if (fs.existsSync(to)) throw new Error(`a pattern named "${body.to}" already exists`);
    fs.renameSync(from, to);
    return { status: 200, body: {} };
  },

  // --- MIDI record (see the "MIDI record" section above) ---

  // Arm a recording. Body: { cycles, grid } - grid is slots per cycle (16 = sixteenth notes at
  // 4 beats/cycle), 0 = unquantized. Starts at the next 4-cycle phrase boundary; the response
  // carries start/end cycles + a transport snapshot so the editor renders the count-in locally.
  'POST /api/midiRecord/start': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    if (midiRec && midiRec.phase !== 'done') throw new Error('a MIDI recording is already armed or running - cancel it first');
    const cycles = Math.min(64, Math.max(1, Math.round(Number(body.cycles) || 4)));
    const grid = Math.max(0, Math.round(body.grid == null ? 16 : Number(body.grid) || 0));
    const startCycle = (Math.floor(transport.cycleAt(engine.getTime()) / PHRASE_CYCLES) + 1) * PHRASE_CYCLES;
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = {
      phase: 'armed',
      startCycle,
      endCycle: startCycle + cycles,
      cycles,
      grid,
      held: new Map(),
      events: new Map(),
      results: null,
      timer: setInterval(midiRecTick, 50),
    };
    return { status: 200, body: midiRecStatus() };
  },

  'GET /api/midiRecord/status': async () => ({ status: 200, body: midiRecStatus() }),

  // Abort an armed/running recording, or acknowledge a finished one (clears its results).
  'POST /api/midiRecord/cancel': async () => {
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = null;
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
