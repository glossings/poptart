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
// ---------------------------------------------------------------------------------------------

const VSTPLUGIN_UPLOAD_BASE = 'https://git.iem.at/-/project/485/uploads';

const MACOS_ASSET = {
  file: 'vstplugin_v0.6.2_macOS.zip',
  upload: 'd7d04b43c6e025d00ddb7cd73217aadf',
  sha256: '82f0bc18ed17a61467231d3320e351e885d39b5187dbd776f9dc83eda9ff40af',
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
  return `${VSTPLUGIN_UPLOAD_BASE}/${asset.upload}/${asset.file}`;
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
// fails with the binary named - here we want to catch that case before it fails).
function sclangStatus() {
  if (process.env.POPTART_SCLANG) return { found: true, path: process.env.POPTART_SCLANG };
  if (onPath('sclang')) return { found: true, path: 'sclang' };
  for (const loc of knownSclangLocations()) {
    try {
      fs.accessSync(loc, fs.constants.X_OK);
      return { found: true, path: loc };
    } catch {
      // not here - try the next candidate
    }
  }
  return { found: false, path: null };
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
  if (process.platform === 'win32') return []; // best-effort; pgrep has no clean equivalent
  const found = [];
  for (const name of ['sclang', 'scsynth']) {
    try {
      execFileSync('pgrep', ['-x', name], { stdio: ['ignore', 'pipe', 'ignore'] });
      found.push(name); // pgrep exits 0 only when something matched
    } catch {
      // exit 1: no such process (or no pgrep) - nothing to report
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
  const summary = { sclangFound: false, vstPlugin: 'present', warnings: [] };
  const warn = (msg) => {
    summary.warnings.push(msg);
    log.warn(`[poptart]   ! ${msg}`);
  };
  log.log('[poptart] setup:');

  const sc = sclangStatus();
  summary.sclangFound = sc.found;
  if (sc.found) {
    log.log(`[poptart]   + SuperCollider found (${sc.path})`);
  } else {
    warn(`SuperCollider not found - ${SC_INSTALL_HINT} (or set POPTART_SCLANG to your sclang binary)`);
  }

  if (vstPluginExtensionInstalled()) {
    log.log('[poptart]   + VSTPlugin extension found');
  } else {
    try {
      await installVstPlugin({ log });
      summary.vstPlugin = 'installed';
    } catch (err) {
      summary.vstPlugin = 'failed';
      warn(
        `could not auto-install the VSTPlugin extension (${err.message}). Manual install: ` +
          'download your platform build from https://git.iem.at/pd/vstplugin/-/releases and ' +
          `unzip its sc/VSTPlugin folder into ${vstPluginExtensionDirs()[0]}`,
      );
    }
  }

  const symlink = findSclangSymlinkOnPath();
  if (symlink) {
    warn(
      `${symlink} is a symlink - a symlinked sclang can't find its class library and poptart ` +
        `auto-detects the real install anyway. Delete it: rm ${symlink}`,
    );
  }

  const running = runningEngineProcesses();
  if (running.length) {
    warn(
      `${running.join(' and ')} already running - if that's not a SuperCollider IDE you're using, ` +
        "it's an orphan that may hold poptart's ports or the audio device: pkill -x sclang; pkill -x scsynth",
    );
  }

  return summary;
}

module.exports = {
  runSetup,
  installVstPlugin,
  pickAsset,
  assetUrl,
  sha256File,
  extractZip,
  sclangStatus,
  findSclangSymlinkOnPath,
  runningEngineProcesses,
  VSTPLUGIN_RELEASE,
};
