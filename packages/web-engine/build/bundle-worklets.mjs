// Bundles each worklet into one self-contained file.
//
// An AudioWorklet is loaded with `addModule(url)`, and whether the browser will then honor an
// `import` statement inside it is not something this project can find out from here - it varies
// by engine and by version, and a wrong guess means the devices poptart wrote itself fail to
// load in somebody's browser with no way for us to have caught it. A single classic script
// works everywhere, unconditionally, so each worklet is flattened into one.
//
// The result is COMMITTED, so cloning the repo and serving `public/` is enough to run the web
// build - which is the same promise the rest of poptart makes about its prebuilt pieces.
//
// This is not a general bundler and must not become one. It handles exactly the subset of the
// module syntax this package's DSP is written in, and it REFUSES anything else rather than
// guessing: a bundler that silently mis-handles a re-export produces a worklet that loads and
// then behaves subtly wrong, which is the worst possible failure for audio code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** The worklets to build: entry file in, published file out. */
export const WORKLETS = [
  { entry: 'src/worklets/synths.worklet.js', out: 'poptart-synths.js' },
  // One file for the effects we wrote, and one for every ported device: within each, the
  // processors share an implementation and differ only in their DSP and their controls.
  { entry: 'src/worklets/effects.worklet.js', out: 'poptart-effects.js' },
  { entry: 'src/worklets/wasm.worklet.js', out: 'poptart-wasm.js' },
];

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"];?\s*$/;
const BARE_IMPORT_RE = /^import\s+['"]([^'"]*)['"];?\s*$/;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\}\s*;?\s*$/;
const DECLARATION_RE = /^(?:export\s+)?(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/;

/** Everything a file declares at its top level, which is what can collide once flattened. */
export function topLevelNames(source) {
  const names = [];
  for (const line of source.split('\n')) {
    const m = DECLARATION_RE.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Reads a module, checks it is written in the subset this can flatten, and reports its imports.
 * Anything outside the subset throws by name and line, because the alternative is a worklet
 * that is quietly wrong.
 */
export function readModule(file, source) {
  const imports = [];
  const body = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const named = IMPORT_RE.exec(trimmed);
    if (named) {
      imports.push(named[2]);
      continue;                                   // the names come into scope by flattening
    }
    if (EXPORT_LIST_RE.test(trimmed)) continue;   // a re-export is a no-op once flattened
    if (BARE_IMPORT_RE.test(trimmed)) {
      throw new Error(`${file}:${i + 1}: a side-effect import cannot be flattened`);
    }
    if (/^import\s/.test(trimmed)) {
      throw new Error(`${file}:${i + 1}: only single-line named imports of relative modules can be flattened - "${trimmed}"`);
    }
    if (/^export\s+default/.test(trimmed)) {
      throw new Error(`${file}:${i + 1}: a default export cannot be flattened`);
    }
    if (/^export\s*\*/.test(trimmed)) {
      throw new Error(`${file}:${i + 1}: a star re-export cannot be flattened`);
    }
    // `export const x = 1` becomes `const x = 1`; everything else is left exactly as written.
    body.push(line.replace(/^(\s*)export\s+/, '$1'));
  }
  return { imports, body: body.join('\n') };
}

/**
 * Walks the import graph depth first and returns the modules in the order they have to appear.
 *
 * Depth first with the dependency emitted BEFORE its dependent is what makes the flattened file
 * valid: `const` is not hoisted, so a module whose top-level code reads another module's
 * constant has to come after it.
 */
export function collect(entryPath, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const order = [];
  const seen = new Set();
  const visiting = new Set();

  const walk = (file) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    if (visiting.has(resolved)) {
      throw new Error(`circular import through ${path.relative(root, resolved)}`);
    }
    visiting.add(resolved);
    const source = readFile(resolved);
    const parsed = readModule(path.relative(root, resolved), source);
    for (const spec of parsed.imports) walk(path.resolve(path.dirname(resolved), spec));
    visiting.delete(resolved);
    seen.add(resolved);
    order.push({ file: resolved, ...parsed });
  };

  walk(entryPath);
  return order;
}

/** Flattens one worklet, refusing any name two of its modules both declare. */
export function bundle(entryPath, readFile) {
  const modules = collect(entryPath, readFile);
  const owner = new Map();
  for (const m of modules) {
    for (const name of topLevelNames(m.body)) {
      const had = owner.get(name);
      if (had) {
        throw new Error(
          `"${name}" is declared by both ${path.relative(root, had)} and ${path.relative(root, m.file)}. `
          + 'Flattening would silently keep one of them - rename it.',
        );
      }
      owner.set(name, m.file);
    }
  }
  const header = [
    '// Generated by build/bundle-worklets.mjs - do not edit.',
    '// The sources are under packages/web-engine/src; this is those files flattened into one',
    '// classic script so that addModule() loads it in every browser.',
    '',
  ].join('\n');
  const parts = modules.map((m) => `// ---- ${path.relative(root, m.file)} ${'-'.repeat(Math.max(0, 60 - path.relative(root, m.file).length))}\n${m.body.trim()}`);
  return `${header}${parts.join('\n\n')}\n`;
}

/** Builds every worklet and writes it into the package's public folder. */
export function buildAll({ write = true } = {}) {
  const outDir = path.join(root, 'public', 'worklets');
  if (write) fs.mkdirSync(outDir, { recursive: true });
  const built = [];
  for (const w of WORKLETS) {
    const code = bundle(path.join(root, w.entry));
    const target = path.join(outDir, w.out);
    if (write) fs.writeFileSync(target, code);
    built.push({ out: w.out, bytes: Buffer.byteLength(code) });
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  for (const b of buildAll()) {
    // eslint-disable-next-line no-console
    console.log(`built public/worklets/${b.out} (${(b.bytes / 1024).toFixed(1)} kB)`);
  }
}
