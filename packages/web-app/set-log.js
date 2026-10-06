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

const pad2 = (n) => String(n).padStart(2, '0');
const monthOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const stampOf = (d) => `${monthOf(d)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const clockOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Elapsed time into the set, as a tracklist writes it: 0:00, 4:12, 1:02:45. */
function elapsedOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

/** A set's length in words: "48m", "1h 12m". */
function lengthOf(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}m` : `${m}m`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The file name: the start stamp, plus the length once the set is over. */
function setFileName(started, ended = null) {
  return `${stampOf(started)}${ended ? ` ${lengthOf(ended - started).replace(' ', '')}` : ''}.md`;
}

// A table cell can't hold a pipe or a line break.
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/**
 * The set as Markdown. `set` is { started: Date, entries: [{ at (ms), deck, kind, title,
 * subtitle?, bpm?, key? }] }; `ended` is the Date it finished, or null while it is still going.
 */
function formatSetLog(set, ended = null) {
  const s = set.started;
  const when = `${DAYS[s.getDay()]} ${s.getDate()} ${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
  const span = ended ? `${clockOf(s)}–${clockOf(ended)} (${lengthOf(ended - s)})` : `${clockOf(s)}–, in progress`;
  const rows = [...set.entries].sort((x, y) => x.at - y.at).map((e) => {
    const name = e.subtitle ? `${e.title} — ${e.subtitle}` : e.title;
    const bpm = Number.isFinite(e.bpm) ? String(Math.round(e.bpm * 10) / 10) : '';
    return `| ${elapsedOf(e.at - s.getTime())} | ${clockOf(new Date(e.at))} | ${String(e.deck).toUpperCase()} | ${cell(name)} | ${e.kind} | ${bpm} | ${cell(e.key)} |`;
  });
  return [
    `# DJ set · ${when} · ${span}`,
    '',
    `${set.entries.length} track${set.entries.length === 1 ? '' : 's'}`,
    '',
    '| time | clock | deck | track | kind | bpm | key |',
    '|---:|---:|:-:|---|---|---:|---|',
    ...rows,
    '',
  ].join('\n');
}

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
