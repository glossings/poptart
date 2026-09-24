// Compiling the ported devices to WebAssembly.
//
// Run by hand, not by the ordinary build, because it needs a toolchain nothing else here needs:
//
//   EMSDK=/path/to/emsdk node build/devices/build-devices.mjs
//   EMSDK=... node build/devices/build-devices.mjs --only Density
//   node build/devices/build-devices.mjs --plan-only        (resolve and read, compile nothing)
//
// What it produces is committed: a `.wasm` per device under public/devices, and a generated
// descriptor module under src/devices. That is the point - a clone, a test run and a deploy all
// need the devices and none of them should need emscripten. The toolchain is a thing one person
// runs when a device is added or an upstream pin moves.
//
// THE PIN IS THE POINT, the same as it is for the sample packs. Every upstream reference is
// resolved to a commit and written to devices.lock.json, and later runs build what is written
// there. A device whose DSP changed underneath a song is a song that no longer sounds the way it
// was written, and nobody would be able to tell what happened.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AIRWINDOWS, descriptorFrom, filesFor, upstreamPath } from './airwindows.mjs';
import { cloudSeedDescriptor } from './cloudseed.mjs';
import { stretchDescriptor } from './stretch.mjs';
import {
  PLAITS_ENGINES, RINGS_MODELS,
  braidsDescriptor, braidsWrapper, cloudsDescriptor, cloudsWrapper,
  elementsDescriptor, elementsWrapper, peaksDescriptor, peaksWrapper,
  plaitsDescriptor, plaitsWrapper,
  ringsDescriptor, ringsWrapper, warpsDescriptor, warpsWrapper,
} from './mutable.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..', '..');
const LOCK_PATH = path.join(here, 'devices.lock.json');
const CACHE = path.join(engineRoot, '.pack-cache', 'devices');
const WASM_OUT = path.join(engineRoot, 'public', 'devices');
const DESCRIPTOR_OUT = path.join(engineRoot, 'src', 'devices', 'airwindows.mjs');
const CLOUDSEED_OUT = path.join(engineRoot, 'src', 'devices', 'cloudseed.mjs');
const STRETCH_OUT = path.join(engineRoot, 'src', 'devices', 'stretch.mjs');
const MUTABLE_OUT = path.join(engineRoot, 'src', 'devices', 'mutable.mjs');
const SHIM = path.join(here, 'shim');

const AIRWINDOWS_REPO = 'airwindows/airwindows';
// Cloud Seed moved: the original repository now holds a readme pointing at the algorithm core,
// which is published on its own and is what this builds.
const CLOUDSEED_REPO = 'GhostNoteAudio/CloudSeedCore';
const STRETCH_REPO = 'Signalsmith-Audio/signalsmith-stretch';
const LINEAR_REPO = 'Signalsmith-Audio/linear';
const EURORACK_REPO = 'pichenettes/eurorack';
const STMLIB_REPO = 'pichenettes/stmlib';

const log = (...a) => console.log(...a);                  // eslint-disable-line no-console

// ---- upstream ---------------------------------------------------------------------------------

const readLock = () => (fs.existsSync(LOCK_PATH) ? JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) : {});
const writeLock = (lock) => fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

async function text(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'poptart-devices' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function headSha(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'poptart-devices' },
  });
  if (!res.ok) throw new Error(`could not resolve ${repo}: ${res.status} ${res.statusText}`);
  return (await res.json()).sha;
}

/**
 * A whole repository at one commit, unpacked once and kept.
 *
 * Some of these are hundreds of files across a dozen folders, and asking for them one at a time
 * is hundreds of requests against a rate limit. The archive endpoint is one request, and naming
 * the commit in the URL is what makes it a pin rather than a download of whatever is current.
 *
 * Git's own metadata files are skipped: this session cannot write them, and nothing here reads
 * them - the submodules they describe are fetched by name instead.
 */
async function repoAt(repo, sha) {
  const root = path.join(CACHE, 'src', `${repo.replace('/', '_')}-${sha.slice(0, 12)}`);
  const stamp = path.join(root, '.unpacked');
  if (fs.existsSync(stamp)) return fs.readFileSync(stamp, 'utf8').trim();

  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(root, 'src.tgz');
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { headers: { 'user-agent': 'poptart-devices' } });
  if (!res.ok) throw new Error(`could not fetch ${repo}@${sha}: ${res.status} ${res.statusText}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['xzf', archive, '-C', root, '--exclude=.gitmodules', '--exclude=.gitignore', '--exclude=.gitattributes']);
  fs.rmSync(archive, { force: true });

  const unpacked = fs.readdirSync(root).find((e) => fs.statSync(path.join(root, e)).isDirectory());
  const full = path.join(root, unpacked);
  fs.writeFileSync(stamp, full, 'utf8');
  return full;
}

/** One upstream file, from the cache if the pin already fetched it and the network if not. */
async function sourceFile(repo, sha, filePath) {
  const cached = path.join(CACHE, repo.replace('/', '_'), sha, filePath);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const body = await text(`https://raw.githubusercontent.com/${repo}/${sha}/${filePath}`);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, body, 'utf8');
  return body;
}

// ---- the wrapper ------------------------------------------------------------------------------

/** The block an AudioWorklet renders. Fixed by the platform, so the buffers can be fixed too. */
const MAX_BLOCK = 128;

const MB = 1024 * 1024;

/**
 * How much memory each device is given, and why that much.
 *
 * This is per INSTANCE and it is committed when the instance is made: the compiled module is
 * shared between every track that uses the device, the memory is not. Growth is off (see
 * `compile`), so a module that runs out does not stall, it traps - and a trapped device is
 * silent until the page is reloaded. That makes the figure worth getting from a measurement
 * rather than from doubling until it stops failing, which is where these started.
 *
 * The right-hand figure is the high-water mark measured by running each module at 44.1k, 48k and
 * 96k with its controls at their defaults, at both ends of their ranges, and swept across them -
 * whichever was worst. Everything here is that, rounded up with room over it, because the mark
 * can only see memory something WROTE to: a buffer that is allocated and left at zero does not
 * show up in it. The headroom is what covers that, so keep it generous when changing these.
 */
const MEMORY = Object.freeze({
  // A reverb whose late section is a dozen delay lines per channel, allocated up front. This one
  // is not padding: it genuinely uses what it asks for, and it is why a page should hold one of
  // these rather than one per track.
  CloudSeed: 80 * MB,   // measured 64.5
  Shift: 8 * MB,        // measured 2.3, and it is the one that grows with the sample rate
  Clouds: 4 * MB,       // measured 0.8
  Elements: 4 * MB,     // measured 1.1
  Rings: 4 * MB,        // measured 0.8
  Plaits: 4 * MB,       // measured 0.6
  Braids: 4 * MB,       // measured 0.6
  Warps: 2 * MB,        // measured 0.1
  Peaks: 2 * MB,        // measured 0.1
  // The Airwindows effects are all `compile`'s default of 2 MB and stay there. Galactic is a
  // reverb and measures 1.6 of it, so this one is not headroom to spend.
});

/** The memory for a device, or the compiler default when it is not listed. */
const memoryFor = (id) => MEMORY[id];

/**
 * The C that gives one plugin poptart's device ABI.
 *
 * Generated rather than written per device because it is the same eleven lines every time, and
 * a hand-written copy per plugin is nine places for one fix to be needed.
 *
 * Parameters arrive through shared memory rather than through a call each: the worklet writes
 * the whole set and calls process once, which is one crossing per block instead of one per
 * control per block.
 */
function wrapperFor(entry) {
  return `// Generated by build/devices/build-devices.mjs - do not edit.
#include "${entry.upstream}.h"

namespace {
${entry.upstream}* g_plugin = nullptr;
float g_in[2 * ${MAX_BLOCK}];
float g_out[2 * ${MAX_BLOCK}];
float g_params[32];
float g_last[32];
bool g_primed = false;
// A control is read once per host block, and a plugin of this family applies it at once. A knob
// somebody is dragging then steps at the block rate, which is a buzz on the sound. So each block
// is rendered in pieces and the controls are ramped from the last block's values to this one's
// across them - a step of a sixteenth of the size, sixteen times as often, which is under the
// threshold of a zipper.
const int kPiece = 8;
}

extern "C" {

void pd_init(double sample_rate) {
  if (!g_plugin) g_plugin = new ${entry.upstream}(nullptr);
  g_plugin->setSampleRate((float)sample_rate);
  g_plugin->setBlockSize(${MAX_BLOCK});
  g_primed = false;
}

int pd_param_count() { return kNumParameters; }
int pd_max_block() { return ${MAX_BLOCK}; }
float* pd_in() { return g_in; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_process(int frames) {
  if (!g_plugin) return;
  if (frames > ${MAX_BLOCK}) frames = ${MAX_BLOCK};
  if (!g_primed) {
    for (int i = 0; i < kNumParameters; i++) g_last[i] = g_params[i];
    g_primed = true;
  }
  bool moving = false;
  for (int i = 0; i < kNumParameters; i++) if (g_params[i] != g_last[i]) moving = true;
  if (!moving) {
    for (int i = 0; i < kNumParameters; i++) g_plugin->setParameter(i, g_params[i]);
    float* ins[2] = { g_in, g_in + ${MAX_BLOCK} };
    float* outs[2] = { g_out, g_out + ${MAX_BLOCK} };
    g_plugin->processReplacing(ins, outs, frames);
    return;
  }
  const int pieces = (frames + kPiece - 1) / kPiece;
  for (int piece = 0; piece < pieces; piece++) {
    const int at = piece * kPiece;
    int n = frames - at;
    if (n > kPiece) n = kPiece;
    const float t = (float)(piece + 1) / (float)pieces;
    for (int i = 0; i < kNumParameters; i++) {
      g_plugin->setParameter(i, g_last[i] + (g_params[i] - g_last[i]) * t);
    }
    float* ins[2] = { g_in + at, g_in + ${MAX_BLOCK} + at };
    float* outs[2] = { g_out + at, g_out + ${MAX_BLOCK} + at };
    g_plugin->processReplacing(ins, outs, n);
  }
  for (int i = 0; i < kNumParameters; i++) g_last[i] = g_params[i];
}

}
`;
}

/** Cloud Seed speaks the same ABI, around a controller rather than a VST class. */
const CLOUDSEED_WRAPPER = `// Generated by build/devices/build-devices.mjs - do not edit.
#include "Programs.h"
#include "DSP/ReverbController.h"

namespace {
Cloudseed::ReverbController* g_reverb = nullptr;
float g_in[2 * ${MAX_BLOCK}];
float g_out[2 * ${MAX_BLOCK}];
float g_params[64];
float g_sent[64];
}

extern "C" {

void pd_init(double sample_rate) {
  Cloudseed::initPrograms();
  if (!g_reverb) g_reverb = new Cloudseed::ReverbController((int)sample_rate);
  g_reverb->SetSamplerate((int)sample_rate);
  // The factory program, so a device built and never touched is the sound upstream ships. The
  // host writes its own values over these on the very next block; this is only the floor.
  for (int i = 0; i < Cloudseed::Parameter::COUNT; i++) {
    g_params[i] = Cloudseed::ProgramDarkPlate[i];
    g_sent[i] = g_params[i];
    g_reverb->SetParameter(i, Cloudseed::ProgramDarkPlate[i]);
  }
  g_reverb->ClearBuffers();
}

int pd_param_count() { return Cloudseed::Parameter::COUNT; }
int pd_max_block() { return ${MAX_BLOCK}; }
float* pd_in() { return g_in; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_process(int frames) {
  if (!g_reverb) return;
  if (frames > ${MAX_BLOCK}) frames = ${MAX_BLOCK};
  // Only a control that moved is set: setting one rebuilds the part of the network it belongs
  // to, which is work every block and a click on the lines it rebuilds.
  for (int i = 0; i < Cloudseed::Parameter::COUNT; i++) {
    if (g_params[i] != g_sent[i]) { g_reverb->SetParameter(i, g_params[i]); g_sent[i] = g_params[i]; }
  }
  g_reverb->Process(g_in, g_in + ${MAX_BLOCK}, g_out, g_out + ${MAX_BLOCK}, frames);
}

}
`;

/** Signalsmith Stretch, driven as a pitch shifter with input and output the same length. */
const STRETCH_WRAPPER = `// Generated by build/devices/build-devices.mjs - do not edit.
#include "signalsmith-stretch.h"

namespace {
signalsmith::stretch::SignalsmithStretch<float>* g_stretch = nullptr;
float g_in[2 * ${MAX_BLOCK}];
float g_out[2 * ${MAX_BLOCK}];
float g_params[8];
}

extern "C" {

void pd_init(double sample_rate) {
  if (!g_stretch) g_stretch = new signalsmith::stretch::SignalsmithStretch<float>();
  g_stretch->presetDefault(2, (float)sample_rate);
  g_stretch->reset();
  g_params[0] = 0.0f;      // pitch, semitones
  g_params[1] = 0.0f;      // formant, semitones
  g_params[2] = 8000.0f;   // tonality limit, Hz
}

int pd_param_count() { return 3; }
int pd_max_block() { return ${MAX_BLOCK}; }
float* pd_in() { return g_in; }
float* pd_out() { return g_out; }
float* pd_params() { return g_params; }

void pd_process(int frames) {
  if (!g_stretch) return;
  if (frames > ${MAX_BLOCK}) frames = ${MAX_BLOCK};
  g_stretch->setTransposeSemitones(g_params[0], g_params[2]);
  g_stretch->setFormantSemitones(g_params[1]);
  float* ins[2] = { g_in, g_in + ${MAX_BLOCK} };
  float* outs[2] = { g_out, g_out + ${MAX_BLOCK} };
  // Same length in and out: this is the pitch half of the library, not the time half.
  g_stretch->process(ins, frames, outs, frames);
}

}
`;

const EXPORTS = ['_pd_init', '_pd_param_count', '_pd_max_block', '_pd_in', '_pd_out', '_pd_params', '_pd_process'];
/** An instrument exports two more: it is played rather than fed. */
const SYNTH_EXPORTS = [...EXPORTS, '_pd_note_on', '_pd_note_off'];

function emccPath() {
  const root = process.env.EMSDK;
  if (!root) throw new Error('set EMSDK to an installed emsdk, e.g. EMSDK=~/emsdk node build/devices/build-devices.mjs');
  // em++ rather than emcc: the C driver does not link the C++ runtime, and every one of these
  // allocates (the plugins keep a std::set of what they can do), so linking with emcc fails on
  // operator new with an error that points at the plugin rather than at the driver.
  const emcc = path.join(root, 'upstream', 'emscripten', 'em++');
  if (!fs.existsSync(emcc)) throw new Error(`no em++ at ${emcc} - is EMSDK pointing at an emsdk that has been installed?`);
  return { emcc, config: path.join(root, '.emscripten') };
}

/** Compiles a set of sources into one freestanding module. */
function compile({ sources, includes = [], defines = [], prelude = [], memory = 2 * 1024 * 1024, exports = EXPORTS, outFile }) {
  const { emcc, config } = emccPath();
  const args = [
    ...sources,
    ...includes.flatMap((dir) => ['-I', dir]),
    ...defines.map((d) => `-D${d}`),
    ...prelude.flatMap((file) => ['-include', file]),
    '-O3',
    '-std=c++17',
    '-ffast-math',
    // Exceptions are ALLOWED but never taken: every one of these plugins ends its parameter
    // switch with a bare `throw` for a case that cannot happen, so the code will not compile
    // without them - and refusing to build over a line that never runs would mean patching
    // upstream source, which is a thing to avoid when the pin is what makes a song reproducible.
    '-fno-rtti',
    // Freestanding: a worklet has no filesystem, no console and no way to answer an import, so
    // the module has to need nothing from its host but memory.
    '-sSTANDALONE_WASM',
    // Fixed, not growing: growth reallocates the whole heap, and an audio thread is the worst
    // place for that. Each device says how much it needs and gets it at instantiation.
    '-sALLOW_MEMORY_GROWTH=0',
    `-sINITIAL_MEMORY=${memory}`,
    '-sTOTAL_STACK=524288',
    `-sEXPORTED_FUNCTIONS=${exports.join(',')}`,
    '--no-entry',
    '-o', outFile,
  ];
  execFileSync(emcc, args, { env: { ...process.env, EM_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---- the generated descriptor module ------------------------------------------------------------

function descriptorModule(descriptors, { title, notes, listName }) {
  const body = descriptors.map((d) => `export const ${d.id.toUpperCase()} = defineDevice(${JSON.stringify(d, null, 2)});`).join('\n\n');
  return `// ${title}
//
// GENERATED by build/devices/build-devices.mjs from the upstream sources pinned in
// devices.lock.json - do not edit.
//
${notes.map((line) => `// ${line}`).join('\n')}

import { defineDevice } from '../descriptor.mjs';

${body}

export const ${listName} = Object.freeze([${descriptors.map((d) => d.id.toUpperCase()).join(', ')}]);
`;
}

// ---- the driver -------------------------------------------------------------------------------

/** Every .cc under a folder, which is how the Mutable modules are laid out. */
function sourcesUnder(dir, skip = []) {
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (skip.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.cc')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * One Mutable module's compile units, plus the stmlib ones every module needs.
 *
 * Most of them keep their DSP in a `dsp` folder beside the firmware. The older ones - Braids and
 * Peaks - put it at the top level next to the main loop, so those name their files instead: the
 * firmware entry point, the display and the hardware drivers are not wanted and would not link.
 */
function mutableSources(euro, stmlib, module, { files = null } = {}) {
  const own = files
    ? files.map((f) => path.join(euro, module, f))
    : [...sourcesUnder(path.join(euro, module, 'dsp')), path.join(euro, module, 'resources.cc')];
  return [
    ...own,
    path.join(stmlib, 'utils', 'random.cc'),
    path.join(stmlib, 'dsp', 'atan.cc'),
    path.join(stmlib, 'dsp', 'units.cc'),
  ];
}

/** One Mutable module whose wrapper and descriptor are already in hand. */
async function buildMutableModule({
  euro, stmlib, planOnly, problems, id, module, descriptor, wrapper,
  exports = EXPORTS, memory = null, files = null, includes = [],
}) {
  log(`${id.padEnd(16)} ${descriptor.params.length} controls`);
  if (planOnly) return descriptor;
  const file = path.join(euro, `poptart-${module}.cc`);
  fs.writeFileSync(file, wrapper, 'utf8');
  const outFile = path.join(WASM_OUT, `${id}.wasm`);
  try {
    compile({
      sources: [file, ...mutableSources(euro, stmlib, module, { files })],
      includes: [...includes, euro, stmlib],
      defines: ['TEST'],
      exports,
      memory: memory ?? memoryFor(id),
      outFile,
    });
    log(`${' '.repeat(16)} -> ${path.relative(engineRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
  } catch (err) {
    problems.push(`${id}: ${(err.stderr?.toString() ?? err.message).split('\n').slice(0, 10).join('\n')}`);
  }
  return descriptor;
}

/** Rings: a resonator, played rather than patched into. */
async function buildRings({ euro, stmlib, planOnly, problems }) {
  const descriptor = ringsDescriptor(`https://github.com/${EURORACK_REPO} (rings)`);
  log(`${'Rings'.padEnd(16)} ${descriptor.params.length} controls, ${RINGS_MODELS.length} models`);
  if (planOnly) return descriptor;

  const wrapper = path.join(euro, 'poptart-rings.cc');
  fs.writeFileSync(wrapper, ringsWrapper(MAX_BLOCK), 'utf8');
  const outFile = path.join(WASM_OUT, 'Rings.wasm');
  try {
    compile({
      sources: [wrapper, ...mutableSources(euro, stmlib, 'rings')],
      includes: [euro, stmlib],
      defines: ['TEST'],
      exports: SYNTH_EXPORTS,
      memory: memoryFor('Rings'),
      outFile,
    });
    log(`${' '.repeat(16)} -> ${path.relative(engineRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
  } catch (err) {
    problems.push(`Rings: ${(err.stderr?.toString() ?? err.message).split('\n').slice(0, 10).join('\n')}`);
  }
  return descriptor;
}

/** Plaits: the module's DSP, its resource tables, and the three stmlib units it needs. */
async function buildPlaits({ lock, planOnly, problems, repin }) {
  for (const [key, repo] of [['eurorack', EURORACK_REPO], ['stmlib', STMLIB_REPO]]) {
    if (repin || !lock[key]) {
      lock[key] = await headSha(repo);
      log(`pinned ${repo} at ${lock[key]}`);
    }
  }
  const euro = await repoAt(EURORACK_REPO, lock.eurorack);
  const stmlib = await repoAt(STMLIB_REPO, lock.stmlib);
  const descriptor = plaitsDescriptor(`https://github.com/${EURORACK_REPO} (plaits)`);
  log(`${'Plaits'.padEnd(16)} ${descriptor.params.length} controls, ${PLAITS_ENGINES.length} engines`);
  if (planOnly) return descriptor;

  // The module's own build lays stmlib beside it as a submodule, and every include says
  // "stmlib/…", so it is linked into place rather than the include path being bent around it.
  // The archive carries an EMPTY folder where the submodule would be - a directory that exists
  // and holds nothing - so the test is for the header rather than for the folder.
  const linked = path.join(euro, 'stmlib');
  if (!fs.existsSync(path.join(linked, 'stmlib.h'))) {
    fs.rmSync(linked, { recursive: true, force: true });
    fs.symlinkSync(stmlib, linked, 'dir');
  }

  const wrapper = path.join(euro, 'poptart-plaits.cc');
  fs.writeFileSync(wrapper, plaitsWrapper(MAX_BLOCK), 'utf8');
  const outFile = path.join(WASM_OUT, 'Plaits.wasm');
  try {
    compile({
      sources: [wrapper, ...mutableSources(euro, stmlib, 'plaits')],
      includes: [euro, stmlib],
      // Upstream's own switch for building off the target chip: stmlib's inner loops are ARM
      // inline assembly, and `TEST` selects the portable C beside them. It is how Mutable build
      // their own unit tests, so it is a supported path rather than a hack.
      defines: ['TEST'],
      exports: SYNTH_EXPORTS,
      // The engines allocate out of one sixteen-kilobyte block, but the resource tables are
      // large and static, so the module needs room beyond its own heap.
      memory: memoryFor('Plaits'),
      outFile,
    });
    log(`${' '.repeat(16)} -> ${path.relative(engineRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
  } catch (err) {
    problems.push(`Plaits: ${(err.stderr?.toString() ?? err.message).split('\n').slice(0, 10).join('\n')}`);
  }
  const rings = await buildRings({ euro, stmlib, planOnly, problems });
  const warps = await buildMutableModule({
    euro, stmlib, planOnly, problems,
    id: 'Warps', module: 'warps', descriptor: warpsDescriptor(`https://github.com/${EURORACK_REPO} (warps)`),
    wrapper: warpsWrapper(MAX_BLOCK), exports: EXPORTS,
  });
  const elements = await buildMutableModule({
    euro, stmlib, planOnly, problems,
    id: 'Elements', module: 'elements', descriptor: elementsDescriptor(`https://github.com/${EURORACK_REPO} (elements)`),
    wrapper: elementsWrapper(MAX_BLOCK), exports: SYNTH_EXPORTS,
  });
  const braids = await buildMutableModule({
    euro, stmlib, planOnly, problems,
    id: 'Braids', module: 'braids', descriptor: braidsDescriptor(`https://github.com/${EURORACK_REPO} (braids)`),
    wrapper: braidsWrapper(MAX_BLOCK), exports: SYNTH_EXPORTS,
    files: ['analog_oscillator.cc', 'digital_oscillator.cc', 'macro_oscillator.cc', 'resources.cc'],
  });
  const peaks = await buildMutableModule({
    euro, stmlib, planOnly, problems,
    id: 'Peaks', module: 'peaks', descriptor: peaksDescriptor(`https://github.com/${EURORACK_REPO} (peaks)`),
    wrapper: peaksWrapper(MAX_BLOCK), exports: SYNTH_EXPORTS,
    files: ['drums/bass_drum.cc', 'drums/snare_drum.cc', 'drums/high_hat.cc', 'drums/fm_drum.cc', 'resources.cc'],
  });
  const clouds = await buildMutableModule({
    euro, stmlib, planOnly, problems,
    id: 'Clouds', module: 'clouds', descriptor: cloudsDescriptor(`https://github.com/${EURORACK_REPO} (clouds)`),
    wrapper: cloudsWrapper(MAX_BLOCK), exports: EXPORTS,
    // The buffers ARE the effect: a hundred and eighty kilobytes of them, plus room to work.
    memory: memoryFor('Clouds'),
    // The shim folder first, so its copy of clouds/dsp/window.h shadows the pinned one: see the
    // note in that file for the upstream regression it puts right.
    includes: [SHIM],
  });
  return [descriptor, rings, elements, braids, peaks, warps, clouds];
}

/** Signalsmith Stretch: header-only, plus the linear-algebra headers it includes. */
async function buildStretch({ lock, planOnly, problems, repin }) {
  for (const [key, repo] of [['stretch', STRETCH_REPO], ['linear', LINEAR_REPO]]) {
    if (repin || !lock[key]) {
      lock[key] = await headSha(repo);
      log(`pinned ${repo} at ${lock[key]}`);
    }
  }
  const stretchRoot = await repoAt(STRETCH_REPO, lock.stretch);
  const linearRoot = await repoAt(LINEAR_REPO, lock.linear);
  const descriptor = stretchDescriptor(`https://github.com/${STRETCH_REPO}`);
  log(`${'Shift'.padEnd(16)} ${descriptor.params.length} controls`);
  if (planOnly) return descriptor;

  const wrapper = path.join(stretchRoot, 'poptart-wrapper.cc');
  fs.writeFileSync(wrapper, STRETCH_WRAPPER, 'utf8');
  const outFile = path.join(WASM_OUT, 'Shift.wasm');
  try {
    compile({
      sources: [wrapper],
      // The stretch header includes "signalsmith-linear/stft.h", which lives in the other
      // repository - published separately rather than vendored, so it is pinned separately too.
      includes: [stretchRoot, path.join(linearRoot, 'include'), linearRoot],
      memory: memoryFor('Shift'),
      outFile,
    });
    log(`${' '.repeat(16)} -> ${path.relative(engineRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
  } catch (err) {
    problems.push(`Shift: ${(err.stderr?.toString() ?? err.message).split('\n').slice(0, 8).join('\n')}`);
  }
  return descriptor;
}

/** Cloud Seed: one module, from the repository the algorithm moved to. */
async function buildCloudSeed({ lock, planOnly, problems, repin }) {
  if (repin || !lock.cloudseed) {
    lock.cloudseed = await headSha(CLOUDSEED_REPO);
    log(`pinned ${CLOUDSEED_REPO} at ${lock.cloudseed}`);
  }
  const root = await repoAt(CLOUDSEED_REPO, lock.cloudseed);
  const programs = fs.readFileSync(path.join(root, 'Programs.h'), 'utf8');
  const descriptor = cloudSeedDescriptor(programs, `https://github.com/${CLOUDSEED_REPO}`);
  log(`${'CloudSeed'.padEnd(16)} ${descriptor.params.length} controls`);
  if (planOnly) return descriptor;

  fs.writeFileSync(path.join(root, 'poptart-wrapper.cc'), CLOUDSEED_WRAPPER, 'utf8');
  const outFile = path.join(WASM_OUT, 'CloudSeed.wasm');
  try {
    compile({
      sources: [
        path.join(root, 'poptart-wrapper.cc'),
        path.join(root, 'Parameters.cpp'),
        path.join(root, 'DSP', 'Biquad.cpp'),
        path.join(root, 'DSP', 'RandomBuffer.cpp'),
      ],
      includes: [root],
      // Upstream takes both of these from the build rather than from a header: BUFFER_SIZE is
      // the largest block it will be handed, and its scratch buffers are that size on the stack.
      defines: [`BUFFER_SIZE=${MAX_BLOCK}`, 'MAX_STR_SIZE=32'],
      prelude: [path.join(SHIM, 'cloudseed-compat.h')],
      // Far more than the effects need, and it is the delay lines: this is a reverb whose late
      // section holds several seconds across a dozen lines per channel, allocated up front from
      // the sample rate. Two megabytes traps on the first init.
      memory: memoryFor('CloudSeed'),
      outFile,
    });
    log(`${' '.repeat(16)} -> ${path.relative(engineRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
  } catch (err) {
    problems.push(`CloudSeed: ${(err.stderr?.toString() ?? err.message).split('\n').slice(0, 8).join('\n')}`);
  }
  return descriptor;
}

export async function build({ only = null, planOnly = false, repin = false } = {}) {
  const lock = readLock();
  if (repin || !lock.airwindows) {
    lock.airwindows = await headSha(AIRWINDOWS_REPO);
    log(`pinned ${AIRWINDOWS_REPO} at ${lock.airwindows}`);
  }
  const sha = lock.airwindows;

  const chosen = AIRWINDOWS.filter((e) => !only || e.id === only);
  const wantCloudSeed = !only || only === 'CloudSeed';
  const wantShift = !only || only === 'Shift';
  const wantPlaits = !only || only === 'Plaits' || only === 'Rings';
  if (chosen.length === 0 && !wantCloudSeed && !wantShift && !wantPlaits) throw new Error(`no device called "${only}"`);

  fs.mkdirSync(WASM_OUT, { recursive: true });
  const descriptors = [];
  const problems = [];

  for (const entry of chosen) {
    const workDir = path.join(CACHE, 'work', entry.id);
    fs.mkdirSync(workDir, { recursive: true });

    const sources = {};
    for (const file of filesFor(entry.upstream)) {
      sources[file] = await sourceFile(AIRWINDOWS_REPO, sha, upstreamPath(entry.upstream, file));
      fs.writeFileSync(path.join(workDir, file), sources[file], 'utf8');
    }

    const descriptor = descriptorFrom(entry, sources[`${entry.upstream}.h`], sources[`${entry.upstream}.cpp`]);
    descriptors.push(descriptor);
    log(`${entry.id.padEnd(16)} ${descriptor.params.length} controls: ${descriptor.params.map((p) => p.name).join(', ')}`);

    if (planOnly) continue;

    fs.writeFileSync(path.join(workDir, 'wrapper.cc'), wrapperFor(entry), 'utf8');
    const outFile = path.join(WASM_OUT, `${entry.id}.wasm`);
    try {
      compile({
        sources: [
          path.join(workDir, 'wrapper.cc'),
          path.join(workDir, `${entry.upstream}.cpp`),
          path.join(workDir, `${entry.upstream}Proc.cpp`),
        ],
        includes: [workDir, SHIM],
        outFile,
      });
      log(`${' '.repeat(16)} -> ${path.relative(engineRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
    } catch (err) {
      const detail = (err.stderr?.toString() ?? err.message).split('\n').slice(0, 6).join('\n');
      problems.push(`${entry.id}: ${detail}`);
    }
  }

  const cloudSeed = wantCloudSeed ? await buildCloudSeed({ lock, planOnly, problems, repin }) : null;
  const shift = wantShift ? await buildStretch({ lock, planOnly, problems, repin }) : null;
  const mutable = wantPlaits ? await buildPlaits({ lock, planOnly, problems, repin }) : [];

  if (!planOnly && problems.length === 0 && !only) {
    fs.writeFileSync(DESCRIPTOR_OUT, descriptorModule(descriptors, {
      title: 'The Airwindows effects, as device descriptors.',
      listName: 'AIRWINDOWS_DEVICES',
      notes: [
        'The names, the defaults and the count are read out of each plugin\'s own source, so what',
        'poptart shows beside a control is what the plugin calls it.',
        '',
        'Every one is MIT, copyright Chris Johnson (airwindows.com), and says so in its descriptor;',
        'the About screen prints those lines from the catalog rather than from a list kept by hand.',
      ],
    }), 'utf8');
    fs.writeFileSync(CLOUDSEED_OUT, descriptorModule([cloudSeed], {
      title: 'Cloud Seed, as a device descriptor.',
      listName: 'CLOUDSEED_DEVICES',
      notes: [
        'The control names are written out in build/devices/cloudseed.mjs and the reason is there',
        'too; the defaults below are upstream\'s own factory program, read from its source.',
        '',
        'MIT, copyright Ghost Note Engineering Ltd.',
      ],
    }), 'utf8');
    fs.writeFileSync(STRETCH_OUT, descriptorModule([shift], {
      title: 'Signalsmith Stretch, as a device descriptor.',
      listName: 'STRETCH_DEVICES',
      notes: [
        'Only the pitch half of the library is exposed; the reason is in build/devices/stretch.mjs.',
        '',
        'MIT, copyright Signalsmith Audio Ltd.',
      ],
    }), 'utf8');
    fs.writeFileSync(MUTABLE_OUT, descriptorModule(mutable, {
      title: 'The Mutable Instruments modules, as device descriptors.',
      listName: 'MUTABLE_DEVICES',
      notes: [
        'Which modules can be ported at all - and which are analog hardware with no DSP to port -',
        'is written down in build/devices/mutable.mjs, along with why.',
        '',
        'MIT, copyright Emilie Gillet, taken from each file\'s own header: the repository itself',
        'declares no license.',
      ],
    }), 'utf8');
    log(`\nwrote the generated descriptors under ${path.relative(engineRoot, path.dirname(DESCRIPTOR_OUT))}`);
  }
  writeLock(lock);

  if (problems.length) {
    log('\nproblems:');
    for (const p of problems) log(`  ${p}`);
    throw new Error(`${problems.length} device(s) did not build`);
  }
  return { descriptors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--only');
  build({
    only: at >= 0 ? argv[at + 1] : null,
    planOnly: argv.includes('--plan-only'),
    repin: argv.includes('--repin'),
  }).catch((err) => {
    console.error(err.message);                           // eslint-disable-line no-console
    process.exit(1);
  });
}
