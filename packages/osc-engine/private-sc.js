'use strict';

// A private SuperCollider, owned entirely by poptart (PACKAGING.md, Stage 1.5).
//
// Setup can fetch SuperCollider itself into `~/.poptart/sc/` instead of asking the user to
// install it system-wide. The point is not just "one less manual step": a private copy is
// resolved by full path and given its own class-library config, so the whole family of
// SETUP.md troubleshooting entries that come from *sharing* SuperCollider with the machine
// stops existing - a stale `sclang` symlink on PATH, a broken class file in the user's
// Extensions folder, a VSTPlugin build that doesn't match the SC underneath it.
//
// Nothing here is installed system-wide and nothing needs admin rights: SuperCollider ships
// self-contained builds for both desktop platforms (the macOS dmg holds a SuperCollider.app
// with sclang, scsynth, the class library and the UGen plugins all inside it; every release
// ships a `win64.zip` beside the Windows installer with the same contents in a plain folder).
// Uninstalling is deleting one directory. Linux has no official binaries, so it stays on the
// package manager and this module reports "no asset" there.
//
// The copy is opt-in - see consentToInstall(). An existing system SuperCollider keeps working
// untouched; the private copy only exists once someone has asked for it.
//
// This module deliberately depends on nothing but node builtins: index.js requires it to
// resolve sclang, so requiring index.js (or setup.js) back would be a cycle.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------------------------
// The pinned release.
//
// Checksums are the ones GitHub publishes for the release assets themselves
// (`.assets[].digest` on /repos/supercollider/supercollider/releases/tags/<tag>), so bumping the
// version does not mean trusting a download: fetch that endpoint, copy the digests, done. A
// repointed link or a corrupted transfer fails the hash check instead of installing - the same
// rule the VSTPlugin pins in setup.js follow, and it matters more here, because what is being
// installed is the audio engine itself.
// ---------------------------------------------------------------------------------------------

const MACOS_ASSET = {
  file: 'SuperCollider-3.14.1-macOS-universal.dmg',
  sha256: 'ed264b32752d27fc86e506dd0a7eb36de7c19ebce73c3fdf2ed5514f8c73f02e',
  bytes: 250537254,
  kind: 'dmg',
};

const SC_RELEASE = {
  version: '3.14.1',
  tag: 'Version-3.14.1',
  // Keyed by `${process.platform}-${process.arch}`. The macOS build is one universal
  // (x86-64 + arm64) dmg. Linux is absent on purpose: there is no official binary to pin.
  assets: {
    'darwin-arm64': MACOS_ASSET,
    'darwin-x64': MACOS_ASSET,
    'win32-x64': {
      file: 'SuperCollider-3.14.1-win64.zip',
      sha256: 'a5f95416307d35c039ca53a9f9c6151c26585064d3229521093a60dddb9458cd',
      bytes: 138627563,
      kind: 'zip',
    },
  },
};

// Where each archive puts things, relative to the version directory. Verified against the
// 3.14.1 artifacts: the dmg holds `SuperCollider.app` (sclang in Contents/MacOS, everything
// else in Contents/Resources), and the zip holds a single top-level `SuperCollider/` folder
// with sclang.exe, scsynth.exe, SCClassLibrary/ and plugins/ side by side.
const LAYOUT = {
  darwin: {
    unpacked: 'SuperCollider.app',
    sclang: path.join('SuperCollider.app', 'Contents', 'MacOS', 'sclang'),
    resources: path.join('SuperCollider.app', 'Contents', 'Resources'),
  },
  win32: {
    unpacked: 'SuperCollider',
    sclang: path.join('SuperCollider', 'sclang.exe'),
    resources: 'SuperCollider',
  },
};

function scAsset(platform = process.platform, arch = process.arch) {
  return SC_RELEASE.assets[`${platform}-${arch}`] ?? null;
}

function scDownloadUrl(asset) {
  return `https://github.com/supercollider/supercollider/releases/download/${SC_RELEASE.tag}/${asset.file}`;
}

function layoutFor(platform = process.platform) {
  return LAYOUT[platform] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

// The install root, overridable so tests (and the CI job) can run the real download → unpack →
// spawn sequence into a temp directory instead of the user's home. Same shape as the other
// per-directory overrides in SETUP.md.
function privateScRoot() {
  return process.env.POPTART_SC_ROOT || path.join(os.homedir(), '.poptart', 'sc');
}

// Versioned, so a future bump installs beside the old copy rather than over it (and so a
// half-finished install of a new version can never be mistaken for the working old one).
function versionDir(root = privateScRoot(), version = SC_RELEASE.version) {
  return path.join(root, version);
}

/** poptart's own SC Extensions folder - VSTPlugin and the keylock UGen live here, not in the
 * user's SuperCollider directory. Shared across versions: the extensions are ours, not the
 * SC build's. */
function privateExtensionsDir(root = privateScRoot()) {
  return path.join(root, 'Extensions');
}

function privateSclangPath(root = privateScRoot(), platform = process.platform) {
  const layout = layoutFor(platform);
  return layout ? path.join(versionDir(root), layout.sclang) : null;
}

function privateResourcesDir(root = privateScRoot(), platform = process.platform) {
  const layout = layoutFor(platform);
  return layout ? path.join(versionDir(root), layout.resources) : null;
}

function privateClassLibraryDir(root = privateScRoot(), platform = process.platform) {
  const res = privateResourcesDir(root, platform);
  return res ? path.join(res, 'SCClassLibrary') : null;
}

/** The SC build's own UGen plugins (the ~50 .scx that ship with it). */
function privateUgenDir(root = privateScRoot(), platform = process.platform) {
  const res = privateResourcesDir(root, platform);
  return res ? path.join(res, 'plugins') : null;
}

/** Is a usable private copy on disk? Cheap enough to call from path resolution. */
function privateScInstalled(root = privateScRoot(), platform = process.platform) {
  const sclang = privateSclangPath(root, platform);
  if (!sclang) return false;
  try {
    fs.accessSync(sclang, fs.constants.X_OK);
    // The class library has to be there too - a half-unpacked copy that still has the binary
    // would resolve as "installed" and then fail to compile, which looks like a broken SC.
    fs.accessSync(privateClassLibraryDir(root, platform), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Does `sclangPath` belong to the private copy? Pure path arithmetic, so index.js can ask
 * "am I about to spawn the private sclang?" without this module knowing how it resolves. */
function isPrivateSclang(sclangPath, root = privateScRoot()) {
  if (!sclangPath) return false;
  const rel = path.relative(path.resolve(root), path.resolve(sclangPath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------------------------
// The generated class-library config
//
// sclang's `-l <file>` picks the yaml config to read instead of the user's own. With
// `excludeDefaultPaths: true` the default class library AND the user/system Extensions folders
// drop off the class path (the same switch as the `-a` command-line flag, which sclang's usage
// calls "standalone mode"), leaving exactly what we list.
//
// What this does NOT isolate: sclang still runs the user's `startup.scd`, because that path
// comes from Platform.userConfigDir - the home directory - and no config file or flag has a say
// over it (checked in 3.14.1's Platform.sc: `loadStartupFiles` reads
// `userConfigDir +/+ "startup.scd"` unconditionally). A startup file that throws or blocks still
// takes the engine's boot with it, so that one stays a preflight warning rather than something
// the private copy fixes.
// ---------------------------------------------------------------------------------------------

// YAML single-quoted style: the only escape inside it is '' for a literal quote. Double quotes
// would treat a backslash as an escape, which mangles every Windows path; single quotes carry
// `C:\Users\Someone With Spaces\...` through untouched.
function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sclangConfPath(root = privateScRoot()) {
  return path.join(root, 'sclang_conf.yaml');
}

function renderSclangConf(includePaths) {
  return (
    '# Generated by poptart before every engine boot - edits here are overwritten.\n' +
    '#\n' +
    "# excludeDefaultPaths drops SuperCollider's default class library and the user and system\n" +
    '# Extensions folders, so this private copy compiles exactly the paths listed below and is\n' +
    "# unaffected by whatever is installed in the machine's own SuperCollider.\n" +
    'excludeDefaultPaths: true\n' +
    'postInlineWarnings: false\n' +
    'includePaths:\n' +
    includePaths.map((p) => `  - ${yamlQuote(p)}\n`).join('')
  );
}

/**
 * Write the config the private sclang boots with, and return its path. Regenerated on every
 * boot rather than written once at install time, so a moved home directory, a changed
 * POPTART_SC_ROOT, or a hand-edited file can't leave sclang pointed at paths that no longer
 * exist.
 */
function writeSclangConf({ root = privateScRoot(), platform = process.platform } = {}) {
  const classLib = privateClassLibraryDir(root, platform);
  if (!classLib) throw new Error(`no private SuperCollider layout for ${platform}`);
  const extensions = privateExtensionsDir(root);
  fs.mkdirSync(extensions, { recursive: true });
  const confPath = sclangConfPath(root);
  fs.writeFileSync(confPath, renderSclangConf([classLib, extensions]));
  return confPath;
}

/**
 * What scsynth's `-U` should be (poptart.scd sets `server.options.ugenPluginsPath` from this).
 * Setting it REPLACES the default search, so the SC build's own plugins directory has to be in
 * the list alongside our Extensions - without it there is no SinOsc, let alone VSTPlugin.
 */
function privateUgenPluginsPath({ root = privateScRoot(), platform = process.platform } = {}) {
  return [privateUgenDir(root, platform), privateExtensionsDir(root)];
}

// ---------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let read;
    // Streamed rather than readFileSync: these archives are 139-250MB and this also runs in
    // the server process.
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const mb = (n) => (n / 1e6).toFixed(0);

async function downloadWithProgress(url, destPath, { log = console, expectedBytes = 0 } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || expectedBytes;
  let seen = 0;
  let nextMark = 20;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    seen += chunk.length;
    if (!total) return;
    const pct = (seen / total) * 100;
    if (pct < nextMark) return;
    while (nextMark <= pct) nextMark += 20;
    log.log(`[poptart]   ... ${mb(seen)} / ${mb(total)} MB`);
  });
  await pipeline(body, fs.createWriteStream(destPath));
}

// Unpack a macOS dmg by mounting it and copying the bundle out with `ditto`, which preserves the
// symlinks, resource forks and permissions inside SuperCollider.app - and, critically, the code
// signature: SuperCollider's binaries are Developer-ID signed, and a copy that breaks the seal
// would be refused by Gatekeeper. Always detached, including on failure, so a botched install
// can't leave a volume mounted.
function unpackDmg(dmgPath, destDir, { log = console } = {}) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-sc-mnt-'));
  let attached = false;
  try {
    execFileSync(
      'hdiutil',
      ['attach', dmgPath, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    attached = true;
    const src = path.join(mountPoint, LAYOUT.darwin.unpacked);
    if (!fs.existsSync(src)) {
      throw new Error(`${path.basename(dmgPath)} did not contain ${LAYOUT.darwin.unpacked}`);
    }
    fs.mkdirSync(destDir, { recursive: true });
    execFileSync('ditto', [src, path.join(destDir, LAYOUT.darwin.unpacked)]);
  } finally {
    if (attached) {
      try {
        execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' });
      } catch {
        // A busy volume (Spotlight, say) needs a moment or a shove; if this fails too the
        // install still succeeded, so say so rather than throwing over a mounted disk image.
        try {
          execFileSync('hdiutil', ['detach', mountPoint, '-force', '-quiet'], { stdio: 'ignore' });
        } catch {
          log.warn(`[poptart]   ! could not unmount ${mountPoint} - eject it by hand`);
        }
      }
    }
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

// Windows 10+ ships bsdtar as `tar`, which reads zips; macOS/Linux have `unzip`. (Only the
// Windows asset is a zip today, but keeping both makes the function testable anywhere.)
function unpackZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zipPath, '-C', destDir]);
  else execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir]);
}

// Rename, tolerating the transient locks Windows puts on freshly written files: an antivirus
// or the search indexer opens each new file to scan it, and for a moment after unpacking two
// thousand of them a rename of their parent fails with EPERM or EBUSY. It clears by itself, so
// wait and try again rather than failing a finished 139MB install at its last step. Any other
// error, or one that persists, is real and is thrown.
async function renameWithRetry(from, to, { attempts = 10, delayMs = 300 } = {}) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const transient = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code);
      if (!transient || i >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Where a downloaded archive is kept between runs. Unset (the normal case) means a temp file
// that is deleted after unpacking; CI sets POPTART_SC_CACHE_DIR so a re-run doesn't pull
// 139-250MB from GitHub again.
function downloadCacheDir() {
  return process.env.POPTART_SC_CACHE_DIR || null;
}

// A directory directly under the root named like a SuperCollider version, i.e. one this module
// created. Anything else in there - `Extensions`, the generated config, whatever a user put
// beside them - is not ours to delete.
const VERSION_DIR = /^\d+\.\d+(\.\d+)?$/;

/**
 * Delete private copies other than the pinned one. Called after a successful install, never on
 * its own: by then the replacement has been verified runnable, so there is something to fall
 * back to. Without this, every version bump would leave another ~500MB in the user's home
 * directory forever, and nothing else would ever clean it up.
 *
 * Two guards. Only directories matching a version number are considered, so the shared
 * `Extensions` folder (which holds VSTPlugin and the keylock UGen, and is deliberately not
 * versioned) can never be caught by this. And a copy something is explicitly pointed at via
 * POPTART_SCLANG is left alone - deleting the binary out from under a running session, or out
 * from under someone who pinned an old version on purpose, would be a nasty surprise.
 *
 * @returns {string[]} the version names removed, for logging.
 */
function pruneOldVersions({
  root = privateScRoot(),
  keep = SC_RELEASE.version,
  protect = process.env.POPTART_SCLANG || null,
  log = console,
} = {}) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed; // no root, nothing to prune
  }
  const protectedPath = protect ? path.resolve(protect) : null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep || !VERSION_DIR.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (protectedPath) {
      const rel = path.relative(dir, protectedPath);
      // '' means it IS this directory; anything not climbing out means it is inside it.
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (err) {
      // A copy we cannot delete is untidy, not broken - the new one is already in place.
      log.warn(`[poptart]   ! could not remove the old SuperCollider at ${dir}: ${err.message}`);
    }
  }
  return removed;
}

/**
 * Download, verify and unpack the pinned SuperCollider into the private root. Throws on any
 * failure, leaving no partial install behind: the archive is unpacked into a staging directory
 * inside the root and renamed into place only once it is complete, so an interrupted install
 * (or a killed process) can never produce a version directory that looks usable but isn't.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] - install root (tests/CI point this at a temp dir).
 * @param {object} [opts.log] - console-shaped logger.
 * @param {string} [opts.platform] @param {string} [opts.arch] - override the asset choice.
 */
async function installPrivateSc({
  root = privateScRoot(),
  log = console,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const asset = scAsset(platform, arch);
  if (!asset) {
    throw new Error(
      `no pinned SuperCollider build for ${platform}-${arch} - install SuperCollider through ` +
        'your package manager instead',
    );
  }
  const target = versionDir(root);
  fs.mkdirSync(root, { recursive: true });

  // An install killed partway (Ctrl-C during the download is the obvious one) never reaches
  // its `finally`, so its staging directory - up to the whole archive plus the whole unpacked
  // app - would otherwise sit in the user's home directory forever. Starting an install is the
  // one moment it is safe to sweep them: nothing else writes here.
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.staging-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }

  const cacheDir = downloadCacheDir();
  // Staging lives inside the root so the final rename is same-filesystem (a temp dir on another
  // volume would make it an EXDEV failure at the very last step of a 250MB install).
  const staging = fs.mkdtempSync(path.join(root, '.staging-'));
  const archivePath = cacheDir
    ? path.join(cacheDir, asset.file)
    : path.join(staging, asset.file);
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });

  try {
    let cached = false;
    if (fs.existsSync(archivePath)) {
      // A cached archive is only worth having if it is the right bytes.
      cached = sha256File(archivePath) === asset.sha256;
      if (!cached) fs.rmSync(archivePath, { force: true });
    }
    if (cached) {
      log.log(`[poptart] using cached SuperCollider ${SC_RELEASE.version} download (${asset.file})`);
    } else {
      log.log(
        `[poptart] downloading SuperCollider ${SC_RELEASE.version} (${asset.file}, ` +
          `~${mb(asset.bytes)} MB) into ${root}...`,
      );
      await downloadWithProgress(scDownloadUrl(asset), archivePath, { log, expectedBytes: asset.bytes });
      const actual = sha256File(archivePath);
      if (actual !== asset.sha256) {
        throw new Error(
          `the SuperCollider download failed its checksum (expected ${asset.sha256}, got ${actual}) ` +
            '- refusing to install it. Retry, or install SuperCollider yourself.',
        );
      }
    }

    log.log('[poptart]   unpacking...');
    const unpackedInto = path.join(staging, 'sc');
    if (asset.kind === 'dmg') unpackDmg(archivePath, unpackedInto, { log });
    else unpackZip(archivePath, unpackedInto);

    const layout = layoutFor(platform);
    const produced = path.join(unpackedInto, layout.unpacked);
    if (!fs.existsSync(produced)) {
      throw new Error(`${asset.file} did not contain ${layout.unpacked}`);
    }
    if (!fs.existsSync(path.join(unpackedInto, layout.resources, 'SCClassLibrary'))) {
      throw new Error(`${asset.file} unpacked without a class library - the layout has changed`);
    }

    // Swap it in whole. A previous copy of the same version is replaced rather than merged:
    // leftovers from an older unpack are exactly the kind of thing that makes a class library
    // fail to compile.
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await renameWithRetry(unpackedInto, target);
    log.log(`[poptart] SuperCollider ${SC_RELEASE.version} installed to ${target}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  if (!privateScInstalled(root, platform)) {
    throw new Error(
      `installed to ${target} but ${privateSclangPath(root, platform)} is still not runnable - ` +
        'please report this',
    );
  }

  // Only now that the new copy is proven runnable: clear out the ones it replaces.
  const pruned = pruneOldVersions({ root, log });
  if (pruned.length) {
    log.log(`[poptart] removed the previous SuperCollider copy: ${pruned.join(', ')}`);
  }

  return { root, version: SC_RELEASE.version, sclang: privateSclangPath(root, platform), pruned };
}

// ---------------------------------------------------------------------------------------------
// Consent
//
// This downloads 139-250MB. A dev script that did that silently would be rude, so it is always
// a deliberate answer: POPTART_INSTALL_SC settles it outright (1 = yes, 0 = never), and
// otherwise an interactive terminal is asked. With no terminal and no variable - a service, a
// CI job, an editor's integrated runner - the answer is no, with the variable named so it can
// be made yes.
// ---------------------------------------------------------------------------------------------

function installEnvChoice() {
  const raw = process.env.POPTART_INSTALL_SC;
  if (raw === undefined || raw === '') return null;
  return /^(1|true|yes|y)$/i.test(raw);
}

function askYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^\s*(y|yes)\s*$/i.test(answer));
    });
  });
}

/**
 * Decide whether to fetch the private copy. Returns { install, reason }.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.systemScFound] - is there already a working SuperCollider? If so the
 *   default is to leave well alone; only an explicit POPTART_INSTALL_SC=1 overrides that.
 * @param {boolean} [opts.interactive] - may we ask? (defaults to "stdin is a terminal")
 */
async function consentToInstall({
  systemScFound = false,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = askYesNo,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const asset = scAsset(platform, arch);
  if (!asset) return { install: false, reason: `no pinned SuperCollider build for ${platform}-${arch}` };

  const choice = installEnvChoice();
  if (choice === false) return { install: false, reason: 'POPTART_INSTALL_SC is set to 0' };
  if (choice === true) return { install: true, reason: 'POPTART_INSTALL_SC=1' };

  if (systemScFound) {
    return { install: false, reason: 'SuperCollider is already installed on this machine' };
  }
  if (!interactive) {
    return {
      install: false,
      reason:
        'not running in a terminal, so there is nobody to ask - set POPTART_INSTALL_SC=1 to let ' +
        'poptart fetch its own SuperCollider',
    };
  }
  // Three short lines rather than one long one: the path alone can be most of a terminal's
  // width (C:\Users\<name>\.poptart\sc), and a wrapped question buries its own [y/N].
  const yes = await ask(
    '[poptart] SuperCollider is not installed. poptart can download its own copy:\n' +
      `[poptart]   ${mb(asset.bytes)} MB, into ${privateScRoot()}\n` +
      '[poptart]   (nothing installed system-wide, no admin rights needed)\n' +
      '[poptart] Download it? [y/N] ',
  );
  return { install: yes, reason: yes ? 'confirmed at the prompt' : 'declined at the prompt' };
}

module.exports = {
  SC_RELEASE,
  scAsset,
  scDownloadUrl,
  privateScRoot,
  versionDir,
  privateExtensionsDir,
  privateSclangPath,
  privateResourcesDir,
  privateClassLibraryDir,
  privateUgenDir,
  privateScInstalled,
  isPrivateSclang,
  sclangConfPath,
  renderSclangConf,
  writeSclangConf,
  privateUgenPluginsPath,
  privateScDownloadCacheDir: downloadCacheDir,
  installPrivateSc,
  pruneOldVersions,
  consentToInstall,
  sha256File,
  yamlQuote,
  unpackZip,
  unpackDmg,
};
