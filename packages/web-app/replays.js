'use strict';

// Replays on disk (what one is: public/replay-log.js). One JSON-lines file per night under
// patterns/replays/<YYYY-MM>/, appended to as the evals come in, so a night that ends in a crash
// still has everything up to the last eval.
//
// Beside each one, a `.states` file: the captured plugin states its entries name, one handle a
// line. The state store's sweep reads the replays folder to learn what is still in use (see
// sweepStates in server.js), but it skips files over 2MB - and a long night's replay is bigger
// than that. The sidecar is small whatever the night's length, so a replay holds the states it
// needs to play back for as long as the replay is kept.
//
// Which replays are kept (starred) is kept.json in the same folder: a list of ids.

const fs = require('fs');
const path = require('path');
const { PATTERNS_DIR } = require('./pattern-files');
const R = require('./public/replay-log.js');

const fsp = fs.promises;
const REPLAYS_DIR = path.join(PATTERNS_DIR, 'replays');
const MONTH_DIR_RE = /^\d{4}-\d{2}$/;

/**
 * `referencedIds(code)` names the state handles a buffer mentions (blobs.referencedIds); `now`
 * is the clock, both injectable for the tests.
 */
function createReplayStore({ dir = REPLAYS_DIR, now = () => Date.now(), referencedIds = () => new Set() } = {}) {
  const keptFile = path.join(dir, 'kept.json');

  function fileOf(id) {
    if (!R.replayIdOk(id)) throw new Error('bad replay id (expected "YYYY-MM/YYYY-MM-DD-HHMMSS")');
    return path.join(dir, `${id}.jsonl`);
  }
  const statesOf = (id) => path.join(dir, `${id}.states`);

  // The replay being written: { id, lastAt, last: { a, b } (each deck's last recorded code),
  // states (handles already in the sidecar) }. Null until the first eval of a run of the app.
  let current = null;
  // Appends are queued: two decks evaluated in the same instant must not interleave their lines.
  let queue = Promise.resolve();
  // A listing re-reads a file only when it has changed since the last time.
  const summaries = new Map();

  function readKept() {
    try {
      const ids = JSON.parse(fs.readFileSync(keptFile, 'utf8'));
      return new Set(Array.isArray(ids) ? ids.filter(R.replayIdOk) : []);
    } catch {
      return new Set(); // none kept yet, or an unreadable list - which keeps nothing extra
    }
  }
  function writeKept(ids) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keptFile, `${JSON.stringify([...ids].sort(), null, 2)}\n`, 'utf8');
  }

  /** Every replay on disk, by id. */
  function allIds() {
    let months = [];
    try {
      months = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && MONTH_DIR_RE.test(e.name)).map((e) => e.name);
    } catch {
      return []; // nothing played yet
    }
    const out = [];
    for (const month of months) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(dir, month));
      } catch {
        continue;
      }
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue;
        const id = `${month}/${f.slice(0, -'.jsonl'.length)}`;
        if (R.replayIdOk(id)) out.push(id);
      }
    }
    return out.sort();
  }

  async function readEntries(id) {
    return R.parseReplay(await fsp.readFile(fileOf(id), 'utf8').catch(() => ''));
  }

  // The app started (or restarted) mid-night: the newest replay carries on if its last entry is
  // recent enough, so one set is one replay however many times the app went down in it.
  async function resume(at) {
    const ids = allIds();
    const id = ids[ids.length - 1];
    if (!id) return null;
    const entries = await readEntries(id);
    const lastAt = entries.length ? entries[entries.length - 1].at : null;
    if (!R.replayContinues(lastAt, at)) return null;
    const held = R.replayDecksAt(entries, entries.length - 1);
    const sidecar = await fsp.readFile(statesOf(id), 'utf8').catch(() => '');
    return { id, lastAt, last: { a: held.a?.code ?? null, b: held.b?.code ?? null }, states: referencedIds(sidecar) };
  }

  /**
   * Files one by-hand eval: { deck, code, start, name }. An update that changes nothing (the same
   * code on the same deck, not a play) is not a new moment and is left out. Resolves to
   * { id, recorded }.
   */
  function record(raw) {
    const run = queue.then(async () => {
      const entry = R.replayEntry({ ...raw, at: raw.at ?? now() });
      if (!entry.code.trim()) return { id: current?.id ?? null, recorded: false };
      if (!current || !R.replayContinues(current.lastAt, entry.at)) {
        current = (current ? null : await resume(entry.at))
          ?? { id: R.replayIdFor(entry.at), lastAt: null, last: { a: null, b: null }, states: new Set() };
      }
      if (!entry.start && current.last[entry.deck] === entry.code) {
        current.lastAt = entry.at;
        return { id: current.id, recorded: false };
      }
      const file = fileOf(current.id);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, R.replayLine(entry), 'utf8');
      const fresh = [...referencedIds(entry.code)].filter((h) => !current.states.has(h));
      if (fresh.length) {
        for (const h of fresh) current.states.add(h);
        await fsp.appendFile(statesOf(current.id), fresh.map((h) => `"@${h}"\n`).join(''), 'utf8');
      }
      current.last[entry.deck] = entry.code;
      current.lastAt = entry.at;
      return { id: current.id, recorded: true };
    });
    queue = run.catch(() => {});
    return run;
  }

  /** The files tab's rows, newest first: an id, its summary (see summarizeReplay), kept, live. */
  async function list() {
    const kept = readKept();
    const out = [];
    for (const id of allIds()) {
      const file = fileOf(id);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) continue;
      let held = summaries.get(file);
      if (!held || held.mtimeMs !== stat.mtimeMs || held.size !== stat.size) {
        held = { mtimeMs: stat.mtimeMs, size: stat.size, summary: R.summarizeReplay(await readEntries(id)) };
        summaries.set(file, held);
      }
      if (!held.summary.count) continue;
      out.push({ id, month: id.slice(0, 7), ...held.summary, bytes: stat.size, kept: kept.has(id), live: current?.id === id });
    }
    return out.sort((x, y) => y.started - x.started);
  }

  async function load(id) {
    const entries = await readEntries(id);
    if (!entries.length) throw new Error(`no replay "${id}"`);
    return { id, kept: readKept().has(id), entries };
  }

  function setKept(id, keep) {
    fileOf(id); // the id check
    const ids = readKept();
    if (keep) ids.add(id);
    else ids.delete(id);
    writeKept(ids);
    return { id, kept: !!keep };
  }

  function removeFiles(id) {
    let freed = 0;
    for (const file of [fileOf(id), statesOf(id)]) {
      try {
        freed += fs.statSync(file).size;
        fs.unlinkSync(file);
      } catch { /* already gone */ }
      summaries.delete(file);
    }
    try { fs.rmdirSync(path.dirname(fileOf(id))); } catch { /* the month still has others */ }
    if (current?.id === id) current = null; // the next eval starts a new one
    return freed;
  }

  function remove(id) {
    const freed = removeFiles(id);
    const ids = readKept();
    if (ids.delete(id)) writeKept(ids);
    return { freed };
  }

  /**
   * Replays a retention of `days` would delete right now: not kept, not the one being written,
   * and last written before the cutoff. 0 days keeps everything.
   */
  function olderThan(days, at = now()) {
    if (!(Number(days) > 0)) return { ids: [], bytes: 0 };
    const cutoff = R.replayCutoff(days, at);
    const kept = readKept();
    const ids = [];
    let bytes = 0;
    for (const id of allIds()) {
      if (kept.has(id) || current?.id === id) continue;
      let stat;
      try {
        stat = fs.statSync(fileOf(id));
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) continue;
      ids.push(id);
      bytes += stat.size;
    }
    return { ids, bytes };
  }

  function prune(days, at = now()) {
    const { ids } = olderThan(days, at);
    let freed = 0;
    for (const id of ids) freed += removeFiles(id);
    return { deleted: ids.length, freed };
  }

  return { dir, record, list, load, setKept, remove, olderThan, prune };
}

module.exports = { REPLAYS_DIR, createReplayStore };
