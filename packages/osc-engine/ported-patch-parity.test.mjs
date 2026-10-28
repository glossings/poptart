// Audio patched onto a control of a PORTED module (one per family: Plaits for the Mutable ones,
// Galactic for Airwindows, CloudSeed, Shift), through the parity harness.
//
// A ported module reads its controls once per call; the patch layer every wrapper is built with
// (build-devices.mjs's withPatchLayer) renders a call a sample at a time while a control of it is
// moving, each sample at its own value. What that has to equal is the module driven one sample
// per call with the control set before each (the harness's `-1`, which is what the desktop's host
// used to do for every device); what it must NOT equal is the same signal read once a block,
// which is what these modules heard before. The module and its layer are one source on both
// engines, so this holds for the browser's build of it too.
//
// Linked from the objects the extension build left behind (build/devices/native.mjs), so it runs
// where the extension has been built here and skips where it has not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const here = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.join(here, 'native', 'devices');
const BUILD = path.join(here, '..', 'web-engine', '.pack-cache', 'devices', 'native');
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
const OBJ = path.join(BUILD, 'obj', ARCH);
const WORK = path.join(BUILD, 'ported-parity');
const SR = 48000;
const BLOCK = 128;
const FRAMES = BLOCK * 200; // long enough for Shift, whose window is thousands of samples late

const { devices: CATALOG } = JSON.parse(fs.readFileSync(path.join(NATIVE_DIR, 'devices.json'), 'utf8'));

const CASES = [
  { id: 'Plaits', param: 'timbre', synth: true },
  { id: 'Galactic', param: 'brightness' },
  { id: 'CloudSeed', param: 'dry' },
  { id: 'Shift', param: 'pitch' },
];

/** The harness, linked against the extension build's objects (one per source), less the UGen's. */
function harness() {
  if (!fs.existsSync(OBJ)) return null;
  const objects = fs.readdirSync(OBJ)
    .filter((name) => name.endsWith('.o') && !/^(PoptartDevice|PoptartSpectrum)_cpp-/.test(name))
    .map((name) => path.join(OBJ, name));
  if (!objects.some((f) => path.basename(f).startsWith('pd_registry_cc-'))) return null;
  fs.mkdirSync(WORK, { recursive: true });
  const binary = path.join(WORK, 'harness');
  const source = path.join(NATIVE_DIR, 'own', 'harness.cc');
  const stamp = Math.max(fs.statSync(source).mtimeMs, ...objects.map((f) => fs.statSync(f).mtimeMs));
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs > stamp) return binary;
  execFileSync('clang++', ['-O3', '-std=c++17', '-ffast-math', '-fno-rtti', '-arch', ARCH,
    '-I', NATIVE_DIR, '-I', path.join(BUILD, 'gen'), source, ...objects, '-o', binary], { stdio: ['ignore', 'pipe', 'pipe'] });
  return binary;
}

function run(binary, device, { file, oneByOne, synth, input }) {
  const real = device.params.map((p) => p.default);
  const stdin = Buffer.alloc(real.length * 4 + input.length * 4);
  real.forEach((v, i) => stdin.writeFloatLE(Math.fround(v), i * 4));
  input.forEach((v, i) => stdin.writeFloatLE(v, real.length * 4 + i * 4));
  const index = device.params.findIndex((p) => p.id === device.patched);
  const args = [device.id, String(SR), String(FRAMES), String(BLOCK), '120', '-A', `${index}:${file}`];
  if (synth) args.push('-n', '0:48:1');
  if (oneByOne) args.push('-1');
  const out = spawnSync(binary, args, { input: stdin, maxBuffer: 1 << 26 });
  assert.equal(out.status, 0, `${device.id}: the harness failed - ${out.stderr?.toString()}`);
  return new Float32Array(out.stdout.buffer, out.stdout.byteOffset, FRAMES * 2);
}

const largest = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };

const binary = (() => { try { return harness(); } catch (err) { return { error: err }; } })();

for (const one of CASES) {
  test(`${one.id} follows audio patched onto ${one.param} a sample at a time`, (t) => {
    if (!binary) { t.skip('no extension build here to link against (run build/devices/native.mjs)'); return; }
    if (binary.error) { t.skip(`could not link the harness: ${String(binary.error.stderr ?? binary.error).split('\n')[0]}`); return; }
    const entry = CATALOG.find((d) => d.id === one.id);
    if (!entry) { t.skip(`no ${one.id} in this build`); return; }
    const device = { ...entry, patched: one.param };
    const p = entry.params.find((x) => x.id === one.param);
    // A 700 Hz sine across the middle of the control's range, in real units.
    const swept = Float32Array.from({ length: FRAMES }, (_, i) => p.min + (p.max - p.min) * (0.5 + 0.35 * Math.sin((2 * Math.PI * 700 * i) / SR)));
    const blocky = Float32Array.from(swept, (_, i) => swept[i - (i % BLOCK)]);
    fs.mkdirSync(WORK, { recursive: true });
    const file = path.join(WORK, `${one.id}-swept.f32`);
    const held = path.join(WORK, `${one.id}-held.f32`);
    fs.writeFileSync(file, Buffer.from(swept.buffer));
    fs.writeFileSync(held, Buffer.from(blocky.buffer));
    const input = Float32Array.from({ length: FRAMES * 2 }, (_, i) => (one.synth ? 0 : 0.3 * (((Math.floor(i / 2) * 220) / SR) % 1 - 0.5)));
    const patched = run(binary, device, { file, synth: one.synth, input });
    const reference = run(binary, device, { file, oneByOne: true, synth: one.synth, input });
    const perBlock = run(binary, device, { file: held, synth: one.synth, input });
    let level = 0;
    for (const v of patched) level = Math.max(level, Math.abs(v));
    assert.ok(level > 1e-3, `${one.id}: nothing came out`);
    assert.ok(largest(patched, reference) < 1e-6, `${one.id}: per sample through the buffer is not what one sample a call plays (${largest(patched, reference)})`);
    assert.ok(largest(patched, perBlock) > 1e-4, `${one.id}: sweeping per sample sounded no different from per block`);
  });
}
