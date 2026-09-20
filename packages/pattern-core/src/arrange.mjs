// The arrangement painter's data - the textual format `_arrange()` carries, its parser/serializer,
// and the span math both the editor (which draws it) and the host (which gates tracks by it)
// read. Like pianoroll.mjs this is served verbatim to the browser and imports nothing.
//
// An arrangement is a set of CLIPS, playlist-style: each clip says "this labeled block sounds
// here". Format: space-separated `label,start,len[,extras]`, e.g. "drums,0,8 bass,4,4 drums,12,4".
//   label - the block's label (`drums:` in the buffer). No commas or whitespace, which a label
//           can't hold anyway.
//   start - onset, in CYCLES (decimals allowed: 4.5 is halfway through bar 4)
//   len   - length in cycles, > 0
// Then any number of TAGGED extras, each one character of tag and the rest its value. Tagged
// rather than positional so the set can grow without a saved song's clips changing meaning, and
// so anything else in these fields is malformed - the retired lane column was a NUMBER here, and
// a pattern from that era must never come back as a song with parts silently muted or rebound:
//   m      - a MUTED clip: it keeps its place in the song (and is drawn there, greyed) but sounds
//            nothing, which is how a part is taken out for a listen without losing the painting.
//   r<id>  - the ROLL this clip plays, on a track headed by clips() (see signal.mjs). Only such a
//            track reads it: every other track plays its own one pattern wherever it is painted,
//            and a clip of it says only WHEN. Two clips naming one roll are linked - one set of
//            notes, drawn once, heard in both places.
//   o<num> - how far INTO its pattern (or, on a clips() track, its roll) the clip starts, in cycles
//            (omitted when 0, the usual case). What splitting a clip leaves behind: the second
//            piece starts where the first left off, so cutting a clip in two changes where you can
//            grab it and nothing you hear. A clip whose offset equals its start plays the pattern
//            on the song's own timeline, bar for bar.
//   c<hex>  - a color chosen for THIS clip, six hex digits without the `#`. The `colors` option
//            below is the same choice made for a whole track; this one overrides it for one clip,
//            which is what right-clicking a clip and picking a color writes. Editor metadata:
//            nothing about playback reads it.
// Every extra is written only when it is set, so a clip that has none is spelled exactly as it
// always was.
//
// ONE ROW PER TRACK, exactly. A row is a block and a block is a row, so painting is only ever
// "draw where this track sounds" - there is no second question about WHAT it plays there. A part
// that comes and goes (the fill that replaces the kick at the end of a phrase) is its own track,
// drawn on its own row, and the two are held together by being in the same GROUP (see groups.mjs):
// the tree says they mix as one, the rows say when each sounds. Rows of one group sit under it and
// fold away with it, which is what keeps a song of forty tracks readable.
//
// The one track with NO row is a BUS - a block headed by audio(): the reverb return reading a
// .bus() sum, the parallel copy of the drums. Nothing of its own sounds on it; the tracks feeding
// it are rows already and gate themselves, so it sounds when they do, and a row for it could only
// cut a tail off. The painter leaves it out (labels.mjs's isBusBlock, arBlocks in the web app)
// and the host never gates it. A group() is the other track with no notes of its own, but it
// keeps a row: its members sit under it. A group with NO BRACES - `main: group().fx(...)`, the
// master chain - has nothing under it and is always on, so it gets no row either (labels.mjs's
// isBodylessGroup; isRowlessBlock asks both questions at once).
//
// (An earlier design gave a track's VARIATIONS its row and asked each clip which variation it
// meant. Every gesture then needed a "which one" answer the painter had nowhere good to put, so
// rows and blocks are 1:1 now and grouping carries the relationship instead. The retired
// spellings from that era - a `lane` column, `label:roll` bindings, the `$: arrange(…)` call -
// no longer parse; the saved patterns that used them were migrated in place. The `r` field above
// is NOT that question coming back: a clips() track has no pattern of its own, so its clips are
// the only thing that can say what plays there and nothing has to choose between them.)
//
// What a clip MEANS at playback time: a block plays ONLY inside its clips - the bare
// `label: pattern` stops being a loop and becomes a part - and a block with no clips at all is
// silent. That is only safe because every track is FILLED when it joins the arrangement (the
// painter paints it edge to edge, see arReconcileTracks in the web app), so a row is empty only
// because it was emptied. A GROUP is the exception: it joins with nothing painted, since it has no
// notes of its own and what sounds on it is whatever its members are doing. The song runs from bar
// 0 to the end of its last clip and STOPS there: the only thing that keeps it going is a loop
// region (the `loops` option), so painting more song never moves where the playhead is.
//
// TIME INSIDE A CLIP IS THE CLIP'S OWN: the pattern starts where the clip starts (plus its `o`
// offset), so a clip is a thing you can put anywhere - a four-bar note plays its four bars
// wherever the clip sits, not only where the clip happens to begin on a multiple of four, and a
// `<a b>` starts on `a` in every clip. Everything the track reads follows: its notes, the channels
// read at their onsets, its polled controls (see ClipClock). A clips() track has always worked
// this way for its rolls (see signal.mjs); a painted GROUP does not - it has no pattern of its
// own to restart, and its clips only gate the submix.
//
// One reader stays on the SONG: an automation lane (signal.mjs's auto()) is drawn against the
// arrangement, so bar 48 of the lane is bar 48 of the song whichever clip is playing over it. A
// read made in clip time says how far it was moved (see withClipShift), and auto() moves it back.
//
// The options are editor metadata plus the loop regions:
//   snap   - the painter's grid, in cells per cycle (default 1 - one cell is one bar)
//   tracks - the tracks that are IN the arrangement, by label. Membership, not order (the rows
//            follow the buffer): it is what tells a track that has never been arranged - fill it -
//            from one whose clips you deleted on purpose - leave it silent. See
//            reconcileArrangement.
//   colors - { label: "#rrggbb" } for the TRACKS a person has colored by hand. A track with no
//            entry takes a hue step off its group's color (see the painter), so the members of one
//            group read as a family and an entry is only written once someone has chosen. One
//            clip colored on its own writes the `c` field above instead, which wins over this.
//   autos  - the automation lanes PINNED into the painter's strip, by name, top to bottom
//   loops - loop regions, [[name, start, end], …] in cycles: while a region is ARMED, playback
//           entering it loops it until the player releases it (ctrl+L), then runs on to the next
//           armed region, or to the end of the song. A fresh arrangement is given one region over
//           its whole length, so a song that has never been arranged loops as it always did, and
//           deleting that region is what makes it play through. The painter always writes this
//           key, empty or not. See ArrangeClock below for the timing.
//   len   - RETIRED, read only from a call that has no `loops` key at all: a song from before the
//           song stopped at its end looped over its whole length, and this was that length. Such a
//           call plays as one region over it (see arrangementLoops); the painter writes `loops`
//           in its place the first time it touches the call.

// The paint grid is editor metadata - nothing about playback reads it - and it defaults to
// 'auto': the painter picks a division from how far it is zoomed in, so the grid you snap to is
// always the grid you can see (see arSnapAuto in the web app). A number here pins it instead, and
// is written into the call only when it has been pinned, so the default stays absent.
export const ARRANGE_DEFAULT_SNAP = 'auto';
// How long a fresh arrangement is, in cycles: what a track is filled over when nothing is painted
// yet, and the loop region the painter seeds it with.
export const ARRANGE_DEFAULT_LEN = 8;
// The name of the region a fresh arrangement loops over, and of the one a retired whole-song loop
// is read as.
export const ARRANGE_SONG_LOOP = 'song';
const EPS = 1e-9;

const num = (s) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/**
 * "drums,0,8 fill,12,4" -> [{ label, start, len }]. Malformed tokens are skipped rather than
 * thrown on: a half-typed clip should cost a missing clip, not the whole arrangement.
 *
 * The optional fields (see the format above) appear on the object only when the token sets them,
 * so an ordinary clip is the same three-key object it has always been - which is what the
 * painter's snapshots, its serializer and the tests all round-trip through.
 */
export function parseArrangement(str) {
  const out = [];
  for (const tok of String(str ?? '').trim().split(/\s+/)) {
    if (!tok) continue;
    const parts = tok.split(',');
    if (parts.length < 3) continue;
    const label = parts[0];
    const start = num(parts[1]);
    const len = num(parts[2]);
    if (!label || start == null || len == null || len <= 0) continue;
    const clip = { label, start, len };
    let bad = false;
    for (const ex of parts.slice(3)) {
      // Each extra once: a token setting the same thing twice says two different things and is
      // no more readable than a token setting something unknown.
      if (ex === 'm' && !clip.mute) clip.mute = true;
      else if (ex.length > 1 && ex[0] === 'r' && clip.roll == null) clip.roll = ex.slice(1);
      else if (ex.length > 1 && ex[0] === 'o' && clip.off == null && num(ex.slice(1)) != null) clip.off = num(ex.slice(1));
      else if (ex.length === 7 && ex[0] === 'c' && clip.color == null && /^[0-9a-fA-F]{6}$/.test(ex.slice(1))) clip.color = `#${ex.slice(1).toLowerCase()}`;
      else { bad = true; break; }
    }
    if (bad) continue;
    if (clip.off === 0) delete clip.off; // the resting value is spelled by leaving it out
    out.push(clip);
  }
  return out;
}

const fmt = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
};

/**
 * The inverse of parseArrangement, clips ordered by track then time so a diff reads. The extras
 * are written in a fixed order (mute, roll, offset) whatever order they were read in, so one
 * clip has exactly one spelling.
 */
export function serializeArrangement(clips) {
  return [...clips]
    .filter((c) => c && c.label && c.len > 0)
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || a.start - b.start)
    .map((c) => `${c.label},${fmt(c.start)},${fmt(c.len)}${c.mute ? ',m' : ''}`
      + `${c.roll ? `,r${c.roll}` : ''}${c.off ? `,o${fmt(c.off)}` : ''}`
      + `${/^#[0-9a-f]{6}$/i.test(c.color ?? '') ? `,c${c.color.slice(1).toLowerCase()}` : ''}`)
    .join(' ');
}

/** True for a string that reads as clip data (or is empty) - what the editor folds. */
export function looksLikeArrangeString(str) {
  const s = String(str ?? '').trim();
  if (!s) return true;
  return s.split(/\s+/).every((tok) => /^[^,\s]+,-?[\d.]+,[\d.]+(?:,(?:m|r[^,\s]+|o-?[\d.]+|c[0-9a-fA-F]{6}))*$/.test(tok));
}

/** The options as the builder and the editor both read them, defaults filled in. */
export function normalizeArrangeOpts(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  // 'auto' (or nothing, or anything unreadable) leaves the division to the painter's zoom; a
  // number pins it to that many cells per bar.
  const snapNum = num(o.snap);
  const snap = snapNum == null ? ARRANGE_DEFAULT_SNAP : Math.max(1, Math.round(snapNum));
  const rawLen = num(o.len);
  const len = rawLen != null && rawLen > 0 ? rawLen : null;
  // The pinned automation lanes, by name, in the order they are stacked under the clips. Editor
  // metadata like `snap`: nothing about playback reads it, but it belongs to the song rather than
  // to the browser, so a patch opened anywhere comes up showing the lanes it was being written
  // against. Blanks and duplicates are dropped - a lane is pinned once or not at all.
  const autos = [];
  if (Array.isArray(o.autos)) {
    for (const a of o.autos) {
      const id = String(a ?? '').trim();
      if (id && !autos.includes(id)) autos.push(id);
    }
  }
  const tracks = [];
  if (Array.isArray(o.tracks)) {
    for (const t of o.tracks) {
      const label = String(t ?? '').trim();
      if (label && !tracks.includes(label)) tracks.push(label);
    }
  }
  // Hand-chosen clip colors, by label. Only what reads as a color is kept: a stray value here
  // would otherwise be painted as CSS's idea of it, which is black.
  const colors = {};
  if (o.colors && typeof o.colors === 'object') {
    for (const [label, c] of Object.entries(o.colors)) {
      const hex = String(c ?? '').trim();
      if (label.trim() && /^#[0-9a-fA-F]{6}$/.test(hex)) colors[label.trim()] = hex.toLowerCase();
    }
  }
  const loops = [];
  if (Array.isArray(o.loops)) {
    for (const item of o.loops) {
      const [name, start, end] = Array.isArray(item) ? item : [item?.name, item?.start, item?.end];
      const a = num(start);
      const b = num(end);
      if (a == null || b == null || b <= a) continue;
      loops.push({ name: String(name ?? '').trim() || `loop${loops.length + 1}`, start: a, end: b });
    }
    loops.sort((x, y) => x.start - y.start || x.end - y.end);
  }
  // No `loops` key at all is a call from before the song stopped at its end, when the whole song
  // looped (see arrangementLoops). Carried as a flag so normalizing twice reads the same.
  const wholeLoop = !Array.isArray(o.loops) || o.wholeLoop === true;
  return { snap, len, tracks, colors, autos, loops, wholeLoop };
}

/**
 * Bring the arrangement up to date with the buffer's tracks: every track that has never been in it
 * joins, FILLED - a clip over the whole song, so it plays exactly as it did before there was an
 * arrangement. A track already in it is left exactly as it is, empty clips and all: that is the
 * whole reason `tracks` is written down. Without it, "this track is silent" and "this track is new"
 * look identical, and a row you emptied would fill itself again on the next evaluation.
 *
 * `labels` are the buffer's tracks, in document order. A label that has left the buffer is dropped
 * from the membership unless clips still name it - an orphan keeps its row until its clips go.
 *
 * A GROUP joins with nothing painted (`unfilled` - the labels headed by group(), see groups.mjs):
 * unpainted it passes through un-gated, so its effective arrangement is the union of its members'
 * clips - and filling its row would gate the whole submix for no reason anyone asked. Painting it
 * by hand later is the override: then the clips gate the submix (see the host's arrangement pass).
 *
 * Pure: hands back what to write, and writes nothing. The editor applies it (see arReconcileTracks
 * in the web app), which is also what makes it testable without a browser.
 */
export function reconcileArrangement(clips, opts = {}, labels = [], unfilled = []) {
  const o = normalizeArrangeOpts(opts);
  const named = new Set(clips.map((c) => c.label));
  const kept = o.tracks.filter((l) => labels.includes(l) || named.has(l));
  const joining = labels.filter((l) => !kept.includes(l));
  // Only a track with nothing painted is filled. One that already has clips is in the arrangement
  // whatever the membership says. Filled to the end of the song as it stands; with nothing painted
  // anywhere, over the last loop region, and failing that the default length.
  const len = arrangementEnd(clips)
    || Math.max(0, ...arrangementLoops(clips, opts).map((r) => r.end))
    || ARRANGE_DEFAULT_LEN;
  const added = joining
    .filter((l) => !named.has(l) && !unfilled.includes(l))
    .map((label) => ({ label, start: 0, len }));
  const tracks = [...kept, ...joining];
  const changed = added.length > 0 || tracks.length !== o.tracks.length || tracks.some((t, i) => t !== o.tracks[i]);
  return { clips: added.length ? [...clips, ...added] : clips, tracks, added, changed };
}

/**
 * Where the song ends, in cycles: the right edge of its last clip, muted or not (0 with nothing
 * painted). Playback that reaches it with no armed loop region ahead stops there.
 */
export function arrangementEnd(clips) {
  let end = 0;
  for (const c of clips) if (c.len > 0) end = Math.max(end, c.start + c.len);
  return end;
}

/**
 * The loop regions the song plays by. A call with a `loops` key plays exactly those. One without
 * it is from before the song stopped at its end, and looped over its whole length - the retired
 * `len`, else the last clip's end rounded up to a whole cycle, never less than one - so it is read
 * as one region over that, and plays as it always did.
 */
export function arrangementLoops(clips, opts = {}) {
  const o = normalizeArrangeOpts(opts);
  if (!o.wholeLoop) return o.loops;
  const end = o.len ?? Math.max(1, Math.ceil(arrangementEnd(clips) - EPS));
  return [{ name: ARRANGE_SONG_LOOP, start: 0, end }];
}

/**
 * Where each label sounds: label -> sorted, merged [start, end) spans in cycles, lanes forgotten.
 * Two clips of one label that touch or overlap (on any lanes) are one span - the block is either
 * sounding at a moment or it isn't.
 *
 * A MUTED clip contributes nothing: it is a clip you can still see and move, and this is the one
 * place that decides what a clip means to the ear, so muting is exactly "leave it out of here".
 * A track whose every clip is muted therefore gets no spans at all, which the host reads as the
 * silence an emptied row means - the part is out until you unmute it.
 */
export function arrangementSpans(clips) {
  const byLabel = new Map();
  for (const c of clips) {
    if (!(c.len > 0) || c.mute) continue;
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

/** Is song position `pos` inside one of `spans`? */
export function inSpans(spans, pos) {
  for (const [s, e] of spans) {
    if (pos >= s - EPS && pos < e - EPS) return true;
    if (s > pos) break; // sorted, so nothing later can hold it
  }
  return false;
}

/**
 * The clips one track SOUNDS, in time order - what a clips() head plays (see signal.mjs). Muted
 * clips are left out here for the same reason arrangementSpans leaves them out: a muted clip is a
 * clip you can still see and move, and nothing about it reaches the ear.
 */
export function clipsOfLabel(clips, label) {
  return clips.filter((c) => c.label === label && !c.mute && c.len > 0).sort((a, b) => a.start - b.start);
}

/** Every label the arrangement mentions, in the order it first mentions them. */
export function arrangementLabels(clips) {
  const out = [];
  for (const c of clips) if (c.label && !out.includes(c.label)) out.push(c.label);
  return out;
}

/**
 * What an `_arrange(...)` definition evaluates to: the painted clips and options, which the host
 * applies to the blocks they name once every block is built (see the arrangement pass in the web
 * app's /api/evaluate). A plain object rather than a Sig, so the line is a definition and not an
 * extra voice - the same trick setbpm()/setscale() blocks use.
 *
 * The editor writes this call and nobody types it: the arrangement is painted (ctrl+A), and the
 * clip string is what the painter serializes.
 */
export function _arrange(str = '', opts = {}) {
  if (typeof str !== 'string') {
    throw new Error('[arrange] _arrange() takes the clip string the painter writes - press ctrl+A to paint one');
  }
  if (!looksLikeArrangeString(str)) {
    throw new Error('[arrange] _arrange() takes "label,start,len …" clips - press ctrl+A to paint them');
  }
  return { poptartArrangeBlock: true, clips: parseArrangement(str), opts: normalizeArrangeOpts(opts) };
}

/**
 * The song clock: where in the arrangement the transport's cycle IS, once loop regions are taken
 * into account. Without regions it is the cycle itself, running on past the song's `end` (where
 * the host stops the deck - see endCycle); with them, playback entering an armed region wraps back
 * to its start every time it reaches the region's end, until the region is released. Nothing else
 * wraps, so the song's end is not part of where the playhead is: painting the song longer or
 * shorter moves no position.
 *
 * The map is kept as ANCHORS - (cycle, position, released set) triples, one per wrap or release -
 * and a position is read by walking forward from the last anchor before it. That makes it a pure
 * function of the anchors, so the host (which gates the patterns by it) and the editor (which
 * draws the playhead by it) agree exactly when handed the same snapshot, and a release lands as
 * one more anchor rather than as state the two would have to keep in step. Walking ahead of real
 * time (the highlight grid asks cycles early) simply records the wraps early; a release cuts the
 * anchors past its cycle and they are walked again.
 */
export class ArrangeClock {
  constructor({ end = 0, regions = [], anchors = null } = {}) {
    this.setEnd(end);
    this.regions = (regions ?? [])
      .map((r) => ({ name: String(r.name), start: Math.max(0, Number(r.start)), end: Number(r.end) }))
      .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start + EPS)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    this.anchors = anchors?.length
      ? anchors.map((a) => ({ cycle: Number(a.cycle), pos: Number(a.pos), released: new Set(a.released ?? []) }))
      : [{ cycle: 0, pos: 0, released: new Set() }];
  }

  /** Back to the top, every region armed - what a transport stop means. */
  reset() {
    this.anchors = [{ cycle: 0, pos: 0, released: new Set() }];
  }

  /** Where the song ends (see arrangementEnd). No position depends on it, so it is simply set. */
  setEnd(end) {
    this.end = Math.max(0, Number(end) || 0);
  }

  /**
   * The transport cycle at which the song ends, or null while an armed region lies ahead of the
   * playhead - that one will loop until it is released, so there is no end to name yet. Read off
   * the last anchor: with no region ahead of it, walking on records no more.
   */
  endCycle() {
    const a = this.anchors[this.anchors.length - 1];
    if (this._loopFrom(a.pos, a.released)) return null;
    return a.cycle + Math.max(0, this.end - a.pos);
  }

  /**
   * A clock over different `regions` that is where this one is at `cycle`: the same position, the
   * same regions let go of (those that still exist). What editing a loop region mid-song builds,
   * so the playhead stays where it is rather than being walked again from the top.
   */
  rebuilt({ end = this.end, regions = [] } = {}, cycle = 0) {
    const { pos, released } = this.stateAt(cycle);
    const names = new Set((regions ?? []).map((r) => String(r.name)));
    return new ArrangeClock({ end, regions, anchors: [{ cycle, pos, released: released.filter((n) => names.has(n)) }] });
  }

  /** What the editor needs to run an identical clock: plain data, sets as arrays. */
  snapshot() {
    return {
      end: this.end,
      regions: this.regions.map((r) => ({ ...r })),
      anchors: this.anchors.map((a) => ({ cycle: a.cycle, pos: a.pos, released: [...a.released] })),
    };
  }

  _anchorIndexAt(cycle) {
    let i = 0;
    while (i + 1 < this.anchors.length && this.anchors[i + 1].cycle <= cycle + EPS) i++;
    return i;
  }

  /** The region that will next wrap the playhead moving forward from `pos` under `released`, if any. */
  _loopFrom(pos, released) {
    let best = null;
    for (const r of this.regions) {
      if (released.has(r.name)) continue;
      if (r.end > pos + EPS && (!best || r.end < best.end)) best = r;
    }
    return best;
  }

  /** Song position (p >= 0) at transport cycle `cycle`, recording the wraps on the way. */
  posAt(cycle) {
    let i = this._anchorIndexAt(cycle);
    for (let guard = 0; guard < 100000; guard++) {
      const a = this.anchors[i];
      const p = a.pos + (cycle - a.cycle);
      if (p < a.pos - EPS) return Math.max(0, p); // before the first anchor (cycle < 0): nothing to wrap
      const region = this._loopFrom(a.pos, a.released);
      if (!region || p < region.end - EPS) return p; // no armed region ahead: the song runs on
      const next = { cycle: a.cycle + (region.end - a.pos), pos: region.start, released: new Set(a.released) };
      const existing = this.anchors[i + 1];
      if (existing && Math.abs(existing.cycle - next.cycle) < EPS) {
        i++;
      } else {
        this.anchors.splice(i + 1, this.anchors.length, next);
        i++;
      }
    }
    return 0;
  }

  /** The deck's clock reads the song where it is, so nothing it reads was moved (see ClipClock#shiftAt). */
  shiftAt() {
    return 0;
  }

  /** The playhead's state at `cycle`: its position, the region it is looping (if any), the released names. */
  stateAt(cycle) {
    const pos = this.posAt(cycle);
    const a = this.anchors[this._anchorIndexAt(cycle)];
    const region = this._loopFrom(pos, a.released);
    return { pos, looping: region && region.start <= pos + EPS ? region.name : null, released: [...a.released] };
  }

  /**
   * ctrl+L: release the region the playhead is looping at `cycle`, so playback runs on past its
   * end. Returns the name released, or null when nothing was looping there. Recorded as an
   * anchor at that cycle; whatever had been walked beyond it is dropped and walked again.
   */
  release(cycle) {
    const { pos, looping, released } = this.stateAt(cycle);
    if (!looping) return null;
    const i = this._anchorIndexAt(cycle);
    const next = { cycle, pos, released: new Set([...released, looping]) };
    this.anchors.splice(i + 1, this.anchors.length, next);
    return looping;
  }

  /**
   * From `cycle` on, the song is at `pos` - what starting playback from the painter's marker
   * means. One more anchor, with every region armed again (a seek is a fresh run at the song
   * from there, not a continuation of a loop you had let go of); whatever had been walked beyond
   * it is dropped and walked again. Returns the position it landed on.
   */
  seek(cycle, pos) {
    const at = Math.max(0, Number(pos) || 0);
    const i = this._anchorIndexAt(cycle);
    const next = { cycle, pos: at, released: new Set() };
    // A seek at the very cycle an anchor already sits on replaces it rather than stacking a
    // second anchor at the same cycle, which _anchorIndexAt would never look past.
    const from = this.anchors[i] && Math.abs(this.anchors[i].cycle - cycle) < EPS ? i : i + 1;
    this.anchors.splice(from, this.anchors.length, next);
    return at;
  }

  /**
   * The transport span [from, to) cut wherever the song clock jumps, each piece with the constant
   * `delta` that turns its transport cycles into song positions (song = transport + delta). Walks
   * the clock to `to` first, so every wrap inside the span is on record before it is cut at.
   */
  segments(from, to) {
    this.posAt(to);
    const out = [];
    let a = from;
    for (let i = this._anchorIndexAt(from); ; i++) {
      const anchor = this.anchors[i];
      const next = this.anchors[i + 1];
      const b = next && next.cycle < to ? Math.max(a, next.cycle) : to;
      if (b > a) out.push({ from: a, to: b, delta: anchor.pos - anchor.cycle });
      if (b >= to) return out;
      a = b;
    }
  }
}

// The clip shift in force: how far the read being made right now was moved off the song, pattern
// time = song position + shift (a ClipClock window's `shift`). Whoever reads a pattern in clip
// time binds it for the length of the read - songSteps for a grid, the scheduler for everything
// it samples - and a signal that belongs to the song takes it back off (signal.mjs's auto()).
// Reads are synchronous, so one module-level value is the whole mechanism, as it is for the note
// gate. Outside any such read it is 0: the position handed over is the song's.
let clipShift = 0;

/** Runs `fn` as a read made in clip time, `shift` cycles off the song (see above). */
export function withClipShift(shift, fn) {
  const prev = clipShift;
  clipShift = shift;
  try {
    return fn();
  } finally {
    clipShift = prev;
  }
}

/** The clip shift the current read was made under - 0 for a read made in song time. */
export function clipShiftNow() {
  return clipShift;
}

/**
 * songSteps entries handed over one at a time, each with its own `shift` bound for as long as the
 * caller's loop body holds it - withClipShift for a loop, where the reads made at a step are
 * spread through a body too long to wrap. A generator because that is what can hold a binding
 * between two turns of someone else's loop; for...of closes it on the way out of a loop left
 * early, which is what unbinds. Spread into an array, the entries arrive with nothing bound.
 */
export function* stepsUnderShift(entries) {
  const prev = clipShift;
  try {
    for (const entry of entries) {
      clipShift = entry.shift ?? 0;
      yield entry;
    }
  } finally {
    clipShift = prev;
  }
}

/**
 * One TRACK's reading of the song clock: clip-relative time (see the note at the top). Inside a
 * clip the track reads its pattern at `position - clip.start + clip.off`, so each clip plays the
 * pattern from its own beginning; between clips it reads nothing at all, which is the silence an
 * unpainted bar means - so a track read through this needs no gate of its own.
 *
 * It answers the two questions ArrangeClock answers for a reader (posAt, segments) and is handed
 * to the scheduler and the highlighter in the deck clock's place, so every read a track makes -
 * steps, channels at their onsets, polled controls, preset and shape swaps - lands in clip time
 * without any of them knowing. It holds the deck's clock rather than a copy, so a release or a
 * seek on that is followed at once. What it moved a read by is on offer too (shiftAt, and the
 * `shift` on each segment), for the signals that are read on the song whatever the clip.
 *
 * `clips` are this track's own, muted ones already left out (see clipsOfLabel). Clips of one
 * track do not overlap - the painter sees to that - but a song from before it did may hold some:
 * where two cover a bar, the one that starts LATER has it, which is the clip drawn on top.
 */
export class ClipClock {
  constructor(clock, clips = []) {
    this.clock = clock;
    const edges = [...new Set(clips.flatMap((c) => [c.start, c.start + c.len]))].sort((a, b) => a - b);
    this.windows = []; // [{ from, to, shift }], in song order: pattern time = song position + shift
    for (let i = 0; i + 1 < edges.length; i++) {
      const from = edges[i];
      const to = edges[i + 1];
      let top = null;
      for (const c of clips) {
        if (c.start <= from + EPS && c.start + c.len >= to - EPS && (!top || c.start > top.start)) top = c;
      }
      if (!top) continue;
      const shift = (top.off ?? 0) - top.start;
      const last = this.windows[this.windows.length - 1];
      if (last && Math.abs(last.to - from) < EPS && Math.abs(last.shift - shift) < EPS) last.to = to;
      else this.windows.push({ from, to, shift });
    }
  }

  /**
   * Where the track's pattern is at transport cycle `cycle`. Between clips - where nothing plays,
   * but a polled control is still read - it runs on from the clip before, and ahead of the first
   * clip it counts in toward that one.
   */
  posAt(cycle) {
    const pos = this.clock.posAt(cycle);
    return pos + this._shiftAtPos(pos);
  }

  /**
   * How far the track's pattern sits off the song at transport cycle `cycle`: posAt less the
   * deck's own position. What a read made there is bound with (see withClipShift), so a signal on
   * song time can find the song again.
   */
  shiftAt(cycle) {
    return this._shiftAtPos(this.clock.posAt(cycle));
  }

  _shiftAtPos(pos) {
    let shift = this.windows.length ? this.windows[0].shift : 0;
    for (const w of this.windows) {
      if (w.from > pos + EPS) break;
      shift = w.shift;
    }
    return shift;
  }

  /**
   * The deck clock's segments, cut down to this track's clips and moved into their time. Each
   * carries the `shift` that moved it, which `delta` has folded in with the deck's own jumps.
   */
  segments(from, to) {
    const out = [];
    for (const seg of this.clock.segments(from, to)) {
      const lo = seg.from + seg.delta;
      const hi = seg.to + seg.delta;
      for (const w of this.windows) {
        const a = Math.max(lo, w.from);
        const b = Math.min(hi, w.to);
        if (b > a + EPS) out.push({ from: a - seg.delta, to: b - seg.delta, delta: seg.delta + w.shift, shift: w.shift });
      }
    }
    return out;
  }
}

/**
 * Every step a pattern plays in the transport span [from, to), each read where the SONG is at that
 * moment - what makes a track started from the painter's marker, or brought round again by a loop
 * region, play the bars the song is on rather than the bars the transport has counted.
 *
 * Returns `{ step, cycle, delta }`: `step` exactly as the pattern gave it for song cycle `cycle`,
 * so its onset is at song position `cycle + step.start` - where every channel, swing grid and
 * sampler control is read - and at transport cycle `cycle + step.start - delta`, which is when it
 * plays. `shift` is the clip shift that position was read under, 0 on the deck's own clock. Both
 * readers of a track's grid (the scheduler that plays it and the host's highlighter)
 * walk it through here, so the two cannot disagree about which bar is sounding.
 *
 * With no clock (a deck without an arrangement) the song is the transport: delta 0, never a wrap.
 * The song positions a clock jumps between are painter-snapped and so may sit inside a cycle; the
 * span is read piece by piece, a step belonging to the piece its song onset lands in.
 */
export function songSteps(stepsForCycle, from, to, clock = null) {
  const out = [];
  for (const { from: a, to: b, delta, shift = 0 } of clock ? clock.segments(from, to) : [{ from, to, delta: 0 }]) {
    const lo = a + delta - EPS;
    const hi = b + delta - EPS;
    for (let cycle = Math.floor(lo + 2 * EPS); cycle < hi; cycle++) {
      // The grid is built under the shift it is read at, so a lane that decides the structure -
      // .when(auto("drop").gt(0.5), ...) - is read where the song is. `shift` rides on each entry
      // for whoever samples the step's channels afterwards (see withClipShift).
      for (const step of withClipShift(shift, () => stepsForCycle(cycle))) {
        const at = cycle + step.start;
        if (at >= lo && at < hi) out.push({ step, cycle, delta, shift });
      }
    }
  }
  return out;
}
