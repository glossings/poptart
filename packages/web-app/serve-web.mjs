// Running the browser build locally, in one command.
//
// `npm run web` builds the site and serves it. That is the whole story, and it is one command on
// purpose: the browser build has no backend, so trying it out should not mean remembering how to
// start a static file server, and the obvious ways to do that by hand have two traps in them.
//
// THE FIRST TRAP IS THE CONTENT TYPE. This build has no bundler, so the page loads its modules as
// modules - and a browser refuses a module served as anything but JavaScript. A server that does
// not know what `.mjs` is sends `application/octet-stream`, and what you get is a blank page and
// a console line about a MIME type, which is a long way from "the server is wrong".
//
// THE SECOND IS THE WORKING DIRECTORY. Serving `dist/web` by standing in it means a rebuild (which
// empties that folder) pulls the ground out from under the shell doing the serving. So this is
// pointed at the folder from outside it and never changes directory.
//
// It is a development server. It is not hardened, it is not fast, and nothing here should ever be
// what serves this to the public - that is a static host's job, and vercel.json is how one is
// told where the files are.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './build-web.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const DEFAULT_PORT = 8777;

/**
 * What to say a file is.
 *
 * `.mjs` and `.js` are the ones that matter - see the note above - and the rest are here so that
 * fonts and audio do not arrive as a byte soup the browser declines to decode.
 */
export const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

export function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The file a request is asking for, or null if it is asking for something outside the folder.
 *
 * A path is not trusted just because it arrived over localhost. Dot segments are DECODED first
 * and normalized second, so `/..%2fsecret` is collapsed the same way `/../secret` is - checking
 * the text before decoding would miss every encoded spelling. Normalizing an absolute path drops
 * the leading `..` segments rather than climbing above the root, and resolving against the root
 * and checking the answer is still inside it is the backstop for anything that reasoning misses.
 */
export function resolveRequest(urlPath, root) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;                                    // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  // Anchored before it is normalized: a relative path would normalize to one that climbs.
  const rooted = decoded.startsWith('/') ? decoded : `/${decoded}`;
  const withIndex = rooted.endsWith('/') ? `${rooted}index.html` : rooted;
  const full = path.resolve(root, `.${path.posix.normalize(withIndex)}`);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** Starts the server. Resolves once it is listening, with the address it is listening on. */
export function serve({ root, port = DEFAULT_PORT, host = '127.0.0.1', log = console.log } = {}) {  // eslint-disable-line no-console
  const server = http.createServer((req, res) => {
    const file = resolveRequest(req.url ?? '/', root);
    if (!file) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('that path is not inside the folder being served\n');
      return;
    }
    fs.stat(file, (err, stat) => {
      const target = !err && stat.isDirectory() ? path.join(file, 'index.html') : file;
      fs.readFile(target, (readErr, body) => {
        if (readErr) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`not built: ${path.relative(root, target)}\n`);
          return;
        }
        res.writeHead(200, {
          'content-type': contentType(target),
          // Nothing here is cached: the whole point of running it locally is to rebuild and
          // reload, and a cached module is a change that appears not to have happened.
          'cache-control': 'no-store',
        });
        res.end(body);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use - stop what is on it, or pass --port to pick another`));
      } else reject(err);
    });
    server.listen(port, host, () => {
      log(`\n  poptart is at http://localhost:${port}\n  ctrl-c to stop\n`);
      resolve(server);
    });
  });
}

/**
 * Rebuilds when anything the build copies changes.
 *
 * Coalesced, because one save fires several events and a rebuild that runs four times is three
 * rebuilds emptying the folder the browser is mid-request against.
 */
function watch(out, log) {
  const watched = [
    path.join(repoRoot, 'packages', 'web-app', 'public'),
    path.join(repoRoot, 'packages', 'web-engine', 'src'),
    path.join(repoRoot, 'packages', 'web-engine', 'public'),
    path.join(repoRoot, 'packages', 'pattern-core', 'src'),
  ];
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build({ out, quiet: true });
        log(`  rebuilt ${new Date().toLocaleTimeString()} - reload the page`);
      } catch (err) {
        log(`  build failed: ${err.message}`);
      }
    }, 120);
  };
  for (const dir of watched) {
    try {
      fs.watch(dir, { recursive: true }, rebuild);
    } catch {
      // A platform without recursive watching, or a folder that is not there. Not fatal: the
      // server still serves, and a rebuild by hand still works.
      log(`  not watching ${path.relative(repoRoot, dir)}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const log = (...a) => console.log(...a);          // eslint-disable-line no-console
  const portArg = argv.indexOf('--port');
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port wants a port number, got ${argv[portArg + 1]}`);

  const { out } = build({ out: undefined, quiet: false });
  await serve({ root: out, port, log });
  if (argv.includes('--watch')) {
    watch(out, log);
    log('  watching for changes\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message);                     // eslint-disable-line no-console
    process.exit(1);
  });
}
