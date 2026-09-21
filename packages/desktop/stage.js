#!/usr/bin/env node
'use strict';

// Assembles the folder electron-builder packages: `stage/`, which electron-builder.yml names as
// its app directory. `npm run pack` and `npm run dist` run this first.
//
// Packaging the repository as it stands does not work, for three reasons, all found by doing it:
//
// - electron-builder does not take `node_modules` from a `files` glob. It collects modules by
//   walking the app's package.json `dependencies`, and the repository root has none (its
//   packages are npm workspaces), so the packed app came out with no node_modules at all.
// - The workspace packages are reachable by name only through symlinks in node_modules/@poptart.
//   A Windows installer cannot carry a symlink, so the staged app has none: the packages that
//   are required by name are real folders under node_modules/@poptart.
// - A glob over a package folder ships whatever is lying in it, including files git ignores
//   because they are personal (a local prebake file) or huge (the SDKs the native helpers'
//   build scripts fetch). Only files git tracks are staged, and anything untracked is reported.
//
// Third-party modules are copied from the repository's own node_modules rather than installed
// fresh, so the app ships exactly the versions package-lock.json pinned and the tests ran against.
//
// Builtins only, like the launcher: a build must not depend on the thing it is building.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STAGE_DIR = path.join(__dirname, 'stage');
const MARKER = '.poptart-stage';
const APP_MAIN = 'packages/desktop/main.js';

// Where each part of the repository lands. web-app and desktop keep their places because they
// find things by relative path (desktop -> ../web-app/server.js, web-app -> ../../mappings);
// osc-engine and pattern-core are only ever reached by package name, so they go where a package
// name resolves without a symlink.
const LAYOUT = [
  {
    from: 'packages/desktop',
    to: 'packages/desktop',
    only: ['main.js', 'server-process.js', 'diagnostics.js', 'loading.html', 'package.json'],
  },
  { from: 'packages/web-app', to: 'packages/web-app', workspace: true },
  { from: 'packages/osc-engine', to: 'node_modules/@poptart/osc-engine', workspace: true, byName: true },
  { from: 'packages/pattern-core', to: 'node_modules/@poptart/pattern-core', workspace: true, byName: true },
  { from: 'mappings', to: 'mappings' },
  { from: 'LICENSE', to: 'LICENSE' },
];

// Sources and build scripts of the native helpers; the app needs what they built (native/*/bin)
// and the SuperCollider class file that sits beside them, not these.
const NATIVE_SOURCE = /\.(cpp|swift|sh)$/;

// Folders never copied out of a third-party module.
const MODULE_JUNK = new Set(['node_modules', '.vscode', '.github', '.idea']);

/** Does a tracked file belong in the app? `rel` is relative to its LAYOUT entry, with `/`. */
function ships(rel, entry) {
  if (entry.only) return entry.only.includes(rel);
  if (/\.test\.(js|mjs)$/.test(rel)) return false;
  if (rel.startsWith('native/') && NATIVE_SOURCE.test(rel)) return false;
  return true;
}

function gitLsFiles(repoRoot, flags, paths) {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', ...flags, '--', ...paths], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

const listTrackedWithGit = (repoRoot, paths) => gitLsFiles(repoRoot, [], paths);
const listUntrackedWithGit = (repoRoot, paths) => gitLsFiles(repoRoot, ['--others', '--exclude-standard'], paths);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const native = (root, rel) => path.join(root, ...rel.split('/'));

/**
 * Find an installed module the way Node would from `fromDir`: the nearest enclosing
 * node_modules that has it, no further up than the repository's own.
 */
function resolveModule(name, fromDir, repoRoot) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === repoRoot || dir === path.dirname(dir)) return null;
  }
}

/**
 * Copy the third-party modules the staged workspaces need, and everything those need in turn.
 * Each module keeps its path relative to the repository (`node_modules/a/node_modules/b` stays
 * nested), so resolution in the staged app finds the same copy it finds in development.
 * Returns the staged modules as `{ name, version, rel }`.
 */
function stageModules({ repoRoot, outDir, seeds, workspaceNames }) {
  const staged = new Map();
  const queue = seeds.map((dir) => ({ dir }));
  while (queue.length) {
    const { dir } = queue.shift();
    const pkg = readJson(path.join(dir, 'package.json'));
    const wanted = [
      ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    ];
    for (const { name, optional } of wanted) {
      if (workspaceNames.has(name)) continue;
      const found = resolveModule(name, dir, repoRoot);
      if (!found) {
        // An optional dependency that was never installed (wrong platform) is not an error.
        if (optional) continue;
        throw new Error(`${pkg.name} depends on ${name}, which is not installed - run \`npm install\` at the repository root`);
      }
      const rel = path.relative(repoRoot, found).split(path.sep).join('/');
      if (staged.has(rel)) continue;
      if (!rel.startsWith('node_modules/')) {
        // npm nests a module under a workspace only on a version conflict with the hoisted
        // copy. It has not happened; when it does, the layout above needs a rule for it.
        throw new Error(`${name} is installed at ${rel}, outside the root node_modules - stage.js has no place for it`);
      }
      fs.cpSync(found, native(outDir, rel), {
        recursive: true,
        dereference: true,
        // Nested node_modules are staged module by module, through this same walk; the rest is
        // what some packages publish by accident, their authors' editor and CI settings.
        filter: (src) => src === found || !MODULE_JUNK.has(path.basename(src)),
      });
      staged.set(rel, { name, version: readJson(path.join(found, 'package.json')).version, rel });
      queue.push({ dir: found });
    }
  }
  return [...staged.values()];
}

/** Empty `outDir`, but only if it is a previous stage - never somebody's folder by mistake. */
function clearStage(outDir) {
  if (!fs.existsSync(outDir)) return;
  if (fs.readdirSync(outDir).length && !fs.existsSync(path.join(outDir, MARKER))) {
    throw new Error(`${outDir} is not empty and was not made by stage.js - refusing to delete it`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
}

/**
 * Build the staged app. Returns `{ files, modules, untracked }`: how many repository files were
 * copied, the third-party modules staged, and the untracked files that were left out.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.outDir]
 * @param {(repoRoot: string, paths: string[]) => string[]} [opts.listTracked] - tests
 * @param {(repoRoot: string, paths: string[]) => string[]} [opts.listUntracked] - tests
 */
function stage({
  repoRoot = REPO_ROOT,
  outDir = STAGE_DIR,
  listTracked = listTrackedWithGit,
  listUntracked = listUntrackedWithGit,
} = {}) {
  clearStage(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, MARKER), 'Made by packages/desktop/stage.js; deleted and rebuilt on every run.\n');

  const roots = LAYOUT.map((entry) => entry.from);
  let files = 0;
  for (const tracked of listTracked(repoRoot, roots)) {
    const entry = LAYOUT.find((e) => tracked === e.from || tracked.startsWith(`${e.from}/`));
    if (!entry) continue;
    const rel = tracked === entry.from ? '' : tracked.slice(entry.from.length + 1);
    if (rel && !ships(rel, entry)) continue;
    const dest = native(outDir, rel ? `${entry.to}/${rel}` : entry.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(native(repoRoot, tracked), dest);
    files += 1;
  }
  // Every entry is a tracked path, so a miss means the listing is wrong, not the repository. It
  // must not pass quietly: electron-builder looks for a module the stage lacks in the folders
  // above it, finds the repository's own, and packages that instead.
  for (const entry of LAYOUT) {
    if (!fs.existsSync(native(outDir, entry.to))) throw new Error(`nothing was staged from ${entry.from} - is it tracked by git?`);
  }
  // An `only` list names files the app cannot start without, so one that git does not track yet
  // is not a warning at the end of the run: the app it would produce dies on launch.
  for (const entry of LAYOUT) {
    for (const file of entry.only ?? []) {
      if (!fs.existsSync(native(outDir, `${entry.to}/${file}`))) {
        throw new Error(`${entry.from}/${file} is part of the app but git does not track it - \`git add\` it and run this again`);
      }
    }
  }

  const workspaces = LAYOUT.filter((entry) => entry.workspace).map((entry) => ({
    ...entry,
    dir: native(repoRoot, entry.from),
    pkg: readJson(native(repoRoot, `${entry.from}/package.json`)),
  }));
  const workspaceNames = new Set(workspaces.map((w) => w.pkg.name));
  const modules = stageModules({
    repoRoot,
    outDir,
    seeds: workspaces.map((w) => w.dir),
    workspaceNames,
  });

  // The collector starts from these. web-app is not a module in the staged app, so what it
  // depends on has to be named here for the walk to reach it.
  const dependencies = {};
  for (const w of workspaces) {
    if (w.byName) dependencies[w.pkg.name] = w.pkg.version;
    for (const name of Object.keys(w.pkg.dependencies ?? {})) {
      if (workspaceNames.has(name)) continue;
      dependencies[name] = modules.find((m) => m.rel === `node_modules/${name}`)?.version ?? w.pkg.dependencies[name];
    }
  }
  const root = readJson(path.join(repoRoot, 'package.json'));
  const appPackage = {
    name: root.name,
    version: root.version,
    description: root.description,
    license: root.license,
    author: root.author, // electron-builder's publisher name on Windows
    private: true,
    main: APP_MAIN,
    dependencies,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`);

  const untracked = listUntracked(repoRoot, roots).filter((file) => {
    const entry = LAYOUT.find((e) => file.startsWith(`${e.from}/`));
    return entry && ships(file.slice(entry.from.length + 1), entry);
  });
  return { files, modules, untracked };
}

module.exports = { stage, ships, resolveModule, LAYOUT, MARKER };

if (require.main === module) {
  /* eslint-disable no-console */
  try {
    const { files, modules, untracked } = stage();
    console.log(`[poptart] staged ${files} files and ${modules.length} modules in ${path.relative(process.cwd(), STAGE_DIR) || '.'}`);
    if (untracked.length) {
      console.warn(`[poptart] left out ${untracked.length} file(s) git does not track - add them if the app needs them:`);
      for (const file of untracked) console.warn(`[poptart]   ${file}`);
    }
  } catch (err) {
    console.error(`[poptart] could not stage the app: ${err.message}`);
    process.exit(1);
  }
}
