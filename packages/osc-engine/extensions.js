'use strict';

// Keeps poptart's own SuperCollider extensions installed in the user's SC Extensions folder,
// which is the one place BOTH halves of the engine look: sclang compiles the class files from
// there and scsynth loads the .scx files from there. There are two, independent of each other:
// the PoptartPitchShift UGen behind the decks' keylock (native/rubberband/), and PoptartDevice,
// which hosts poptart's own synths and effects (native/devices/ - the same devices the browser
// build plays). Either can be present without the other: each is a prebuilt binary, and a
// platform nobody has built one on simply does without that half. Run before sclang is spawned (sclang compiles its class library at
// startup, so a file that lands later is invisible until the next boot).
//
// The files are copied, not symlinked: a symlink into a checkout that later moves or is deleted
// would leave sclang failing to compile its class library - which takes the whole engine down,
// for a reason that would look like a SuperCollider problem. A copy is compared by content and
// refreshed when the repo's version changes, so a `git pull` that rebuilt the .scx takes effect
// on the next engine boot. Missing prebuilt (a platform nobody built one on) = nothing to
// install; the engine's SynthDefs fall back to the in-graph SOLA keylock (see poptart.scd).
//
// WHERE EACH PLATFORM'S BUILD IS. macOS's in bin/ itself, committed, where it has always been.
// Windows's and Linux's in bin/<platform>-<arch>/ (bin/win32-x64/, bin/linux-x64/), built by CI
// and shipped in the installer rather than committed; a checkout that never built them has none.
// A plugin is .scx on macOS and Windows and .so on Linux, because that is the suffix scsynth looks
// for on each. web-engine's build/devices/toolchain.mjs builds to the same places (binSubdir,
// pluginSuffix) - extensions.test.js holds the two to each other.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, 'native', 'rubberband');
const DEVICES_DIR = path.join(__dirname, 'native', 'devices');

/** A plugin's file name on a platform: scsynth loads .so on Linux and .scx everywhere else. */
function pluginFile(base, platform = process.platform) {
  return `${base}${platform === 'linux' ? '.so' : '.scx'}`;
}

/** The folder under an extension's bin/ that holds a platform's build ('' = bin/ itself, macOS). */
function binSubdir(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' ? '' : `${platform}-${arch}`;
}

/** One extension on one platform: the names it installs under, and where each comes from. */
function extensionLayout({ dir, base, classFile }, platform = process.platform, arch = process.arch) {
  const binary = pluginFile(base, platform);
  const binDir = path.join(dir, 'bin', binSubdir(platform, arch));
  return {
    binary,
    files: [binary, classFile],
    sources: { [binary]: path.join(binDir, binary), [classFile]: path.join(dir, classFile) },
    from: path.relative(__dirname, binDir).split(path.sep).join('/'),
  };
}

const PITCH_SHIFT = { dir: SOURCE_DIR, base: 'PoptartPitchShift', classFile: 'PoptartPitchShift.sc' };
const DEVICES = { dir: DEVICES_DIR, base: 'PoptartDevices', classFile: 'PoptartDevice.sc' };

const pitchShiftLayout = (platform, arch) => extensionLayout(PITCH_SHIFT, platform, arch);
const deviceLayout = (platform, arch) => extensionLayout(DEVICES, platform, arch);

// This machine's, which is what every caller but the tests wants.
const { files: FILES, sources: SOURCES } = pitchShiftLayout();
const { files: DEVICE_FILES, sources: DEVICE_SOURCES } = deviceLayout();
/** The device plugin this checkout has for this machine (tests hand its folder to scsynth). */
const DEVICE_BINARY = DEVICE_SOURCES[DEVICE_FILES[0]];
/** The device catalog, read by the engine's Node half rather than installed anywhere. */
const DEVICE_CATALOG = path.join(DEVICES_DIR, 'devices.json');

/** The user-level SuperCollider Extensions directory for this platform. */
function userExtensionsDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'SuperCollider', 'Extensions');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SuperCollider', 'Extensions');
  }
  return path.join(os.homedir(), '.local', 'share', 'SuperCollider', 'Extensions');
}

/**
 * sclang's personal startup file - run before poptart's script on every boot, private copy or
 * not (Platform.userConfigDir +/+ "startup.scd"). Used to tell "a startup.scd is hanging the
 * boot" from "there is no such file, look elsewhere".
 */
function sclangStartupFile({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SuperCollider', 'startup.scd');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'SuperCollider', 'startup.scd');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'SuperCollider', 'startup.scd');
}

/**
 * Which platform a native binary was built for, read off its magic number: 'darwin' (Mach-O,
 * thin or universal), 'win32' (PE), 'linux' (ELF), or null when it is none of those. The .scx
 * extension says nothing - SuperCollider uses it on macOS and Windows alike - so the file itself
 * is the only thing to ask; a build copied into the wrong folder is refused rather than loaded.
 */
function binaryPlatform(file) {
  const head = Buffer.alloc(4);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const magic = head.readUInt32BE(0);
  // Universal (either byte order), then 64-bit and 32-bit thin, each in both byte orders.
  if ([0xcafebabe, 0xbebafeca, 0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe].includes(magic)) return 'darwin';
  if (magic === 0x7f454c46) return 'linux';
  if (head[0] === 0x4d && head[1] === 0x5a) return 'win32';
  return null;
}

function sameContent(a, b) {
  let sa;
  let sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Install or refresh one extension. Returns what happened, for the boot log:
 *   { installed: [names copied], upToDate: [names already current], skipped: reason|null }
 * Never throws - a failure here must not stop the engine booting (it costs keylock's pitch
 * shifter, or poptart's own devices, and nothing else), so problems come back in `skipped` for
 * the caller to log.
 *
 * @param {object} [opts]
 * @param {string} [opts.extensionsDir] - override the destination (tests).
 * @param {Record<string,string>} [opts.sources] - override the source files (tests).
 * @param {string} [opts.platform] - override process.platform (tests).
 * @param {string} [opts.arch] - override process.arch (tests).
 * @param {string[]} [opts.files] - which names to install (defaults to the pitch shifter's).
 * @param {string} [opts.binary] - the name among them whose platform decides the whole group.
 * @param {string} [opts.from] - where they come from, for the message when they are missing.
 */
function ensurePoptartExtension({
  extensionsDir = userExtensionsDir(), platform = process.platform, arch = process.arch,
  layout = pitchShiftLayout(platform, arch),
  sources = layout.sources, files = layout.files, binary = layout.binary, from = layout.from,
} = {}) {
  const result = { installed: [], upToDate: [], skipped: null };
  const missing = files.filter((f) => !sources[f] || !fs.existsSync(sources[f]));
  if (missing.length) {
    result.skipped = `no prebuilt extension for this platform (${missing.join(', ')} not in ${from})`;
    return result;
  }
  const dest = path.join(extensionsDir, 'poptart');
  // A prebuilt for another platform is the same as no prebuilt - and must not be installed:
  // scsynth fails to load it (an error on every boot), while the class file beside it compiles
  // fine, so poptart.scd would see the class, skip the SOLA fallback, and build the keylock
  // around a UGen the server does not have. Both files go, including a copy an earlier version
  // installed before this check existed.
  const builtFor = binaryPlatform(sources[binary]);
  if (builtFor && builtFor !== platform) {
    for (const f of files) {
      try {
        fs.rmSync(path.join(dest, f), { force: true });
      } catch {
        // Left in place it fails the way it always did; nothing here is worth stopping a boot for.
      }
    }
    result.skipped = `no prebuilt extension for this platform (the ${binary} in ${from} is a ${builtFor} build)`;
    return result;
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) {
      const target = path.join(dest, f);
      if (sameContent(sources[f], target)) {
        result.upToDate.push(f);
        continue;
      }
      // Write beside and rename: sclang or scsynth could be reading a half-written file
      // otherwise, and a rename swaps it whole.
      const tmp = `${target}.tmp-${process.pid}`;
      fs.copyFileSync(sources[f], tmp);
      fs.renameSync(tmp, target);
      result.installed.push(f);
    }
  } catch (err) {
    result.skipped = `could not install into ${dest}: ${err.message}`;
  }
  return result;
}

/**
 * The same, for the device extension (native/devices/): poptart's own synths and effects.
 *
 * Separate from the pitch shifter rather than one list of four files, because the two are built
 * by different scripts and one can be present where the other is not - and a missing or
 * wrong-platform binary takes down only its own half. Which is what the whole-group platform
 * check is for: a class file that compiles beside an .scx scsynth cannot load would leave
 * sclang building track slots around a UGen the server does not have.
 */
function ensureDeviceExtension({ extensionsDir = userExtensionsDir(), platform = process.platform, arch = process.arch, sources } = {}) {
  const layout = deviceLayout(platform, arch);
  return ensurePoptartExtension({ extensionsDir, platform, arch, layout, sources: sources ?? layout.sources });
}

module.exports = {
  sclangStartupFile,
  ensurePoptartExtension,
  ensureDeviceExtension,
  userExtensionsDir,
  pluginFile,
  binSubdir,
  binaryPlatform,
  pitchShiftLayout,
  deviceLayout,
  EXTENSION_FILES: FILES,
  DEVICE_EXTENSION_FILES: DEVICE_FILES,
  DEVICE_BINARY,
  DEVICE_CATALOG,
};
