'use strict';

// Unit tests for the first-run setup logic (setup.js) - the pinned-release table, checksum
// verification, and preflight checks. No network, no engine boot: installVstPlugin's
// download/extract path is covered by the manual first-run checklist instead.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  pickAsset,
  assetUrl,
  stockHostDir,
  STOCK_MACOS_HOST_SHA256,
  sha256File,
  sclangStatus,
  findSclangSymlinkOnPath,
  VSTPLUGIN_RELEASE,
} = require('./setup.js');

test('release table covers the supported platforms and pins full checksums', () => {
  const keys = Object.keys(VSTPLUGIN_RELEASE.assets);
  for (const wanted of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']) {
    assert.ok(keys.includes(wanted), `missing pinned asset for ${wanted}`);
  }
  for (const [key, asset] of Object.entries(VSTPLUGIN_RELEASE.assets)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${key}: sha256 must be a full lowercase hex digest`);
    if (asset.url) {
      // Forked asset (the patched macOS build): pinned by full https URL instead of an
      // upload id, still hash-checked like the rest.
      assert.match(asset.url, /^https:\/\/.+\.zip$/, `${key}: url should be a full https zip link`);
    } else {
      assert.match(asset.upload, /^[0-9a-f]{32}$/, `${key}: upload segment should be a 32-hex gitlab id`);
    }
    assert.ok(asset.file.includes(VSTPLUGIN_RELEASE.version), `${key}: filename should carry the pinned version`);
  }
});

test('both mac architectures share the one universal binary', () => {
  assert.strictEqual(pickAsset('darwin', 'arm64'), pickAsset('darwin', 'x64'));
});

test('pickAsset returns null for platforms without a pinned build', () => {
  assert.strictEqual(pickAsset('win32', 'ia32'), null);
  assert.strictEqual(pickAsset('freebsd', 'x64'), null);
});

test('assetUrl uses the /-/project/485/uploads form, not the release-page path', () => {
  // The links displayed on the release page 404 when fetched as pd/vstplugin/uploads/...;
  // only this shape works (see the memory note baked into setup.js's header comment).
  const url = assetUrl(pickAsset('linux', 'x64'));
  assert.match(url, /^https:\/\/git\.iem\.at\/-\/project\/485\/uploads\/[0-9a-f]{32}\/vstplugin_.+\.zip$/);
});

test('the macOS asset points at the patched fork release, hash-pinned', () => {
  // macOS installs poptart's probe-crash-fixed build (see setup.js header); an explicit url
  // must win over the git.iem.at upload path so the two can never silently disagree.
  const asset = pickAsset('darwin', 'arm64');
  assert.match(assetUrl(asset), /^https:\/\/github\.com\/glossings\/vstplugin\/releases\/download\/.+\.zip$/);
  assert.ok(!asset.upload, 'forked asset should not also carry an upstream upload id');
});

test('sha256File matches a known digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-setup-'));
  const file = path.join(dir, 'hello.txt');
  fs.writeFileSync(file, 'hello\n');
  // printf 'hello\n' | shasum -a 256
  assert.strictEqual(sha256File(file), '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');
});

test('findSclangSymlinkOnPath flags a symlink and ignores a real binary', (t) => {
  if (process.platform === 'win32') return t.skip('symlink semantics differ on Windows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-setup-path-'));
  const real = path.join(dir, 'real-binary');
  fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });

  // No sclang at all in the dir -> nothing to flag.
  assert.strictEqual(findSclangSymlinkOnPath([dir]), null);

  // A real (non-link) sclang is legitimate.
  const realSclangDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-setup-path-'));
  fs.writeFileSync(path.join(realSclangDir, 'sclang'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(findSclangSymlinkOnPath([realSclangDir]), null);

  // A symlinked sclang is the footgun.
  const link = path.join(dir, 'sclang');
  fs.symlinkSync(real, link);
  assert.strictEqual(findSclangSymlinkOnPath([dir]), link);
});

test('sclangStatus trusts a POPTART_SCLANG override', () => {
  const saved = process.env.POPTART_SCLANG;
  process.env.POPTART_SCLANG = '/custom/sclang';
  try {
    assert.deepStrictEqual(sclangStatus(), { found: true, path: '/custom/sclang' });
  } finally {
    if (saved === undefined) delete process.env.POPTART_SCLANG;
    else process.env.POPTART_SCLANG = saved;
  }
});

test('stockHostDir finds the dir whose prober matches the stock hash, in order', () => {
  // Real hashing over fixture files; the stock sha is injected so the test controls it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-stockhost-'));
  try {
    const mk = (name, content) => {
      const dir = path.join(base, name);
      fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugins', 'host'), content);
      return dir;
    };
    const stock = mk('user', 'stock bytes');
    const patched = mk('system', 'patched bytes');
    const stockSha = sha256File(path.join(stock, 'plugins', 'host'));
    // stock prober found; non-matching and missing dirs skipped
    assert.strictEqual(stockHostDir({ dirs: [patched, stock], stockSha }), stock);
    assert.strictEqual(stockHostDir({ dirs: [patched, path.join(base, 'nope')], stockSha }), null);
    // earlier dir wins when both match (user dir is listed first in production)
    const stock2 = mk('user2', 'stock bytes');
    assert.strictEqual(stockHostDir({ dirs: [stock, stock2], stockSha }), stock);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the pinned stock-host hash is a full digest and differs from the patched asset hash', () => {
  assert.match(STOCK_MACOS_HOST_SHA256, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(STOCK_MACOS_HOST_SHA256, pickAsset('darwin', 'arm64').sha256);
});
