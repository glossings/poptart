// The catalog: every device poptart ships in the browser, in one registry.
//
// This is the list `synth("…")` and `fx("…")` resolve against, and the list the About screen
// credits. It is assembled at module load rather than discovered, because a static site has
// nothing to scan and because what is in the build is a decision somebody made, not a fact
// about the machine it is running on.
//
// Adding a device means registering it here. Changing one that is already shipped means
// registering a NEW VERSION beside the old one - see registry.mjs for why, but briefly: a saved
// song is a recording of how these sounded on the day it was written.

import { createRegistry } from './registry.mjs';
import { WAVETABLE } from './devices/wavetable.mjs';
import { FMSYNTH } from './devices/fmsynth.mjs';
import { GRANULAR } from './devices/granular.mjs';
import { DISTORT } from './devices/distort.mjs';
import { CRUSH } from './devices/crush.mjs';
import { OVERDRIVE } from './devices/overdrive.mjs';
import { REVERB } from './devices/reverb.mjs';
import { FILTER } from './devices/filter.mjs';
import { EQ } from './devices/eq.mjs';
import { DELAY } from './devices/delay.mjs';
import { GRAINECHO } from './devices/grainecho.mjs';
import { CHORUS } from './devices/chorus.mjs';
import { FLANGER } from './devices/flanger.mjs';
import { PHASER } from './devices/phaser.mjs';
import { COMPRESSOR } from './devices/compressor.mjs';
import { MULTIBAND } from './devices/multiband.mjs';
import { LIMITER } from './devices/limiter.mjs';
import { DUCKER } from './devices/ducker.mjs';
import { STUTTER } from './devices/stutter.mjs';
import { NODE_DEVICES } from './devices/builtins.mjs';
import { AIRWINDOWS_DEVICES } from './devices/airwindows.mjs';
import { CLOUDSEED_DEVICES } from './devices/cloudseed.mjs';
import { STRETCH_DEVICES } from './devices/stretch.mjs';
import { MUTABLE_DEVICES } from './devices/mutable.mjs';

/** Every device, newest version of each. Ordered as the browser lists them. */
export const DEVICES = Object.freeze([
  WAVETABLE, FMSYNTH, GRANULAR,
  FILTER, EQ, DISTORT, CRUSH, OVERDRIVE, COMPRESSOR, MULTIBAND, LIMITER, DUCKER,
  DELAY, GRAINECHO, STUTTER, CHORUS, FLANGER, PHASER, REVERB, ...NODE_DEVICES,
  ...AIRWINDOWS_DEVICES, ...CLOUDSEED_DEVICES, ...STRETCH_DEVICES, ...MUTABLE_DEVICES,
]);

/**
 * The devices whose DSP is a compiled binary, and the file each one's binary is.
 *
 * Named here so a page knows what to fetch without instantiating anything: the binaries are
 * loaded and compiled before any device is built, for the same reason the worklets are - a node
 * for a processor that has not been registered throws, and a processor handed no module can only
 * be silent.
 */
export const WASM_DEVICES = Object.freeze(
  DEVICES.filter((d) => d.build === 'wasm').map((d) => Object.freeze({ id: d.id, file: `${d.id}.wasm` })),
);

/**
 * Builds a registry holding the whole catalog. A function rather than a shared singleton so a
 * test can build its own, and so a later build with a different device list is a different call
 * rather than a mutation of global state.
 */
export function buildCatalog(devices = DEVICES) {
  const registry = createRegistry();
  for (const d of devices) registry.register(d);
  return registry;
}

/** The catalog this build ships. */
export const catalog = buildCatalog();

/**
 * The credits the running page has to be able to show. AGPL section 13 means a page that serves
 * this has to offer its source, and a catalog assembled out of several upstream projects has to
 * say whose code each device is - so this is generated from the descriptors rather than kept as
 * a hand-written list that would drift.
 */
export function licenseReport(registry = catalog) {
  const rows = registry.licenses();
  const lines = ['# Devices', ''];
  for (const row of rows) {
    const who = row.vendor === 'poptart' ? 'poptart' : row.vendor;
    const source = row.source ? ` - ${row.source}` : '';
    lines.push(`- ${row.id} v${row.version}: ${row.license}, ${who}${source}`);
  }
  return lines.join('\n');
}
