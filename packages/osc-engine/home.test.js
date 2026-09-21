'use strict';

// Tests for poptart's data folder (home.js), and the one property the rest of the code relies
// on: nothing outside home.js knows the folder's name.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { poptartHome } = require('./home');

test('the home folder by default; POPTART_HOME moves it, resolved to an absolute path', () => {
  assert.strictEqual(poptartHome({ env: {}, home: '/Users/someone' }), path.join('/Users/someone', '.poptart'));
  assert.strictEqual(poptartHome({ env: { POPTART_HOME: '/Volumes/Gig/pt' }, home: '/Users/someone' }), path.resolve('/Volumes/Gig/pt'));
  assert.ok(path.isAbsolute(poptartHome({ env: { POPTART_HOME: 'relative/data' }, home: '/Users/someone' })));
  assert.strictEqual(poptartHome({ env: { POPTART_HOME: '' }, home: '/Users/someone' }), path.join('/Users/someone', '.poptart'));
});

test('no other module spells the folder out - a path built without home.js ignores POPTART_HOME', () => {
  const packages = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'stage', 'public', 'native'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) && file !== path.join(__dirname, 'home.js')) {
        const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/['"`]\.poptart['"`]/.test(code)) offenders.push(path.relative(packages, file));
      }
    }
  };
  walk(packages);
  assert.deepStrictEqual(offenders, []);
});

const os = require('node:os');
const { describeHome, checkoutDataDir, DATA_FOLDER } = require('./home');

test('a checkout\'s own poptart-data folder is found at its root - and only in a checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-home-'));
  const engine = path.join(root, 'packages', 'osc-engine');
  fs.mkdirSync(engine, { recursive: true });
  assert.strictEqual(checkoutDataDir({ dir: engine }), null, 'looked for, never created');
  assert.ok(!fs.existsSync(path.join(root, DATA_FOLDER)));
  fs.mkdirSync(path.join(root, DATA_FOLDER));
  assert.strictEqual(path.resolve(checkoutDataDir({ dir: engine })), path.join(root, DATA_FOLDER));

  // The packaged app keeps this module under node_modules/@poptart; nothing there is a checkout,
  // even with a folder of the right name two levels up.
  const packed = path.join(root, 'node_modules', '@poptart', 'osc-engine');
  fs.mkdirSync(packed, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', DATA_FOLDER));
  assert.strictEqual(checkoutDataDir({ dir: packed }), null);

  fs.rmSync(path.join(root, DATA_FOLDER), { recursive: true });
  fs.writeFileSync(path.join(root, DATA_FOLDER), 'a file, not a folder');
  assert.strictEqual(checkoutDataDir({ dir: engine }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POPTART_HOME outranks everything, and a named home (a test\'s) ignores the checkout', () => {
  assert.deepStrictEqual(describeHome({ env: { POPTART_HOME: '/Volumes/Gig/pt' } }), { dir: path.resolve('/Volumes/Gig/pt'), why: 'POPTART_HOME' });
  assert.deepStrictEqual(describeHome({ env: {}, home: '/Users/someone' }), { dir: path.join('/Users/someone', '.poptart'), why: null });
});

test('.gitignore keeps a checkout\'s data folder out of git', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, new RegExp(`^${DATA_FOLDER}/$`, 'm'));
});

test('code that takes a `home` for its tests does not name one in production', () => {
  // home.js skips a checkout's data folder for a NAMED home, so a default of os.homedir() on the
  // way in would quietly send that module back to ~/.poptart while the rest use poptart-data.
  const offenders = [];
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.includes('.test.'))) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
    if (!/poptartHome\(\{[^}]*\bhome\b/.test(code)) continue;
    const fns = code.split(/\n(?=function |async function )/).filter((fn) => /poptartHome\(\{[^}]*\bhome\b/.test(fn));
    for (const fn of fns) if (/\bhome = os\.homedir\(\)/.test(fn)) offenders.push(`${file}: ${fn.split('\n')[0]}`);
  }
  assert.deepStrictEqual(offenders, []);
});
