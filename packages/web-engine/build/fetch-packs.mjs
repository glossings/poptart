// Assembles the sourced sample packs into a repository of their own.
//
// Run by hand, not by the ordinary build: it downloads tens of megabytes from three upstream
// projects and it writes OUTSIDE this repository, because the audio is not ours to commit here.
// What it produces is a folder that is itself a git repository - packs, an index the app reads,
// a license file and generated credits - which is then pushed once and served from a CDN.
//
//   node build/fetch-packs.mjs --out ../../../poptart-packs
//   node build/fetch-packs.mjs --out ../../../poptart-packs --only pt_drumbox
//   node build/fetch-packs.mjs --plan-only          (resolve and choose, download nothing)
//
// THE LOCK FILE IS THE POINT. Every upstream reference is resolved to a commit and written to
// build/packs/upstream.lock.json, and later runs use what is written there rather than whatever
// the branch has moved on to. A pack that changed underneath a song is a song that no longer
// sounds the way it was written, and the person who wrote it would have no way to tell what
// happened - so the packs are pinned, and moving a pin is a deliberate edit with a new tag.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildIndex, creditLine } from '../src/packs/library.mjs';
import { validateManifest } from '../src/packs/manifest.mjs';
import { SOURCES, freepatsUrl, packPlans } from './packs/upstream.mjs';
import { chooseFromSfz, entryFor, planInstruments, planNamedFiles } from './packs/plan.mjs';
import { normalizeWav, PEAK_DB } from './packs/normalize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.join(here, 'packs', 'upstream.lock.json');

const log = (...args) => console.log(...args);          // eslint-disable-line no-console

// ---- upstream reads -------------------------------------------------------------------------

async function json(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'poptart-packs' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function bytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'poptart-packs' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Resolves a branch or tag to the commit it points at right now. */
async function resolveCommit(repo, ref) {
  const info = await json(`https://api.github.com/repos/${repo}/commits/${ref}`);
  if (!info?.sha) throw new Error(`could not resolve ${repo}@${ref}`);
  return info.sha;
}

/** Every path in a repository at one commit. */
async function listTree(repo, commit) {
  const tree = await json(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo} is too large to list in one request`);
  return tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
}

const rawUrl = (repo, commit, filePath) =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`;

// ---- the lock file --------------------------------------------------------------------------

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return { resolved: {} };
  }
}

function writeLock(lock) {
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * The commit a source is pinned to, resolving and recording it the first time.
 *
 * `--repin` is the deliberate edit that moves one forward. Without it an existing pin is used
 * as-is and the branch it came from is not even consulted, which is what makes a rebuild
 * reproducible on a machine that has never seen this repository before.
 */
async function pinnedCommit(lock, key, repo, ref, { repin = false } = {}) {
  if (!repin && lock.resolved[key]?.commit) return lock.resolved[key].commit;
  const commit = await resolveCommit(repo, ref);
  lock.resolved[key] = { repo, ref, commit, resolved: new Date().toISOString().slice(0, 10) };
  log(`  pinned ${key} to ${commit.slice(0, 12)}`);
  return commit;
}

// ---- building one pack ----------------------------------------------------------------------

async function buildNamedPack(plan, lock, opts) {
  const source = SOURCES[plan.source];
  const commit = await pinnedCommit(lock, plan.source, source.repo, source.ref, opts);
  const manifest = planNamedFiles(plan, source, commit);
  const fetches = manifest.files.map((f) => ({ entry: f, url: rawUrl(source.repo, commit, f.from) }));
  return { manifest, fetches, problems: [] };
}

async function buildInstrumentPack(plan, lock, opts) {
  const source = SOURCES[plan.source];
  const audio = await pinnedCommit(lock, `${plan.source}:audio`, source.repo, source.ref, opts);
  const described = await pinnedCommit(lock, `${plan.source}:sfz`, source.repo, source.sfzRef, opts);

  const sfzPaths = await listTree(source.repo, described);
  const cache = new Map();
  const readSfz = async (p) => {
    if (!cache.has(p)) cache.set(p, (await bytes(rawUrl(source.repo, described, p))).toString('utf8'));
    return cache.get(p);
  };

  const { manifest, problems } = await planInstruments(plan, source, { audio, described }, sfzPaths, readSfz);
  const fetches = manifest.files.map((f) => ({ entry: f, url: rawUrl(source.repo, audio, f.from) }));
  return { manifest, fetches, problems };
}

/**
 * The synthesized banks arrive as archives, so each one is downloaded, opened, read and thrown
 * away again. libarchive reads these without a separate tool, which keeps the build's
 * requirements to what a developer machine already has.
 */
async function buildArchivePack(plan, lock, opts, scratch) {
  const source = SOURCES[plan.source];
  const files = [];
  const problems = [];
  const fetches = [];
  fs.mkdirSync(scratch, { recursive: true });

  for (const bank of plan.banks) {
    const url = freepatsUrl(bank);
    const archive = path.join(scratch, bank.file);
    try {
      if (!fs.existsSync(archive) || opts.repin) fs.writeFileSync(archive, await bytes(url));
      const into = path.join(scratch, bank.name);
      fs.rmSync(into, { recursive: true, force: true });
      fs.mkdirSync(into, { recursive: true });
      execFileSync('bsdtar', ['-xf', archive, '-C', into], { stdio: 'pipe' });

      const sfz = walk(into).find((p) => p.toLowerCase().endsWith('.sfz'));
      if (!sfz) throw new Error('the archive holds no description');
      const relative = path.relative(into, sfz).split(path.sep).join('/');
      const chosen = chooseFromSfz(relative, fs.readFileSync(sfz, 'utf8'), { note: plan.note });
      if (!chosen) throw new Error('the description names no recording with a pitch');

      const from = path.join(into, ...chosen.path.split('/'));
      if (!fs.existsSync(from)) throw new Error(`the recording it names is not in the archive (${chosen.path})`);
      const entry = entryFor({
        name: bank.name,
        sourcePath: chosen.path,
        source,
        sourceRef: null,
        rootNote: chosen.rootNote,
        extra: chosen.loop ? { loop: chosen.loop } : {},
      });
      entry.source = url;
      files.push(entry);
      fetches.push({ entry, local: from });
    } catch (err) {
      problems.push(`${plan.id}: ${bank.title} was skipped - ${err.message}`);
    }
  }
  return {
    manifest: { id: plan.id, title: plan.title, kind: plan.kind, description: plan.description, files },
    fetches,
    problems,
  };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---- the repository this writes ---------------------------------------------------------------

function writeReadme(dir, manifests) {
  const lines = [
    '# poptart sample packs',
    '',
    'The sample packs the browser build of poptart offers. They are kept out of the main',
    'repository because a clone should not carry other people\'s recordings, and because these',
    'are redistributed under their own terms rather than under poptart\'s.',
    '',
    'Every file here is either a public domain dedication or an attribution license, and every',
    'one records where it came from - see `LICENSE` and `CREDITS.md`, which are generated, and the `source`',
    'field on each entry in a pack\'s `manifest.json`, which links to the file it was taken from.',
    '',
    'This folder is generated. Nothing in it should be edited by hand: run',
    '`node build/fetch-packs.mjs` in poptart\'s web-engine package instead, which pins every',
    'upstream reference to a commit so that a pack cannot change underneath a song that uses it.',
    '',
    '## Packs',
    '',
    ...manifests.map((m) => `- \`${m.id}\` - ${m.title}, ${m.files.length} files`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'README.md'), `${lines.join('\n')}\n`);
}

function writeCredits(dir, manifests) {
  const lines = ['# Credits', ''];
  for (const key of Object.keys(SOURCES)) {
    const s = SOURCES[key];
    lines.push(`## ${s.title}`, '', `- License: ${s.license}`, `- By: ${s.by}`, `- ${s.homepage}`, '', s.provenance, '');
  }
  lines.push('## Packs', '');
  for (const m of manifests) lines.push(`- ${creditLine(m)}`);
  lines.push('');
  fs.writeFileSync(path.join(dir, 'CREDITS.md'), `${lines.join('\n')}\n`);
}

/**
 * The legal text each license a source may carry is found at. A source under any other license
 * cannot be written into the LICENSE file, and says so rather than going in unexplained: a new
 * kind of license is a decision (upstream.mjs admits only public domain dedications and
 * attribution licenses), and this list is where it is recorded.
 */
const LICENSE_TEXTS = Object.freeze({
  'CC0-1.0': { name: 'CC0 1.0 Universal (public domain dedication)', url: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode' },
  'CC-BY-4.0': { name: 'Creative Commons Attribution 4.0 International', url: 'https://creativecommons.org/licenses/by/4.0/legalcode' },
});

/**
 * The packs repository's LICENSE file. There is no one license over the repository: the files
 * are other projects' recordings, each under its source's own terms, so this names every source
 * with its license and where the legal text is - and says in one line when they all agree.
 */
export function licenseText(sources = SOURCES) {
  const list = Object.values(sources);
  for (const s of list) {
    if (!LICENSE_TEXTS[s.license]) throw new Error(`"${s.title}" is under ${s.license}, which the packs' LICENSE does not know how to state - add it to LICENSE_TEXTS`);
  }
  const kinds = [...new Set(list.map((s) => s.license))];
  const lines = [
    '# License',
    '',
    'The files in this repository are recordings made by other projects, redistributed under',
    'each project\'s own terms. There is no single license over the repository as a whole.',
    '',
  ];
  if (kinds.length === 1) {
    const only = LICENSE_TEXTS[kinds[0]];
    lines.push(`Every source is under ${only.name}, ${kinds[0]}:`, only.url, '');
  }
  lines.push('## By source', '');
  for (const s of list) {
    const text = LICENSE_TEXTS[s.license];
    lines.push(`- ${s.title} (${s.by}): ${s.license}, ${text.url}`);
  }
  lines.push(
    '',
    'Who made each and where it came from is in `CREDITS.md`, and each pack\'s `manifest.json`',
    'links every file to the original it was taken from.',
    '',
  );
  return lines.join('\n');
}

function writeLicense(dir) {
  fs.writeFileSync(path.join(dir, 'LICENSE'), licenseText());
}

// ---- entry point -------------------------------------------------------------------------------

async function main(argv) {
  const opts = {
    out: null,
    only: null,
    planOnly: argv.includes('--plan-only'),
    repin: argv.includes('--repin'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = argv[i + 1];
    if (argv[i] === '--only') opts.only = argv[i + 1];
  }
  if (!opts.out && !opts.planOnly) {
    throw new Error('say where the packs go: --out ../../../poptart-packs (it must be outside this repository)');
  }

  const lock = readLock();
  const plans = packPlans().filter((p) => !opts.only || p.id === opts.only);
  if (plans.length === 0) throw new Error(`no pack called "${opts.only}"`);

  const scratch = path.join(here, '..', '.pack-cache');
  const manifests = [];
  const sizes = {};
  const problems = [];

  for (const plan of plans) {
    log(`${plan.id}:`);
    const built = plan.banks
      ? await buildArchivePack(plan, lock, opts, scratch)
      : plan.instruments
        ? await buildInstrumentPack(plan, lock, opts)
        : await buildNamedPack(plan, lock, opts);
    problems.push(...built.problems);
    writeLock(lock);

    // Validated before anything is written: a pack that could not ship is a pack that should
    // not be downloaded either, and the check is the same one the rendered packs pass.
    const manifest = validateManifest(built.manifest);
    manifests.push(manifest);

    if (opts.planOnly) {
      log(`  ${manifest.files.length} files chosen`);
      for (const f of manifest.files) log(`    ${f.file}  <- ${built.fetches.find((x) => x.entry.file === f.file)?.entry.from ?? '?'}`);
      continue;
    }

    const packDir = path.join(opts.out, manifest.id);
    fs.mkdirSync(packDir, { recursive: true });
    let total = 0;
    // The sampled libraries' one-shots are brought to one peak (normalize.mjs). Not the drum
    // machine's dial sweeps, whose level moving with the dial is part of what the sweep shows,
    // and not the synth banks, which arrive as FLAC at full scale already.
    const normalize = !!plan.instruments;
    for (const fetchable of built.fetches) {
      const target = path.join(packDir, fetchable.entry.file);
      let data = fetchable.local ? fs.readFileSync(fetchable.local) : await bytes(fetchable.url);
      if (normalize) {
        const scaled = normalizeWav(data);
        if (scaled.gainDb == null) log(`    ${fetchable.entry.file}: left at its own level (not a WAV this can scale)`);
        data = scaled.bytes;
      }
      fs.writeFileSync(target, data);
      total += data.length;
    }
    if (normalize) log(`  peaks set to ${PEAK_DB} dBFS`);
    sizes[manifest.id] = total;
    fs.writeFileSync(path.join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`  ${manifest.files.length} files, ${(total / 1e6).toFixed(1)} MB`);
  }

  if (!opts.planOnly) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'index.json'), `${JSON.stringify(buildIndex(manifests, { sizes }), null, 2)}\n`);
    writeCredits(opts.out, manifests);
    writeReadme(opts.out, manifests);
    writeLicense(opts.out);
    log(`\nwrote ${manifests.length} packs to ${opts.out}`);
  }

  if (problems.length) {
    log('\nnot everything was taken:');
    for (const p of problems) log(`  ${p}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[packs] ${err.message}`);   // eslint-disable-line no-console
    process.exitCode = 1;
  });
}

export { main };
