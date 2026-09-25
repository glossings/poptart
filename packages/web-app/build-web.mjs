// Assembles the browser build into one folder a plain file server can serve.
//
// There is no bundler and nothing is compiled. The editor is classic scripts, the host and the
// engine are native modules, and the worklets were flattened when the engine was built - so this
// is a copy, a rewrite of one line of HTML, and nothing else. That is deliberate: a build step
// is a thing that breaks between somebody wanting to change a pattern and being able to, and
// none of this code needs one.
//
// What it does have to do is reproduce the layout the desktop server serves at runtime, because
// the page asks for the same paths either way:
//
//   /                  the editor
//   /vendor/codemirror the editor component, from node_modules
//   /pattern-core      the language, as source
//   /web-engine        the devices, the worklets and the packs that ship with the app
//   /web               the host that stands in for the server
//
// The one edit is a script tag: the page has to start the host before the editor's first
// request, and the editor waits on the promise it leaves behind. On the desktop that tag is
// absent and the same editor talks to a real server instead.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(here, '..', '..');

// Built at the repository root rather than inside the package, for a reason worth writing down:
// `node --test` walks the package it runs in, and a copy of the editor's third-party dependency
// carries files named like tests. A build that lands beside the source gets picked up and run.
const DIST = path.join(repoRoot, 'dist', 'web');

/** Folders copied verbatim: where they come from, and the path they are served at. */
function sources() {
  const codemirror = path.dirname(require.resolve('codemirror/package.json'));
  const patternCore = path.join(path.dirname(require.resolve('@poptart/pattern-core/package.json')), 'src');
  const webEngine = path.join(repoRoot, 'packages', 'web-engine');
  return [
    { from: path.join(here, 'public'), to: '' },
    { from: codemirror, to: 'vendor/codemirror', only: ['lib', 'addon', 'mode', 'keymap'] },
    { from: patternCore, to: 'pattern-core' },
    { from: path.join(webEngine, 'src'), to: 'web-engine/src' },
    { from: path.join(webEngine, 'public', 'worklets'), to: 'web-engine/worklets' },
    { from: path.join(webEngine, 'public', 'packs'), to: 'web-engine/packs' },
    { from: path.join(webEngine, 'public', 'devices'), to: 'web-engine/devices' },
  ];
}

function copyTree(from, to, only = null) {
  if (!fs.existsSync(from)) throw new Error(`nothing to copy at ${from}`);
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (only && !only.includes(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const inner = copyTree(source, target);
      files += inner.files;
      bytes += inner.bytes;
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
      files += 1;
      bytes += fs.statSync(source).size;
    }
  }
  return { files, bytes };
}

/**
 * Puts the boot tag into the page, immediately before the editor.
 *
 * A classic script rather than a module, because a module is deferred and would run AFTER the
 * editor - which makes its first request before the host exists. This one runs where it stands,
 * starts the import, and leaves the promise where `api()` looks for it.
 */
export function injectBoot(html) {
  if (html.includes('__poptartHostReady')) return html;
  const anchor = '<script src="client.js"></script>';
  if (!html.includes(anchor)) throw new Error('could not find the editor script tag to boot in front of');
  const tag = [
    '    <!-- The browser build: the host runs in this page in place of a server. -->',
    '    <script>',
    '      window.__poptartHostReady = import("./web/boot.mjs")',
    '        .then((m) => m.boot())',
    '        .catch((err) => {',
    '          document.documentElement.removeAttribute("data-booting");',
    '          console.error("[poptart] could not start", err);',
    '          throw err;',
    '        });',
    '    </script>',
    `    ${anchor}`,
  ].join('\n');
  return html.replace(anchor, tag.trim().replace(/^ {4}/, ''));
}

/**
 * Puts the visit counter into the page's head: Vercel's Web Analytics, which counts page views
 * and visitors without cookies or anything that identifies a person.
 *
 * What it would report is cut down before it leaves: the URL goes without its query and its `#`,
 * because a shared link carries the whole pattern after the `#`, and only a load's FIRST page
 * view is sent, because the editor pushes a history entry per checkpoint and the script counts
 * each one as a view.
 *
 * Only this build's page gets it - the desktop app serves the same index.html and counts nothing
 * - and only off this machine: the script is served by the host at /_vercel/insights/, which a
 * local serve-web.mjs does not have, and asking for it there is a 404 on every load.
 */
export function injectAnalytics(html) {
  if (html.includes('/_vercel/insights/')) return html;
  const anchor = '</head>';
  if (!html.includes(anchor)) throw new Error('could not find the page head to put the visit counter in');
  const tag = [
    // The page's own indent before `</head>` stays in front of the first line, hence two here.
    '  <!-- Anonymous visit counts (Vercel Web Analytics), off localhost only. -->',
    '    <script>',
    '      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };',
    '      // Only the page itself is reported: never the query or the #, which can hold a whole',
    '      // shared pattern. And one page view per load, since every checkpoint is a history entry.',
    '      let counted = false;',
    '      window.va("beforeSend", (event) => {',
    '        if (event.type === "pageview") { if (counted) return null; counted = true; }',
    '        return { ...event, url: String(event.url).split(/[?#]/)[0] };',
    '      });',
    '      if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {',
    '        const s = document.createElement("script");',
    '        s.defer = true;',
    '        s.src = "/_vercel/insights/script.js";',
    '        document.head.appendChild(s);',
    '      }',
    '    </script>',
    `  ${anchor}`,
  ].join('\n');
  return html.replace(anchor, tag);
}

/**
 * The buffer a fresh page opens on.
 *
 * The desktop's names a plugin, because on the desktop there is one. This one names only what
 * this build ships: the rendered kit, the wavetable synth, its filter and the reverb, with a
 * moving control on each so the first thing anybody sees is a parameter being patterned. Every
 * control takes 0..1, which is what an lfo() runs over unless told otherwise, so neither needs
 * a range.
 */
export const WEB_SKETCH = [
  'kick: s("pt_kit:0*4")',
  'hat: s("pt_kit:4*8")',
  'keys: n("0 2 3 <5 7>")',
  '  .scale("F minor")',
  '  .synth("Wavetable")',
  '  .param("Osc 1 Position", lfo("0,0 0.5,1,-3 1,0", { rate: 0.3 }))',
  '  .fx("Filter").param("Cutoff", sine(0.25).range(0.3, 0.8))',
  '  .fx("Reverb")',
].join('\n');

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Puts this build's sketch in the editor's textarea in place of the desktop's. */
export function replaceSketch(html, sketch = WEB_SKETCH) {
  const re = /(<textarea id="editor"[^>]*>)[\s\S]*?(<\/textarea>)/;
  if (!re.test(html)) throw new Error('could not find the editor textarea to put the sketch in');
  return html.replace(re, (_m, open, close) => `${open}${escapeText(sketch)}${close}`);
}

export function build({ out = DIST, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);   // eslint-disable-line no-console
  // Emptied rather than removed. Somebody serving the last build is sitting IN this folder, and
  // a shell or a server whose working directory is deleted out from under it does not notice:
  // it goes on holding a directory that no longer exists, and every command it runs afterwards
  // fails in getcwd, naming nothing that would lead anybody back to here.
  fs.mkdirSync(out, { recursive: true });
  for (const entry of fs.readdirSync(out)) fs.rmSync(path.join(out, entry), { recursive: true, force: true });

  let total = 0;
  for (const s of sources()) {
    const { files, bytes } = copyTree(s.from, path.join(out, s.to), s.only);
    total += bytes;
    log(`  ${s.to || '/'}  ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
  }

  // The licenses, at the root of the site. AGPL section 13 asks a page served over a network to
  // offer its source, and the MIT devices ask that their notices travel with any copy of them -
  // so the served page carries both, at the paths the About screen links to.
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'LICENSES/GPL-2.0.txt']) {
    const from = path.join(repoRoot, name);
    if (!fs.existsSync(from)) throw new Error(`the build ships ${name}, and it is not there`);
    fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
    fs.copyFileSync(from, path.join(out, name));
  }

  // The ★ library's file format, shared with the desktop server rather than copied: the page's
  // host imports it beside itself (see public/web/prebake.mjs).
  fs.copyFileSync(path.join(here, 'pinned-defs.js'), path.join(out, 'web', 'pinned-defs.js'));

  const indexPath = path.join(out, 'index.html');
  fs.writeFileSync(indexPath, replaceSketch(injectAnalytics(injectBoot(fs.readFileSync(indexPath, 'utf8')))));

  // The desktop server's own file, which the browser build has no use for and should not ship.
  for (const gone of ['docs.html.map']) {
    fs.rmSync(path.join(out, gone), { force: true });
  }

  log(`\nbuilt ${out} (${(total / 1e6).toFixed(1)} MB)`);
  return { out, bytes: total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  build();
}
