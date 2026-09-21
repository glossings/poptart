'use strict';

// Where poptart keeps what it writes: settings, songs, samples, recordings, caches, logs, and its
// private SuperCollider. One folder, and this is the only place that says which.
//
// The default is ~/.poptart, not the folder poptart was installed to, for three reasons. An
// install folder is often not writable (inside a signed macOS app bundle a write breaks the
// signature; under Program Files it needs an administrator). Updating or uninstalling replaces
// it, which must never take somebody's songs with it. And every poptart on the machine - a
// checkout, the desktop app, next month's version - should see the same songs and share the one
// SuperCollider download.
//
// For someone who wants it all in one place anyway - an external drive, a second independent
// setup, a poptart that travels - there are two ways to move the whole folder:
//
// - POPTART_HOME names it outright.
// - A folder called `poptart-data` that lives with poptart is used without being asked: at the
//   root of a checkout (found here), or beside the desktop app (found by desktop/portable.js,
//   which hands it over as POPTART_HOME). It is looked for, never created, so nobody ends up in
//   this mode by accident; .gitignore names it, so git neither lists the songs in it nor sweeps
//   them away with a `git clean`. The repository's root itself would work as POPTART_HOME and is
//   a bad idea for exactly those two reasons.
//
// The narrower variables (POPTART_PATTERNS_DIR, POPTART_SC_ROOT, ...) still win for the one
// location each names.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_FOLDER = 'poptart-data';

/**
 * A checkout's own data folder, or null. "A checkout" is this file sitting at
 * <root>/packages/osc-engine - in the packaged app it is under node_modules instead, and the
 * folder beside the app is portable.js's business.
 */
function checkoutDataDir({ dir = __dirname, fsImpl = fs } = {}) {
  if (path.basename(path.dirname(dir)) !== 'packages') return null;
  const candidate = path.join(dir, '..', '..', DATA_FOLDER);
  try {
    return fsImpl.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

// Looked up once: modules work their paths out at different moments (some as they load, some
// per call), and a folder that appeared mid-run must not split them across two homes.
let checkoutData;

/**
 * The folder poptart's data lives in, and why that one. `home` is for tests, and passing it
 * skips the checkout's folder: a test that names a home means that home, whatever happens to be
 * sitting in the developer's checkout.
 */
function describeHome({ env = process.env, home } = {}) {
  if (env.POPTART_HOME) return { dir: path.resolve(env.POPTART_HOME), why: 'POPTART_HOME' };
  if (home === undefined) {
    if (checkoutData === undefined) checkoutData = checkoutDataDir();
    if (checkoutData) return { dir: checkoutData, why: `the ${DATA_FOLDER} folder in this checkout` };
  }
  return { dir: path.join(home ?? os.homedir(), '.poptart'), why: null };
}

const poptartHome = (opts) => describeHome(opts).dir;

module.exports = { poptartHome, describeHome, checkoutDataDir, DATA_FOLDER };
