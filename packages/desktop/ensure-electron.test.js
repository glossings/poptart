'use strict';

// Tests for the desktop launcher's self-install (ensure-electron.js). Everything here runs
// against scratch directories made to look like the three states an Electron install can be in -
// no network, no real Electron, no npm - because what matters is the DECISIONS: install when it
// is missing, repair when its unzip came up empty, and do nothing at all when it is fine.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  ensureElectron,
  electronStatus,
  electronCacheDir,
  findCachedZip,
  platformBinaryPath,
} = require('./ensure-electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ensure-electron-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const scratch = () => fs.mkdtempSync(path.join(tmp, `case-${n++}-`));

// A desktop dir whose node_modules/electron is in the given state.
function desktopDir(state, { version = '34.5.8' } = {}) {
  const dir = scratch();
  if (state === 'missing') return dir;
  const mod = path.join(dir, 'node_modules', 'electron');
  fs.mkdirSync(path.join(mod, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'electron', version }));
  if (state === 'unpacked') {
    // Exactly what the broken postinstall leaves: a dist folder with only a license in it.
    fs.writeFileSync(path.join(mod, 'dist', 'LICENSES.chromium.html'), '');
    return dir;
  }
  const binary = path.join(mod, 'dist', platformBinaryPath());
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '', { mode: 0o755 });
  fs.writeFileSync(path.join(mod, 'path.txt'), platformBinaryPath());
  return dir;
}

const quiet = { log: () => {}, warn: () => {} };

test('status tells apart not-installed, installed-but-empty, and ready', () => {
  assert.strictEqual(electronStatus(desktopDir('missing')), 'missing');
  assert.strictEqual(electronStatus(desktopDir('unpacked')), 'unpacked');
  assert.strictEqual(electronStatus(desktopDir('ready')), 'ready');
});

test('a binary without a correct path.txt is not ready', () => {
  // Electron's own loader reads path.txt verbatim, so a trailing newline there is a broken
  // install even though every file is present.
  const dir = desktopDir('ready');
  fs.writeFileSync(path.join(dir, 'node_modules', 'electron', 'path.txt'), `${platformBinaryPath()}\n`);
  assert.strictEqual(electronStatus(dir), 'unpacked');
});

test('the binary path is per platform', () => {
  assert.strictEqual(platformBinaryPath('darwin'), 'Electron.app/Contents/MacOS/Electron');
  assert.strictEqual(platformBinaryPath('win32'), 'electron.exe');
  assert.strictEqual(platformBinaryPath('linux'), 'electron');
});

test("the download cache is looked for where Electron's installer puts it", () => {
  assert.strictEqual(
    electronCacheDir({ platform: 'darwin', env: {}, home: '/Users/x' }),
    path.join('/Users/x', 'Library', 'Caches', 'electron'),
  );
  assert.strictEqual(
    electronCacheDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, home: 'C:\\Users\\x' }),
    path.join('C:\\Users\\x\\AppData\\Local', 'electron', 'Cache'),
  );
  assert.strictEqual(
    electronCacheDir({ platform: 'linux', env: {}, home: '/home/x' }),
    path.join('/home/x', '.cache', 'electron'),
  );
  // Electron's own override wins, so a relocated cache is still found.
  assert.strictEqual(electronCacheDir({ platform: 'darwin', env: { electron_config_cache: '/elsewhere' } }), '/elsewhere');
});

test('the cached zip is matched on version, platform and arch exactly', () => {
  const cacheDir = scratch();
  const put = (hash, name) => {
    fs.mkdirSync(path.join(cacheDir, hash), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, hash, name), 'zip');
  };
  put('aaa', 'electron-v33.4.11-darwin-arm64.zip');
  put('bbb', 'electron-v34.5.8-darwin-arm64.zip');
  put('ccc', 'electron-v34.5.8-win32-x64.zip');
  const find = (version, platform, arch) => findCachedZip({ cacheDir, version, platform, arch });
  assert.strictEqual(find('34.5.8', 'darwin', 'arm64'), path.join(cacheDir, 'bbb', 'electron-v34.5.8-darwin-arm64.zip'));
  assert.strictEqual(find('34.5.8', 'win32', 'x64'), path.join(cacheDir, 'ccc', 'electron-v34.5.8-win32-x64.zip'));
  // An older version's zip must never be unpacked into a newer package.
  assert.strictEqual(find('35.0.0', 'darwin', 'arm64'), null);
  assert.strictEqual(find('34.5.8', 'linux', 'x64'), null);
  assert.strictEqual(findCachedZip({ cacheDir: path.join(cacheDir, 'nope'), version: '34.5.8' }), null);
});

test('a ready install is left completely alone', () => {
  const dir = desktopDir('ready');
  const calls = [];
  const binary = ensureElectron({ desktopDir: dir, log: quiet, run: (...a) => (calls.push(a), { status: 0 }) });
  assert.deepStrictEqual(calls, [], 'nothing should be run when Electron already works');
  assert.ok(binary.endsWith(platformBinaryPath()));
});

test('a missing install runs npm install in the desktop directory, once', () => {
  const dir = desktopDir('missing');
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    // What a healthy `npm install` leaves behind.
    fs.cpSync(path.join(desktopDir('ready'), 'node_modules'), path.join(dir, 'node_modules'), { recursive: true });
    return { status: 0 };
  };
  ensureElectron({ desktopDir: dir, log: quiet, run });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'npm');
  assert.strictEqual(calls[0].args[0], 'install');
  assert.strictEqual(calls[0].cwd, dir, 'must install into the desktop package, not the repo root');
});

test('a failed npm install is reported as that, plainly', () => {
  assert.throws(
    () => ensureElectron({ desktopDir: desktopDir('missing'), log: quiet, run: () => ({ status: 1 }) }),
    /npm install failed/,
  );
});

test('an empty unzip with no cached download says what to do instead of failing obscurely', () => {
  // Pointed at an empty cache via Electron's own override, so the machine's real cache can't
  // make this pass by accident.
  const saved = process.env.electron_config_cache;
  process.env.electron_config_cache = scratch();
  try {
    assert.throws(
      () => ensureElectron({ desktopDir: desktopDir('unpacked'), log: quiet, run: () => ({ status: 0 }) }),
      /download is missing/,
    );
  } finally {
    if (saved === undefined) delete process.env.electron_config_cache;
    else process.env.electron_config_cache = saved;
  }
});
