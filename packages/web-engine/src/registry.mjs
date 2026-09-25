// The device registry - what `synth("Wavetable")` and `fx("Distort")` resolve against.
//
// On desktop the equivalent is the plugin scan: a list of what is installed, keyed by name.
// Here the list is fixed at build time, so the registry's real job is the other thing the scan
// does badly - VERSIONS.
//
// A shipped device's sound is frozen. Somebody's song is a recording of how these devices
// sounded on the day it was written, and a better reverb that quietly replaces the old one
// rewrites their record. So an improvement that changes the sound is registered as a NEW
// version beside the old one, both stay resolvable forever, and:
//
//   - `synth("Wavetable")` in a buffer somebody is typing into means the newest version,
//   - a saved song records `{ id, version }` and gets exactly that version back,
//   - a song naming a version we no longer ship is an error the host reports by name, never a
//     silent substitution.
//
// Retiring a version is therefore a decision with a cost, not a cleanup.

import { defineDevice } from './descriptor.mjs';

const keyOf = (id, version) => `${String(id).trim().toLowerCase()}@${version}`;

export function createRegistry() {
  /** @type {Map<string, object>} every version, keyed id@version */
  const byKey = new Map();
  /** @type {Map<string, number>} newest version per lowercased id */
  const newest = new Map();
  /** @type {Map<string, string>} lowercased id to its canonical capitalization */
  const canonical = new Map();

  /**
   * Registers a descriptor (a plain spec is validated on the way in). Registering the same
   * id@version twice is a programming error, not an update: a device's sound is frozen, so a
   * changed device is a changed version.
   */
  function register(spec) {
    const descriptor = Object.isFrozen(spec) && spec.params ? spec : defineDevice(spec);
    const lower = descriptor.id.toLowerCase();
    const key = keyOf(descriptor.id, descriptor.version);
    if (byKey.has(key)) {
      throw new Error(`[web-engine] device "${descriptor.id}" version ${descriptor.version} is already registered`);
    }
    const known = canonical.get(lower);
    if (known && known !== descriptor.id) {
      throw new Error(`[web-engine] device "${descriptor.id}" collides with "${known}" - ids differ only in case`);
    }
    const prior = byKey.get(keyOf(descriptor.id, descriptor.version - 1));
    if (prior && prior.kind !== descriptor.kind) {
      throw new Error(`[web-engine] device "${descriptor.id}" changed kind between versions - that is a new id`);
    }
    byKey.set(key, descriptor);
    canonical.set(lower, descriptor.id);
    if (!newest.has(lower) || newest.get(lower) < descriptor.version) newest.set(lower, descriptor.version);
    return descriptor;
  }

  /**
   * Resolves an id to a descriptor. Without a version you get the newest, which is what a
   * freshly typed `synth("Wavetable")` means; with one you get exactly that version, which is
   * what a saved song means. Returns null when nothing matches - the caller turns that into the
   * warning userland sees.
   */
  function get(id, version = null) {
    if (id == null) return null;
    const lower = String(id).trim().toLowerCase();
    const want = version == null ? newest.get(lower) : version;
    if (want == null) return null;
    return byKey.get(keyOf(lower, want)) ?? null;
  }

  function has(id, version = null) {
    return get(id, version) !== null;
  }

  /** The newest version of every device, in id order - what a browser or a doc page lists. */
  function list(kind = null) {
    const out = [];
    for (const [lower, version] of newest) {
      const d = byKey.get(keyOf(lower, version));
      if (d && (!kind || d.kind === kind)) out.push(d);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every registered version of one device, oldest first. */
  function versions(id) {
    const lower = String(id ?? '').trim().toLowerCase();
    const top = newest.get(lower);
    if (top == null) return [];
    const out = [];
    for (let v = 1; v <= top; v++) {
      const d = byKey.get(keyOf(lower, v));
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * What the About screen needs: one line per device, every version, with its license and where
   * the DSP came from. AGPL section 13 means the running page has to offer its source, and a
   * catalog assembled out of half a dozen upstream projects has to say whose code each device is.
   */
  function licenses() {
    const out = [];
    for (const d of byKey.values()) {
      out.push({ id: d.id, version: d.version, vendor: d.vendor, license: d.license, source: d.source });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  }

  return { register, get, has, list, versions, licenses, get size() { return byKey.size; } };
}
