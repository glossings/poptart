// A modulator whose RATE is a pattern - sine("<1 2 4>"), lfo(...).fast("<1 2>"), a rate that
// follows an automation lane. Dependency-free, so the editor can load it in the browser and draw
// the same phase the engine plays.
//
// Phase under a moving rate is the INTEGRAL of the rate: each stretch of the cycle grid adds
// rate x length turns to the count. A constant rate reduces to position x rate, which is the
// count a plain number gets (see signal.mjs's lfoPhaseCount), so a pattern that never changes
// lands on the same grid anchors - rate 0.25 still starts its pass on cycles 0, 4, 8. A change
// re-anchors there: the phase carries on from where the old rate had brought it, and the new
// rate counts on from that point. "<1 2 4>" passes the cycle boundaries at whole turns, so each
// cycle starts its shape from the top; "<0.25 1>" reaches cycle 1 a quarter of the way in and
// carries on from there.
//
// The rate is read on the cycle grid the phase counts on. A step pattern changes rate exactly at
// its step edges. A continuous rate signal (an LFO, an automation lane) is read at the middle of
// each 1/RATE_STEPS_PER_CYCLE slice of the cycle and held across it - the engine is told about
// each change at the slice edge, so the native modulator runs the same piecewise rate the count
// here integrates. A rest, a gap or a value that is not a number holds the rate before it; until
// any rate has been read, the rate is 1.
//
// The count is accumulated from cycle 0 forward and remembered, so reading it is cheap however
// late in a set it is. Anything lazy the rate reads (an automation lane being redrawn) therefore
// changes the rate from the next stretch it is read over, never the phase already counted.

/** How finely a continuous rate signal is read: slices per cycle, each held at its middle value. */
export const RATE_STEPS_PER_CYCLE = 32;

/** The rate a bare modulator has, and the one held until a pattern first says otherwise. */
const DEFAULT_RATE = 1;

/** Cycles of resolved slices kept around, for the reads that land in the same few cycles. */
const PIECE_CACHE_CYCLES = 8;

/**
 * Builds the running count for one rate source: `{ stepsForCycle }` (a step pattern) or
 * `{ sample(t, cps, pos) }` (anything continuous). `toRate(value)` turns a raw step value into a
 * number of cycles per pass, or null to hold the one before it.
 */
export function rateLedger(source, toRate = defaultToRate) {
  const starts = [0]; // turns already counted at the start of cycle c
  const carries = [DEFAULT_RATE]; // rate in force entering cycle c
  const cache = new Map(); // cycle -> resolved pieces [{ start, end, rate }]

  // The cycle's own pieces with any held stretch filled in from the rate entering it, merged
  // where two neighbors run at one rate. Needs carries[c], so the count has reached c.
  function piecesOf(c, cps) {
    const hit = cache.get(c);
    if (hit) return hit;
    let rate = carries[c];
    const out = [];
    for (const p of rawPieces(source, c, cps, toRate)) {
      if (p.rate != null) rate = p.rate;
      const last = out[out.length - 1];
      if (last && last.rate === rate) last.end = p.end;
      else out.push({ start: p.start, end: p.end, rate });
    }
    if (out.length === 0) out.push({ start: 0, end: 1, rate });
    if (cache.size >= PIECE_CACHE_CYCLES) cache.delete(cache.keys().next().value);
    cache.set(c, out);
    return out;
  }

  function reach(c, cps) {
    while (starts.length <= c) {
      const k = starts.length - 1;
      const pieces = piecesOf(k, cps);
      let total = 0;
      for (const p of pieces) total += p.rate * (p.end - p.start);
      starts.push(starts[k] + total);
      carries.push(pieces[pieces.length - 1].rate);
    }
  }

  // Before the downbeat there is nothing to integrate: the count runs back from 0 at the rate the
  // pattern opens on, which is all a clock that briefly reads negative (a start lead) needs.
  function openingRate(cps) {
    reach(0, cps);
    return piecesOf(0, cps)[0].rate;
  }

  return {
    /** Turns counted from cycle 0 to `pos`. */
    turnsAt(pos, cps = 1) {
      if (!(pos >= 0)) return Number.isFinite(pos) ? pos * openingRate(cps) : 0;
      const c = Math.floor(pos);
      const f = pos - c;
      reach(c, cps);
      let turns = starts[c];
      if (f === 0) return turns;
      for (const p of piecesOf(c, cps)) {
        if (f <= p.start) break;
        turns += p.rate * (Math.min(f, p.end) - p.start);
      }
      return turns;
    },

    /** The rate in force at `pos`, in cycles per pass. */
    rateAt(pos, cps = 1) {
      if (!(pos >= 0)) return openingRate(cps);
      const c = Math.floor(pos);
      const f = pos - c;
      reach(c, cps);
      const pieces = piecesOf(c, cps);
      for (const p of pieces) if (f >= p.start && f < p.end) return p.rate;
      return pieces[pieces.length - 1].rate;
    },

    /** Every point in [from, to) where the rate changes, with the rate it changes to. */
    changesIn(from, to, cps = 1) {
      const out = [];
      if (!(to > from)) return out;
      const first = Math.max(0, Math.floor(from));
      for (let c = first; c < to; c++) {
        reach(c, cps);
        // The origin is not a change: before it the count already runs at the opening rate.
        let before = c === 0 ? piecesOf(0, cps)[0].rate : carries[c];
        for (const p of piecesOf(c, cps)) {
          const at = c + p.start;
          if (p.rate !== before && at >= from && at < to) out.push({ at, rate: p.rate });
          before = p.rate;
        }
      }
      return out;
    },
  };
}

function defaultToRate(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

// One cycle's pieces as the source states them, before holds are filled in: rate null where the
// source says nothing usable. A step grid gives a piece per span between step edges, read like
// signal.mjs's sampleViaSteps (the last step covering a point wins, so a stack reads its top);
// a continuous source gives RATE_STEPS_PER_CYCLE even slices.
function rawPieces(source, c, cps, toRate) {
  const out = [];
  if (source.stepsForCycle) {
    const steps = (source.stepsForCycle(c) ?? []).filter((s) => s && s.value != null);
    const cuts = new Set([0, 1]);
    for (const s of steps) {
      if (s.start > 0 && s.start < 1) cuts.add(s.start);
      if (s.end > 0 && s.end < 1) cuts.add(s.end);
    }
    const edges = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < edges.length; i++) {
      const mid = (edges[i] + edges[i + 1]) / 2;
      let value = null;
      for (const s of steps) if (mid >= s.start && mid < s.end) value = s.value;
      out.push({ start: edges[i], end: edges[i + 1], rate: value == null ? null : toRate(value) });
    }
    return out;
  }
  const n = RATE_STEPS_PER_CYCLE;
  for (let k = 0; k < n; k++) {
    const mid = c + (k + 0.5) / n;
    out.push({ start: k / n, end: (k + 1) / n, rate: toRate(source.sample(mid / cps, cps, mid)) });
  }
  return out;
}
