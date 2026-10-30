'use strict';

// ensurePoptartExtension: installs the keylock UGen's files into a SuperCollider Extensions
// folder, refreshes them when the repo's copies change, leaves current ones alone, and never
// throws (a failure is reported for the boot log, not raised into the engine boot).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensurePoptartExtension, ensureDeviceExtension, EXTENSION_FILES, sclangStartupFile,
  pitchShiftLayout, deviceLayout, pluginFile, binSubdir, binaryPlatform,
} = require('./extensions.js');

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

// Binaries as their first bytes say: what binaryPlatform reads.
const MACH_O = Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.from('universal binary')]);
const PE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62), Buffer.from('a Windows DLL')]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('a Linux shared object')]);

test('refuses a prebuilt for another platform and removes a copy installed earlier', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ext-'));
  // The macOS names, whatever this machine is: .scx on Windows too, so the same group of files
  // can be offered to both.
  const files = ['PoptartPitchShift.scx', 'PoptartPitchShift.sc'];
  const sources = {};
  for (const f of files) {
    sources[f] = path.join(tmp, `src-${f}`);
    fs.writeFileSync(sources[f], f.endsWith('.scx') ? MACH_O : `${f} v1`);
  }
  const group = { files, sources, binary: 'PoptartPitchShift.scx', from: 'native/rubberband' };
  const extensionsDir = path.join(tmp, 'Extensions');

  // The platform it was built for: installed as usual.
  const mac = ensurePoptartExtension({ extensionsDir, ...group, platform: 'darwin' });
  assert.deepStrictEqual(mac.installed, files);

  // The same files on Windows: nothing installed, and what is already there is taken out - the
  // class file too, since its presence alone switches the engine onto the native keylock.
  const win = ensurePoptartExtension({ extensionsDir, ...group, platform: 'win32' });
  assert.deepStrictEqual(win.installed, []);
  assert.match(win.skipped, /no prebuilt extension for this platform .*darwin build/);
  for (const f of files) {
    assert.strictEqual(fs.existsSync(path.join(extensionsDir, 'poptart', f)), false, `${f} removed`);
  }

  // Nothing to remove is not an error either.
  const again = ensurePoptartExtension({ extensionsDir: path.join(tmp, 'Fresh'), ...group, platform: 'linux' });
  assert.match(again.skipped, /darwin build/);
});

test('each platform installs its own build, from its own folder, under the name its scsynth loads', () => {
  const root = path.join(__dirname, 'native');
  // macOS: bin/ itself, as it always was - existing checkouts and installs depend on it.
  assert.deepStrictEqual(deviceLayout('darwin', 'arm64').sources, {
    'PoptartDevices.scx': path.join(root, 'devices', 'bin', 'PoptartDevices.scx'),
    'PoptartDevice.sc': path.join(root, 'devices', 'PoptartDevice.sc'),
  });
  assert.strictEqual(pitchShiftLayout('darwin', 'x64').sources['PoptartPitchShift.scx'], path.join(root, 'rubberband', 'bin', 'PoptartPitchShift.scx'));
  // Windows: a DLL named .scx, in bin/win32-x64/.
  assert.deepStrictEqual(deviceLayout('win32', 'x64').files, ['PoptartDevices.scx', 'PoptartDevice.sc']);
  assert.strictEqual(deviceLayout('win32', 'x64').sources['PoptartDevices.scx'], path.join(root, 'devices', 'bin', 'win32-x64', 'PoptartDevices.scx'));
  assert.strictEqual(pitchShiftLayout('win32', 'x64').from, 'native/rubberband/bin/win32-x64');
  // Linux: .so, in bin/linux-x64/.
  assert.deepStrictEqual(pitchShiftLayout('linux', 'x64').files, ['PoptartPitchShift.so', 'PoptartPitchShift.sc']);
  assert.strictEqual(pitchShiftLayout('linux', 'x64').sources['PoptartPitchShift.so'], path.join(root, 'rubberband', 'bin', 'linux-x64', 'PoptartPitchShift.so'));
  assert.strictEqual(pluginFile('PoptartDevices', 'linux'), 'PoptartDevices.so');
  assert.strictEqual(binSubdir('darwin', 'arm64'), '');
});

test('a Windows or Linux build installs on its platform and is refused on the others', () => {
  for (const [platform, bytes, other] of [['win32', PE, ELF], ['linux', ELF, PE]]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ext-'));
    const layout = deviceLayout(platform, 'x64');
    const sources = {};
    for (const f of layout.files) {
      sources[f] = path.join(tmp, f);
      fs.writeFileSync(sources[f], f === layout.binary ? bytes : 'PoptartDevice : MultiOutUGen {}');
    }
    assert.strictEqual(binaryPlatform(sources[layout.binary]), platform);
    const extensionsDir = path.join(tmp, 'Extensions');
    const ok = ensureDeviceExtension({ extensionsDir, platform, arch: 'x64', sources });
    assert.deepStrictEqual(ok, { installed: layout.files, upToDate: [], skipped: null }, platform);
    for (const f of layout.files) assert.ok(fs.existsSync(path.join(extensionsDir, 'poptart', f)), `${platform}: ${f}`);

    // Another platform's build copied into this platform's folder: refused, and the copy taken out.
    fs.writeFileSync(sources[layout.binary], other);
    const wrong = ensureDeviceExtension({ extensionsDir, platform, arch: 'x64', sources });
    assert.deepStrictEqual(wrong.installed, []);
    assert.match(wrong.skipped, /is a (win32|linux) build/);
    for (const f of layout.files) assert.strictEqual(fs.existsSync(path.join(extensionsDir, 'poptart', f)), false);
  }
});

test('a checkout with no build for this platform installs nothing and says where it looked', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-ext-'));
  // No such architecture is ever built, so its folder is empty in every checkout.
  const r = ensureDeviceExtension({ extensionsDir: path.join(tmp, 'Extensions'), platform: 'linux', arch: 'mips' });
  assert.deepStrictEqual(r.installed, []);
  assert.match(r.skipped, /not in native\/devices\/bin\/linux-mips/);
});

test("the build writes each platform's plugin where the installer looks for it", async () => {
  // toolchain.mjs (the build) and extensions.js (the installer) each name the folder and suffix;
  // this is what keeps a CI build from landing somewhere the app never reads.
  const toolchain = await import('../web-engine/build/devices/toolchain.mjs');
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]) {
    assert.strictEqual(toolchain.binSubdir(platform, arch), binSubdir(platform, arch), platform);
    assert.strictEqual(`PoptartDevices${toolchain.pluginSuffix(platform)}`, pluginFile('PoptartDevices', platform), platform);
  }
});

test("this checkout's plugins, where there are any, are this platform's", () => {
  // What CI's Windows and Linux jobs build lands here; a mislabeled one would be refused at boot.
  for (const layout of [deviceLayout(), pitchShiftLayout()]) {
    const file = layout.sources[layout.binary];
    if (!fs.existsSync(file)) continue;
    assert.strictEqual(binaryPlatform(file), process.platform, file);
  }
});

test("sclang's startup file is found where each platform's SuperCollider keeps it", () => {
  // Not a guess: Platform.userConfigDir, which is where sclang reads startup.scd from before it
  // runs poptart's script. Getting this wrong means blaming a file the user does not have.
  assert.strictEqual(
    sclangStartupFile({ platform: 'darwin', env: {}, home: '/Users/x' }),
    path.join('/Users/x', 'Library', 'Application Support', 'SuperCollider', 'startup.scd'),
  );
  assert.strictEqual(
    sclangStartupFile({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, home: 'C:\\Users\\x' }),
    'C:\\Users\\x\\AppData\\Local\\SuperCollider\\startup.scd',
  );
  assert.match(sclangStartupFile({ platform: 'win32', env: {}, home: 'C:\\Users\\x' }), /AppData.Local.SuperCollider.startup\.scd$/);
  assert.strictEqual(
    sclangStartupFile({ platform: 'linux', env: {}, home: '/home/x' }),
    path.join('/home/x', '.config', 'SuperCollider', 'startup.scd'),
  );
});
