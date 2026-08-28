'use strict';

// ensurePoptartExtension: installs the keylock UGen's files into a SuperCollider Extensions
// folder, refreshes them when the repo's copies change, leaves current ones alone, and never
// throws (a failure is reported for the boot log, not raised into the engine boot).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensurePoptartExtension, EXTENSION_FILES } = require('./extensions.js');

function fakeSources(dir, contents) {
  const sources = {};
  for (const f of EXTENSION_FILES) {
    sources[f] = path.join(dir, `src-${f}`);
    fs.writeFileSync(sources[f], contents[f] ?? `${f} v1`);
  }
  return sources;
}

test('installs both files on first run, then reports them up to date', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ext-'));
  const sources = fakeSources(tmp, {});
  const extensionsDir = path.join(tmp, 'Extensions');

  const first = ensurePoptartExtension({ extensionsDir, sources });
  assert.deepStrictEqual(first, { installed: [...EXTENSION_FILES], upToDate: [], skipped: null });
  for (const f of EXTENSION_FILES) {
    assert.strictEqual(fs.readFileSync(path.join(extensionsDir, 'poptart', f), 'utf8'), `${f} v1`);
  }

  const second = ensurePoptartExtension({ extensionsDir, sources });
  assert.deepStrictEqual(second, { installed: [], upToDate: [...EXTENSION_FILES], skipped: null });
});

test('refreshes only the file whose content changed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ext-'));
  const sources = fakeSources(tmp, {});
  const extensionsDir = path.join(tmp, 'Extensions');
  ensurePoptartExtension({ extensionsDir, sources });

  fs.writeFileSync(sources['PoptartPitchShift.scx'], 'PoptartPitchShift.scx v2');
  const r = ensurePoptartExtension({ extensionsDir, sources });
  assert.deepStrictEqual(r.installed, ['PoptartPitchShift.scx']);
  assert.deepStrictEqual(r.upToDate, ['PoptartPitchShift.sc']);
  assert.strictEqual(fs.readFileSync(path.join(extensionsDir, 'poptart', 'PoptartPitchShift.scx'), 'utf8'), 'PoptartPitchShift.scx v2');
  assert.strictEqual(fs.readdirSync(path.join(extensionsDir, 'poptart')).filter((n) => n.includes('.tmp-')).length, 0, 'no temp files left behind');
});

test('skips (does not throw) when the prebuilt is missing or the destination is unwritable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ext-'));
  const sources = fakeSources(tmp, {});
  fs.unlinkSync(sources['PoptartPitchShift.scx']);
  const noBuild = ensurePoptartExtension({ extensionsDir: path.join(tmp, 'Extensions'), sources });
  assert.deepStrictEqual(noBuild.installed, []);
  assert.match(noBuild.skipped, /no prebuilt extension/);

  const good = fakeSources(tmp, {});
  const blocked = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocked, 'a file where the Extensions dir should be');
  const unwritable = ensurePoptartExtension({ extensionsDir: blocked, sources: good });
  assert.deepStrictEqual(unwritable.installed, []);
  assert.match(unwritable.skipped, /could not install/);
});
