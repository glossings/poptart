'use strict';

// Makes sure Electron is installed and runnable before the desktop app is launched, so that
// starting the app is one command on a fresh checkout and never a troubleshooting session.
//
// The desktop package sits outside the npm workspaces on purpose (a plain `npm install` at the
// repository root must not pull ~200MB of Electron onto people who only want `npm run dev`), which
// means nothing installs Electron until someone asks for the app. This is that moment, so this is
// where it happens - automatically.
//
// It also repairs the one install failure actually seen in the wild: Electron's postinstall
// downloads its zip fine and then its unzip step silently produces an empty folder (extract-zip
// misbehaving on newer Node versions), leaving `electron` installed-but-unrunnable behind the
// unhelpful "Electron failed to install correctly". The zip is still sitting in Electron's
// download cache, so the fix is to unpack it ourselves with the platform's own tool.
//
// Builtins only: this runs BEFORE anything in node_modules can be assumed to exist.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DESKTOP_DIR = __dirname;

/** Where the Electron binary lives inside `node_modules/electron/dist`, per platform. */
function platformBinaryPath(platform = process.platform) {
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  if (platform === 'win32') return 'electron.exe';
  return 'electron';
}

function electronModuleDir(desktopDir = DESKTOP_DIR) {
  return path.join(desktopDir, 'node_modules', 'electron');
}

/**
 * What state is the Electron install in?
 *   'missing'  - the npm package is not there at all (nothing has been installed yet)
 *   'unpacked' - the package is there but its binary is not (the broken-unzip case)
 *   'ready'    - the binary exists and path.txt points at it
 */
function electronStatus(desktopDir = DESKTOP_DIR, platform = process.platform) {
  const dir = electronModuleDir(desktopDir);
  if (!fs.existsSync(path.join(dir, 'package.json'))) return 'missing';
  const binary = path.join(dir, 'dist', platformBinaryPath(platform));
  let pointer = null;
  try {
    pointer = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8');
  } catch {
    // no path.txt - Electron's own loader would refuse to start
  }
  return fs.existsSync(binary) && pointer === platformBinaryPath(platform) ? 'ready' : 'unpacked';
}

/** Where Electron's installer keeps downloaded zips (the defaults of its download library). */
function electronCacheDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.electron_config_cache) return env.electron_config_cache;
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'electron');
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'electron', 'Cache');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'electron');
}

/** The cached download for exactly this version/platform/arch, or null. Zips sit one hashed
 * directory down from the cache root. */
function findCachedZip({ cacheDir, version, platform = process.platform, arch = process.arch }) {
  const wanted = `electron-v${version}-${platform}-${arch}.zip`;
  let entries;
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = entry.isDirectory()
      ? path.join(cacheDir, entry.name, wanted)
      : path.join(cacheDir, entry.name);
    if (path.basename(candidate) === wanted && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The platform's own unzip: ditto keeps the app bundle's symlinks and signature intact on macOS,
// Windows 10+ ships bsdtar (which reads zips) as `tar`, and Linux has unzip.
function unpackZip(zipPath, destDir, { platform = process.platform, run = spawnSync } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const [cmd, args] =
    platform === 'darwin'
      ? ['ditto', ['-x', '-k', zipPath, destDir]]
      : platform === 'win32'
        ? ['tar', ['-xf', zipPath, '-C', destDir]]
        : ['unzip', ['-q', '-o', zipPath, '-d', destDir]];
  const res = run(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} could not unpack ${zipPath}`);
}

/** Unpack the cached zip into the electron package and write the pointer file its loader reads.
 * Returns false when there is no cached zip to repair from. */
function repairFromCache({ desktopDir = DESKTOP_DIR, platform = process.platform, arch = process.arch, cacheDir, log = console } = {}) {
  const dir = electronModuleDir(desktopDir);
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const zip = findCachedZip({ cacheDir: cacheDir ?? electronCacheDir({ platform }), version, platform, arch });
  if (!zip) return false;
  log.log(`[poptart] unpacking Electron ${version} from its download cache...`);
  unpackZip(zip, path.join(dir, 'dist'), { platform });
  // No trailing newline: Electron's loader uses this string as a path verbatim.
  fs.writeFileSync(path.join(dir, 'path.txt'), platformBinaryPath(platform));
  return true;
}

/**
 * Get Electron into a runnable state, doing as little as needed, and return the binary's path.
 * Throws with a plain explanation if it cannot - at which point the message names what failed
 * rather than leaving the user with Electron's own "failed to install correctly".
 */
function ensureElectron({ desktopDir = DESKTOP_DIR, log = console, run = spawnSync } = {}) {
  if (electronStatus(desktopDir) === 'missing') {
    log.log('[poptart] first run of the desktop app - installing Electron (one time, ~200 MB)...');
    // shell: true so `npm` resolves to npm.cmd on Windows.
    const res = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: desktopDir, stdio: 'inherit', shell: true });
    if (res.status !== 0) throw new Error('npm install failed for the desktop app - see the output above');
  }
  if (electronStatus(desktopDir) === 'unpacked') {
    // Installed, but its own unzip step came up empty. Finish the job from the cached download.
    if (!repairFromCache({ desktopDir, log })) {
      throw new Error(
        "Electron's download is missing, so it could not be unpacked. Check the network and run " +
          'this again; if it keeps failing, delete packages/desktop/node_modules and retry.',
      );
    }
  }
  if (electronStatus(desktopDir) !== 'ready') {
    throw new Error('Electron is installed but its binary is still not in place - please report this');
  }
  return path.join(electronModuleDir(desktopDir), 'dist', platformBinaryPath());
}

module.exports = {
  ensureElectron,
  electronStatus,
  electronCacheDir,
  findCachedZip,
  platformBinaryPath,
  repairFromCache,
  unpackZip,
};
