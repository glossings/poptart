// Builds the PoptartKeylock scsynth extension: the DJ keylock in a UGen.
//
//   node native/keylock/build.mjs                 (from packages/osc-engine)
//   node native/keylock/build.mjs --out <dir>     (build somewhere other than bin/)
//
// On macOS the output is a universal (arm64 + x86_64) bundle in bin/, and it is COMMITTED: this is
// for changing PoptartKeylock.cpp or the stretcher it wraps (native/devices/own/dsp/keylock.h),
// not for installing poptart - requiring a C++ toolchain on every machine that runs poptart would
// undo the "clone and npm install" story. On Windows and Linux it builds that platform's plugin
// into bin/<platform>-<arch>/, which CI does on its runners (tests.yml, release.yml); nothing
// commits those. How a plugin is compiled and linked per platform is in web-engine's
// build/devices/toolchain.mjs, shared with the devices, and the DSP flags are the devices' own,
// which are the ones native-device-parity.test.mjs compiles the stretcher with.
//
// The SuperCollider plugin headers are fetched on first run (into .deps/, which is gitignored),
// at the version the app downloads (SC_VERSION below). Point SC_SRC at a checkout to skip that.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DSP_FLAGS, binSubdir, extractTarGz, linkFlags, pluginSuffix, runCompiler, targetFlags,
} from '../../../web-engine/build/devices/toolchain.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const deps = path.join(dir, '.deps');
const devices = path.join(dir, '..', 'devices');
const SC_VERSION = process.env.SC_VERSION ?? '3.14.1';

const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function scHeaders() {
  if (process.env.SC_SRC) return process.env.SC_SRC;
  const sc = path.join(deps, `supercollider-Version-${SC_VERSION}`);
  if (fs.existsSync(path.join(sc, 'include', 'plugin_interface'))) return sc;
  // The devices extension keeps its own copy; use it rather than fetching a second one.
  const sibling = path.join(devices, '.deps', `supercollider-Version-${SC_VERSION}`);
  if (fs.existsSync(path.join(sibling, 'include', 'plugin_interface'))) return sibling;
  log(`fetching SuperCollider ${SC_VERSION} headers`);
  fs.mkdirSync(deps, { recursive: true });
  const url = `https://github.com/supercollider/supercollider/archive/refs/tags/Version-${SC_VERSION}.tar.gz`;
  const res = await fetch(url, { headers: { 'user-agent': 'poptart-keylock' } });
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status} ${res.statusText}`);
  const archive = path.join(deps, 'download.tgz');
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  try {
    extractTarGz(archive, deps, { include: '*/include/*' });
  } finally {
    fs.rmSync(archive, { force: true });
  }
  return sc;
}

export async function buildKeylock({ outDir = null } = {}) {
  const sc = await scHeaders();
  const binDir = outDir ? path.resolve(outDir) : path.join(dir, 'bin', binSubdir());
  fs.mkdirSync(binDir, { recursive: true });
  const out = path.join(binDir, `PoptartKeylock${pluginSuffix()}`);
  const includes = [
    '-I', path.join(sc, 'include', 'plugin_interface'),
    '-I', path.join(sc, 'include', 'common'),
    '-I', path.join(sc, 'include', 'server'),
    '-I', devices,
  ];
  const unit = path.join(dir, 'PoptartKeylock.cpp');

  if (process.platform === 'darwin') {
    log(`building ${out} (arm64 + x86_64) against SC ${SC_VERSION}`);
    runCompiler([
      ...DSP_FLAGS, ...targetFlags(), '-arch', 'arm64', '-arch', 'x86_64', '-DNDEBUG',
      ...includes, unit, ...linkFlags({ out }),
    ]);
    log(execFileSync('lipo', ['-info', out]).toString().trim());
    return out;
  }

  log(`building ${out} (${process.arch}) against SC ${SC_VERSION}`);
  const work = path.join(deps, `obj-${process.platform}-${process.arch}`);
  fs.mkdirSync(work, { recursive: true });
  const obj = path.join(work, 'PoptartKeylock.o');
  runCompiler(['-c', ...DSP_FLAGS, ...targetFlags(), '-DNDEBUG', ...includes, unit, '-o', obj]);
  runCompiler([obj, ...linkFlags({ out })], { responseFile: path.join(work, 'link.rsp') });
  log(`built ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} kB)`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  buildKeylock({ outDir: at >= 0 ? argv[at + 1] : null }).catch((err) => {
    console.error(err.stderr?.toString() || err.message); // eslint-disable-line no-console
    process.exit(1);
  });
}
