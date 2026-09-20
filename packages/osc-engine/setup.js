'use strict';

// First-run setup: everything that used to be manual install steps or README troubleshooting,
// run by the web-app server before it boots the engine (see PACKAGING.md, Stage 1). Three jobs:
//
//   1. Say clearly whether SuperCollider is installed, with the install command if not.
//   2. Auto-install the VSTPlugin server extension when it's missing - the single worst manual
//      step (find the right build on git.iem.at, unzip a subfolder into a hidden directory).
//   3. Warn about the known boot-wreckers before they wreck the boot: a symlinked sclang
//      shadowing the real one, and orphaned sclang/scsynth processes holding ports/devices.
//
// runSetup() never throws and never blocks the boot - a failed auto-install degrades to the
// README's manual instructions, and the engine's own boot diagnostics (diagnoseSclangOutput)
// remain the backstop.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  onPath,
  knownSclangLocations,
  vstPluginExtensionDirs,
  vstPluginExtensionInstalled,
} = require('./index');
const {
  privateScInstalled,
  privateSclangPath,
  privateScRoot,
  installPrivateSc,
  consentToInstall,
  SC_RELEASE,
} = require('./private-sc');
const { liveEngineStacks } = require('./orphans');

// ---------------------------------------------------------------------------------------------
// Pinned VSTPlugin release. URLs and checksums are pinned (not scraped from the release page)
// so a repointed link or compromised upload fails the hash check instead of installing.
//
// NOTE the URL shape: the `/uploads/...` links displayed on the git.iem.at release page 404
// when fetched as git.iem.at/pd/vstplugin/uploads/...; the working form is
// https://git.iem.at/-/project/485/uploads/<hash>/<file> (485 = vstplugin's project id).
//
// To bump the version: `curl -s https://git.iem.at/api/v4/projects/485/releases` lists the
// per-platform upload paths in the newest release's description; download each and pin its
// `shasum -a 256`. The macOS build is one universal (x86-64 + arm64) zip.
//
// The macOS asset comes from poptart's vstplugin fork instead of upstream: it is the official
// v0.6.2 zip with the SC binaries (VSTPlugin.scx, VSTPlugin_supernova.scx, host) rebuilt for two
// fixes. A probe crash: plugins that automate parameters during their own init - Auto-Tune Pro,
// sforzando, Arturia V Collection, ... - segfault the stock prober and get wrongly added to the
// scan cache's ignore list. And transport keys: a plugin's editor window swallows ⌘↵ / ⌘. with a
// system beep, where the fork forwards them to poptart (see OscEngine#onHotkey). Fix branch:
// https://github.com/glossings/vstplugin/tree/fix/probe-performedit-null-info. Before bumping
// past v0.6.2, check whether upstream picked up the fix (VST3Plugin::performEdit guarding a
// null info_) - if so, drop the fork and repin all platforms to upstream.
// ---------------------------------------------------------------------------------------------

const VSTPLUGIN_UPLOAD_BASE = 'https://git.iem.at/-/project/485/uploads';

const MACOS_ASSET = {
  file: 'vstplugin_v0.6.2-poptart.4_macOS.zip',
  url: 'https://github.com/glossings/vstplugin/releases/download/v0.6.2-poptart.4/vstplugin_v0.6.2-poptart.4_macOS.zip',
  sha256: 'dcddc7f15dcf093e30f11a1861a19ea697a729f819565dbc480b9388b3dab272',
};

const VSTPLUGIN_RELEASE = {
  version: 'v0.6.2',
  // Keyed by `${process.platform}-${process.arch}`. Unlisted combinations (32-bit Windows,
  // ARMhf Linux, ...) fall back to the README's manual install.
  assets: {
    'darwin-arm64': MACOS_ASSET,
    'darwin-x64': MACOS_ASSET,
    'win32-x64': {
      file: 'vstplugin_v0.6.2_win64.zip',
      upload: 'c262d8a3f23a03d761c5d7575772480d',
      sha256: '778767c62f6d1340826fdb9e79d1f623e15104dfa0ba1d6b9c3a5d9ad376a3ef',
    },
    'linux-x64': {
      file: 'vstplugin_v0.6.2_Linux.zip',
      upload: '7dcb287f5cc882fd3aa6f157cdc7bb5d',
      sha256: 'f7139df5ac74be5bd71fe32b992a8706470897ca026bec3b06c920ea170f227f',
    },
    'linux-arm64': {
      file: 'vstplugin_v0.6.2_Linux_ARM64.zip',
      upload: 'c3466098d71e135c229dccf3703ee263',
      sha256: '787f29c6b1c941d168069a1db92321f5811da9f69e3871cad0b1bffdf4a04145',
    },
  },
};

function assetUrl(asset) {
  // Assets live on git.iem.at uploads unless they carry an explicit url (the patched macOS zip).
  return asset.url ?? `${VSTPLUGIN_UPLOAD_BASE}/${asset.upload}/${asset.file}`;
}

// sha256 of the `host` prober in every macOS build poptart has shipped or replaced, with what is
// wrong with it. `host` is rebuilt with every fork release (the editor window code is compiled
// into it too), so its hash identifies the build: an installed extension matching one of these
// byte-for-byte is exactly that release, and setup upgrades it in place. Any other hash (the
// current release, a custom build, a future version) is somebody's deliberate state and is left
// alone. Add the outgoing release's host here whenever MACOS_ASSET is bumped.
const OUTDATED_MACOS_HOSTS = {
  // upstream v0.6.2
  '9cae4e6537e46f24a2474c668e8675cee2de9b269d934cafc547929f9d62ffb7':
    'the stock v0.6.2 prober, which crashes on some plugins (Auto-Tune Pro, sforzando, ...) during scans',
  // v0.6.2-poptart.1
  '92f2e3d957f811190077fd3249361ed9620e0f11938b801f69387d3918174030':
    'an older poptart build, whose plugin windows beep at ⌘↵ / ⌘. instead of playing and stopping',
  // v0.6.2-poptart.2
  '27030af745d7d28b492f7db6d7f58854c2880a3d02cb2c9c06b9594dbf2cae12':
    'an older poptart build that cannot restore a preset bigger than 64KB into a bridged (Intel-only) plugin',
  // v0.6.2-poptart.3
  '8eec27662a62e95928b6b32dd57a9a7f9432858ef1fcc1a9c627d56212311032':
    'an older poptart build, which a file that is not really a plugin (a Windows DLL in a macOS plugin folder, say) crashes during scans',
};

// The first installed extension dir whose plugins/host is an outdated macOS build, as
// { dir, why }, or null. `dirs`/`outdated` are injectable for tests.
function outdatedHostDir({ dirs = vstPluginExtensionDirs(), outdated = OUTDATED_MACOS_HOSTS } = {}) {
  if (process.platform !== 'darwin') return null; // only the macOS asset carries the fixes
  for (const dir of dirs) {
    try {
      const why = outdated[sha256File(path.join(dir, 'plugins', 'host'))];
      if (why) return { dir, why };
    } catch {
      // no prober here - not this dir
    }
  }
  return null;
}

function pickAsset(platform = process.platform, arch = process.arch) {
  return VSTPLUGIN_RELEASE.assets[`${platform}-${arch}`] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function downloadTo(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// macOS ships `unzip`; Windows 10+ ships bsdtar (which reads zips) as `tar`; Linux `unzip` is
// near-universal (and the failure message names it if not).
function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zipPath, '-C', destDir]);
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir]);
  }
}

// Download, verify, and unzip the pinned release's `sc/VSTPlugin` folder into the platform's
// user Extensions directory. Throws on any failure (caller degrades to manual instructions).
async function installVstPlugin({ log = console } = {}) {
  const asset = pickAsset();
  if (!asset) {
    throw new Error(
      `no pinned VSTPlugin build for ${process.platform}-${process.arch} - install manually per the README`,
    );
  }
  const destDir = vstPluginExtensionDirs()[0]; // user-level dir, same one the README names
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-vstplugin-'));
  try {
    const zipPath = path.join(tmpDir, asset.file);
    log.log(`[poptart] downloading VSTPlugin ${VSTPLUGIN_RELEASE.version} (${asset.file})...`);
    await downloadTo(assetUrl(asset), zipPath);
    const actual = sha256File(zipPath);
    if (actual !== asset.sha256) {
      throw new Error(
        `VSTPlugin download failed its checksum (expected ${asset.sha256}, got ${actual}) - ` +
          'refusing to install it. Retry, or install manually per the README.',
      );
    }
    extractZip(zipPath, tmpDir);
    const src = path.join(tmpDir, 'sc', 'VSTPlugin');
    if (!fs.existsSync(src)) throw new Error(`${asset.file} did not contain sc/VSTPlugin`);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(src, destDir, { recursive: true });
    if (process.platform === 'darwin') {
      // Quarantine xattrs come from browser downloads, not Node's fetch - but strip
      // defensively so Gatekeeper can never block the .scx from loading into scsynth.
      try {
        execFileSync('xattr', ['-dr', 'com.apple.quarantine', destDir]);
      } catch {
        // fine - nothing was quarantined
      }
    }
    if (!vstPluginExtensionInstalled()) {
      throw new Error(`installed to ${destDir} but the extension check still fails - please report this`);
    }
    log.log(`[poptart] VSTPlugin installed to ${destDir}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------------------------

// Like resolveSclangPath(), but answers "is it actually installed?" instead of "what do we
// spawn?" (resolveSclangPath falls back to bare 'sclang' precisely so the not-installed case
// fails with the binary named - here we want to catch that case before it fails). `source` says
// which rule matched, which is the thing worth printing: "found" is not interesting, "found the
// private copy rather than the one in /Applications" is.
//
// The order has to match resolveSclangPath()'s exactly, or setup would report on one SC while
// the engine booted another.
function sclangStatus() {
  if (process.env.POPTART_SCLANG) {
    return { found: true, path: process.env.POPTART_SCLANG, source: 'POPTART_SCLANG' };
  }
  if (privateScInstalled()) return { found: true, path: privateSclangPath(), source: 'private' };
  if (onPath('sclang')) return { found: true, path: 'sclang', source: 'PATH' };
  for (const loc of knownSclangLocations()) {
    try {
      fs.accessSync(loc, fs.constants.X_OK);
      return { found: true, path: loc, source: 'system' };
    } catch {
      // not here - try the next candidate
    }
  }
  return { found: false, path: null, source: null };
}

// A symlinked sclang on PATH shadows nothing poptart needs (it resolves the real binary
// itself) but breaks class-library resolution for whoever spawns it - the README's oldest
// troubleshooting entry. `pathDirs` is injectable for tests.
function findSclangSymlinkOnPath(pathDirs = (process.env.PATH || '').split(path.delimiter)) {
  const names = process.platform === 'win32' ? ['sclang.exe'] : ['sclang'];
  for (const dir of pathDirs.filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// sclang/scsynth processes already alive before we've spawned anything are either the SC IDE
// (deliberate - don't touch) or orphans from a crashed run holding poptart's ports or the
// audio device. We can't tell which, so warn with the pkill rather than killing.
function runningEngineProcesses() {
  const found = [];
  for (const name of ['sclang', 'scsynth']) {
    try {
      if (process.platform === 'win32') {
        // tasklist exits 0 whether or not it matched, printing an INFO line when it didn't, so
        // the image name has to be looked for in the output rather than inferred from the code.
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH', '/FO', 'CSV'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
        if (out.toLowerCase().includes(`${name}.exe`)) found.push(name);
      } else {
        execFileSync('pgrep', ['-x', name], { stdio: ['ignore', 'pipe', 'ignore'] });
        found.push(name); // pgrep exits 0 only when something matched
      }
    } catch {
      // exit 1: no such process (or no pgrep/tasklist) - nothing to report
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The one entry point the server calls. Logs its findings, returns a summary (for tests and
// a future /api/status surface), never throws.
// ---------------------------------------------------------------------------------------------

const SC_INSTALL_HINT =
  process.platform === 'darwin'
    ? 'install it with: brew install --cask supercollider'
    : process.platform === 'win32'
      ? 'install it from https://supercollider.github.io/downloads (poptart finds it in Program Files)'
      : 'install it via your package manager (e.g. apt install supercollider)';

async function runSetup({ log = console } = {}) {
  const summary = { sclangFound: false, sclangSource: null, privateSc: null, vstPlugin: 'present', warnings: [] };
  const warn = (msg) => {
    summary.warnings.push(msg);
    log.warn(`[poptart]   ! ${msg}`);
  };
  log.log('[poptart] setup:');

  let sc = sclangStatus();
  // Offer poptart its own SuperCollider when there isn't one to use - and, when
  // POPTART_INSTALL_SC=1 says so, even if there is (someone deliberately moving off a system
  // install). consentToInstall() decides; it never downloads on its own initiative, because
  // this is 139-250MB (see private-sc.js).
  if (!privateScInstalled()) {
    const consent = await consentToInstall({ systemScFound: sc.found });
    if (consent.install) {
      try {
        await installPrivateSc({ log });
        summary.privateSc = 'installed';
        sc = sclangStatus();
      } catch (err) {
        summary.privateSc = 'failed';
        warn(`could not install poptart's own SuperCollider (${err.message})`);
      }
    } else if (!sc.found) {
      summary.privateSc = 'declined';
      log.log(`[poptart]   . not fetching SuperCollider: ${consent.reason}`);
    }
  }

  summary.sclangFound = sc.found;
  summary.sclangSource = sc.source;
  if (sc.source === 'private') {
    log.log(
      `[poptart]   + SuperCollider ${SC_RELEASE.version}, poptart's own copy (${privateScRoot()})`,
    );
  } else if (sc.found) {
    log.log(`[poptart]   + SuperCollider found (${sc.path})`);
  } else {
    warn(
      `SuperCollider not found - ${SC_INSTALL_HINT}, or let poptart fetch its own copy with ` +
        'POPTART_INSTALL_SC=1 (or set POPTART_SCLANG to your sclang binary)',
    );
  }

  const stale = vstPluginExtensionInstalled() ? outdatedHostDir() : null;
  if (stale) {
    // An outdated build (see OUTDATED_MACOS_HOSTS). Upgrade in place when it is in the dir we
    // install to; a system-wide copy can't be fixed from here (installing beside it would
    // duplicate the classes and break sclang's boot).
    if (stale.dir === vstPluginExtensionDirs()[0]) {
      log.log(`[poptart]   ~ VSTPlugin found, but it is ${stale.why} - upgrading`);
      try {
        await installVstPlugin({ log });
        summary.vstPlugin = 'upgraded';
      } catch (err) {
        warn(
          `could not upgrade VSTPlugin (${err.message}) - it is ${stale.why}. Reinstall from ` +
            'https://github.com/glossings/vstplugin/releases',
        );
      }
    } else {
      warn(
        `VSTPlugin at ${stale.dir} is ${stale.why}. Replace that install with the macOS zip ` +
          'from https://github.com/glossings/vstplugin/releases',
      );
    }
  } else if (vstPluginExtensionInstalled()) {
    log.log('[poptart]   + VSTPlugin extension found');
  } else {
    try {
      await installVstPlugin({ log });
      summary.vstPlugin = 'installed';
    } catch (err) {
      summary.vstPlugin = 'failed';
      const manualSource =
        process.platform === 'darwin'
          ? 'download the macOS zip from https://github.com/glossings/vstplugin/releases (poptart\'s ' +
            'build - fixes a probe crash that upstream v0.6.2 has) '
          : 'download your platform build from https://git.iem.at/pd/vstplugin/-/releases ';
      warn(
        `could not auto-install the VSTPlugin extension (${err.message}). Manual install: ` +
          manualSource +
          `and unzip its sc/VSTPlugin folder into ${vstPluginExtensionDirs()[0]}`,
      );
    }
  }

  // A symlinked sclang on PATH only matters when PATH is how sclang gets found. The private
  // copy is resolved by full path and outranks PATH entirely, so the warning would be noise.
  const symlink = sc.source === 'private' ? null : findSclangSymlinkOnPath();
  if (symlink) {
    warn(
      `${symlink} is a symlink - a symlinked sclang can't find its class library and poptart ` +
        `auto-detects the real install anyway. Delete it: rm ${symlink}`,
    );
  }

  const running = runningEngineProcesses();
  if (running.length) {
    // Before advising anything: is this our own other session? A live pidfile says yes, and the
    // advice then has to be the opposite of the orphan advice - killing by name would take down
    // a poptart someone is working in.
    const ours = liveEngineStacks();
    if (ours.length) {
      const pids = ours
        .map((s) => Object.entries(s.pids).map(([name, pid]) => `${name} ${pid}`).join(', '))
        .join('; ');
      warn(
        `another poptart is already running (${pids}). Quit it before starting this one - two ` +
          "stacks fight over poptart's OSC ports and the audio device. Don't kill sclang or " +
          'scsynth by name; that would take the other session down with them.',
      );
    } else {
      const kill =
        process.platform === 'win32'
          ? 'taskkill /IM sclang.exe /F & taskkill /IM scsynth.exe /F'
          : 'pkill -x sclang; pkill -x scsynth';
      warn(
        `${running.join(' and ')} already running - if that's not a SuperCollider IDE you're using, ` +
          `it's an orphan that may hold poptart's ports or the audio device: ${kill}`,
      );
    }
  }

  return summary;
}

module.exports = {
  runSetup,
  installVstPlugin,
  pickAsset,
  assetUrl,
  outdatedHostDir,
  OUTDATED_MACOS_HOSTS,
  sha256File,
  extractZip,
  sclangStatus,
  findSclangSymlinkOnPath,
  runningEngineProcesses,
  VSTPLUGIN_RELEASE,
};
