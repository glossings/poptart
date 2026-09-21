'use strict';

// Portable mode: a folder named `poptart-data` beside the app makes that folder poptart's home
// (osc-engine/home.js) instead of ~/.poptart - settings, songs, samples, logs and the private
// SuperCollider all go in it, so the app and its data are one thing that can sit on an external
// drive, move between machines, or exist twice on one machine without the copies meeting.
//
// It is opt-in, by creating the folder: the default has to stay the home folder, because an
// install folder is the one place an update or an uninstall is entitled to delete (home.js has
// the full argument). So the folder is looked for and never made, and "beside the app" means
// beside, not inside:
//
//   Windows, Linux   next to the executable. Meant for the zip build unpacked somewhere of the
//                    user's choosing. Inside an INSTALLED copy it works too, but the uninstaller
//                    removes the install folder and everything in it.
//   macOS            next to poptart.app, never in it - a write inside the bundle breaks its
//                    signature. macOS runs an app that was never moved out of its download
//                    folder from a random read-only path ("translocation"); no folder can be
//                    beside that, so there is no portable mode until the app has been moved.
//
// No Electron, and nothing that works a path out as it loads (home.js, required for the folder's
// name, decides nothing until it is asked): main.js runs this before it loads anything else.

const fs = require('node:fs');
const path = require('node:path');

const { DATA_FOLDER } = require('@poptart/osc-engine/home'); // one name, for the app and for a checkout

// Path rules come from the `platform` argument, not from the host: everything below is written
// per platform, and reading "/Applications/poptart.app" with Windows rules answers nonsense.
// In production the two are the same thing; the difference is what lets the macOS cases be
// tested on the Windows runner, where they first went wrong.
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The folder the app itself sits in, or null when "beside the app" has no meaning. */
function appContainer({ platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const p = pathFor(platform);
  if (platform === 'darwin') {
    // .../poptart.app/Contents/MacOS/poptart
    const bundle = p.resolve(execPath, '..', '..', '..');
    if (!bundle.endsWith('.app')) return null;
    if (bundle.split(p.sep).includes('AppTranslocation')) return null;
    return p.dirname(bundle);
  }
  // An AppImage runs from a temporary mount; the file the user has is named here.
  if (platform === 'linux' && env.APPIMAGE) return p.dirname(env.APPIMAGE);
  return p.dirname(execPath);
}

/**
 * The portable data folder if this launch has one, else null.
 * An explicit POPTART_HOME wins (it is returned as null here - nothing to detect), and an
 * unpackaged run never looks: in development the "executable" is Electron inside node_modules.
 */
function portableHome({ isPackaged, platform = process.platform, execPath = process.execPath, env = process.env, fsImpl = fs } = {}) {
  if (!isPackaged || env.POPTART_HOME) return null;
  const container = appContainer({ platform, execPath, env });
  if (!container) return null;
  const candidate = pathFor(platform).join(container, DATA_FOLDER);
  try {
    return fsImpl.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

module.exports = { portableHome, appContainer, DATA_FOLDER };
