'use strict';

// A DJ set's tracklist as Markdown, and the name of its file - shared by both builds. The desktop
// (set-log.js) writes it under patterns/sets/<YYYY-MM>/ on the disk, the browser build under the
// same name in its store (see desk.mjs). Loaded in the browser as a module of its own and
// require()d by the desktop and the tests.

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

const poptartSetLog = { formatSetLog, setFileName, elapsedOf, lengthOf, monthOf };

if (typeof module !== 'undefined' && module.exports) module.exports = poptartSetLog;
else globalThis.poptartSetLog = poptartSetLog;
