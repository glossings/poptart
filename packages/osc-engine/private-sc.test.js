'use strict';

// Tests for poptart's private SuperCollider (private-sc.js, PACKAGING.md Stage 1.5).
//
// Two halves. The unit tests below always run: they cover the decisions that are pure
// arithmetic on paths and environment - which asset, which layout, what the generated config
// says, who wins the resolution order, where extensions get installed - and each one forces
// POPTART_SC_ROOT at a scratch directory so the result never depends on whether the machine
// running them happens to have a private copy (or a SuperCollider at all).
//
// The second half is the real thing: download the pinned release, check it, unpack it, generate
// the config, boot that sclang and ask it what it sees. It is opt-in via POPTART_SC_INSTALL_TEST
// because it pulls 139-250MB; CI sets it. That test is the one that answers the questions
// PACKAGING.md listed as "to confirm, not assumed" - that excludeDefaultPaths really does drop
// the user's Extensions, and that the config's paths survive a directory with a space in it.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const priv = require('./private-sc');
const {
  SC_RELEASE,
  scAsset,
  scDownloadUrl,
  privateSclangPath,
  privateClassLibraryDir,
  privateExtensionsDir,
  privateUgenPluginsPath,
  privateScInstalled,
  isPrivateSclang,
  renderSclangConf,
  writeSclangConf,
  yamlQuote,
  consentToInstall,
  installPrivateSc,
} = priv;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const tmpDirs = [];
function scratch(prefix = 'poptart-sc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Run `fn` with the private-SC environment forced to known values. Every test that touches
// resolution goes through this, so a real ~/.poptart/sc on the developer's machine can't change
// an outcome (and a test can never write into one).
function withEnv(vars, fn) {
  const keys = ['POPTART_SC_ROOT', 'POPTART_SCLANG', 'POPTART_INSTALL_SC', 'PATH'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (!(k in vars)) continue;
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// A directory tree that looks like an unpacked private SuperCollider, without being one: enough
// for the "is it installed / what would we spawn" logic, which only inspects paths.
function fakePrivateSc(root, platform = process.platform) {
  const sclang = privateSclangPath(root, platform);
  const classLib = privateClassLibraryDir(root, platform);
  fs.mkdirSync(path.dirname(sclang), { recursive: true });
  fs.writeFileSync(sclang, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(classLib, { recursive: true });
  fs.mkdirSync(privateUgenPluginsPath({ root, platform })[0], { recursive: true });
  return { sclang, classLib };
}

// ---------------------------------------------------------------------------------------------
// Pinned release
// ---------------------------------------------------------------------------------------------

test('every pinned asset has a checksum and a plausible size', () => {
  const seen = Object.entries(SC_RELEASE.assets);
  assert.ok(seen.length >= 3, 'expected macOS (arm64 + x64) and Windows');
  for (const [key, asset] of seen) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${key} needs a sha256`);
    assert.ok(asset.bytes > 50e6, `${key} looks too small to be SuperCollider`);
    assert.ok(['dmg', 'zip'].includes(asset.kind), `${key} has an unknown archive kind`);
  }
});

test('asset selection is per platform and arch, and Linux has none', () => {
  assert.strictEqual(scAsset('darwin', 'arm64').kind, 'dmg');
  assert.strictEqual(scAsset('darwin', 'x64').kind, 'dmg');
  // One universal binary serves both Macs - the same asset object, not a copy of it.
  assert.strictEqual(scAsset('darwin', 'arm64'), scAsset('darwin', 'x64'));
  assert.strictEqual(scAsset('win32', 'x64').kind, 'zip');
  assert.strictEqual(scAsset('linux', 'x64'), null, 'Linux has no official SC binary to pin');
  assert.strictEqual(scAsset('win32', 'arm64'), null);
});

test('the download URL is built from the pinned tag, not scraped', () => {
  const url = scDownloadUrl(scAsset('win32', 'x64'));
  assert.ok(url.startsWith('https://github.com/supercollider/supercollider/releases/download/'));
  assert.ok(url.endsWith(SC_RELEASE.assets['win32-x64'].file));
  assert.ok(url.includes(SC_RELEASE.tag));
});

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

test('layout matches what each archive actually contains', () => {
  const root = path.join(path.sep, 'tmp', 'root');
  // Verified against the 3.14.1 artifacts: the dmg holds SuperCollider.app, the zip holds a
  // single top-level SuperCollider/ folder.
  const mac = privateSclangPath(root, 'darwin');
  assert.ok(mac.includes(path.join(SC_RELEASE.version, 'SuperCollider.app', 'Contents', 'MacOS')));
  assert.ok(mac.endsWith('sclang'));
  const win = privateSclangPath(root, 'win32');
  assert.ok(win.includes(path.join(SC_RELEASE.version, 'SuperCollider')));
  assert.ok(win.endsWith('sclang.exe'));
  assert.strictEqual(privateSclangPath(root, 'linux'), null);
});

test('the version is part of the path, so a bump installs beside the old copy', () => {
  const root = path.join(path.sep, 'tmp', 'root');
  assert.ok(privateClassLibraryDir(root, 'darwin').includes(SC_RELEASE.version));
  // ...but the Extensions folder is NOT versioned: those files are poptart's, not the build's.
  assert.ok(!privateExtensionsDir(root).includes(SC_RELEASE.version));
  assert.strictEqual(privateExtensionsDir(root), path.join(root, 'Extensions'));
});

test('ugenPluginsPath carries the build\'s own plugins as well as ours', () => {
  const root = path.join(path.sep, 'tmp', 'root');
  const dirs = privateUgenPluginsPath({ root, platform: 'darwin' });
  assert.strictEqual(dirs.length, 2);
  // Setting -U replaces the default search, so missing the build's own plugins would mean no
  // SinOsc - the engine would fail in a way that looks nothing like a path problem.
  assert.ok(dirs[0].endsWith('plugins'), 'the SC build\'s own UGens must be listed');
  assert.strictEqual(dirs[1], privateExtensionsDir(root));
});

test('isPrivateSclang recognizes only paths inside the root', () => {
  const root = path.join(path.sep, 'tmp', 'my root');
  assert.ok(isPrivateSclang(privateSclangPath(root, 'darwin'), root));
  assert.ok(!isPrivateSclang('/Applications/SuperCollider.app/Contents/MacOS/sclang', root));
  assert.ok(!isPrivateSclang('sclang', root));
  assert.ok(!isPrivateSclang(null, root));
  // A sibling directory whose name merely starts with the root's must not count.
  assert.ok(!isPrivateSclang(path.join(path.sep, 'tmp', 'my root-2', 'sclang'), root));
});

test('privateScInstalled needs the class library, not just the binary', () => {
  const root = scratch();
  assert.ok(!privateScInstalled(root), 'empty root is not an install');
  const sclang = privateSclangPath(root);
  fs.mkdirSync(path.dirname(sclang), { recursive: true });
  fs.writeFileSync(sclang, '#!/bin/sh\n', { mode: 0o755 });
  // A half-unpacked copy has the binary but nothing to compile: reporting it as installed would
  // shadow a perfectly good system SuperCollider with one that cannot boot.
  assert.ok(!privateScInstalled(root), 'binary without a class library is not an install');
  fs.mkdirSync(privateClassLibraryDir(root), { recursive: true });
  assert.ok(privateScInstalled(root));
});

// ---------------------------------------------------------------------------------------------
// Pruning old versions
// ---------------------------------------------------------------------------------------------

// A root holding several version directories plus the things that must survive pruning.
function rootWithVersions(versions) {
  const root = scratch();
  for (const v of versions) fs.mkdirSync(path.join(root, v, 'SuperCollider.app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Extensions', 'VSTPlugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sclang_conf.yaml'), 'excludeDefaultPaths: true\n');
  return root;
}

test('pruning removes other versions and keeps the pinned one', () => {
  const root = rootWithVersions(['3.13.0', '3.14.1', '3.15.0']);
  const removed = priv.pruneOldVersions({ root, keep: '3.14.1', protect: null });
  assert.deepStrictEqual(removed.sort(), ['3.13.0', '3.15.0']);
  assert.ok(fs.existsSync(path.join(root, '3.14.1')));
  assert.ok(!fs.existsSync(path.join(root, '3.13.0')));
});

test('pruning never touches the shared Extensions folder or anything unversioned', () => {
  const root = rootWithVersions(['3.13.0']);
  // VSTPlugin and the keylock UGen live here and are deliberately not versioned - losing them
  // to a version bump would silently disable plugins.
  fs.mkdirSync(path.join(root, 'my-notes'), { recursive: true });
  priv.pruneOldVersions({ root, keep: '3.14.1', protect: null });
  assert.ok(fs.existsSync(path.join(root, 'Extensions', 'VSTPlugin')), 'Extensions must survive');
  assert.ok(fs.existsSync(path.join(root, 'sclang_conf.yaml')));
  assert.ok(fs.existsSync(path.join(root, 'my-notes')), 'only version directories are ours to delete');
});

test('pruning spares a copy POPTART_SCLANG points at', () => {
  const root = rootWithVersions(['3.13.0', '3.14.1']);
  // Someone deliberately pinned an old copy; deleting the binary under them would be a nasty
  // surprise, and worse if a session is running on it.
  const pinned = privateSclangPath(root, 'darwin').replace(SC_RELEASE.version, '3.13.0');
  const removed = priv.pruneOldVersions({ root, keep: '3.14.1', protect: pinned });
  assert.deepStrictEqual(removed, []);
  assert.ok(fs.existsSync(path.join(root, '3.13.0')));
});

test('pruning a root that does not exist is not an error', () => {
  assert.deepStrictEqual(
    priv.pruneOldVersions({ root: path.join(scratch(), 'nope'), keep: '3.14.1', protect: null }),
    [],
  );
});

// ---------------------------------------------------------------------------------------------
// The generated config
// ---------------------------------------------------------------------------------------------

test('config paths survive spaces and backslashes', () => {
  // Single-quoted YAML: the only escape is '' for a quote, so a Windows path keeps its
  // backslashes (double quotes would read \U and \S as escapes) and a space is simply a space.
  assert.strictEqual(yamlQuote('C:\\Users\\Someone Else\\sc'), "'C:\\Users\\Someone Else\\sc'");
  assert.strictEqual(yamlQuote("it's here"), "'it''s here'");

  const conf = renderSclangConf(['C:\\Program Files\\poptart\\SCClassLibrary', '/Users/a b/Extensions']);
  assert.match(conf, /excludeDefaultPaths: true/);
  assert.match(conf, /- 'C:\\Program Files\\poptart\\SCClassLibrary'/);
  assert.match(conf, /- '\/Users\/a b\/Extensions'/);
  assert.ok(!conf.includes('"'), 'double quotes would make backslashes escapes');
});

test('writeSclangConf lists the class library and the private Extensions, and nothing else', () => {
  const root = scratch('poptart sc with spaces ');
  const confPath = writeSclangConf({ root });
  const conf = fs.readFileSync(confPath, 'utf8');
  assert.strictEqual(confPath, path.join(root, 'sclang_conf.yaml'));
  assert.match(conf, /excludeDefaultPaths: true/);
  assert.ok(conf.includes(yamlQuote(privateClassLibraryDir(root))));
  assert.ok(conf.includes(yamlQuote(privateExtensionsDir(root))));
  assert.strictEqual(conf.match(/^ {2}- /gm).length, 2, 'exactly two include paths');
  // The Extensions directory has to exist by the time sclang reads the config, or the path is
  // silently dropped from the class path.
  assert.ok(fs.existsSync(privateExtensionsDir(root)));
});

test('writeSclangConf is regenerated, not appended to', () => {
  const root = scratch();
  const first = fs.readFileSync(writeSclangConf({ root }), 'utf8');
  const second = fs.readFileSync(writeSclangConf({ root }), 'utf8');
  assert.strictEqual(first, second);
});

// ---------------------------------------------------------------------------------------------
// Resolution order (the contract index.js and setup.js must agree on)
// ---------------------------------------------------------------------------------------------

test('the private copy outranks PATH but not POPTART_SCLANG', () => {
  const root = scratch();
  const { sclang } = fakePrivateSc(root);
  // A directory with a bare `sclang` on it, so PATH would otherwise win.
  const pathDir = scratch();
  const onPathBin = path.join(pathDir, process.platform === 'win32' ? 'sclang.exe' : 'sclang');
  fs.writeFileSync(onPathBin, '#!/bin/sh\n', { mode: 0o755 });

  // Required fresh inside the env, because index.js reads POPTART_SC_ROOT through
  // privateScRoot() at call time - but delete it from the cache so nothing is stale.
  const reload = () => {
    delete require.cache[require.resolve('./index.js')];
    return require('./index.js');
  };

  withEnv({ POPTART_SC_ROOT: root, POPTART_SCLANG: undefined, PATH: pathDir }, () => {
    const { resolveSclangPath, usingPrivateSc } = reload();
    assert.strictEqual(resolveSclangPath(), sclang, 'private copy should win over PATH');
    assert.ok(usingPrivateSc());
  });

  withEnv({ POPTART_SC_ROOT: root, POPTART_SCLANG: '/custom/sclang', PATH: pathDir }, () => {
    const { resolveSclangPath, usingPrivateSc } = reload();
    assert.strictEqual(resolveSclangPath(), '/custom/sclang', 'explicit override always wins');
    assert.ok(!usingPrivateSc());
  });

  // No private copy: PATH behaves exactly as it did before this feature existed.
  withEnv({ POPTART_SC_ROOT: scratch(), POPTART_SCLANG: undefined, PATH: pathDir }, () => {
    const { resolveSclangPath, usingPrivateSc } = reload();
    assert.strictEqual(resolveSclangPath(), 'sclang');
    assert.ok(!usingPrivateSc());
  });

  delete require.cache[require.resolve('./index.js')];
});

test('in private mode extensions go to the private folder and the system dirs are not consulted', () => {
  const root = scratch();
  fakePrivateSc(root);
  const reload = () => {
    delete require.cache[require.resolve('./index.js')];
    return require('./index.js');
  };

  withEnv({ POPTART_SC_ROOT: root, POPTART_SCLANG: undefined, PATH: '' }, () => {
    const idx = reload();
    assert.strictEqual(idx.activeExtensionsDir(), privateExtensionsDir(root));
    const dirs = idx.vstPluginExtensionDirs();
    assert.deepStrictEqual(dirs, [path.join(privateExtensionsDir(root), 'VSTPlugin')]);
    // The machine's own VSTPlugin must not be reported: the generated config excludes it, so
    // claiming it is installed would skip the download and then fail to compile.
    for (const sys of idx.systemVstPluginExtensionDirs()) {
      assert.ok(!dirs.includes(sys), `${sys} must not be searched in private mode`);
    }
    assert.strictEqual(idx.vstPluginExtensionInstalled(), false);
    fs.mkdirSync(dirs[0], { recursive: true });
    assert.strictEqual(idx.vstPluginExtensionInstalled(), true);
  });

  withEnv({ POPTART_SC_ROOT: scratch(), POPTART_SCLANG: undefined, PATH: '' }, () => {
    const idx = reload();
    // Without a private copy the old behavior is untouched.
    assert.deepStrictEqual(idx.vstPluginExtensionDirs(), idx.systemVstPluginExtensionDirs());
  });

  delete require.cache[require.resolve('./index.js')];
});

// ---------------------------------------------------------------------------------------------
// Consent - nothing downloads 250MB without a deliberate answer
// ---------------------------------------------------------------------------------------------

test('consent: an existing SuperCollider is left alone by default', async () => {
  const decision = await withEnv({ POPTART_INSTALL_SC: undefined }, () =>
    consentToInstall({ systemScFound: true, interactive: true, ask: () => Promise.resolve(true) }),
  );
  assert.strictEqual(decision.install, false);
  assert.match(decision.reason, /already installed/);
});

test('consent: POPTART_INSTALL_SC settles it either way', async () => {
  const yes = await withEnv({ POPTART_INSTALL_SC: '1' }, () =>
    consentToInstall({ systemScFound: true, interactive: false }),
  );
  assert.strictEqual(yes.install, true, 'an explicit 1 installs even when SC is present');

  const no = await withEnv({ POPTART_INSTALL_SC: '0' }, () =>
    consentToInstall({ systemScFound: false, interactive: true, ask: () => Promise.resolve(true) }),
  );
  assert.strictEqual(no.install, false, 'an explicit 0 declines even at an interactive prompt');
});

test('consent: with no terminal and no variable the answer is no, and it says how to say yes', async () => {
  const decision = await withEnv({ POPTART_INSTALL_SC: undefined }, () =>
    consentToInstall({ systemScFound: false, interactive: false }),
  );
  assert.strictEqual(decision.install, false);
  assert.match(decision.reason, /POPTART_INSTALL_SC/);
});

test('consent: an interactive prompt is asked, and only "yes" is yes', async () => {
  const asked = [];
  const ask = (q) => {
    asked.push(q);
    return Promise.resolve(false);
  };
  const decision = await withEnv({ POPTART_INSTALL_SC: undefined }, () =>
    consentToInstall({ systemScFound: false, interactive: true, ask }),
  );
  assert.strictEqual(decision.install, false);
  assert.strictEqual(asked.length, 1);
  // The prompt has to say how big it is and where it goes - that is the whole point of asking.
  assert.match(asked[0], /MB/);
  assert.match(asked[0], /\[y\/N\]/);
});

test('consent: a platform with no pinned build never offers', async () => {
  const decision = await consentToInstall({ platform: 'linux', arch: 'x64', interactive: true });
  assert.strictEqual(decision.install, false);
  assert.match(decision.reason, /no pinned SuperCollider build/);
});

// ---------------------------------------------------------------------------------------------
// The real install. Opt-in: it downloads the pinned release.
// ---------------------------------------------------------------------------------------------

const INSTALL_TEST = process.env.POPTART_SC_INSTALL_TEST === '1';
const skipInstall = INSTALL_TEST
  ? false
  : 'set POPTART_SC_INSTALL_TEST=1 to run the real download (139-250MB)';

// What sclang reports about itself once booted with the generated config. `\X.asClass` rather
// than a bare class name so a missing extension posts nil instead of failing to compile.
const PROBE = `
"PROBE started".postln;
"PROBE conf: %".format(LanguageConfig.currentPath).postln;
"PROBE excludeDefaultPaths: %".format(LanguageConfig.excludeDefaultPaths).postln;
"PROBE includePaths: %".format(LanguageConfig.includePaths).postln;
"PROBE classLibraryDir: %".format(Platform.classLibraryDir).postln;
"PROBE userExtensionDir: %".format(Platform.userExtensionDir).postln;
"PROBE vstplugin: %".format(\\VSTPlugin.asClass).postln;
"PROBE classes: %".format(Object.allSubclasses.size).postln;
"PROBE done".postln;
0.exit;
`;

function probeSclang(sclang, confPath, port) {
  const dir = scratch('poptart probe ');
  const scd = path.join(dir, 'probe.scd');
  fs.writeFileSync(scd, PROBE);
  try {
    return execFileSync(sclang, ['-l', confPath, '-u', String(port), scd], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}\n(exit: ${err.message})`;
  }
}

const probeValue = (output, key) => {
  const m = output.match(new RegExp(`^PROBE ${key}: (.*)$`, 'm'));
  return m ? m[1].trim() : null;
};

test('a private SuperCollider installs, isolates itself, and compiles', { skip: skipInstall }, async (t) => {
  // A space in the path on purpose: PACKAGING.md listed "do the generated config's paths
  // survive spaces on both platforms" as an open question, and this is the answer.
  const root = scratch('poptart sc install test ');
  assert.ok(root.includes(' '), 'this test is pointless without a space in the path');

  await t.test('downloads, verifies and unpacks', async () => {
    // What an install killed mid-download leaves behind; the next install has to sweep it, or
    // every Ctrl-C costs the user hundreds of megabytes for good. Covered by the leftovers
    // assertion below.
    fs.mkdirSync(path.join(root, '.staging-killed'), { recursive: true });
    fs.writeFileSync(path.join(root, '.staging-killed', 'half-a-download.dmg'), 'x');
    const result = await installPrivateSc({ root, log: { log: () => {}, warn: () => {} } });
    assert.strictEqual(result.version, SC_RELEASE.version);
    assert.ok(privateScInstalled(root), 'sclang and the class library should both be present');
    assert.ok(fs.existsSync(privateUgenPluginsPath({ root })[0]), 'the build\'s UGens must be there');
    // Nothing half-finished is left lying around next to the install.
    const leftovers = fs.readdirSync(root).filter((n) => n.startsWith('.staging-'));
    assert.deepStrictEqual(leftovers, [], 'staging directories must be cleaned up');
  });

  const sclang = privateSclangPath(root);
  const confPath = writeSclangConf({ root });

  await t.test('boots with the generated config and compiles its class library', () => {
    const output = probeSclang(sclang, confPath, 57297);
    assert.match(output, /PROBE done/, `sclang did not finish:\n${output.slice(-3000)}`);
    assert.strictEqual(probeValue(output, 'excludeDefaultPaths'), 'true');
    assert.ok(Number(probeValue(output, 'classes')) > 500, 'the class library should have compiled');
    // It must be OUR class library, not the machine's.
    assert.ok(
      probeValue(output, 'classLibraryDir').startsWith(root),
      `class library came from outside the private copy: ${probeValue(output, 'classLibraryDir')}`,
    );
  });

  await t.test('does not see the machine\'s own Extensions', () => {
    const { systemVstPluginExtensionDirs } = require('./index.js');
    const systemVst = systemVstPluginExtensionDirs().find((d) => fs.existsSync(d));
    if (!systemVst) {
      // On a clean CI runner there is nothing to be isolated from, so there is nothing to
      // prove here - the excludeDefaultPaths assertion above still stands.
      return t.skip('no system VSTPlugin on this machine to be isolated from');
    }
    const output = probeSclang(sclang, confPath, 57297);
    assert.match(output, /PROBE done/);
    // The canary: VSTPlugin IS installed on this machine, in a default Extensions path. If the
    // private sclang can see it, excludeDefaultPaths is not doing what the plan assumed.
    assert.strictEqual(
      probeValue(output, 'vstplugin'),
      'nil',
      `the private copy can see ${systemVst}, so it is not isolated`,
    );
  });

  await t.test('sees VSTPlugin once it is installed into the private Extensions', async () => {
    const dest = path.join(privateExtensionsDir(root), 'VSTPlugin');
    const { installVstPlugin } = require('./setup.js');
    await withEnv({ POPTART_SC_ROOT: root, POPTART_SCLANG: undefined }, async () => {
      delete require.cache[require.resolve('./index.js')];
      delete require.cache[require.resolve('./setup.js')];
      await require('./setup.js').installVstPlugin({ log: { log: () => {}, warn: () => {} } });
    });
    assert.ok(fs.existsSync(dest), `VSTPlugin should have landed in ${dest}`);
    const output = probeSclang(sclang, confPath, 57297);
    assert.match(output, /PROBE done/);
    assert.strictEqual(
      probeValue(output, 'vstplugin'),
      'VSTPlugin',
      `VSTPlugin in ${dest} was not picked up:\n${output.slice(-2000)}`,
    );
    void installVstPlugin;
    delete require.cache[require.resolve('./index.js')];
    delete require.cache[require.resolve('./setup.js')];
  });
});
