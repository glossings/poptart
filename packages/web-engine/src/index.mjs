// The public surface of the browser engine.
//
// Two halves, and they are independent on purpose. The CATALOG is a list of devices and what
// each one's controls are - it needs no audio context, no browser and no worklet, which is what
// lets the editor's autocomplete, the params panel and the documentation be built from the same
// descriptors the audio thread uses. The ENGINE is the Web Audio implementation of the interface
// pattern-core's Scheduler drives, and it is the only part that needs a browser.
//
// Everything a host needs is re-exported here so that nothing outside this package has to know
// which file a thing happens to live in.

// `WASM_DEVICES` is used by `loadDeviceBinaries` below. A re-export forwards a name without
// binding it in this module, so the list has to be imported as well as exported.
import { WASM_DEVICES } from './catalog.mjs';

export {
  argToValue,
  clampParam,
  defaultValues,
  decimalsFor,
  defineDevice,
  denormalize,
  findParam,
  formatValue,
  isToggle,
  normalize,
  paramGroups,
  positionsOf,
  signalDestinations,
  valueToArg,
} from './descriptor.mjs';

export { createRegistry } from './registry.mjs';
export { DEVICES, buildCatalog, catalog, licenseReport } from './catalog.mjs';
export { WASM_DEVICES };
export { AIRWINDOWS_DEVICES } from './devices/airwindows.mjs';

export { buildPanel, paramArgFor, paramCallFor, valueFromPosition, widgetFor } from './panel.mjs';
export { RESPONSE_RANGE, buildFigures, figuresFor, subsumedParams } from './figures.mjs';

export { WAVETABLE, WavetableSynth, MAX_VOICES, TABLE_NAMES, TABLE_SLOTS, tableFromSample } from './devices/wavetable.mjs';
export { FMSYNTH, FmSynth } from './devices/fmsynth.mjs';
export { GRANULAR, GranularSynth } from './devices/granular.mjs';
export { sharedBuiltInTables, buildMipmaps } from './dsp/tables.mjs';
export { DISTORT, DistortProcessor } from './devices/distort.mjs';
export { REVERB, ReverbProcessor } from './devices/reverb.mjs';
export { IR_NAMES, NODE_DEVICES, buildNodeDevice, synthesizeImpulse } from './devices/builtins.mjs';
export { decodeWav, framesOf } from './dsp/wavfile.mjs';
export { SYNC_OPTIONS } from './dsp/sync.mjs';
export { BIQUAD_TYPES } from './dsp/biquad.mjs';
export { parseSampleRef } from './engine/web-audio-engine.mjs';

export { WARP_MODES, WARP_INDEX, PHASE_WARPS, CROSS_MODES, crossModOf, warpPhase, warpSlope } from './dsp/warp.mjs';
export { FILTER_MODES } from './dsp/filters.mjs';
export { SHAPER_MODES, SHAPER_INDEX } from './dsp/shapers.mjs';
export { FRAME_LENGTH, BASIC_FRAME_NAMES, buildTable, builtInTables } from './dsp/tables.mjs';

export { WebAudioEngine } from './engine/web-audio-engine.mjs';
export { detectOnsets, monoOf } from './engine/sample-plan.mjs';
export { MIX_BAND_COUNT, MIX_BAND_FREQS, MIX_BAND_VALUES, MIX_TRACK_MAX } from './engine/analysis.mjs';
export { SUPPORTED_CHANNELS } from './engine/track.mjs';
export { renderShape, renderRange } from './engine/modulators.mjs';

export {
  ALLOWED_LICENSES,
  PACK_PREFIX,
  builtInLibrary,
  packCredits,
  packDefinition,
  validateManifest,
} from './packs/manifest.mjs';

export {
  DEFAULT_PACK_BASE,
  INDEX_FORMAT,
  buildIndex,
  creditLine,
  fileUrl,
  isSafeRelativePath,
  validateIndex,
} from './packs/library.mjs';

export {
  copyleftRisk,
  creditsMarkdown,
  plannedDeviceCount,
  unverified,
  validateSources,
} from './packs/sources.mjs';

/**
 * Where this package's static files are served from, relative to the page.
 *
 * The worklets and the shipped packs are ordinary files the host mounts somewhere; naming the
 * layout here rather than in the host keeps the two from drifting apart when a folder moves.
 */
export const PUBLIC_PATHS = Object.freeze({
  worklets: 'worklets',
  packs: 'packs',
  builtInPacks: 'packs/built-in.js',
  devices: 'devices',
});

/**
 * The worklet files a page has to load before any of poptart's own devices can be built.
 *
 * `AudioWorklet.addModule()` returns a promise per file and they can all be in flight at once;
 * nothing here depends on anything else here.
 */
export const WORKLET_FILES = Object.freeze([
  'poptart-synths.js',
  'poptart-effects.js',
  'poptart-wasm.js',
]);

/**
 * Loads every worklet into a context. Call it once, before building any device - an
 * AudioWorkletNode for a processor that has not been registered throws, and the error it throws
 * names the processor rather than the missing file, which is a confusing place to start.
 */
export async function loadWorklets(ctx, base = PUBLIC_PATHS.worklets) {
  await Promise.all(WORKLET_FILES.map((file) => ctx.audioWorklet.addModule(`${base}/${file}`)));
}

/**
 * Compiles the binaries behind the ported devices, as `deviceId -> WebAssembly.Module`.
 *
 * Compiled once here and handed to the engine, because building a device is synchronous and
 * compiling is not. A binary that will not load costs that one device and is reported: the rest
 * of the catalog is unaffected and the page still starts, which is the same rule a sample pack
 * that will not download follows.
 */
export async function loadDeviceBinaries(base = PUBLIC_PATHS.devices, fetchImpl = fetch) {
  const modules = new Map();
  const problems = [];
  await Promise.all(WASM_DEVICES.map(async ({ id, file }) => {
    try {
      const res = await fetchImpl(`${base}/${file}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      modules.set(id, await WebAssembly.compile(await res.arrayBuffer()));
    } catch (err) {
      problems.push(`${id} did not load - ${err.message}`);
    }
  }));
  return { modules, problems };
}
