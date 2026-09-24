// Starting poptart in a page.
//
// Everything the desktop does in a Node process before the editor connects - loading the pattern
// language, bringing up the engine, opening the store, reading the prebake - happens here
// instead, and the editor waits for it through one promise. The editor's own `api()` is the only
// thing that knows this file exists: it awaits `window.__poptartHostReady` and then calls the
// host directly in place of a request.
//
// TWO THINGS THE BROWSER IMPOSES, and both shape what follows.
//
// An AudioContext may not make a sound until somebody has interacted with the page. So the
// context is built suspended, the first real gesture resumes it, and until then the editor is
// fully usable and simply silent. Starting playback IS a gesture, so in practice nobody meets
// this; what it prevents is a page that looks broken because it was opened in a background tab.
//
// And the audio worklets have to be loaded before any device is built - an AudioWorkletNode for
// a processor that has not been registered throws, and the error names the processor rather than
// the file that failed to load, which is a confusing place to start looking.

import { memoryStore, openStore } from './kv.mjs';
import { createBlobs } from './blobs.mjs';
import { createStorage } from './storage.mjs';
import { createEvaluator } from './evaluate.mjs';
import { createSampleStore, registerPacks } from './samples.mjs';
import { createHost } from './host.mjs';
import { createAudioOutputs } from './audio-output.mjs';
import { createWebMidi } from './midi.mjs';
import { createAudioInputs } from './audio-input.mjs';
import { createPrebake } from './prebake.mjs';
import { createBlockEvaluator } from './block-eval.mjs';

/** Where the pieces are served from. One place, so moving a folder is one edit. */
export const PATHS = Object.freeze({
  patternCore: '/pattern-core/index.mjs',
  engine: '/web-engine/src/index.mjs',
  worklets: '/web-engine/worklets',
  builtInPacks: '/web-engine/packs',
  devices: '/web-engine/devices',
});

/** The packs that ship with the page, so a fresh load is playable with no network at all. */
const BUILT_IN_PACKS = Object.freeze(['pt_kit', 'pt_keys']);

const say = (line) => console.log(`[poptart] ${line}`);          // eslint-disable-line no-console
const warn = (line) => console.warn(`[poptart] ${line}`);        // eslint-disable-line no-console

/**
 * Resumes the audio context the first time somebody touches the page.
 *
 * Registered on several events because browsers disagree about which ones count, and removed
 * once it has worked so the page is not carrying listeners for the rest of the session.
 */
function resumeOnGesture(context) {
  if (context.state !== 'suspended') return;
  const events = ['pointerdown', 'keydown', 'touchstart'];
  const wake = () => {
    context.resume().then(() => {
      for (const e of events) window.removeEventListener(e, wake);
    }).catch(() => {});
  };
  for (const e of events) window.addEventListener(e, wake, { passive: true });
}

/** The manifests of the packs committed alongside the app. */
export async function readBuiltInPacks(fetchImpl) {
  const out = [];
  for (const id of BUILT_IN_PACKS) {
    try {
      const res = await fetchImpl(`${PATHS.builtInPacks}/${id}/manifest.json`);
      if (res.ok) out.push(await res.json());
    } catch (err) {
      warn(`the built-in pack ${id} did not load - ${err.message}`);
    }
  }
  return out;
}

/**
 * The sourced packs, from the index published beside them.
 *
 * A failure here is not a failure to start: the index lives on a CDN and the app has to work
 * when that is unreachable, behind a filter, or simply slow. What is lost is the packs somebody
 * has not downloaded yet, and the built-in ones still play.
 */
export async function readLibrary(fetchImpl, base, validateIndex) {
  if (!base) return { packs: [], problems: [] };
  try {
    const res = await fetchImpl(`${base}/index.json`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const { packs, problems } = validateIndex(await res.json());
    for (const p of problems) warn(p);
    return { packs, problems };
  } catch (err) {
    warn(`the sample library is not reachable, so only the built-in packs are here - ${err.message}`);
    return { packs: [], problems: [`the library did not load: ${err.message}`] };
  }
}

/**
 * Brings up everything and returns the host the editor talks to.
 *
 * Called once. The promise it returns is what `api()` awaits, so a request made before this has
 * finished simply waits rather than racing it.
 */
export async function boot({
  AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  fetchImpl = fetch.bind(globalThis),
  packBase = null,
} = {}) {
  const patternCore = await import(PATHS.patternCore);
  const webEngine = await import(PATHS.engine);

  const context = new AudioContextCtor({ latencyHint: 'interactive' });
  resumeOnGesture(context);

  // The worklets have to be registered before any device is built, and the ported devices need
  // their compiled DSP in hand for the same reason: building one is synchronous, so anything it
  // needs has to have arrived. Both are fetched at once; neither depends on the other.
  const [, binaries] = await Promise.all([
    webEngine.loadWorklets(context, PATHS.worklets),
    webEngine.loadDeviceBinaries(PATHS.devices, fetchImpl),
  ]);
  for (const line of binaries.problems) warn(line);

  // Storage first, so that a store which refuses to open is one line in the console rather than
  // a page that appears to work and silently keeps nothing.
  const opened = await openStore();
  if (opened.kind !== 'durable') {
    warn(`nothing will be saved in this window - ${opened.reason ?? 'the browser would not open a store'}`);
  } else if (!opened.persisted) {
    say('saving locally; the browser may clear this site\'s data if it runs short of room');
  }
  const store = opened.store ?? memoryStore();
  const blobs = createBlobs(store);
  const storage = createStorage(store, { meta: globalThis, blobs });

  const samples = createSampleStore({ context, store, warn });
  const engine = new webEngine.WebAudioEngine(context, {
    registry: webEngine.catalog,
    samples,
    warn,
    deviceModules: binaries.modules,
    // How a control that takes a drawn curve reads one: the language's own parser and sampler,
    // so the shape editor and the synth agree about what a curve is.
    shapes: {
      looksLikeShapeData: patternCore.looksLikeShapeData,
      parseShapePoints: patternCore.parseShapePoints,
      sampleShape: patternCore.sampleShape,
    },
  });
  const transport = new patternCore.Transport(() => engine.getTime(), { cps: 0.5, paused: true });

  // The prebake is somebody's own setup file, and it runs before any pattern so its bindings are
  // in scope for every one of them.
  const prebakeDefs = new Map();
  const evaluator = createEvaluator({ patternCore, engine, transport, prebakeDefs, log: say });

  const builtIn = await readBuiltInPacks(fetchImpl);
  const builtInUrl = (id, file) => `${PATHS.builtInPacks}/${id}/${file}`;
  registerPacks(patternCore, builtIn);
  for (const manifest of builtIn) {
    await samples.ensure(manifest, builtInUrl);
  }
  // The files added from this browser before - one-offs and a wavetable folder - so a pattern
  // that names one plays again without being pointed at it a second time.
  const added = await samples.loadFiles();
  registerPacks(patternCore, added.filter((m) => m.files.length));
  engine.setTempo(transport.cps * 240, transport.secAt(0));

  // The sourced packs are registered, not loaded: the first pattern to name one starts it.
  const base = packBase ?? webEngine.DEFAULT_PACK_BASE;
  const library = await readLibrary(fetchImpl, base, webEngine.validateIndex);
  registerPacks(patternCore, library.packs);
  library.urlFor = (id, file) => webEngine.fileUrl(base, id, file);
  samples.register(library.packs, library.urlFor);

  // The output device chosen last time, if it is still plugged in. Not awaited past a moment:
  // a device that takes its time to answer should not hold up the editor.
  const outputs = createAudioOutputs({ context });
  const restored = await Promise.race([outputs.restore(), new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (restored) say(`playing to ${restored}`);

  // MIDI from the controllers on this machine. Asked for only when something wants it (see
  // midi.mjs); every message goes to the engine, which plays the tracks listening to that device,
  // and a controller also to the language's own store, which a midicc() read in a pattern samples.
  const midi = createWebMidi({
    transport,
    context,
    warn,
    onMessage: (device, msg) => {
      engine.midiIn(device, msg.kind, msg.channel, msg.num, msg.value);
      if (msg.kind === 'cc') patternCore.feedMidiCC(device, msg.channel, msg.num, msg.value);
    },
  });
  // Clock out chosen on an earlier visit: the permission was given then, so this does not prompt.
  if (midi.available && midi.clockWanted) midi.enable().catch((err) => warn(err.message));

  // The output channel count chosen on an earlier visit, where the device still has them.
  try {
    const saved = Number(globalThis.localStorage?.getItem('poptart.outputChannels'));
    if (saved > 2) engine.setOutputChannels(saved);
  } catch { /* storage off */ }

  // Audio in: the inputs picked in settings, or the default one the first time input() is read.
  // The engine takes its channels off one node; the language is told the channel layout, which
  // is what input("Scarlett", 1) is resolved against.
  const inputs = createAudioInputs({
    context,
    onChange: (node, channels, layout) => {
      engine.setHardwareInput(node, channels);
      patternCore.setAudioInputLayout(layout);
    },
  });
  engine.onAudioInputWanted = () => { inputs.want()?.catch?.(() => {}); };
  inputs.restore().then((layout) => { if (layout?.length) say(`audio in: ${layout.map((d) => d.name).join(' + ')}`); });

  // The ★ library and the prebake, run before any pattern so every buffer starts from them. The
  // pinned file's format belongs to the desktop's pinned-defs.js, loaded here as it is there.
  let prebake = null;
  try {
    await import('./pinned-defs.js');
    prebake = createPrebake({
      patternCore, storage, prebakeDefs, createBlockEvaluator,
      pinnedDefs: globalThis.poptartPinnedDefs,
      dehydrate: (code) => storage.dehydrateOnLoad(code),
      log: say,
    });
    for (const line of await prebake.run()) warn(`prebake ${line}`);
  } catch (err) {
    warn(`the prebake did not run - ${err?.message ?? err}`);
  }

  const host = createHost({
    patternCore, engine, transport, evaluator, storage, samples, outputs, midi, inputs,
    slicing: { detectOnsets: webEngine.detectOnsets, monoOf: webEngine.monoOf },
    prebake,
    catalog: webEngine.catalog,
    // What the generated device window is built and edited through. Handed in rather than
    // imported so the host stays a plain route table with no idea where a device comes from.
    panel: {
      buildPanel: webEngine.buildPanel,
      valueFromPosition: webEngine.valueFromPosition,
      paramArgFor: webEngine.paramArgFor,
      formatValue: webEngine.formatValue,
      clampParam: webEngine.clampParam,
      normalize: webEngine.normalize,
      findParam: webEngine.findParam,
      // The pictures. `figuresFor` is the one a drag uses: it recomputes only the figures the
      // parameter that moved appears in, so turning a cutoff does not rebuild a wavetable stack.
      figuresFor: webEngine.figuresFor,
    },
    // Memoized in web-engine, so this hands the same frames the synth is reading rather than a
    // second copy of them, and builds them on the first device window rather than at boot.
    tables: webEngine.sharedBuiltInTables,
    // How a file becomes frames, for the wavetable browser's preview: the same two functions
    // the engine cuts a loaded table with, so what is drawn is what would be played.
    wavetables: { decodeWav: webEngine.decodeWav, framesOf: webEngine.framesOf },
    builtIn,
    builtInUrl,
    library,
  });

  say(`ready - ${webEngine.catalog.list().length} devices, ${builtIn.length + library.packs.length} packs`);
  return {
    ...host,
    context,
    engine,
    transport,
    storage,
    samples,
    patternCore,
    webEngine,
    storeKind: opened.kind,
  };
}
