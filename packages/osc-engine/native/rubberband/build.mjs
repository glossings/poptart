// Builds the PoptartPitchShift scsynth extension: the DJ keylock, Rubber Band's Live Shifter in a
// UGen.
//
//   node native/rubberband/build.mjs                 (from packages/osc-engine)
//   node native/rubberband/build.mjs --out <dir>     (build somewhere other than bin/)
//
// On macOS the output is a universal (arm64 + x86_64) bundle in bin/, and it is COMMITTED: this is
// for changing PoptartPitchShift.cpp or bumping Rubber Band, not for installing poptart - requiring
// a C++ toolchain on every machine that runs poptart would undo the "clone and npm install" story.
// On Windows and Linux it builds that platform's plugin into bin/<platform>-<arch>/, which CI does
// on its runners (tests.yml, release.yml); nothing commits those. How a plugin is compiled and
// linked per platform is in web-engine's build/devices/toolchain.mjs, shared with the devices.
//
// Sources it needs and fetches on first run (into .deps/, which is gitignored):
//   - the SuperCollider plugin headers, at the version the app downloads (SC_VERSION below)
//   - the Rubber Band Library source (GPL - see THIRD-PARTY-NOTICES.md), built from its
//     single-file amalgamation. That file picks the FFT itself: vDSP on Apple (so the Mac build
//     links the Accelerate framework), Rubber Band's built-in FFT everywhere else.
// Point SC_SRC / RB_SRC at existing checkouts to skip the downloads.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  binSubdir, compiler, extractTarGz, linkFlags, pluginSuffix, runCompiler, targetFlags,
} from '../../../web-engine/build/devices/toolchain.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const deps = path.join(dir, '.deps');
const SC_VERSION = process.env.SC_VERSION ?? '3.14.1';
const RB_VERSION = process.env.RB_VERSION ?? '4.0.0';

const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function fetchInto(url, include = null) {
  const res = await fetch(url, { headers: { 'user-agent': 'poptart-rubberband' } });
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status} ${res.statusText}`);
  const archive = path.join(deps, 'download.tgz');
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  try {
    extractTarGz(archive, deps, { include });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function sources() {
  fs.mkdirSync(deps, { recursive: true });
  let sc = process.env.SC_SRC;
  if (!sc) {
    sc = path.join(deps, `supercollider-Version-${SC_VERSION}`);
    if (!fs.existsSync(path.join(sc, 'include', 'plugin_interface'))) {
      log(`fetching SuperCollider ${SC_VERSION} headers`);
      await fetchInto(`https://github.com/supercollider/supercollider/archive/refs/tags/Version-${SC_VERSION}.tar.gz`, '*/include/*');
    }
  }
  let rb = process.env.RB_SRC;
  if (!rb) {
    rb = path.join(deps, `rubberband-${RB_VERSION}`);
    if (!fs.existsSync(path.join(rb, 'single', 'RubberBandSingle.cpp'))) {
      log(`fetching Rubber Band ${RB_VERSION}`);
      await fetchInto(`https://github.com/breakfastquay/rubberband/archive/refs/tags/v${RB_VERSION}.tar.gz`);
    }
  }
  return { sc, rb };
}

export async function buildPitchShift({ outDir = null } = {}) {
  const { sc, rb } = await sources();
  const binDir = outDir ? path.resolve(outDir) : path.join(dir, 'bin', binSubdir());
  fs.mkdirSync(binDir, { recursive: true });
  const out = path.join(binDir, `PoptartPitchShift${pluginSuffix()}`);
  const includes = [
    '-I', path.join(sc, 'include', 'plugin_interface'),
    '-I', path.join(sc, 'include', 'common'),
    '-I', path.join(sc, 'include', 'server'),
    '-I', rb,
  ];
  const units = [path.join(dir, 'PoptartPitchShift.cpp'), path.join(rb, 'single', 'RubberBandSingle.cpp')];

  if (process.platform === 'darwin') {
    // One invocation for both architectures, exactly as build.sh always built it.
    log(`building ${out} (arm64 + x86_64) against SC ${SC_VERSION} / Rubber Band ${RB_VERSION}`);
    execFileSync(compiler(), [
      '-O3', '-std=c++17', '-fPIC',
      '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11',
      '-DSC_DARWIN', '-DNDEBUG',
      ...includes,
      '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'Accelerate',
      '-o', out, ...units,
    ], { stdio: 'inherit' });
    log(execFileSync('lipo', ['-info', out]).toString().trim());
    return out;
  }

  // Rubber Band is built as it ships: -O3, RTTI on, no -ffast-math (build.sh never used it).
  log(`building ${out} (${process.arch}) against SC ${SC_VERSION} / Rubber Band ${RB_VERSION}`);
  const work = path.join(deps, `obj-${process.platform}-${process.arch}`);
  fs.mkdirSync(work, { recursive: true });
  const objects = units.map((unit) => {
    const obj = path.join(work, `${path.basename(unit, '.cpp')}.o`);
    runCompiler(['-c', '-O3', '-std=c++17', ...targetFlags({ rtti: true }), '-DNDEBUG', ...includes, unit, '-o', obj]);
    return obj;
  });
  runCompiler([...objects, ...linkFlags({ out })], { responseFile: path.join(work, 'link.rsp') });
  log(`built ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} kB)`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  buildPitchShift({ outDir: at >= 0 ? argv[at + 1] : null }).catch((err) => {
    console.error(err.stderr?.toString() || err.message); // eslint-disable-line no-console
    process.exit(1);
  });
}
