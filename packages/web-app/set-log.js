'use strict';

// DJ set tracklists - one Markdown file per set, under patterns/sets/<YYYY-MM>/ the way work in
// progress lives under patterns/wip/<YYYY-MM>/, and expired by the same retention setting.
//
// The file is rewritten whole each time a track is added, so a set that ends in a crash still
// leaves its list behind (headed "in progress"); when the set ends it is rewritten once more with
// its end time and length, and renamed to carry the length, so a month folder reads as a list of
// sets: "2026-10-06-213012 1h12m.md".

const fs = require('fs');
const path = require('path');
const { PATTERNS_DIR } = require('./pattern-files');

const SETS_DIR = path.join(PATTERNS_DIR, 'sets');
const MONTH_MS = 30 * 24 * 60 * 60 * 1000; // the same month the WIP retention counts in

// The tracklist itself and its file name are set-log-format.js, which the browser build shares.
const { formatSetLog, setFileName, elapsedOf, lengthOf, monthOf } = require('./public/set-log-format.js');

/**
 * Writes the set's file, renaming the previous one when the name has changed (the length is
 * added at the end). Returns the path written - kept on the set as `file` for the next write.
 */
function writeSetLog(set, ended = null) {
  const dir = path.join(SETS_DIR, monthOf(set.started));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, setFileName(set.started, ended));
  fs.writeFileSync(file, formatSetLog(set, ended), 'utf8');
  if (set.file && set.file !== file) {
    try { fs.unlinkSync(set.file); } catch { /* already gone */ }
  }
  set.file = file;
  return file;
}

/** Tracklists last written more than `months` ago, as { files, bytes } - 0 means keep them all. */
function setLogsOlderThan(months, now = Date.now()) {
  if (!(Number(months) > 0)) return { files: [], bytes: 0 };
  const cutoff = now - Number(months) * MONTH_MS;
  const files = [];
  let bytes = 0;
  let monthDirs = [];
  try {
    monthDirs = fs.readdirSync(SETS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return { files, bytes }; // no set played yet
  }
  for (const month of monthDirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(SETS_DIR, month)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of names) {
      const file = path.join(SETS_DIR, month, f);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) continue;
      files.push(file);
      bytes += stat.size;
    }
  }
  return { files, bytes };
}

/** Deletes them; a month folder left empty goes too. Returns what went. */
function pruneSetLogs(months, now = Date.now()) {
  const { files, bytes } = setLogsOlderThan(months, now);
  let deleted = 0;
  for (const file of files) {
    try {
      fs.unlinkSync(file);
      deleted += 1;
    } catch { /* already gone */ }
    try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty yet */ }
  }
  return { deleted, freed: bytes };
}

module.exports = {
  SETS_DIR,
  formatSetLog,
  setFileName,
  writeSetLog,
  setLogsOlderThan,
  pruneSetLogs,
  elapsedOf,
  lengthOf,
};
