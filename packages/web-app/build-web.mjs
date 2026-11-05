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
//   /vendor/acorn      the JavaScript parser that places a syntax error, from node_modules
//   /pattern-core      the language, as source
//   /web-engine        the devices, the worklets and the packs that ship with the app
//   /web               the host that stands in for the server
//   /osc-engine        the maths the desktop's engine shares with the page (the sample map, songs)
//   /shared            the desk's tempo maths, the desktop server's own files
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
    // The parser that places a syntax error (see pattern-core's eval-errors.mjs).
    { from: path.join(path.dirname(require.resolve('acorn/package.json')), 'dist'), to: 'vendor/acorn', only: ['acorn.mjs'] },
    { from: patternCore, to: 'pattern-core' },
    { from: path.join(webEngine, 'src'), to: 'web-engine/src' },
    { from: path.join(webEngine, 'public', 'worklets'), to: 'web-engine/worklets' },
    { from: path.join(webEngine, 'public', 'packs'), to: 'web-engine/packs' },
    { from: path.join(webEngine, 'public', 'devices'), to: 'web-engine/devices' },
    // The maths both builds share, each a module of its own (see their headers): the sample map,
    // and a song's waveform and beatgrid for the DJ decks.
    { from: path.join(repoRoot, 'packages', 'osc-engine'), to: 'osc-engine', only: ['sample-map-core.mjs', 'wave-core.mjs', 'song-detect-core.mjs', 'song-tags-core.mjs', 'slice-grid-core.mjs'] },
    // ...and the desk's tempo maths, which the desktop server require()s and the page imports.
    { from: here, to: 'shared', only: ['song-sync.js', 'link-sync.js'] },
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
    // Embedded in the guide (?embed), the app keeps nothing and reads none of this browser's own.
    '        .then((m) => m.boot({ isolated: document.documentElement.dataset.embed === "1" }))',
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
/**
 * A page of the guide as the browser build serves it: the same page, marked as this build's,
 * which is what shows its `data-build="web"` passages, hides the desktop's, and turns its
 * `data-run` examples into ones that play (public/docs/docs.js).
 */
export function markDocsWeb(html) {
  if (/<html[^>]*\bclass="web"/.test(html)) return html;
  const anchor = '<html lang="en">';
  if (!html.includes(anchor)) throw new Error('could not find the guide\'s <html> tag to mark');
  return html.replace(anchor, '<html lang="en" class="web">');
}

// ---- search engines and link previews --------------------------------------------------------
// Only this build's pages carry these: the desktop serves the same files from this machine, where
// nothing crawls them.

export const SITE = 'https://poptart.glossing.dev';
export const APP_TITLE = 'poptart: livecode music in your browser';
export const APP_DESCRIPTION = 'poptart is a livecoding music app in your browser: write short patterns and play them on built-in synths, samplers and effects, with an arrangement, piano rolls, a mixer and DJ decks. Nothing to install.';
const PREVIEW_IMAGE = `${SITE}/docs/img/app.png`;

/** The guide's chapters, in order, from the list docs.js builds its links from. */
const chapters = () => require('./public/docs/docs.js').CHAPTERS;

/** A guide page's address as the host serves it: no `.html`, the index at /docs/. */
export const guideUrl = (file) => `${SITE}/docs/${file === 'index' ? '' : file}`;

const escapeAttr = (s) => s.replace(/&(?!amp;|lt;|gt;|quot;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The app page's head: its language, a title that says what it is, and a description. */
export function markAppHead(html) {
  if (html.includes('name="description"')) return html;
  if (!/<html>/.test(html) || !/<title>poptart<\/title>/.test(html)) throw new Error('could not find the app page\'s <html> and <title> to mark');
  return html
    .replace('<html>', '<html lang="en">')
    .replace('<title>poptart</title>', `<title>${escapeAttr(APP_TITLE)}</title>\n    <meta name="description" content="${escapeAttr(APP_DESCRIPTION)}" />`);
}

/**
 * The page's address and its link preview, from its own title and description: the canonical URL
 * (so `/docs/start` and `/docs/start.html` count as one page) and the Open Graph and card tags a
 * chat or a social site reads to draw the preview.
 */
export function injectPreview(html, url) {
  if (html.includes('rel="canonical"')) return html;
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1];
  if (!title || !description) throw new Error(`the page at ${url} needs a <title> and a description`);
  const anchor = '</head>';
  if (!html.includes(anchor)) throw new Error('could not find the page head to put the preview in');
  const tags = [
    `<link rel="canonical" href="${url}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="poptart" />',
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${PREVIEW_IMAGE}" />`,
    '<meta property="og:image:width" content="1440" />',
    '<meta property="og:image:height" content="900" />',
    '<meta name="twitter:card" content="summary_large_image" />',
  ];
  return html.replace(anchor, `  ${tags.join('\n    ')}\n  ${anchor}`);
}

/**
 * The guide's chapter list and the index's chapter cards, written into the page rather than left
 * for docs.js to add, so a crawler that runs no script still finds every chapter. The markup is
 * the one docs.js builds, which replaces it once it runs.
 */
export function fillGuideLinks(html, page) {
  const list = chapters();
  const navAnchor = '<nav class="chapters"></nav>';
  if (!html.includes(navAnchor)) throw new Error(`could not find the empty chapter list in the guide's ${page} page`);
  const links = list.map((c, i) => `<a class="chapter${c.file === page ? ' here' : ''}" href="${c.file === 'index' ? '/docs/' : `/docs/${c.file}.html`}"><span class="num">${i === 0 ? '' : i}</span><span>${escapeText(c.title)}</span></a>`);
  html = html.replace(navAnchor, `<nav class="chapters"><a class="brand" href="/docs/"><span class="dot"></span> poptart</a><p class="tagline">the guide</p>${links.join('')}<a class="back" href="/">← back to poptart</a></nav>`);
  const cardsAnchor = '<div class="cards"></div>';
  if (html.includes(cardsAnchor)) {
    const cards = list.slice(1).map((c, i) => `<a href="/docs/${c.file}.html"><span class="num">${i + 1}</span><span class="title">${escapeText(c.title)}</span><span class="blurb">${escapeText(c.blurb)}</span></a>`);
    html = html.replace(cardsAnchor, `<div class="cards">${cards.join('')}</div>`);
  }
  return html;
}

/** Tells crawlers where the pages are and to leave the projector window alone. */
export function robotsTxt() {
  return ['User-agent: *', 'Disallow: /projector', '', `Sitemap: ${SITE}/sitemap.xml`, ''].join('\n');
}

/** Every page worth finding: the app and each chapter of the guide. */
export function sitemapXml() {
  const urls = [`${SITE}/`, ...chapters().map((c) => guideUrl(c.file))];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${u}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
}

export const WEB_SKETCH = [
  'kick: s("bd*4")',
  'hat: s("hh*8")',
  'keys: n("0 2 3 <5 7>")',
  '  .scale("F minor")',
  '  .synth("Wavetable")',
  '  .param("Osc 1 Position", lfo("swell", { rate: 0.3 }))',
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
  const app = injectPreview(markAppHead(fs.readFileSync(indexPath, 'utf8')), `${SITE}/`);
  fs.writeFileSync(indexPath, replaceSketch(injectAnalytics(injectBoot(app))));

  // Every chapter of the guide, marked as this build's, with its links and preview in the page.
  const docsDir = path.join(out, 'docs');
  for (const name of fs.readdirSync(docsDir).filter((f) => f.endsWith('.html'))) {
    const page = path.join(docsDir, name);
    const file = name.replace(/\.html$/, '');
    const html = fillGuideLinks(markDocsWeb(fs.readFileSync(page, 'utf8')), file);
    fs.writeFileSync(page, injectAnalytics(injectPreview(html, guideUrl(file))));
  }

  fs.writeFileSync(path.join(out, 'robots.txt'), robotsTxt());
  fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemapXml());

  log(`\nbuilt ${out} (${(total / 1e6).toFixed(1)} MB)`);
  return { out, bytes: total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  build();
}
