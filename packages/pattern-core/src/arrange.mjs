// The arrangement painter's data - the textual format `arrange()` carries, its parser/serializer,
// and the span math both the editor (which draws it) and the host (which gates tracks by it)
// read. Like pianoroll.mjs this is served verbatim to the browser and imports nothing.
//
// An arrangement is a set of CLIPS painted onto lanes, playlist-style: each clip says "this
// labelled block sounds here". Format: space-separated `label,lane,start,len`, e.g.
// "drums,0,0,8 bass,1,4,4 drums,0,12,4".
//   label - the block's label (`drums:` in the buffer). No commas or whitespace, which a label
//           can't hold anyway.
//   lane  - which row it is painted on, an integer >= 0. Lanes are display only: the same label
//           may sit on any number of lanes, and a lane may hold any number of labels. They are
//           there so a painter can lay parts out the way a playlist does.
//   start - onset, in CYCLES (decimals allowed: 4.5 is halfway through bar 4)
//   len   - length in cycles, > 0
//
// What a clip MEANS at playback time: a block painted anywhere in an arrangement plays ONLY inside
// its clips - the bare `label: pattern` stops being a loop and becomes a part. The arrangement
// loops over its length (`len` option, or the end of the last clip rounded up to a whole cycle),
// and the pattern inside a clip runs on absolute cycle time, so a `<a b>` alternation keeps its
// place whether or not its block was sounding the bar before. Blocks never painted play as before.
//
// The options are editor metadata plus the loop length:
//   len   - loop length in cycles (default: the last clip's end, rounded up)
//   snap  - the painter's grid, in cells per cycle (default 1 - one cell is one bar)
//   lanes - lane names, an array indexed by lane (a hole or an empty string is an unnamed lane)

export const ARRANGE_DEFAULT_SNAP = 1;
export const ARRANGE_MIN_LANES = 4;
const EPS = 1e-9;

const num = (s) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/**
 * "drums,0,0,8 bass,1,4,4" -> [{ label, lane, start, len }]. Malformed tokens are skipped rather
 * than thrown on: a half-typed clip should cost a missing clip, not the whole arrangement.
 */
export function parseArrangement(str) {
  const out = [];
  for (const tok of String(str ?? '').trim().split(/\s+/)) {
    if (!tok) continue;
    const [label, laneS, startS, lenS] = tok.split(',');
    const lane = num(laneS);
    const start = num(startS);
    const len = num(lenS);
    if (!label || lane == null || start == null || len == null || len <= 0) continue;
    out.push({ label, lane: Math.max(0, Math.round(lane)), start, len });
  }
  return out;
}

const fmt = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
};

/** The inverse of parseArrangement, clips ordered by lane then time so a diff reads. */
export function serializeArrangement(clips) {
  return [...clips]
    .filter((c) => c && c.label && c.len > 0)
    .sort((a, b) => a.lane - b.lane || a.start - b.start || (a.label < b.label ? -1 : 1))
    .map((c) => `${c.label},${c.lane},${fmt(c.start)},${fmt(c.len)}`)
    .join(' ');
}

/** True for a string that reads as clip data (or is empty) - what the editor folds. */
export function looksLikeArrangeString(str) {
  const s = String(str ?? '').trim();
  if (!s) return true;
  return s.split(/\s+/).every((tok) => /^[^,\s]+,\d+,-?[\d.]+,[\d.]+$/.test(tok));
}

/** The options as the builder and the editor both read them, defaults filled in. */
export function normalizeArrangeOpts(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const snap = Math.max(1, Math.round(num(o.snap) ?? ARRANGE_DEFAULT_SNAP));
  const rawLen = num(o.len);
  const len = rawLen != null && rawLen > 0 ? rawLen : null;
  const lanes = Array.isArray(o.lanes) ? o.lanes.map((n) => (n == null ? '' : String(n))) : [];
  return { snap, len, lanes };
}

/**
 * How long the arrangement's loop is, in cycles: the explicit `len`, else the end of the last clip
 * rounded up to a whole cycle (never less than one - an empty arrangement still has to loop
 * something rather than divide by zero).
 */
export function arrangementLength(clips, opts = {}) {
  const { len } = normalizeArrangeOpts(opts);
  if (len != null) return len;
  let end = 0;
  for (const c of clips) end = Math.max(end, c.start + c.len);
  return Math.max(1, Math.ceil(end - EPS));
}

/**
 * Where each label sounds: label -> sorted, merged [start, end) spans in cycles, lanes forgotten.
 * Two clips of one label that touch or overlap (on any lanes) are one span - the block is either
 * sounding at a moment or it isn't.
 */
export function arrangementSpans(clips) {
  const byLabel = new Map();
  for (const c of clips) {
    if (!(c.len > 0)) continue;
    const list = byLabel.get(c.label) ?? [];
    list.push([c.start, c.start + c.len]);
    byLabel.set(c.label, list);
  }
  for (const [label, list] of byLabel) {
    list.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of list) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + EPS) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    byLabel.set(label, merged);
  }
  return byLabel;
}

/** Is cycle position `pos` (already reduced modulo the loop) inside one of `spans`? */
export function inSpans(spans, pos) {
  for (const [s, e] of spans) {
    if (pos >= s - EPS && pos < e - EPS) return true;
    if (s > pos) break; // sorted, so nothing later can hold it
  }
  return false;
}

/** How many lanes the painter shows: enough for every clip and every named lane, never fewer than the minimum. */
export function arrangementLaneCount(clips, opts = {}) {
  const { lanes } = normalizeArrangeOpts(opts);
  let n = Math.max(ARRANGE_MIN_LANES, lanes.length);
  for (const c of clips) n = Math.max(n, c.lane + 1);
  return n;
}
