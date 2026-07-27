'use strict';

// Unit tests for sclang path resolution - no engine boot, just the pure decision logic.
// Runs each case in an isolated PATH/env so the host machine's real SuperCollider install
// (or lack of one) can't sway the result.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { resolveSclangPath, onPath } = require('./index.js');

// Run `fn` with PATH and POPTART_SCLANG forced to known values, restoring them after.
function withEnv({ PATH, POPTART_SCLANG }, fn) {
  const savedPath = process.env.PATH;
  const savedOverride = process.env.POPTART_SCLANG;
  process.env.PATH = PATH ?? '';
  if (POPTART_SCLANG === undefined) delete process.env.POPTART_SCLANG;
  else process.env.POPTART_SCLANG = POPTART_SCLANG;
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
    if (savedOverride === undefined) delete process.env.POPTART_SCLANG;
    else process.env.POPTART_SCLANG = savedOverride;
  }
}

// A temp dir with an executable named `sclang` in it - stands in for a PATH entry that has it.
function dirWithSclang() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-sclang-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'sclang.exe' : 'sclang');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return { dir, bin };
}

test('POPTART_SCLANG override wins over everything', () => {
  const { dir } = dirWithSclang(); // even with a real sclang on PATH...
  const result = withEnv(
    { PATH: dir, POPTART_SCLANG: '/custom/path/to/sclang' },
    resolveSclangPath,
  );
  assert.strictEqual(result, '/custom/path/to/sclang');
});

test('returns bare "sclang" when it is on PATH', () => {
  const { dir } = dirWithSclang();
  const result = withEnv({ PATH: dir, POPTART_SCLANG: undefined }, resolveSclangPath);
  assert.strictEqual(result, 'sclang');
});

test('falls back to a standard install location when PATH has no sclang', () => {
  // Empty PATH, no override -> resolver consults knownSclangLocations(). The result is either a
  // real install path (if this machine has one) or the 'sclang' last resort - never a PATH hit.
  const result = withEnv({ PATH: '', POPTART_SCLANG: undefined }, resolveSclangPath);
  if (result !== 'sclang') {
    assert.ok(fs.existsSync(result), `resolved to ${result} but nothing is there`);
    assert.ok(/sclang(\.exe)?$/.test(result), `resolved path should name sclang: ${result}`);
  }
});

test('onPath finds an executable placed on PATH and misses when absent', () => {
  const { dir } = dirWithSclang();
  withEnv({ PATH: dir }, () => assert.strictEqual(onPath('sclang'), true));
  withEnv({ PATH: '' }, () => assert.strictEqual(onPath('definitely-not-a-real-binary'), false));
});
