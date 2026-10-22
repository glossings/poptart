'use strict';

// Replays - the night as it was played: every evaluation made BY HAND (cmd+enter, play, update,
// on either deck) is one entry, with the whole buffer as it was sent. The panels' own evals (a
// piano roll drag, a preset written into the code, the arrangement painter) are not entries -
// they are the tools, not the performance, and they are in the next by-hand eval's code anyway.
//
// A replay is one file of JSON lines, appended to as you play. A night is one replay however many
// times the app restarts in it: a new one starts only after REPLAY_GAP_MS without an entry. Kept
// ones (the star in the files tab) stay until deleted; the rest go after the retention setting's
// days (REPLAY_KEEP_DAYS unless changed).
//
// The format and its arithmetic, shared: loaded as a plain script in the browser (before
// client.js, which draws the timeline from it), require()d by server.js and replays.js, and
// handed to the browser build's storage (see public/web/boot.mjs).

const REPLAY_GAP_MS = 2 * 60 * 60 * 1000;
const REPLAY_KEEP_DAYS = 30;
const REPLAY_DAY_MS = 24 * 60 * 60 * 1000;

// "<month>/<start stamp>" - "2026-10/2026-10-22-213012" - which is also its path under the
// replays folder. The same shape as a work-in-progress id, checked the same strict way: the id
// comes back from the editor, and this is the only place it gets to name a folder.
const REPLAY_ID_RE = /^(\d{4}-\d{2})\/(\d{4}-\d{2})-\d{2}-\d{6}$/;

const replayPad2 = (n) => String(n).padStart(2, '0');

/** The id a replay started at `ms` (local time) is filed under. */
function replayIdFor(ms) {
  const d = new Date(ms);
  const month = `${d.getFullYear()}-${replayPad2(d.getMonth() + 1)}`;
  return `${month}/${month}-${replayPad2(d.getDate())}-${replayPad2(d.getHours())}${replayPad2(d.getMinutes())}${replayPad2(d.getSeconds())}`;
}

/** Is this a well-formed id whose month folder is the month of its date? */
function replayIdOk(id) {
  const m = REPLAY_ID_RE.exec(String(id ?? ''));
  return !!m && m[1] === m[2];
}

/**
 * One entry as it is filed: { at (ms), deck ('a' | 'b'), start (it was play, not update), name
 * (the saved pattern on that deck, or null), code }. Anything else on the object is dropped.
 */
function replayEntry({ at, deck, start, name, code }) {
  return {
    at: Number(at),
    deck: deck === 'b' ? 'b' : 'a',
    start: !!start,
    name: name ? String(name) : null,
    code: String(code ?? ''),
  };
}

const replayLine = (entry) => `${JSON.stringify(replayEntry(entry))}\n`;

/**
 * The entries of a replay file, in order. A line that does not parse is skipped rather than
 * failing the whole night: the app quitting mid-write leaves exactly one such line, at the end.
 */
function parseReplay(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Number.isFinite(e?.at) && typeof e.code === 'string') out.push(replayEntry(e));
    } catch {
      /* a torn last line */
    }
  }
  return out.sort((x, y) => x.at - y.at);
}

/** What a list row says about a replay: when, how long, how many evals, which decks, which songs. */
function summarizeReplay(entries) {
  const decks = [...new Set(entries.map((e) => e.deck))].sort();
  const names = [...new Set(entries.map((e) => e.name).filter(Boolean))];
  return {
    started: entries.length ? entries[0].at : null,
    ended: entries.length ? entries[entries.length - 1].at : null,
    count: entries.length,
    decks,
    names,
  };
}

/** Index of the last entry at or before `t`, or -1 when `t` is before the first. */
function replayIndexAt(entries, t) {
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].at <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * What each deck was holding once entry `i` had been played: { a, b }, each the latest entry for
 * that deck at or before `i`, or null for a deck nothing had been played on yet.
 */
function replayDecksAt(entries, i) {
  const out = { a: null, b: null };
  for (let k = Math.min(i, entries.length - 1); k >= 0 && !(out.a && out.b); k--) {
    const e = entries[k];
    if (!out[e.deck]) out[e.deck] = e;
  }
  return out;
}

/** Should an entry at `now` carry on the replay whose last entry was at `lastAt`? */
const replayContinues = (lastAt, now, gapMs = REPLAY_GAP_MS) => Number.isFinite(lastAt) && now - lastAt < gapMs;

/** The cutoff a retention of `days` deletes before (unkept replays last written earlier go). */
const replayCutoff = (days, now = Date.now()) => now - Number(days) * REPLAY_DAY_MS;

const poptartReplayLog = {
  REPLAY_GAP_MS,
  REPLAY_KEEP_DAYS,
  REPLAY_ID_RE,
  replayIdFor,
  replayIdOk,
  replayEntry,
  replayLine,
  parseReplay,
  summarizeReplay,
  replayIndexAt,
  replayDecksAt,
  replayContinues,
  replayCutoff,
};

if (typeof module !== 'undefined' && module.exports) module.exports = poptartReplayLog;
else globalThis.poptartReplayLog = poptartReplayLog;
