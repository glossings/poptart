// The ported devices, compiled for scsynth instead of for the browser.
//
//   SC_SRC=/path/to/supercollider node build/devices/native.mjs
//   node build/devices/native.mjs --only Plaits      (one device, for a quick compile)
//   node build/devices/native.mjs --emit-only        (write the generated C++, compile nothing)
//
// Run by hand, like the WebAssembly build beside it, and for the same reason: the output is
// COMMITTED (packages/osc-engine/native/devices/bin/PoptartDevices.scx), so a clone, a test run
// and a release need the devices and none of them needs a compiler. Everything about which
// sources a device is built from, which upstream switches it needs and which shimmed headers
// shadow which pinned ones is in build-devices.mjs's recipes - this file only says what to do
// with a recipe to get a server plugin rather than a module.
//
// WHY THE SAME DSP TWICE AND NOT TWO PORTS. A song is code, and `synth("Plaits")` has to mean the
// same instrument whichever engine opens it. Two hand-written implementations of a Mutable module
// would drift the first time either was touched, and the drift would show up as a song that
// sounds wrong on the desktop with nothing to point at. One source, two compilers, is the only
// version of this that stays true.
//
// WHAT CHANGES FOR THE NATIVE BUILD, and it is one thing: where a device keeps its state. The
// generated wrapper holds it in file-scope globals, which is exactly right for an
// AudioWorkletProcessor - one module instance per node - and allows one instance per PROCESS,
// which is wrong for a server where every track may want a Plaits. `structify` below lifts that
// state into a struct without touching a line of the DSP around it, and the result is what
// pd-device.h's adapter drives. The WebAssembly build still compiles the wrapper exactly as it
// always did, so the committed .wasm binaries stay reproducible from the same templates.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { deviceRecipes } from './build-devices.mjs';
import { AIRWINDOWS_DEVICES } from '../../src/devices/airwindows.mjs';
import { CLOUDSEED_DEVICES } from '../../src/devices/cloudseed.mjs';
import { STRETCH_DEVICES } from '../../src/devices/stretch.mjs';
import { MUTABLE_DEVICES } from '../../src/devices/mutable.mjs';
import { normalize } from '../../src/descriptor.mjs';
import { FILTER } from '../../src/devices/filter.mjs';
import { EQ } from '../../src/devices/eq.mjs';
import { CRUSH } from '../../src/devices/crush.mjs';
import { OVERDRIVE } from '../../src/devices/overdrive.mjs';
import { COMPRESSOR } from '../../src/devices/compressor.mjs';
import { DISTORT } from '../../src/devices/distort.mjs';
import { LIMITER } from '../../src/devices/limiter.mjs';
import { MULTIBAND } from '../../src/devices/multiband.mjs';
import { REVERB } from '../../src/devices/reverb.mjs';
import { FREQSHIFT } from '../../src/devices/freqshift.mjs';
import { VOICE } from '../../src/devices/voice.mjs';
import { CHORUS } from '../../src/devices/chorus.mjs';
import { FLANGER } from '../../src/devices/flanger.mjs';
import { PHASER } from '../../src/devices/phaser.mjs';
import { DELAY } from '../../src/devices/delay.mjs';
import { GRAINECHO } from '../../src/devices/grainecho.mjs';
import { STUTTER } from '../../src/devices/stutter.mjs';
import { DUCKER } from '../../src/devices/ducker.mjs';
import { FMSYNTH } from '../../src/devices/fmsynth.mjs';
import { WAVETABLE } from '../../src/devices/wavetable.mjs';
import { GRANULAR } from '../../src/devices/granular.mjs';
import { NOISE } from '../../src/devices/noise.mjs';
import { LPG } from '../../src/devices/lpg.mjs';
import { CROSSOVER } from '../../src/devices/crossover.mjs';
import { CONVOLVER } from '../../src/devices/builtins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(engineRoot, '..', '..');
const LOCK_PATH = path.join(here, 'devices.lock.json');
/** Where the UGen, the ABI header and the built bundle live: the desktop engine's own folder. */
const NATIVE_DIR = path.join(repoRoot, 'packages', 'osc-engine', 'native', 'devices');
const WORK = path.join(engineRoot, '.pack-cache', 'devices', 'native');
const OUT_NAME = 'PoptartDevices.scx';

/** The SuperCollider the installed app ships, which is what the plugin must match. */
const SC_VERSION = process.env.SC_VERSION ?? '3.14.1';

/** Both Macs: the committed bundle has to load on an Intel machine as well as this one. */
const ARCHES = (process.env.ARCHES ?? 'arm64,x86_64').split(',').filter(Boolean);

const log = (...a) => console.log(...a);                  // eslint-disable-line no-console

/**
 * Every device that actually ships, by id.
 *
 * The recipes know how to build more than the catalog offers - Warps is compiled by the build and
 * deliberately absent from the device list, because after two rounds of wrapper fixes it still
 * produced noise across most of its range (see src/devices/mutable.mjs). The desktop ships what
 * the browser ships and not one device more: a `synth()` name that works on one engine and not
 * the other is the whole thing this port exists to prevent.
 */
const SHIPPED = new Map(
  [...AIRWINDOWS_DEVICES, ...CLOUDSEED_DEVICES, ...STRETCH_DEVICES, ...MUTABLE_DEVICES]
    .map((d) => [d.id, d]),
);

// ---- poptart's own devices --------------------------------------------------------------------

/**
 * The devices whose DSP poptart wrote, and the C++ that plays them on this engine.
 *
 * These are the one place in the port where there are two implementations of a device rather than
 * one: their DSP was written for an AudioWorklet, in JavaScript, and a server cannot run a
 * worklet. The safeguard is a parity test, not a promise - osc-engine's
 * native-device-parity.test.mjs runs the browser's processor and the compiled one over the same
 * input and compares what comes out, so a change to either side that is not a change to both
 * fails. Nothing else about them differs: the descriptor is the SAME OBJECT the browser's
 * catalog registers, so a control's name, range, curve and default cannot disagree.
 *
 * A device is added here when its C++ lands. Until then it is a browser device, the catalog this
 * build writes does not mention it, and `synth("…")`/`fx("…")` go on treating the name as a
 * plugin's - which is exactly what should happen to a name this engine cannot host.
 */
const OWN = [
  { descriptor: FILTER, source: 'filter.cc' },
  { descriptor: EQ, source: 'eq.cc' },
  { descriptor: CRUSH, source: 'crush.cc' },
  { descriptor: OVERDRIVE, source: 'overdrive.cc' },
  { descriptor: COMPRESSOR, source: 'compressor.cc' },
  { descriptor: DISTORT, source: 'distort.cc' },
  { descriptor: LIMITER, source: 'limiter.cc' },
  { descriptor: MULTIBAND, source: 'multiband.cc' },
  { descriptor: REVERB, source: 'reverb.cc' },
  { descriptor: FREQSHIFT, source: 'freqshift.cc' },
  { descriptor: VOICE, source: 'voice.cc' },
  { descriptor: CHORUS, source: 'chorus.cc' },
  { descriptor: FLANGER, source: 'flanger.cc' },
  { descriptor: PHASER, source: 'phaser.cc' },
  { descriptor: DELAY, source: 'delay.cc' },
  { descriptor: GRAINECHO, source: 'grainecho.cc' },
  { descriptor: STUTTER, source: 'stutter.cc' },
  { descriptor: DUCKER, source: 'ducker.cc' },
  { descriptor: CONVOLVER, source: 'convolver.cc' },
  { descriptor: FMSYNTH, source: 'fm.cc' },
  { descriptor: WAVETABLE, source: 'wavetable.cc' },
  { descriptor: GRANULAR, source: 'granular.cc' },
  { descriptor: NOISE, source: 'noise.cc' },
  { descriptor: LPG, source: 'lpg.cc' },
  // The engine's own, never the user's: built into the extension, listed apart in the catalog (see
  // catalogJson), so no name a pattern writes reaches it.
  { descriptor: CROSSOVER, source: 'crossover.cc', internal: true },
];

/** The ids of the devices the engine builds for itself. */
const INTERNAL_IDS = new Set(OWN.filter((o) => o.internal).map((o) => o.descriptor.id));

/** Every own device, with where its source is. Throws if a listed source is missing. */
export function ownDevices() {
  return OWN.map(({ descriptor, source }) => {
    const file = path.join(NATIVE_DIR, 'own', source);
    if (!fs.existsSync(file)) throw new Error(`${descriptor.id}: ${path.relative(repoRoot, file)} is not there`);
    return { id: descriptor.id, device: descriptor, file };
  });
}

/**
 * The control indexes, as a header the hand-written devices include.
 *
 * A device reads `p[ids::cutoff]`, never `p[1]`, because the index is the descriptor's own order
 * and the descriptor is edited by whoever is adding a control. Generated from that order, so a
 * control inserted in the middle of a list moves every index with it and nothing has to be
 * found by hand. kCount is the count the device reports to the host, for the same reason.
 */
export function ownIdsSource(devices) {
  const ident = (id) => id.replace(/[^A-Za-z0-9_]/g, '_');
  const blocks = devices.map(({ device }) => {
    const rows = device.params.map((p, i) => `  ${ident(p.id)} = ${i},`).join('\n');
    return `namespace ${device.id} {\nenum : int {\n${rows}\n};\nconstexpr int kCount = ${device.params.length};\n}  // namespace ${device.id}`;
  });
  return `// GENERATED by build/devices/native.mjs - do not edit.
//
// Which control is which, for poptart's own devices: the descriptor's parameter order, as names
// the C++ can index with. The name is the control's id with anything C++ cannot spell replaced
// by an underscore, so op1.level is op1_level and mod.2.3 is mod_2_3.

#pragma once

namespace pd_ids {

${blocks.join('\n\n')}

}  // namespace pd_ids
`;
}

// ---- the wrapper, with its state lifted into a struct ----------------------------------------

/**
 * One generated wrapper, as a struct that can be instantiated more than once.
 *
 * The wrappers are all written to one skeleton, because one file generates all of them:
 *
 *   <includes>
 *   namespace {  <state and helpers>  }
 *   extern "C" {  <the ABI>  }
 *
 * and this moves the second and third parts inside a struct, where the state becomes members and
 * the ABI becomes methods. NOT A LINE OF THE DSP MOVES: every `g_params`, `g_fifo` and `g_voice`
 * in the bodies resolves to the member of the same name, which is the point of keeping the
 * names. What does change is spelled out below, and the build fails loudly if a wrapper ever
 * stops matching the skeleton rather than quietly compiling something else.
 */
export function structify(wrapper, { id }) {
  const NS = 'namespace {\n';
  const EXTERN = 'extern "C" {\n';
  const nsAt = wrapper.indexOf(NS);
  const externAt = wrapper.indexOf(EXTERN);
  if (nsAt < 0 || externAt < 0 || externAt < nsAt) {
    throw new Error(`${id}: the wrapper is not shaped the way the native build expects `
      + '(includes, then `namespace {`, then `extern "C" {`) - see structify in build/devices/native.mjs');
  }
  if (/\bnew\s+\w[\w:<>]*\s*\[/.test(wrapper)) {
    throw new Error(`${id}: the wrapper allocates an array, which the generated destructor would `
      + 'free with the wrong delete - give it a destructor by hand');
  }

  const head = wrapper.slice(0, nsAt);
  // The namespace's own closing brace, which is the last line of that section.
  const state = wrapper
    .slice(nsAt + NS.length, externAt)
    .replace(/\n\}[ \t]*(\/\/[^\n]*)?\s*$/, '\n')
    // An array member's size has to be a constant expression, and a `const int` at struct scope
    // is not one - it would be a member of its own, sized by itself.
    .replace(/^const (int|float|double|size_t) k/gm, 'static constexpr $1 k');
  const body = wrapper
    .slice(externAt + EXTERN.length)
    .replace(/\}\s*$/, '')
    // `static` at file scope means internal linkage; at struct scope it means one copy for every
    // instance, which is the opposite of what this build is for.
    .replace(/^static /gm, '');

  // What the wrapper owns. Each is allocated once in pd_init, behind an `if (!p)` guard, and
  // never anywhere else - so a destructor that deletes each one is both necessary (eight tracks
  // opening and closing devices would otherwise leak a reverb at a time) and sufficient.
  const owned = [...state.matchAll(/^[A-Za-z_][\w:<>, ]*\*\s*(g_\w+)\s*=\s*nullptr\s*;/gm)].map((m) => m[1]);
  const unowned = [...state.matchAll(/^[A-Za-z_][\w:<>, ]*\*\s*(g_\w+)\s*;/gm)].map((m) => m[1]);
  if (unowned.length) {
    throw new Error(`${id}: pointer state ${unowned.join(', ')} is not initialised to nullptr, `
      + 'so the native build cannot tell whether the wrapper owns it');
  }

  const ns = `pd_${id}`;
  const destructor = owned.length
    ? `
  // What pd_init allocated. A device instance is created and destroyed as a slot is filled and
  // emptied, which on a desktop engine happens all evening.
  ~Device() {
${owned.map((name) => `    delete ${name};`).join('\n')}
  }
`
    : '';

  return `${head}#include "pd-device.h"

// GENERATED by build/devices/native.mjs from the wrapper build/devices/build-devices.mjs writes
// for the browser - the same DSP, with its state lifted into a struct so a server can hold more
// than one. Do not edit; edit the wrapper.
namespace ${ns} {

struct Device {
${state}${destructor}${body}};

}  // namespace ${ns}

extern "C" PdAny* pd_make_${id}() { return new PdAdapter<${ns}::Device>(); }
`;
}

// ---- the registry ----------------------------------------------------------------------------

/** C's spelling of a float that has to parse back to the same number. */
const cFloat = (v) => {
  if (!Number.isFinite(v)) return '0.f';
  const s = Number(v).toPrecision(9).replace(/0+$/, '').replace(/\.$/, '.0');
  return `${s}f`;
};

const cString = (s) => JSON.stringify(String(s));

const CURVES = { lin: 0, exp: 1, pow: 2 };

/**
 * One device's control table: the descriptor, as data the audio thread can read.
 *
 * Positions come in and real values go out, through pd_denormalize - so min, max, the curve and
 * the step are the whole of what the DSP needs to know about a control, and the default comes
 * along as the POSITION it sits at, which is where a control rests until a pattern moves it.
 */
function paramTable(device) {
  const rows = device.params.map((p) => {
    const curve = CURVES[p.curve] ?? 0;
    return `    { ${cString(p.id)}, ${cString(p.name)}, ${cFloat(p.min)}, ${cFloat(p.max)}, `
      + `${cFloat(normalize(p, p.default))}, ${cFloat(p.step ?? 0)}, ${cFloat(p.curveExp ?? 1)}, ${curve}, ${p.open ? 1 : 0} },`;
    // (min, max, the default as a POSITION, the step, the pow exponent, the curve, whether it is open)
  });
  return `static const PdParamSpec k${device.id}Params[] = {\n${rows.join('\n')}\n};`;
}

/** The table the UGen looks a device up in. */
export function registrySource(devices) {
  const tables = devices.map((d) => paramTable(d)).join('\n\n');
  const externs = devices.map((d) => `extern "C" PdAny* pd_make_${d.id}();`).join('\n');
  const rows = devices.map((d) => `    { ${cString(d.id)}, ${d.kind === 'synth' ? 1 : 0}, `
    + `${d.kind === 'synth' || d.notes ? 1 : 0}, `
    + `${d.sidechain ? 1 : 0}, ${d.build === 'wasm' ? 0 : 1}, ${d.params.length}, k${d.id}Params, &pd_make_${d.id} },`).join('\n');
  return `// GENERATED by build/devices/native.mjs - do not edit.
//
// Every ported device this extension was built with, and what each one's controls mean. Read off
// the same descriptors the browser's panel and autocomplete are generated from, so a control's
// name, its range and its curve are one answer on both engines.

#include "pd-device.h"

${externs}

namespace {

${tables}

const PdDeviceInfo kDevices[] = {
${rows}
};

} // namespace

extern "C" const PdDeviceInfo* pd_device_table() { return kDevices; }
extern "C" int pd_device_count() { return ${devices.length}; }
`;
}

// ---- compiling -------------------------------------------------------------------------------

/** The SuperCollider plugin headers, fetched once into the native folder's own .deps. */
async function scHeaders() {
  if (process.env.SC_SRC) return process.env.SC_SRC;
  const deps = path.join(NATIVE_DIR, '.deps');
  const root = path.join(deps, `supercollider-Version-${SC_VERSION}`);
  if (fs.existsSync(path.join(root, 'include', 'plugin_interface'))) return root;
  // The sibling extension keeps its own copy; use it rather than fetching a second one.
  const sibling = path.join(repoRoot, 'packages', 'osc-engine', 'native', 'rubberband', '.deps',
    `supercollider-Version-${SC_VERSION}`);
  if (fs.existsSync(path.join(sibling, 'include', 'plugin_interface'))) return sibling;

  log(`fetching SuperCollider ${SC_VERSION} headers`);
  fs.mkdirSync(deps, { recursive: true });
  const url = `https://github.com/supercollider/supercollider/archive/refs/tags/Version-${SC_VERSION}.tar.gz`;
  const res = await fetch(url, { headers: { 'user-agent': 'poptart-devices' } });
  if (!res.ok) throw new Error(`could not fetch the SC headers: ${res.status} ${res.statusText}`);
  const archive = path.join(deps, 'sc.tgz');
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['xzf', archive, '-C', deps, '--include=*/include/*']);
  fs.rmSync(archive, { force: true });
  return root;
}

/** Compiler flags every translation unit here is built with, whatever device it belongs to. */
function baseFlags({ sc, arch }) {
  return [
    '-c', '-O3', '-std=c++17', '-ffast-math', '-fno-rtti',
    '-fPIC', '-arch', arch, '-mmacosx-version-min=11', '-DSC_DARWIN',
    '-I', path.join(sc, 'include', 'plugin_interface'),
    '-I', path.join(sc, 'include', 'common'),
    '-I', path.join(sc, 'include', 'server'),
    '-I', NATIVE_DIR,
  ];
}

/**
 * Compiles one translation unit, skipping the work when the object is already newer than its
 * source and was built with the same flags.
 *
 * The Mutable modules are thirty files each and there are five of them, twice over for the two
 * architectures; a rebuild after one edit to one wrapper should not be four minutes.
 */
function compileOne({ source, objDir, flags, stamps, headersMs = 0 }) {
  const key = path.resolve(source);
  const obj = path.join(objDir, `${path.basename(source).replace(/\W/g, '_')}-${hash(key + flags.join(' '))}.o`);
  const stampKey = `${obj}`;
  if (stamps.has(stampKey)) return obj;
  stamps.add(stampKey);
  const newest = Math.max(fs.statSync(source).mtimeMs, headersMs);
  if (fs.existsSync(obj) && fs.statSync(obj).mtimeMs > newest) return obj;
  execFileSync('clang++', [...flags, source, '-o', obj], { stdio: ['ignore', 'pipe', 'pipe'] });
  return obj;
}

/**
 * When the hand-written headers last changed: the ABI (pd-device.h) and what poptart's own
 * devices are built on (own/pd-own.h, own/dsp/*.h).
 *
 * compileOne goes by each source's own time, and a header is nobody's source - so without this a
 * change to a struct the UGen and the registry share (PdDeviceInfo, say) rebuilt the files that
 * changed and linked them against objects that still had the old layout, which loads and then
 * crashes the server on the first device opened.
 */
function headersChangedMs() {
  const dsp = path.join(NATIVE_DIR, 'own', 'dsp');
  const files = [
    path.join(NATIVE_DIR, 'pd-device.h'),
    path.join(NATIVE_DIR, 'own', 'pd-own.h'),
    ...(fs.existsSync(dsp) ? fs.readdirSync(dsp).filter((f) => f.endsWith('.h')).map((f) => path.join(dsp, f)) : []),
  ];
  return Math.max(0, ...files.filter((f) => fs.existsSync(f)).map((f) => fs.statSync(f).mtimeMs));
}

/** A short, stable name for a set of flags. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * The catalog, as the desktop engine's Node half reads it.
 *
 * A trimmed descriptor: what a name resolves to, and what a control is called and means. Not the
 * descriptions or the figures - those are the browser panel's business, and the device window on
 * the desktop is drawn from the same shared descriptor the web build serves. Sorted by name so a
 * rebuild that changed nothing produces no diff.
 */
export function catalogJson(devices, internal = INTERNAL_IDS) {
  const entry = (d) => ({
    id: d.id,
    name: d.name ?? d.id,
    kind: d.kind,
    version: d.version ?? 1,
    sidechain: !!d.sidechain,
    // How late the device is, which the scheduler plays its track's notes early by.
    ...(d.latencySec ? { latencySec: d.latencySec } : {}),
    params: d.params.map((p) => ({
      id: p.id,
      name: p.name,
      min: p.min,
      max: p.max,
      default: p.default,
      step: p.step ?? 0,
      curve: p.curve,
      curveExp: p.curveExp ?? 1,
      unit: p.unit ?? '',
      ui: p.ui,
      group: p.group ?? '',
      rate: p.rate,
      // Which stage of the instrument's amp envelope this is, for .attack() and the rest.
      ...(p.amp ? { amp: p.amp } : {}),
      ...(p.options ? { options: [...p.options] } : {}),
      // What a control takes that is not a number: a FILE (a granulator's sample, a convolver's
      // impulse response) or a drawn CURVE. The engine reads this to know that `.param("sample",
      // "break:2")` names a file to load rather than an option to look up, into the next free
      // slot past the control's own options (see the sample path in osc-engine's index.js, which
      // fills those slots the way the browser's engine does).
      ...(p.takes ? { takes: p.takes } : {}),
      // A control with no top (descriptor.mjs's open controls), and the range an open count had
      // before it was one, which an old 0..1 position on it still means.
      ...(p.open ? { open: true } : {}),
      ...(p.legacyMax != null ? { legacyMax: p.legacyMax } : {}),
      ...(p.sampleAs ? { sampleAs: p.sampleAs } : {}),
      // Controls sharing one store of files, which hand out its slots between them.
      ...(p.bank ? { bank: p.bank } : {}),
    })),
  });
  const sorted = [...devices].sort((a, b) => a.id.localeCompare(b.id));
  // `devices` is every name a pattern can write; `internal` the ones the engine builds for itself
  // (a .bands() crossover), which no device list, completion or `fx()` may reach.
  return `${JSON.stringify({
    generatedBy: 'packages/web-engine/build/devices/native.mjs',
    devices: sorted.filter((d) => !internal.has(d.id)).map(entry),
    internal: sorted.filter((d) => internal.has(d.id)).map(entry),
  }, null, 2)}\n`;
}

export async function buildNative({ only = null, emitOnly = false, repin = false } = {}) {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const all = await deviceRecipes({ lock, only, repin });
  const recipes = all.filter((r) => SHIPPED.has(r.id));
  const skipped = all.filter((r) => !SHIPPED.has(r.id)).map((r) => r.id);
  if (skipped.length) log(`not in the catalog, so not built: ${skipped.join(', ')}`);
  if (recipes.length === 0) throw new Error('no devices to build');

  fs.mkdirSync(WORK, { recursive: true });
  const genDir = path.join(WORK, 'gen');
  fs.mkdirSync(genDir, { recursive: true });

  // The generated C++: a struct per device, and the table the UGen looks them up in.
  const generated = [];
  for (const one of recipes) {
    const device = SHIPPED.get(one.id);
    const file = path.join(one.workDir, `poptart-${one.id}.native.cc`);
    fs.writeFileSync(file, structify(one.wrapper, { id: one.id }), 'utf8');
    generated.push({ recipe: one, device, file });
    log(`${one.id.padEnd(16)} ${device.params.length} controls, ${device.kind}`);
  }
  // poptart's own devices: hand-written C++ beside the UGen, listed in OWN above. Nothing is
  // generated for them but the control indexes they index their parameter block with.
  const own = ownDevices().filter((o) => !only || o.id.toLowerCase() === String(only).toLowerCase());
  const idsHeader = path.join(genDir, 'pd-own-ids.h');
  fs.writeFileSync(idsHeader, ownIdsSource(own), 'utf8');
  for (const one of own) log(`${one.id.padEnd(16)} ${one.device.params.length} controls, ${one.device.kind}, poptart's own`);

  const everything = [...generated.map((g) => g.device), ...own.map((o) => o.device)];
  const registry = path.join(genDir, 'pd-registry.cc');
  fs.writeFileSync(registry, registrySource(everything), 'utf8');
  // The same list as data, for the engine's Node half: it is what decides that `synth("Plaits")`
  // is one of poptart's own devices rather than a plugin name to look up in the scan, and what
  // it sends sclang so a control resolves by name. Written only by a whole build - a catalog
  // naming one device because the build was narrowed to one would take the rest off the desktop.
  if (!only) {
    fs.writeFileSync(path.join(NATIVE_DIR, 'devices.json'), catalogJson(everything), 'utf8');
  }
  if (emitOnly) {
    log(`\nwrote the generated C++ under ${genDir} and beside each device's sources`);
    return { generated: generated.map((g) => g.file), registry, idsHeader, own: own.map((o) => o.file) };
  }

  const sc = await scHeaders();
  const thin = [];
  for (const arch of ARCHES) {
    const objDir = path.join(WORK, 'obj', arch);
    fs.mkdirSync(objDir, { recursive: true });
    const base = baseFlags({ sc, arch });
    const stamps = new Set();
    const objects = [];
    const compiledFrom = new Map();

    for (const { recipe, file } of generated) {
      const flags = [
        ...base,
        ...recipe.includes.flatMap((dir) => ['-I', dir]),
        ...recipe.defines.map((d) => `-D${d}`),
        ...recipe.prelude.flatMap((f) => ['-include', f]),
      ];
      for (const source of [file, ...recipe.sources]) {
        // stmlib's three units belong to every Mutable module and are one object for all of
        // them: compiled per module they would be five definitions of the same symbols.
        const already = compiledFrom.get(path.resolve(source));
        if (already) {
          if (already.device !== recipe.id && already.flags !== flags.join(' ')) {
            log(`  note: ${path.basename(source)} is shared with ${already.device} and is built `
              + 'once, with that device\'s flags');
          }
          continue;
        }
        compiledFrom.set(path.resolve(source), { device: recipe.id, flags: flags.join(' ') });
        objects.push(compileOne({ source, objDir, flags, stamps }));
      }
    }

    // The UGen, the parts of the ABI that are not generated, and poptart's own devices - all
    // built with the same flags, since none of them wants anything upstream.
    const ownFlags = [...base, '-I', genDir];
    const headersMs = headersChangedMs();
    for (const source of [path.join(NATIVE_DIR, 'PoptartDevice.cpp'), path.join(NATIVE_DIR, 'PoptartSpectrum.cpp'), path.join(NATIVE_DIR, 'pd-device.cc'), registry]) {
      objects.push(compileOne({ source, objDir, flags: ownFlags, stamps, headersMs }));
    }
    for (const one of own) {
      objects.push(compileOne({ source: one.file, objDir, flags: ownFlags, stamps, headersMs }));
    }

    const out = path.join(WORK, `${arch}.scx`);
    log(`linking ${objects.length} objects for ${arch}`);
    execFileSync('clang++', [
      '-bundle', '-undefined', 'dynamic_lookup',
      '-arch', arch, '-mmacosx-version-min=11',
      ...objects, '-o', out,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    thin.push(out);
  }

  const binDir = path.join(NATIVE_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const outFile = path.join(binDir, OUT_NAME);
  if (thin.length === 1) fs.copyFileSync(thin[0], outFile);
  else execFileSync('lipo', ['-create', ...thin, '-output', outFile]);
  log(`\nbuilt ${path.relative(repoRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
  log(execFileSync('lipo', ['-info', outFile]).toString().trim());
  return { outFile, devices: everything.map((d) => d.id) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--only');
  buildNative({
    only: at >= 0 ? argv[at + 1] : null,
    emitOnly: argv.includes('--emit-only'),
    repin: argv.includes('--repin'),
  }).catch((err) => {
    console.error(err.stderr?.toString() || err.message);  // eslint-disable-line no-console
    process.exit(1);
  });
}
