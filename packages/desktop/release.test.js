'use strict';

// Tests for the release bookkeeping (release.js): how a commit subject becomes changelog bullets,
// and that a version lands everywhere it is written down. No git and no npm - the parts that
// shell out are thin, and the parts that decide things are these.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { splitSubject, groupOf, changelogSection, withSection, sectionFor, agreedVersion, setVersion, isVersion, PACKAGES } = require('./release');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-release-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

test('a subject splits on semicolons and sentence ends, never inside parentheses', () => {
  assert.deepStrictEqual(
    splitSubject('Packaging: first test of app build (bump electron; no asar); add logging; fix misleading npm warnings. Don\'t send notes to plugins that failed to load'),
    [
      'Packaging: first test of app build (bump electron; no asar)',
      'Add logging',
      'Fix misleading npm warnings',
      'Don\'t send notes to plugins that failed to load',
    ],
  );
  assert.deepStrictEqual(splitSubject('Update outdated readmes'), ['Update outdated readmes']);
  assert.deepStrictEqual(splitSubject('Bump to v0.6.2 of the plugin host; tidy'), ['Bump to v0.6.2 of the plugin host', 'Tidy'], 'a version number is not a sentence end');
});

test('bullets are grouped by their verb, looking past a topic prefix', () => {
  assert.strictEqual(groupOf('Add logging'), 'Added');
  assert.strictEqual(groupOf('Allow splitting and joining of clips'), 'Added');
  assert.strictEqual(groupOf('Arrange: Allow splitting and joining of clips'), 'Added');
  assert.strictEqual(groupOf('Fix arrangement loop hotkey collision'), 'Fixed');
  assert.strictEqual(groupOf('Don\'t send notes to plugins that failed to load'), 'Fixed');
  assert.strictEqual(groupOf('Quality of life: fix bug where inputs resolved to the wrong channels'), 'Fixed');
  assert.strictEqual(groupOf('Make desktop launch simpler (one command: no setup)'), 'Changed');
});

test('a section lists oldest first under its groups; a first release says so', () => {
  const section = changelogSection({
    version: '0.2.0',
    date: '2026-10-01',
    subjects: ['Fix a late bug; add a late feature', 'Add an early feature'],
  });
  assert.strictEqual(section, [
    '## 0.2.0 - 2026-10-01', '',
    '### Added', '', '- Add an early feature', '- Add a late feature', '',
    '### Fixed', '', '- Fix a late bug', '',
  ].join('\n'));
  assert.strictEqual(changelogSection({ version: '0.1.0', date: '2026-10-01', subjects: [] }), '## 0.1.0 - 2026-10-01\n\nFirst release.\n');
});

test('sections stack newest first, and one can be read back for the release notes', () => {
  const first = withSection('', changelogSection({ version: '0.1.0', date: '2026-10-01', subjects: [] }));
  assert.match(first, /^# Changelog\n/);
  const second = withSection(first, changelogSection({ version: '0.2.0', date: '2026-11-01', subjects: ['Add a thing'] }));
  assert.ok(second.indexOf('## 0.2.0') < second.indexOf('## 0.1.0'));
  assert.strictEqual(second.match(/^# Changelog/gm).length, 1);
  assert.strictEqual(sectionFor(second, '0.2.0'), '### Added\n\n- Add a thing');
  assert.strictEqual(sectionFor(second, '0.1.0'), 'First release.');
  assert.strictEqual(sectionFor(second, '0.3.0'), null);
  assert.strictEqual(sectionFor(second, '0.2'), null, 'a prefix of a version is not that version');
});

test('a version is set in every package.json and both lockfiles, and nowhere else in them', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
  for (const p of PACKAGES) {
    fs.mkdirSync(path.join(root, p), { recursive: true });
    fs.writeFileSync(path.join(root, p, 'package.json'), JSON.stringify({ name: p, version: '0.1.0', dependencies: { osc: '^2.4.5' } }));
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'poptart', version: '0.1.0',
    packages: { '': { version: '0.1.0' }, 'packages/web-app': { version: '0.1.0' }, 'node_modules/osc': { version: '2.4.5' } },
  }));
  fs.writeFileSync(path.join(root, 'packages/desktop/package-lock.json'), JSON.stringify({
    name: '@poptart/desktop', version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/electron': { version: '44.4.3' } },
  }));

  assert.strictEqual(agreedVersion(root), '0.1.0');
  setVersion('0.2.0', root);
  assert.strictEqual(agreedVersion(root), '0.2.0');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.version, '0.2.0');
  assert.strictEqual(lock.packages[''].version, '0.2.0');
  assert.strictEqual(lock.packages['packages/web-app'].version, '0.2.0');
  assert.strictEqual(lock.packages['node_modules/osc'].version, '2.4.5', 'a dependency keeps its own version');
  const desktopLock = JSON.parse(fs.readFileSync(path.join(root, 'packages/desktop/package-lock.json'), 'utf8'));
  assert.strictEqual(desktopLock.packages[''].version, '0.2.0');
  assert.strictEqual(desktopLock.packages['node_modules/electron'].version, '44.4.3');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'packages/web-app/package.json'), 'utf8')).dependencies, { osc: '^2.4.5' });

  fs.writeFileSync(path.join(root, 'packages/web-app/package.json'), JSON.stringify({ version: '0.1.9' }));
  assert.throws(() => agreedVersion(root), /disagree on the version.*packages\/web-app=0\.1\.9/);
});

test('the real packages agree on a version today', () => {
  assert.ok(isVersion(agreedVersion()));
  assert.ok(!isVersion('v0.2.0') && !isVersion('0.2') && isVersion('0.2.0-beta.1'));
});
