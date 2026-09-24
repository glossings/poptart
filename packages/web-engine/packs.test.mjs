// The shipped sample packs: the manifest rules that stop something unredistributable shipping,
// and the rendered files themselves, read back off disk as files.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_LICENSES,
  PACK_PREFIX,
  builtInLibrary,
  packCredits,
  packDefinition,
  validateManifest,
} from './src/packs/manifest.mjs';
import { decodeWav, encodeWav, finish, trim } from './build/wav.mjs';
import { renderPacks } from './build/render-packs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packsDir = path.join(here, 'public', 'packs');
const require = createRequire(import.meta.url);

const good = (over = {}) => ({
  id: 'pt_test',
  title: 'A pack',
  files: [{ file: 'kick.wav', license: 'CC0-1.0', source: 'somewhere' }],
  ...over,
});

test('a manifest has to name every file license and where it came from', () => {
  assert.throws(() => validateManifest(good({ files: [{ file: 'a.wav', source: 'x' }] })), /has no license/);
  assert.throws(() => validateManifest(good({ files: [{ file: 'a.wav', license: 'CC0-1.0' }] })), /has no source/);
  assert.throws(() => validateManifest(good({ files: [{ license: 'CC0-1.0', source: 'x' }] })), /has no filename/);
});

test('a license poptart does not redistribute is refused, not warned about', () => {
  // The usual free-pack terms - free to USE, nothing about republishing - are exactly what this
  // is here to catch, and catching them at build time is the only time anybody would look.
  assert.throws(
    () => validateManifest(good({ files: [{ file: 'a.wav', license: 'free-for-any-use', source: 'x' }] })),
    /not one poptart redistributes/,
  );
  for (const license of ALLOWED_LICENSES) {
    assert.doesNotThrow(() => validateManifest(good({
      files: [{ file: 'a.wav', license, source: 'x', by: 'somebody' }],
    })));
  }
});

test('an attribution license needs somebody to attribute', () => {
  assert.throws(
    () => validateManifest(good({ files: [{ file: 'a.wav', license: 'CC-BY-4.0', source: 'x' }] })),
    /nobody to credit/,
  );
});

test('a shipped pack has to wear the prefix, so it cannot take a name somebody wants', () => {
  assert.throws(() => validateManifest(good({ id: 'kit' })), /must start with "pt_"/);
  assert.throws(() => validateManifest(good({ id: 'pt_My Kit' })), /lowercase letters/);
  assert.equal(validateManifest(good()).id, 'pt_test');
  assert.ok(PACK_PREFIX.length > 0);
});

test('a manifest cannot list a file twice, because the order is the sample index', () => {
  assert.throws(() => validateManifest(good({
    files: [
      { file: 'a.wav', license: 'CC0-1.0', source: 'x' },
      { file: 'a.wav', license: 'CC0-1.0', source: 'x' },
    ],
  })), /twice/);
});

test('a filename cannot climb out of its own folder', () => {
  assert.throws(() => validateManifest(good({ files: [{ file: '../secret.wav', license: 'CC0-1.0', source: 'x' }] })), /plain relative name/);
  assert.throws(() => validateManifest(good({ files: [{ file: '/etc/passwd', license: 'CC0-1.0', source: 'x' }] })), /plain relative name/);
});

test('a pack becomes one definition line, in the order its files are listed', () => {
  const manifest = validateManifest(good({
    files: [
      { file: 'kick.wav', license: 'CC0-1.0', source: 'x' },
      { file: 'snare.wav', license: 'CC0-1.0', source: 'x' },
    ],
  }));
  assert.equal(
    packDefinition(manifest),
    '_pack("pt_test", ["packs/pt_test/kick.wav","packs/pt_test/snare.wav"])',
  );
});

test('the built-in library is readable by the parser that reads the star library', () => {
  // It IS a prebake source, so it has to parse with poptart's own parser rather than with
  // something that merely looks similar.
  const { parsePinned } = require('@poptart/web-app/pinned-defs.js');
  const text = fs.readFileSync(path.join(packsDir, 'built-in.js'), 'utf8');
  const entries = parsePinned(text);
  assert.ok(entries.length >= 2, 'both shipped packs should be found');
  for (const entry of entries) {
    assert.equal(entry.kind, 'pack');
    assert.ok(entry.id.startsWith(PACK_PREFIX), `${entry.id} should wear the prefix`);
  }
  assert.deepEqual(entries.map((e) => e.id).sort(), ['pt_keys', 'pt_kit']);
});

test('the generated library carries a header and one definition per line', () => {
  const manifest = validateManifest(good());
  const text = builtInLibrary([manifest]);
  assert.ok(text.startsWith('//'), 'it should say what it is');
  const lines = text.trim().split('\n').filter((l) => !l.startsWith('//') && l.trim());
  assert.equal(lines.length, 1);
});

test('the credits list every license in a pack', () => {
  const manifest = validateManifest(good({
    files: [
      { file: 'a.wav', license: 'CC0-1.0', source: 'x' },
      { file: 'b.wav', license: 'CC-BY-4.0', source: 'y', by: 'somebody' },
    ],
  }));
  const [credit] = packCredits([manifest]);
  assert.deepEqual(credit.licenses, ['CC-BY-4.0', 'CC0-1.0']);
  assert.equal(credit.files[1].by, 'somebody');
});

// -- the rendered files ---------------------------------------------------------------------

function shippedManifests() {
  return fs.readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => validateManifest(JSON.parse(fs.readFileSync(path.join(packsDir, e.name, 'manifest.json'), 'utf8'))));
}

test('every shipped pack validates, and every file it names is on disk', () => {
  const manifests = shippedManifests();
  assert.ok(manifests.length >= 2);
  for (const manifest of manifests) {
    for (const entry of manifest.files) {
      const file = path.join(packsDir, manifest.id, entry.file);
      assert.ok(fs.existsSync(file), `${manifest.id}/${entry.file} is listed but missing`);
      assert.ok(fs.statSync(file).size > 1000, `${manifest.id}/${entry.file} is suspiciously small`);
    }
  }
});

test('nothing is on disk that the manifest does not account for', () => {
  // A file nobody listed would ship with no license recorded anywhere, which is the whole thing
  // the manifests exist to prevent.
  for (const manifest of shippedManifests()) {
    const listed = new Set([...manifest.files.map((f) => f.file), 'manifest.json']);
    for (const name of fs.readdirSync(path.join(packsDir, manifest.id))) {
      assert.ok(listed.has(name), `${manifest.id}/${name} is on disk but not in the manifest`);
    }
  }
});

test('every shipped file is CC0, since poptart rendered them itself', () => {
  for (const manifest of shippedManifests()) {
    for (const entry of manifest.files) {
      assert.equal(entry.license, 'CC0-1.0', `${manifest.id}/${entry.file}`);
      assert.ok(entry.source.includes('render-packs'), 'the source should say what made it');
    }
  }
});

test('every rendered file is audible, normalized, and does not clip', () => {
  for (const manifest of shippedManifests()) {
    for (const entry of manifest.files) {
      const { sampleRate, channels } = decodeWav(fs.readFileSync(path.join(packsDir, manifest.id, entry.file)));
      assert.equal(sampleRate, 48000);
      assert.equal(channels.length, 2, `${entry.file} should be stereo`);
      let peak = 0;
      let energy = 0;
      for (const c of channels) for (const v of c) { peak = Math.max(peak, Math.abs(v)); energy += v * v; }
      assert.ok(peak > 0.8 && peak <= 1, `${manifest.id}/${entry.file} peaks at ${peak.toFixed(3)}`);
      assert.ok(energy > 0.1, `${manifest.id}/${entry.file} is nearly silent`);
    }
  }
});

test('every rendered file starts and ends at silence, so it can be cut into a pattern', () => {
  for (const manifest of shippedManifests()) {
    for (const entry of manifest.files) {
      const { channels } = decodeWav(fs.readFileSync(path.join(packsDir, manifest.id, entry.file)));
      for (const c of channels) {
        assert.ok(Math.abs(c[0]) < 0.02, `${entry.file} starts on a step`);
        assert.ok(Math.abs(c[c.length - 1]) < 0.02, `${entry.file} ends on a step`);
      }
    }
  }
});

test('the melodic pack is rendered at middle C, which is what the sampler treats as unpitched', () => {
  // poptart repitches a sample around MIDI 60, so a one-shot recorded at any other pitch plays
  // at the wrong one until somebody works out the offset by ear.
  const manifest = shippedManifests().find((m) => m.id === 'pt_keys');
  assert.ok(manifest);
  for (const entry of manifest.files) {
    const { channels, sampleRate } = decodeWav(fs.readFileSync(path.join(packsDir, 'pt_keys', entry.file)));
    const signal = channels[0];
    // Autocorrelation over a window well inside the sound, looking for the period of middle C.
    const from = Math.floor(sampleRate * 0.05);
    const window = Math.min(4096, signal.length - from - 1200);
    if (window < 1024) continue;
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = 60; lag < 800; lag++) {
      let sum = 0;
      for (let i = 0; i < window; i++) sum += signal[from + i] * signal[from + i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    const hz = sampleRate / bestLag;
    // Any octave of middle C counts: autocorrelation happily locks onto a strong harmonic or the
    // octave below, and neither would mean the file was rendered at the wrong pitch.
    const octaves = Math.log2(hz / 261.6255653005986);
    assert.ok(
      Math.abs(octaves - Math.round(octaves)) < 0.06,
      `pt_keys/${entry.file} measured ${hz.toFixed(1)} Hz, which is not an octave of middle C`,
    );
  }
});

test('rendering is deterministic, so the committed files are reproducible', () => {
  const { manifests } = renderPacks({ write: false });
  assert.deepEqual(manifests.map((m) => m.id), ['pt_kit', 'pt_keys']);
  const onDisk = shippedManifests();
  for (const fresh of manifests) {
    const committed = onDisk.find((m) => m.id === fresh.id);
    assert.deepEqual(fresh.files.map((f) => f.file), committed.files.map((f) => f.file));
  }
});

test('the wav writer and reader round-trip', () => {
  const left = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.1) * 0.5);
  const right = Float32Array.from({ length: 512 }, (_, i) => Math.cos(i * 0.1) * 0.25);
  const { sampleRate, channels } = decodeWav(encodeWav([left, right], 44100));
  assert.equal(sampleRate, 44100);
  assert.equal(channels.length, 2);
  for (let i = 0; i < 512; i++) {
    assert.ok(Math.abs(channels[0][i] - left[i]) < 1e-4, `left ${i}`);
    assert.ok(Math.abs(channels[1][i] - right[i]) < 1e-4, `right ${i}`);
  }
});

test('the writer clamps rather than wrapping, since a wrap turns a loud hit into a click', () => {
  const loud = Float32Array.from([2, -2, 0.5]);
  const { channels } = decodeWav(encodeWav([loud], 48000));
  assert.ok(channels[0][0] > 0.99, 'a sample over full scale should stay positive');
  assert.ok(channels[0][1] < -0.99, 'and one under it negative');
});

test('the writer refuses channels of different lengths rather than writing noise', () => {
  assert.throws(() => encodeWav([new Float32Array(10), new Float32Array(20)], 48000), /same length/);
  assert.throws(() => encodeWav([], 48000), /no channels/);
});

test('finishing normalizes and fades, so nothing ships quiet or clicking', () => {
  const quiet = [Float32Array.from({ length: 300 }, () => 0.01)];
  const [out] = finish(quiet);
  assert.ok(Math.max(...out) > 0.8, 'it should be brought up to level');
  assert.ok(Math.abs(out[out.length - 1]) < 0.01, 'and faded at the end');
});

test('trimming keeps the sound and drops the silence after it', () => {
  const buf = new Float32Array(10000);
  for (let i = 0; i < 500; i++) buf[i] = 0.5;
  const [out] = trim([buf]);
  assert.ok(out.length > 500 && out.length < 1200, `trimmed to ${out.length}`);
});
