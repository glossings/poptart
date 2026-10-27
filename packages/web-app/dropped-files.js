'use strict';

// The desktop's `files` sample pack: audio dropped on the code, kept as the absolute paths where
// each file lives. Nothing is copied - a file that moves or is deleted simply drops out of the
// pack until it is dropped again (see osc-engine/listed-packs.js for how the sampler reads it).
//
// The browser build keeps the same pack in its own store, bytes and all, because a page has no
// disk to point at (public/web/samples.mjs). Both answer a drop with the same `files:<name>`, and
// both follow the same rule for a name already in the pack: the new file takes the old one's
// place, so its index - and every pattern naming it - stands.
//
// The list is a small JSON document in the poptart folder: { version: 1, files: [paths] }.
// Plain file work with the location injected - see dropped-files.test.js.

const fs = require('node:fs');
const path = require('node:path');

const DROPPED_FILES_PACK = 'files';

function createDroppedFiles(file) {
  const read = () => {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(doc?.files) ? doc.files.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
    } catch {
      return []; // no list yet, or one that can't be read - an empty pack, not an error
    }
  };
  const write = (files) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, files }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  };
  return {
    file,
    /** The pack's files, in index order. */
    read,
    /**
     * Adds one absolute path. A file of the same name takes that entry's place; anything else
     * joins the end. -> { index, name, ref, replaced }
     */
    add(abs) {
      const p = path.resolve(String(abs));
      const name = path.basename(p);
      const files = read();
      let index = files.findIndex((f) => path.basename(f) === name);
      const replaced = index >= 0 && files[index] !== p;
      if (index < 0) {
        files.push(p);
        index = files.length - 1;
      } else {
        files[index] = p;
      }
      write(files);
      return { index, name, ref: `${DROPPED_FILES_PACK}:${name}`, replaced };
    },
  };
}

/**
 * Where each dropped file lives, in drop order: an item is { path } when the drag named it, or
 * { name, size, sha256 } when all the page had was the file (found again by sample-locate.js).
 * `find` and `verify` are those two lookups. -> [absolute path | null], null for a file that is
 * nowhere on the disk or that its lookup refused.
 */
async function locateDrops(items, { find, verify }) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      out.push((item?.path != null ? await verify(String(item.path)) : await find(item ?? {})) ?? null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * One dropped sample into the `files` pack: found on the disk, then listed where it lives.
 * `shadowed` is true when the sample library has a folder of the pack's name, which plays in the
 * list's place (the rule every built-in pack follows) - the caller says so.
 * -> { ref, index, name, shadowed } | throws when the file can't be found.
 */
async function addDroppedSample(item, { store, find, verify, shadowed = () => false }) {
  const [abs] = await locateDrops([item], { find, verify });
  if (!abs) throw new Error(`couldn't find where ${item?.name ?? path.basename(String(item?.path ?? 'that file'))} lives on disk`);
  const { ref, index, name } = store.add(abs);
  return { ref, index, name, path: abs, shadowed: !!shadowed() };
}

module.exports = { createDroppedFiles, locateDrops, addDroppedSample, DROPPED_FILES_PACK };
