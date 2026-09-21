#!/usr/bin/env node
'use strict';

// Release bookkeeping (PACKAGING.md, "Cutting a release"). Releases are cut by tag, and this is
// everything around the tag that a person should not be doing by hand:
//
//   npm run release -- 0.2.0       prepare: refuse a dirty tree, run the tests, set the version in
//                                  every package.json and lockfile, draft the CHANGELOG.md section
//                                  from the commits since the last tag. Commits and tags NOTHING -
//                                  the draft wants an editing pass, and the commit is a person's.
//   release.js --check-tag v0.2.0  CI: fail unless the tag is the version the packages carry, so
//                                  an installer can never be named one thing and report another.
//   release.js --notes v0.2.0      CI: print that version's CHANGELOG.md section, for the
//                                  release's description.
//
// It lives here because the desktop package is what a release produces, and because this
// package's tests already run in CI. Builtins only.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PACKAGES = ['.', 'packages/osc-engine', 'packages/pattern-core', 'packages/web-app', 'packages/desktop'];
const CHANGELOG = 'CHANGELOG.md';
const CHANGELOG_HEAD = '# Changelog\n\nWhat changed in each release, newest first.\n';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const isVersion = (v) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);

/**
 * One commit subject as changelog bullets. The subjects here are written as clauses - "Topic:
 * first thing; second thing (why; with detail). Unrelated third thing" - so they split
 * mechanically: on a semicolon, or on a sentence end, but never inside parentheses.
 */
function splitSubject(subject) {
  const clauses = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < subject.length; i += 1) {
    const ch = subject[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    const sentenceEnd = ch === '.' && /^\s+[A-Z]/.test(subject.slice(i + 1));
    if (depth === 0 && (ch === ';' || sentenceEnd)) {
      clauses.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  clauses.push(current);
  return clauses
    .map((c) => c.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .map((c) => c[0].toUpperCase() + c.slice(1));
}

// Grouped by what the clause's first verb says happened. A "Topic: " prefix is looked past.
const GROUPS = [
  { title: 'Added', verbs: /^(add|allow|support|introduce)/i },
  { title: 'Fixed', verbs: /^(fix|don't|do not|avoid|stop|prevent|correct)/i },
  { title: 'Changed', verbs: /./ },
];

function groupOf(bullet) {
  const afterTopic = bullet.replace(/^[^:(]{1,40}:\s+/, '');
  return GROUPS.find((g) => g.verbs.test(afterTopic)).title;
}

/** The CHANGELOG.md section for a release, as Markdown. `subjects` is newest first, as git gives them. */
function changelogSection({ version, date, subjects }) {
  const lines = [`## ${version} - ${date}`, ''];
  if (!subjects.length) return `${[...lines, 'First release.'].join('\n')}\n`;
  const bullets = [...subjects].reverse().flatMap(splitSubject);
  for (const { title } of GROUPS) {
    const mine = bullets.filter((b) => groupOf(b) === title);
    if (!mine.length) continue;
    lines.push(`### ${title}`, '', ...mine.map((b) => `- ${b}`), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Put a new section at the top of the changelog text (creating the file's heading if needed). */
function withSection(changelog, section) {
  const text = changelog.trim() ? changelog : CHANGELOG_HEAD;
  const firstSection = text.search(/^## /m);
  if (firstSection < 0) return `${text.trimEnd()}\n\n${section}`;
  return `${text.slice(0, firstSection)}${section}\n${text.slice(firstSection)}`;
}

/** One version's section out of the changelog text, without its heading; null if it has none. */
function sectionFor(changelog, version) {
  const escaped = version.replace(/[.+-]/g, '\\$&');
  const match = changelog.match(new RegExp(`^## ${escaped}(?![\\w.-])[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return match ? match[1].trim() : null;
}

/** The version every package.json carries, or an error naming the ones that disagree. */
function agreedVersion(repoRoot = REPO_ROOT) {
  const versions = PACKAGES.map((p) => [p, readJson(path.join(repoRoot, p, 'package.json')).version]);
  const distinct = [...new Set(versions.map(([, v]) => v))];
  if (distinct.length !== 1) {
    throw new Error(`the packages disagree on the version: ${versions.map(([p, v]) => `${p}=${v}`).join(', ')}`);
  }
  return distinct[0];
}

/** Set the version everywhere it is written down: each package.json, and both lockfiles. */
function setVersion(version, repoRoot = REPO_ROOT) {
  for (const p of PACKAGES) {
    const file = path.join(repoRoot, p, 'package.json');
    writeJson(file, { ...readJson(file), version });
  }
  for (const lockDir of ['.', 'packages/desktop']) {
    const file = path.join(repoRoot, lockDir, 'package-lock.json');
    if (!fs.existsSync(file)) continue;
    const lock = readJson(file);
    lock.version = version;
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      // The lockfile's own root, and the workspace packages it links - not their dependencies.
      if (key === '' || PACKAGES.includes(key)) entry.version = version;
    }
    writeJson(file, lock);
  }
}

const git = (args, repoRoot = REPO_ROOT) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();

function lastReleaseTag(repoRoot = REPO_ROOT) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], repoRoot);
  } catch {
    return null; // no release yet
  }
}

function prepare(version, { skipTests = false } = {}) {
  if (!isVersion(version)) throw new Error(`'${version}' is not a version (expected something like 0.2.0)`);
  if (git(['status', '--porcelain'])) throw new Error('the working tree has uncommitted changes - commit or stash them first');
  if (!skipTests) {
    execFileSync('npm', ['test'], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    execFileSync('npm', ['test'], { cwd: __dirname, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const since = lastReleaseTag();
  // The whole history is not a changelog: with no earlier release there is nothing to compare to.
  const subjects = since ? git(['log', '--format=%s', `${since}..HEAD`]).split('\n').filter(Boolean) : [];
  setVersion(version);
  const file = path.join(REPO_ROOT, CHANGELOG);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, withSection(existing, changelogSection({ version, date, subjects })));
  return { since, commits: subjects.length };
}

module.exports = { splitSubject, groupOf, changelogSection, withSection, sectionFor, agreedVersion, setVersion, isVersion, PACKAGES };

if (require.main === module) {
  /* eslint-disable no-console */
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--check-tag') {
      const version = agreedVersion();
      if (args[1] !== `v${version}`) throw new Error(`the tag is ${args[1]} but the packages are at ${version} - the tag must be v${version}`);
      console.log(`[poptart] ${args[1]} matches the packages`);
    } else if (args[0] === '--notes') {
      const file = path.join(REPO_ROOT, CHANGELOG);
      const section = fs.existsSync(file) ? sectionFor(fs.readFileSync(file, 'utf8'), String(args[1]).replace(/^v/, '')) : null;
      console.log(section ?? `No ${CHANGELOG} section was written for ${args[1]}.`);
    } else {
      const version = args.find((a) => !a.startsWith('--'));
      if (!version) throw new Error('usage: npm run release -- <version> [--skip-tests]');
      const { since, commits } = prepare(version, { skipTests: args.includes('--skip-tests') });
      console.log(`[poptart] set the version to ${version} and drafted its ${CHANGELOG} section (${since ? `${commits} commit(s) since ${since}` : 'first release'}).`);
      console.log(`[poptart] Nothing is committed. Next: edit ${CHANGELOG}, review \`git diff\`, commit, then`);
      console.log(`[poptart]   git tag v${version} && git push origin main v${version}`);
      console.log('[poptart] The tag starts the release workflow, which leaves a DRAFT release to test and publish.');
    }
  } catch (err) {
    console.error(`[poptart] ${err.message}`);
    process.exit(1);
  }
}
