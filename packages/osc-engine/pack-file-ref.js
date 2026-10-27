'use strict';

// One file of a pack, named: `s("files:loop.wav")`, `s("drums:kick")`. The scheduler takes a
// numeric suffix off as the index (`s("bd:4")`), so a ref that still carries a suffix names its
// file - matched against the pack's file names with or without the extension, the rule a device's
// sample control already uses (OscEngine#_fileInPack) and the browser build's store follows.
//
// The single-file sources (file:, rec:, say:) are not packs: a ":" in one of those is part of
// the name.

const path = require('node:path');

/** `{ pack, want }` for a "pack:file" ref (the pack may be a named "sp:" one), or null. */
function splitPackFileRef(ref) {
  const text = String(ref ?? '');
  if (/^(say|file|rec):/.test(text)) return null;
  const prefix = text.startsWith('sp:') ? 'sp:' : '';
  const rest = text.slice(prefix.length);
  const at = rest.indexOf(':');
  if (at <= 0) return null;
  const want = rest.slice(at + 1).trim();
  return want ? { pack: prefix + rest.slice(0, at), want } : null;
}

/** The path among `paths` that `want` names - by index, or by file name with or without its extension. */
function pickPackFile(paths, want) {
  if (!paths?.length) return null;
  const text = String(want ?? '').trim();
  if (/^\d+$/.test(text)) return paths[Number(text) % paths.length];
  const lower = text.toLowerCase();
  return paths.find((p) => {
    const base = path.basename(String(p)).toLowerCase();
    return base === lower || base.replace(/\.[^.]+$/, '') === lower;
  }) ?? null;
}

module.exports = { splitPackFileRef, pickPackFile };
