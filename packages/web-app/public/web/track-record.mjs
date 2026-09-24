// Bouncing a track to a recording, in the page - the desktop's "Track record" (server.js), with
// the same answers, so the record panel works alike in both builds.
//
// Arm, and the take starts at the next phrase boundary far enough out for the recorder to hear
// about it; it runs for the cycles asked; then it is cut, folded, leveled and kept as a file
// in this browser's recordings, where sr("name") plays it. The panel's meter is a queue of
// readings per tapped track, drained by each poll, so its live waveform keeps the recorder's
// resolution rather than the poll's.
//
// Two things differ from the desktop, both simplifications the page affords. The recorder's
// window is kept to the sample on the audio clock, so there is no pre-roll to trim off; and when
// a tail is to be folded over the head, the capture runs on past the window for as long as the
// window itself (at most three seconds) - the most that can be folded - rather than a fixed
// three seconds.

const PHRASE_CYCLES = 4;
const REC_MIN_LEAD_SEC = 0.2;
const REC_TAIL_MAX_SEC = 3;
const LEVEL_QUEUE_MAX = 64;

export function createTrackRecorder({ engine, transport, idOf, labelOf, snapshot, finishTake, mintName, keep, names }) {
  let rec = null;               // { phase, label, cycles, startCycle, endCycle, startSec, endSec, name, wrapTail, normalize, capture, result, error, timer }
  const tapped = new Set();
  const levels = new Map();     // label -> [{ peak, rms, at }]

  engine.onRecLevel = (trackId, peak, rms) => {
    const label = trackId === '*' ? '*' : labelOf(trackId);
    let queue = levels.get(label);
    if (!queue) levels.set(label, (queue = []));
    queue.push({ peak, rms, at: Date.now() });
    while (queue.length > LEVEL_QUEUE_MAX) queue.shift();
  };

  function drain(label) {
    const queue = levels.get(label);
    if (!queue?.length) return [];
    const cutoff = Date.now() - 1000;
    const out = queue.filter((r) => r.at >= cutoff).map((r) => ({ peak: r.peak, rms: r.rms }));
    queue.length = 0;
    return out;
  }

  function status() {
    const lv = Object.fromEntries([...tapped].map((label) => [label, drain(label)]));
    if (!rec) return { phase: 'idle', tapped: [...tapped], levels: lv, transport: snapshot() };
    const { phase, label, cycles, startCycle, endCycle, name, result, error } = rec;
    return {
      phase, label, cycles, startCycle, endCycle, name, result, error,
      tapped: [...tapped],
      levels: tapped.has(label) ? lv : { ...lv, [label]: drain(label) },
      transport: snapshot(),
    };
  }

  function tap(label, on) {
    if (on) tapped.add(label);
    else if (rec?.label !== label || rec.phase === 'done') tapped.delete(label);
    else return { ok: true };
    engine.tapTrack(idOf(label), on || rec?.label === label);
    if (!on) levels.delete(label);
    return { ok: true };
  }

  function tick() {
    if (!rec || rec.phase !== 'armed') return;
    if (engine.getTime() >= rec.startSec) rec.phase = 'recording';
  }

  async function finish(capture) {
    try {
      if (!capture.frames) throw new Error(`nothing was recorded from "${rec.label}" - is the block still playing, and not muted?`);
      const name = mintName(rec.name || rec.label, names());
      const { bytes, info } = finishTake(capture, { startSec: 0, lengthSec: rec.endSec - rec.startSec, wrapTail: rec.wrapTail, normalize: rec.normalize });
      await keep(name, bytes);
      rec.result = { name, cycles: rec.cycles, ...info };
    } catch (err) {
      rec.error = err?.message ?? String(err);
    }
    rec.phase = 'done';
    clearInterval(rec.timer);
    rec.timer = null;
    if (!tapped.has(rec.label)) engine.tapTrack(idOf(rec.label), false);
  }

  function start(body = {}) {
    if (rec && rec.phase !== 'done') throw new Error('a bounce is already armed or running - cancel it first');
    const label = String(body.label ?? '').trim();
    if (!label) throw new Error('trackRecord/start needs a block label');
    if (!engine.tracks.has(idOf(label))) throw new Error(`"${label}" isn't playing - only a live block can be bounced`);
    const cycles = Math.min(128, Math.max(1, Math.round(Number(body.cycles) || 4)));
    const now = engine.getTime();
    let startCycle = (Math.floor(transport.cycleAt(now) / PHRASE_CYCLES) + 1) * PHRASE_CYCLES;
    while (transport.secAt(startCycle) - now < REC_MIN_LEAD_SEC) startCycle += PHRASE_CYCLES;
    const startSec = transport.secAt(startCycle);
    const endSec = transport.secAt(startCycle + cycles);
    const wrapTail = body.wrapTail === true;
    const tail = wrapTail ? Math.min(REC_TAIL_MAX_SEC, endSec - startSec) : 0;
    if (rec?.timer) clearInterval(rec.timer);
    rec = {
      phase: 'armed', label, cycles, startCycle, endCycle: startCycle + cycles, startSec, endSec,
      name: String(body.name ?? '').trim(), wrapTail, normalize: body.normalize !== false,
      capture: null, result: null, error: null, timer: setInterval(tick, 50),
    };
    const mine = rec;
    mine.capture = engine.recordTrack(idOf(label), startSec, endSec + tail);
    mine.capture.then((capture) => { if (rec === mine) finish(capture); }, (err) => {
      if (rec !== mine) return;
      mine.error = err?.message ?? String(err);
      mine.phase = 'done';
      clearInterval(mine.timer);
    });
    return status();
  }

  function cancel() {
    if (rec) {
      if (rec.phase !== 'done') rec.capture?.cancel?.();
      clearInterval(rec.timer);
      if (!tapped.has(rec.label)) engine.tapTrack(idOf(rec.label), false);
    }
    rec = null;
    return {};
  }

  /**
   * The master bus for `seconds`, starting now, kept as a recording. The desktop writes this to a
   * path on disk; a page has no disk, so it lands in the recordings under a name like any bounce.
   */
  async function recordMaster(body = {}) {
    const seconds = Math.min(600, Math.max(0.1, Number(body.seconds) || 4));
    const base = String(body.path ?? body.name ?? 'master').split(/[\\/]/).pop().replace(/\.wav$/i, '') || 'master';
    const at = engine.getTime() + 0.05;
    const capture = await engine.recordTrack('*', at, at + seconds);
    const name = mintName(base, names());
    const { bytes, info } = finishTake(capture, { startSec: 0, lengthSec: seconds, normalize: false });
    await keep(name, bytes);
    return { name, ...info };
  }

  return { start, status, cancel, tap, recordMaster };
}
