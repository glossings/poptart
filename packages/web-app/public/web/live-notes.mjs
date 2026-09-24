// Live notes - every note edge played by hand on a track, kept for a while - and the MIDI
// recorder, which is a window cut out of them.
//
// The desktop keeps the same log in its server (see server.js, "Live notes" and "MIDI record"),
// and this is that code for the page, with the same numbers and the same answers, so the roll's
// capture button and the ● rec button work alike in both builds. Two sources feed it: a MIDI
// device playing a track (midikeys(), midi("dev:…")), and the computer keyboard through the
// roll's ⌨ button. A note-on waits until its note-off completes the event; completed events are
// kept per track for the last LIVE_LOG_CYCLES cycles, in the transport's own cycle count.

export const PHRASE_CYCLES = 4;
const LIVE_LOG_CYCLES = 64;
const LIVE_LOG_MAX = 4096;

/** The key a held note waits under: the note, and the index with it on an index roll. */
const liveKey = (note, index) => (Number.isFinite(index) ? `${note}:${Math.max(0, Math.round(index))}` : String(note));

export function createLiveNotes({ nowCycle, recordStartCycle, snapshot = () => null, setTimer = setInterval, clearTimer = clearInterval }) {
  const log = new Map();    // label -> completed events, oldest first
  const held = new Map();   // label -> Map(key -> stack of open events)
  let rec = null;           // { phase, armCycle, startCycle, endCycle, cycles, grid, results, timer }

  function clear() {
    log.clear();
    held.clear();
  }

  function edge(label, note, vel, isOn, index = null) {
    const now = nowCycle();
    const key = liveKey(note, index);
    if (isOn && vel > 0) {
      let byKey = held.get(label);
      if (!byKey) held.set(label, (byKey = new Map()));
      let stack = byKey.get(key);
      if (!stack) byKey.set(key, (stack = []));
      const ev = { note, vel, start: now };
      if (Number.isFinite(index)) ev.index = Math.max(0, Math.round(index));
      stack.push(ev);
    } else {
      const ev = held.get(label)?.get(key)?.pop();
      if (!ev) return;
      push(label, { ...ev, end: Math.max(ev.start + 1e-3, now) });
    }
  }

  function push(label, ev) {
    let list = log.get(label);
    if (!list) log.set(label, (list = []));
    list.push(ev);
    const horizon = ev.end - LIVE_LOG_CYCLES;
    let drop = 0;
    while (drop < list.length && (list[drop].end < horizon || list.length - drop > LIVE_LOG_MAX)) drop++;
    if (drop) list.splice(0, drop);
  }

  /** A track's events from `since`, with the keys still down closed at `now`. */
  function eventsFor(label, since = -Infinity, now = null) {
    const out = (log.get(label) ?? []).filter((ev) => ev.start >= since);
    const open = held.get(label);
    if (open && now != null) {
      for (const stack of open.values()) {
        for (const ev of stack) if (ev.start >= since) out.push({ ...ev, end: Math.max(ev.start + 1e-3, now), held: true });
      }
    }
    return out;
  }

  function takes(since, now) {
    const out = {};
    for (const label of new Set([...log.keys(), ...held.keys()])) {
      const evs = eventsFor(label, since, now);
      if (evs.length) out[label] = evs;
    }
    return out;
  }

  // ---- the recorder ---------------------------------------------------------------------------

  function status() {
    if (!rec) return { phase: 'idle' };
    const { phase, armCycle, startCycle, endCycle, cycles, grid, results } = rec;
    const body = { phase, armCycle, startCycle, endCycle, cycles, grid, results, transport: snapshot() };
    if (phase !== 'done') {
      const now = nowCycle();
      body.now = now;
      body.events = takes(armCycle, now);
    }
    return body;
  }

  function tick() {
    if (!rec || rec.phase === 'done') return;
    const pos = nowCycle();
    if (rec.phase === 'armed' && pos >= rec.startCycle) rec.phase = 'recording';
    // A little past the end, so a note-off landing on the boundary completes its event first.
    if (pos >= rec.endCycle + 0.02) finish();
  }

  function finish() {
    clearTimer(rec.timer);
    rec.timer = null;
    const results = [];
    for (const [label, events] of Object.entries(takes(rec.armCycle, rec.endCycle))) {
      const inWindow = events.filter((ev) => ev.start < rec.endCycle).map((ev) => ({ ...ev, end: Math.min(rec.endCycle, ev.end) }));
      if (inWindow.length) results.push({ label, events: inWindow });
    }
    rec.results = results;
    rec.phase = 'done';
  }

  function start({ cycles, grid } = {}) {
    if (rec && rec.phase !== 'done') throw new Error('a MIDI recording is already armed or running - cancel it first');
    const n = Math.min(64, Math.max(1, Math.round(Number(cycles) || 4)));
    const g = Math.max(0, Math.round(grid == null ? 16 : Number(grid) || 0));
    const armCycle = nowCycle();
    const startCycle = recordStartCycle(armCycle, n, PHRASE_CYCLES);
    if (rec?.timer) clearTimer(rec.timer);
    rec = { phase: 'armed', armCycle, startCycle, endCycle: startCycle + n, cycles: n, grid: g, results: null, timer: setTimer(tick, 50) };
    return status();
  }

  function cancel() {
    if (rec?.timer) clearTimer(rec.timer);
    rec = null;
    return {};
  }

  return { edge, eventsFor, takes, clear, start, status, cancel, tick };
}
