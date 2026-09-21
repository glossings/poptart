'use strict';

// Tests for portable mode's detection (portable.js). The rule being held: the data folder is
// found, never made; it is beside the app, never inside it; and anything that makes "beside"
// meaningless - development, a translocated Mac app - means no portable mode, not a guess.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { portableHome, appContainer, DATA_FOLDER } = require('./portable');

const dirs = (...present) => ({
  statSync: (p) => {
    if (!present.includes(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  },
});

test('macOS: the folder is looked for beside poptart.app, not inside it', () => {
  const execPath = '/Volumes/Gig/poptart.app/Contents/MacOS/poptart';
  assert.strictEqual(appContainer({ platform: 'darwin', execPath }), '/Volumes/Gig');
  const beside = path.join('/Volumes/Gig', DATA_FOLDER);
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'darwin', execPath, env: {}, fsImpl: dirs(beside) }), beside);
  const inside = path.join('/Volumes/Gig/poptart.app/Contents/MacOS', DATA_FOLDER);
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'darwin', execPath, env: {}, fsImpl: dirs(inside) }), null);
});

test('macOS: a translocated app has no "beside"', () => {
  const execPath = '/private/var/folders/xy/T/AppTranslocation/1B2C-3D/d/poptart.app/Contents/MacOS/poptart';
  assert.strictEqual(appContainer({ platform: 'darwin', execPath }), null);
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'darwin', execPath, env: {}, fsImpl: { statSync: () => ({ isDirectory: () => true }) } }), null);
});

test('Windows and Linux: next to the executable; an AppImage means next to the AppImage', () => {
  const win = path.win32.join('D:\\tools\\poptart', 'poptart.exe');
  assert.strictEqual(appContainer({ platform: 'linux', execPath: '/opt/poptart/poptart', env: {} }), '/opt/poptart');
  assert.strictEqual(appContainer({ platform: 'linux', execPath: '/tmp/.mount_pop123/poptart', env: { APPIMAGE: '/home/u/apps/poptart.AppImage' } }), '/home/u/apps');
  assert.ok(appContainer({ platform: 'win32', execPath: win, env: {} }));
  const beside = path.join('/opt/poptart', DATA_FOLDER);
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: {}, fsImpl: dirs(beside) }), beside);
});

test('no folder, no portable mode - and the folder is never created', () => {
  let touched = false;
  const fsImpl = { statSync: () => { throw new Error('ENOENT'); }, mkdirSync: () => { touched = true; } };
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: {}, fsImpl }), null);
  assert.strictEqual(touched, false);
  const aFile = { statSync: () => ({ isDirectory: () => false }) };
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: {}, fsImpl: aFile }), null, 'a file of that name is not a data folder');
});

test('development never looks, and an explicit POPTART_HOME is left alone', () => {
  const everything = { statSync: () => ({ isDirectory: () => true }) };
  assert.strictEqual(portableHome({ isPackaged: false, platform: 'linux', execPath: '/repo/node_modules/electron/dist/electron', env: {}, fsImpl: everything }), null);
  assert.strictEqual(portableHome({ isPackaged: true, platform: 'linux', execPath: '/opt/poptart/poptart', env: { POPTART_HOME: '/elsewhere' }, fsImpl: everything }), null);
});
