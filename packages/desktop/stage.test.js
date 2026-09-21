'use strict';

// Tests for the packaging stage (stage.js). Each case builds a scratch folder shaped like the
// repository - workspaces, a node_modules, a few files that must and must not ship - and stages
// it with the git queries replaced by plain lists. No git, no npm, no electron-builder: what
// matters is WHAT ends up in the app and where, because a mistake here is either a crash on a
// user's first launch (a module left behind) or somebody's personal file in a public download.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { stage, ships, LAYOUT, MARKER } = require('./stage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-stage-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const scratch = () => fs.mkdtempSync(path.join(tmp, `case-${n++}-`));

function write(root, rel, content = '') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

function installed(root, rel, pkg) {
  write(root, `${rel}/package.json`, pkg);
  write(root, `${rel}/index.js`, `// ${pkg.name}@${pkg.version}`);
}

const TRACKED = [
  'LICENSE',
  'mappings/synth.json',
  'packages/desktop/main.js',
  'packages/desktop/server-process.js',
  'packages/desktop/diagnostics.js',
  'packages/desktop/portable.js',
  'packages/desktop/loading.html',
  'packages/desktop/package.json',
  'packages/desktop/start.js',
  'packages/desktop/stage.test.js',
  'packages/desktop/build/entitlements.mac.plist',
  'packages/web-app/package.json',
  'packages/web-app/server.js',
  'packages/web-app/server.test.js',
  'packages/web-app/public/index.html',
  'packages/web-app/public/arrange.test.mjs',
  'packages/osc-engine/package.json',
  'packages/osc-engine/index.js',
  'packages/osc-engine/sc/poptart.scd',
  'packages/osc-engine/native/build.sh',
  'packages/osc-engine/native/helper.swift',
  'packages/osc-engine/native/bin/helper',
  'packages/osc-engine/native/rubberband/Shift.cpp',
  'packages/osc-engine/native/rubberband/Shift.sc',
  'packages/osc-engine/native/rubberband/bin/Shift.scx',
  'packages/pattern-core/package.json',
  'packages/pattern-core/src/index.mjs',
];

// A repository with the real one's shape: web-app needs an editor library, osc-engine needs a
// module with a hoisted dependency, a nested one and an optional one that is not installed.
function fakeRepo({ tracked = TRACKED } = {}) {
  const root = scratch();
  for (const rel of tracked) write(root, rel, rel);
  write(root, 'package.json', { name: 'poptart', version: '1.2.3', description: 'd', license: 'AGPL-3.0-only', author: 'A Publisher', workspaces: [] });
  write(root, 'packages/web-app/package.json', {
    name: '@poptart/web-app',
    version: '1.2.3',
    dependencies: { '@poptart/osc-engine': '*', '@poptart/pattern-core': '*', editor: '^5.0.0' },
  });
  write(root, 'packages/osc-engine/package.json', { name: '@poptart/osc-engine', version: '1.2.3', dependencies: { wire: '^2.0.0' } });
  write(root, 'packages/pattern-core/package.json', { name: '@poptart/pattern-core', version: '1.2.3', type: 'module' });

  installed(root, 'node_modules/editor', { name: 'editor', version: '5.6.7' });
  write(root, 'node_modules/editor/.idea/workspace.xml', 'published by accident');
  installed(root, 'node_modules/wire', {
    name: 'wire',
    version: '2.4.5',
    dependencies: { hoisted: '^1.0.0', clash: '^2.0.0' },
    optionalDependencies: { 'other-platform-only': '^1.0.0' },
  });
  installed(root, 'node_modules/hoisted', { name: 'hoisted', version: '1.0.1', dependencies: { '@scope/leaf': '^3.0.0' } });
  installed(root, 'node_modules/@scope/leaf', { name: '@scope/leaf', version: '3.0.0' });
  installed(root, 'node_modules/clash', { name: 'clash', version: '1.0.0' });
  installed(root, 'node_modules/wire/node_modules/clash', { name: 'clash', version: '2.0.0' });
  // In node_modules, needed by nothing that ships.
  installed(root, 'node_modules/dev-tool', { name: 'dev-tool', version: '9.9.9' });
  return root;
}

function run(root, { tracked = TRACKED, untracked = [] } = {}) {
  const outDir = path.join(scratch(), 'stage');
  const result = stage({ repoRoot: root, outDir, listTracked: () => tracked, listUntracked: () => untracked });
  const has = (rel) => fs.existsSync(path.join(outDir, ...rel.split('/')));
  return { outDir, result, has };
}

test('web-app and desktop keep their places; the libraries go where their names resolve', () => {
  const { has } = run(fakeRepo());
  assert.ok(has('packages/desktop/main.js'));
  assert.ok(has('packages/web-app/server.js'));
  assert.ok(has('packages/web-app/public/index.html'));
  assert.ok(has('mappings/synth.json'), 'web-app reads ../../mappings');
  assert.ok(has('LICENSE'));
  assert.ok(has('node_modules/@poptart/osc-engine/index.js'));
  assert.ok(has('node_modules/@poptart/osc-engine/sc/poptart.scd'));
  assert.ok(has('node_modules/@poptart/pattern-core/src/index.mjs'));
  assert.ok(!has('packages/osc-engine'), 'one copy of the engine, not two');
  assert.ok(!has('packages/pattern-core'));
});

test('the staged app resolves the libraries by name, from both packages that require them', () => {
  const { outDir } = run(fakeRepo());
  for (const from of ['packages/desktop', 'packages/web-app']) {
    const paths = [path.join(outDir, ...from.split('/'))];
    assert.strictEqual(
      fs.realpathSync(require.resolve('@poptart/osc-engine', { paths })),
      fs.realpathSync(path.join(outDir, 'node_modules', '@poptart', 'osc-engine', 'index.js')),
    );
    assert.ok(require.resolve('@poptart/pattern-core/package.json', { paths }).startsWith(fs.realpathSync(outDir)));
  }
});

test('nothing staged is a symlink', () => {
  const { outDir } = run(fakeRepo());
  const entries = fs.readdirSync(outDir, { recursive: true, withFileTypes: true });
  assert.ok(entries.length > 10);
  assert.deepStrictEqual(entries.filter((e) => e.isSymbolicLink()).map((e) => e.name), []);
});

test('tests, launcher-only files and native sources stay behind; built helpers ship', () => {
  const { has } = run(fakeRepo());
  assert.ok(!has('packages/web-app/server.test.js'));
  assert.ok(!has('packages/web-app/public/arrange.test.mjs'));
  assert.ok(!has('packages/desktop/start.js'));
  assert.ok(!has('packages/desktop/stage.test.js'));
  assert.ok(!has('packages/desktop/build'));
  assert.ok(!has('node_modules/@poptart/osc-engine/native/build.sh'));
  assert.ok(!has('node_modules/@poptart/osc-engine/native/helper.swift'));
  assert.ok(!has('node_modules/@poptart/osc-engine/native/rubberband/Shift.cpp'));
  assert.ok(has('node_modules/@poptart/osc-engine/native/bin/helper'));
  assert.ok(has('node_modules/@poptart/osc-engine/native/rubberband/bin/Shift.scx'));
  assert.ok(has('node_modules/@poptart/osc-engine/native/rubberband/Shift.sc'), 'the class file is installed beside the .scx');
});

test('every file the shell requires is on the list of files staged from this folder', () => {
  // The list is an allowlist, so a new module is left out of the app until it is added - and
  // the first anyone hears of it is a packaged app that dies on launch.
  const entry = LAYOUT.find((e) => e.from === 'packages/desktop');
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(entry.only.includes(file), `${file} is required by the shell but not staged`);
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const [, local] of source.matchAll(/require\('\.\/([\w-]+)'\)/g)) visit(`${local}.js`);
  };
  visit('main.js');
  assert.ok(seen.has('diagnostics.js') && seen.has('server-process.js'));
  assert.ok(entry.only.includes('loading.html'));
});

test('a shell script outside native/ is not mistaken for a build script', () => {
  const entry = LAYOUT.find((e) => e.from === 'packages/osc-engine');
  assert.strictEqual(ships('native/link/build.sh', entry), false);
  assert.strictEqual(ships('scripts/reset.sh', entry), true);
});

test('a file git does not track is left out and reported', () => {
  const root = fakeRepo();
  write(root, 'packages/web-app/prebake.local.js', 'personal');
  write(root, 'packages/web-app/scratch.test.js', 'would not ship anyway');
  const { has, result } = run(root, {
    untracked: ['packages/web-app/prebake.local.js', 'packages/web-app/scratch.test.js'],
  });
  assert.ok(!has('packages/web-app/prebake.local.js'));
  assert.deepStrictEqual(result.untracked, ['packages/web-app/prebake.local.js']);
});

test('third-party modules: the whole closure, nested copies in place, nothing else', () => {
  const { outDir, has, result } = run(fakeRepo());
  const version = (rel) => JSON.parse(fs.readFileSync(path.join(outDir, ...rel.split('/'), 'package.json'), 'utf8')).version;
  assert.strictEqual(version('node_modules/editor'), '5.6.7');
  assert.strictEqual(version('node_modules/wire'), '2.4.5');
  assert.strictEqual(version('node_modules/hoisted'), '1.0.1');
  assert.strictEqual(version('node_modules/@scope/leaf'), '3.0.0', 'a dependency of a dependency');
  assert.strictEqual(version('node_modules/wire/node_modules/clash'), '2.0.0', 'wire gets its own clash');
  assert.ok(!has('node_modules/clash'), 'the hoisted clash is nobody\'s dependency here');
  assert.ok(!has('node_modules/dev-tool'));
  assert.ok(has('node_modules/editor/index.js'));
  assert.ok(!has('node_modules/editor/.idea'), 'a module author\'s editor settings');
  assert.ok(!has('node_modules/@poptart/web-app'), 'web-app ships under packages/, not as a module');
  assert.deepStrictEqual(
    result.modules.map((m) => m.rel).sort(),
    ['node_modules/@scope/leaf', 'node_modules/editor', 'node_modules/hoisted', 'node_modules/wire', 'node_modules/wire/node_modules/clash'],
  );
});

test('a required module that is not installed stops the build; an optional one does not', () => {
  const root = fakeRepo();
  fs.rmSync(path.join(root, 'node_modules', 'hoisted'), { recursive: true });
  assert.throws(() => run(root), /wire depends on hoisted, which is not installed/);
});

test('a part of the layout that staged nothing stops the build', () => {
  const root = fakeRepo();
  assert.throws(() => run(root, { tracked: [] }), /nothing was staged from packages\/desktop/);
  assert.throws(
    () => run(root, { tracked: TRACKED.filter((f) => !f.startsWith('mappings/')) }),
    /nothing was staged from mappings/,
  );
});

test('a file on the shell\'s own list that git does not track stops the build', () => {
  const root = fakeRepo();
  assert.throws(
    () => run(root, { tracked: TRACKED.filter((f) => f !== 'packages/desktop/server-process.js') }),
    /packages\/desktop\/server-process\.js is part of the app but git does not track it/,
  );
});

test('the generated package.json is what electron-builder walks', () => {
  const { outDir } = run(fakeRepo());
  const pkg = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'poptart');
  assert.strictEqual(pkg.version, '1.2.3');
  assert.strictEqual(pkg.main, 'packages/desktop/main.js');
  assert.strictEqual(pkg.author, 'A Publisher');
  assert.ok(fs.existsSync(path.join(outDir, ...pkg.main.split('/'))));
  // Installed versions, not ranges: web-app's own dependency has to be named at the top,
  // because web-app is not a module the walk would pass through.
  assert.deepStrictEqual(pkg.dependencies, {
    '@poptart/osc-engine': '1.2.3',
    '@poptart/pattern-core': '1.2.3',
    editor: '5.6.7',
    wire: '2.4.5',
  });
  assert.strictEqual(pkg.workspaces, undefined);
});

test('staging again replaces the old stage, stale files included', () => {
  const root = fakeRepo();
  const outDir = path.join(scratch(), 'stage');
  const opts = { repoRoot: root, outDir, listUntracked: () => [] };
  stage({ ...opts, listTracked: () => TRACKED });
  const stale = path.join(outDir, 'packages', 'web-app', 'public', 'index.html');
  assert.ok(fs.existsSync(stale));
  stage({ ...opts, listTracked: () => TRACKED.filter((f) => f !== 'packages/web-app/public/index.html') });
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(path.join(outDir, MARKER)));
});

test('a folder stage.js did not make is never deleted', () => {
  const root = fakeRepo();
  const outDir = scratch();
  write(outDir, 'somebody-elses-work.txt', 'keep');
  assert.throws(
    () => stage({ repoRoot: root, outDir, listTracked: () => TRACKED, listUntracked: () => [] }),
    /was not made by stage\.js/,
  );
  assert.ok(fs.existsSync(path.join(outDir, 'somebody-elses-work.txt')));
});

test('electron-builder packages the Electron version the lockfile installs', () => {
  const config = fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8');
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'));
  const [, configured] = config.match(/^electronVersion: (\S+)$/m) ?? [];
  assert.strictEqual(configured, lock.packages['node_modules/electron'].version);
});
