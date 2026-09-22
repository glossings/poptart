'use strict';

// Tests for portable mode's detection (portable.js). The rules being held: the data folder is
// found, never made; it is beside the app, never inside it; a folder an uninstaller would delete
// is refused rather than filled; and anything that makes "beside the app" meaningless -
// development, a translocated Mac app - means no portable mode, not a guess.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { portableHome, appContainer, DATA_FOLDER } = require('./portable');

// Every case names a platform, so expectations are built with that platform's path rules - these
// run on macOS and on the Windows runner alike, and once passed only on the first.
const posix = path.posix;

// A filesystem holding exactly these directories. `installedDirs` adds the uninstaller that
// electron-builder leaves beside an installed app.
const dirs = (...present) => ({
  statSync: (p) => {
    if (!present.includes(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  },
  readdirSync: () => ['Poptart.exe', 'resources'],
});
const installedDirs = (...present) => ({
  ...dirs(...present),
  readdirSync: () => ['Poptart.exe', 'Uninstall Poptart.exe', 'resources'],
});
const found = (opts) => portableHome(opts).dir;

test('macOS: the folder is looked for beside Poptart.app, not inside it', () => {
  const execPath = '/Volumes/Gig/Poptart.app/Contents/MacOS/Poptart';
  assert.strictEqual(appContainer({ platform: 'darwin', execPath }), '/Volumes/Gig');
  const beside = posix.join('/Volumes/Gig', DATA_FOLDER);
  assert.strictEqual(found({ isPackaged: true, platform: 'darwin', execPath, env: {}, fsImpl: dirs(beside) }), beside);
  const inside = posix.join('/Volumes/Gig/Poptart.app/Contents/MacOS', DATA_FOLDER);
  assert.strictEqual(found({ isPackaged: true, platform: 'darwin', execPath, env: {}, fsImpl: dirs(inside) }), null);
});

test('macOS: a translocated app has no "beside"', () => {
  const execPath = '/private/var/folders/xy/T/AppTranslocation/1B2C-3D/d/Poptart.app/Contents/MacOS/Poptart';
  assert.strictEqual(appContainer({ platform: 'darwin', execPath }), null);
  assert.strictEqual(
    found({ isPackaged: true, platform: 'darwin', execPath, env: {}, fsImpl: { statSync: () => ({ isDirectory: () => true }), readdirSync: () => [] } }),
    null,
  );
});

test('Windows and Linux: next to the executable; an AppImage means next to the AppImage', () => {
  assert.strictEqual(appContainer({ platform: 'linux', execPath: '/opt/poptart/poptart', env: {} }), '/opt/poptart');
  assert.strictEqual(
    appContainer({ platform: 'linux', execPath: '/tmp/.mount_pop123/poptart', env: { APPIMAGE: '/home/u/apps/poptart.AppImage' } }),
    '/home/u/apps',
  );
  assert.strictEqual(appContainer({ platform: 'win32', execPath: 'D:\\tools\\poptart\\Poptart.exe', env: {} }), 'D:\\tools\\poptart');

  const linux = posix.join('/opt/poptart', DATA_FOLDER);
  assert.strictEqual(found({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: {}, fsImpl: dirs(linux) }), linux);
  const win = `D:\\tools\\poptart\\${DATA_FOLDER}`;
  assert.strictEqual(found({ isPackaged: true, platform: 'win32', execPath: 'D:\\tools\\poptart\\Poptart.exe', env: {}, fsImpl: dirs(win) }), win);
});

test('an installed copy refuses portable mode, and says why', () => {
  // electron-builder's uninstaller ends with `RMDir /r $INSTDIR`, and an upgrade runs the old
  // uninstaller first - so a data folder next to an installed Poptart.exe is deleted by a routine
  // update. The uninstaller beside the app is the marker; the folder is ignored, not filled.
  const installDir = 'C:\\Users\\x\\AppData\\Local\\Programs\\poptart';
  const data = `${installDir}\\${DATA_FOLDER}`;
  const opts = { isPackaged: true, platform: 'win32', execPath: `${installDir}\\Poptart.exe`, env: {} };

  const unpacked = portableHome({ ...opts, fsImpl: dirs(data) });
  assert.strictEqual(unpacked.dir, data, 'a folder the user unpacked themselves is fine');
  assert.strictEqual(unpacked.declined, null);

  const installed = portableHome({ ...opts, fsImpl: installedDirs(data) });
  assert.strictEqual(installed.dir, null);
  assert.match(installed.declined, /deletes everything in that folder/);
  assert.match(installed.declined, /POPTART_HOME/, 'and names the way that does work');
});

test('with no data folder there, an installed copy has nothing to decline', () => {
  const installDir = 'C:\\Users\\x\\AppData\\Local\\Programs\\poptart';
  const r = portableHome({ isPackaged: true, platform: 'win32', execPath: `${installDir}\\Poptart.exe`, env: {}, fsImpl: installedDirs() });
  assert.deepStrictEqual(r, { dir: null, declined: null });
});

test('no folder, no portable mode - and the folder is never created', () => {
  let touched = false;
  const fsImpl = {
    statSync: () => { throw new Error('ENOENT'); },
    readdirSync: () => [],
    mkdirSync: () => { touched = true; },
  };
  assert.strictEqual(found({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: {}, fsImpl }), null);
  assert.strictEqual(touched, false);

  const aFile = { statSync: () => ({ isDirectory: () => false }), readdirSync: () => [] };
  assert.strictEqual(
    found({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: {}, fsImpl: aFile }),
    null,
    'a file of that name is not a data folder',
  );
});

test('development never looks, and an explicit POPTART_HOME is left alone', () => {
  const everything = { statSync: () => ({ isDirectory: () => true }), readdirSync: () => [] };
  assert.deepStrictEqual(
    portableHome({ isPackaged: false, platform: 'linux', execPath: '/repo/node_modules/electron/dist/electron', env: {}, fsImpl: everything }),
    { dir: null, declined: null },
  );
  assert.deepStrictEqual(
    portableHome({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: { POPTART_HOME: '/elsewhere' }, fsImpl: everything }),
    { dir: null, declined: null },
  );
});
