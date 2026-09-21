'use strict';

// Keeps poptart's own SuperCollider extension (the PoptartPitchShift UGen behind the decks'
// keylock - native/rubberband/) installed in the user's SC Extensions folder, which is the one
// place BOTH halves of the engine look: sclang compiles the class file from there and scsynth
// loads the .scx from there. Run before sclang is spawned (sclang compiles its class library at
// startup, so a file that lands later is invisible until the next boot).
//
// The files are copied, not symlinked: a symlink into a checkout that later moves or is deleted
// would leave sclang failing to compile its class library - which takes the whole engine down,
// for a reason that would look like a SuperCollider problem. A copy is compared by content and
// refreshed when the repo's version changes, so a `git pull` that rebuilt the .scx takes effect
// on the next engine boot. Missing prebuilt (a platform build.sh never ran on) = nothing to
// install; the engine's SynthDefs fall back to the in-graph SOLA keylock (see poptart.scd).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, 'native', 'rubberband');
const FILES = ['PoptartPitchShift.scx', 'PoptartPitchShift.sc'];
const SOURCES = {
  'PoptartPitchShift.scx': path.join(SOURCE_DIR, 'bin', 'PoptartPitchShift.scx'),
  'PoptartPitchShift.sc': path.join(SOURCE_DIR, 'PoptartPitchShift.sc'),
};

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
 * Which platform a native binary was built for, read off its magic number: 'darwin' (Mach-O,
 * thin or universal), 'win32' (PE), 'linux' (ELF), or null when it is none of those. The .scx
 * extension says nothing - SuperCollider uses it on macOS and Windows alike - and bin/ holds
 * whichever platform's build.sh ran last, so the file itself is the only thing to ask.
 */
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
 * Install or refresh the extension. Returns what happened, for the boot log:
 *   { installed: [names copied], upToDate: [names already current], skipped: reason|null }
 * Never throws - a failure here must not stop the engine booting (it just loses keylock's
 * pitch shifter), so problems come back in `skipped` for the caller to log.
 *
 * @param {object} [opts]
 * @param {string} [opts.extensionsDir] - override the destination (tests).
 * @param {Record<string,string>} [opts.sources] - override the source files (tests).
 * @param {string} [opts.platform] - override process.platform (tests).
 */
function ensurePoptartExtension({ extensionsDir = userExtensionsDir(), sources = SOURCES, platform = process.platform } = {}) {
  const result = { installed: [], upToDate: [], skipped: null };
  const missing = FILES.filter((f) => !fs.existsSync(sources[f]));
  if (missing.length) {
    result.skipped = `no prebuilt extension for this platform (${missing.join(', ')} not in native/rubberband)`;
    return result;
  }
  const dest = path.join(extensionsDir, 'poptart');
  // A prebuilt for another platform is the same as no prebuilt - and must not be installed:
  // scsynth fails to load it (an error on every boot), while the class file beside it compiles
  // fine, so poptart.scd would see the class, skip the SOLA fallback, and build the keylock
  // around a UGen the server does not have. Both files go, including a copy an earlier version
  // installed before this check existed.
  const builtFor = binaryPlatform(sources['PoptartPitchShift.scx']);
  if (builtFor && builtFor !== platform) {
    for (const f of FILES) {
      try {
        fs.rmSync(path.join(dest, f), { force: true });
      } catch {
        // Left in place it fails the way it always did; nothing here is worth stopping a boot for.
      }
    }
    result.skipped = `no prebuilt extension for this platform (the PoptartPitchShift.scx in native/rubberband is a ${builtFor} build)`;
    return result;
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of FILES) {
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

module.exports = {
  sclangStartupFile, ensurePoptartExtension, userExtensionsDir, EXTENSION_FILES: FILES };
