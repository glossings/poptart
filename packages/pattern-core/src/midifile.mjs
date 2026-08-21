// Standard MIDI Files -> drawn note grids, so a .mid dragged into the editor lands as a lane you
// can open the piano roll on:
//
//   bass: pianoroll("36,0,4 47,9,3,0.5", { grid: 8, len: 16 })
//
// A roll rather than mini-notation because it's the form that stays editable: the notes are on a
// grid you can see, drag and audition, and the roll's own →♪ writes the mini-notation whenever
// it's wanted (in the key, if the roll is folded to one) - so nothing is lost by landing here
// first, and everything the pencil can do is gained.
//
// Three jobs live here, and nothing else: parse the file (a small SMF reader - no dependency, in
// keeping with the rest of this package), decide what grid the music is actually on, and guess
// what key it's in. Placing the result in the buffer is the editor's job - see client.js's midi
// import.
//
// Time is reported in CYCLES throughout, because that's the unit patterns are written in: a cycle
// is 4 beats (the Transport's cps = bpm/240), so a 4/4 bar is one cycle. A file in another metre
// still imports - its bars just don't line up with cycle boundaries, which `midiFileToLanes`
// reports as `timeSig` so the caller can say so.

import { UNQUANTIZED_GRID } from './record.mjs';
import { serializePianoRoll, PIANOROLL_DEFAULT_INDEX } from './pianoroll.mjs';

// ---------------------------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------------------------

const MThd = 0x4d546864;
const MTrk = 0x4d54726b;

const DEFAULT_BPM = 120;

/** Beats in one cycle - the Transport's definition (cps = bpm / 240). */
export const BEATS_PER_CYCLE = 4;

function u16(b, p) {
  return (b[p] << 8) | b[p + 1];
}

function u32(b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

/** MIDI's variable-length quantity: 7 bits per byte, high bit set on all but the last. */
function readVlq(b, p) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    if (p >= b.length) throw new Error('[midifile] file ends inside a variable-length number');
    const byte = b[p++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return [value, p];
  }
  throw new Error('[midifile] variable-length number is too long');
}

function asBytes(data) {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/**
 * Parses a Standard MIDI File into per-track note lists, with times in beats.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{
 *   format: number,
 *   bpm: number,             // the file's first tempo, or 120 if it never sets one
 *   timeSig: {num: number, den: number},
 *   tracks: Array<{ index: number, name: string|null,
 *     notes: Array<{ midi: number, vel: number, channel: number, start: number, end: number }> }>
 * }}
 */
export function parseMidiFile(data) {
  const b = asBytes(data);
  if (b.length < 14 || u32(b, 0) !== MThd) {
    throw new Error('[midifile] not a MIDI file (no MThd header)');
  }
  const headerLen = u32(b, 4);
  const format = u16(b, 8);
  const division = u16(b, 12);

  // Collected across all tracks: tempo and metre are properties of the piece, and in a format-1
  // file they live in track 0 rather than in the track whose notes they describe. Only the first
  // of each is kept - a pattern lane has one grid, so a tempo map can't be represented anyway.
  const meta = { bpm: null, timeSig: null };

  const tracks = [];
  let p = 8 + headerLen;
  while (p + 8 <= b.length) {
    const type = u32(b, p);
    const len = u32(b, p + 4);
    const start = p + 8;
    const end = Math.min(start + len, b.length);
    if (type === MTrk) tracks.push(readTrack(b, start, end, tracks.length, meta));
    p = start + len;
  }
  if (!tracks.length) throw new Error('[midifile] the file has no tracks');

  const bpm = meta.bpm ?? DEFAULT_BPM;
  const toBeats = beatsConverter(division, bpm);
  for (const tr of tracks) {
    for (const nt of tr.notes) {
      nt.start = toBeats(nt.start);
      nt.end = toBeats(nt.end);
    }
  }

  return { format, bpm, timeSig: meta.timeSig ?? { num: 4, den: 4 }, tracks };
}

/**
 * Ticks -> beats. With the usual ticks-per-quarter division this is exact and tempo-independent;
 * an SMPTE division (real time, high bit set) has to go through seconds, so it reads beats off the
 * file's tempo and a tempo change mid-file would skew it.
 */
function beatsConverter(division, bpm) {
  if (!(division & 0x8000)) {
    const ppq = division || 96;
    return (tick) => tick / ppq;
  }
  const fps = 256 - (division >> 8); // stored as a negative two's-complement frame rate
  const ticksPerFrame = division & 0xff;
  const ticksPerSecond = Math.max(1, fps * ticksPerFrame);
  return (tick) => (tick / ticksPerSecond) * (bpm / 60);
}

// One MTrk chunk -> its notes (times still in ticks; the caller converts once the tempo is known).
function readTrack(b, start, end, index, meta) {
  const notes = [];
  const open = new Map(); // `${channel}:${midi}` -> note objects still waiting for their note-off
  let name = null;
  let tick = 0;
  let running = 0;
  let p = start;

  const noteOff = (channel, midi, at) => {
    const key = `${channel}:${midi}`;
    const pending = open.get(key);
    if (!pending?.length) return;
    pending.shift().end = at; // oldest first, so overlapping repeats of one pitch nest correctly
    if (!pending.length) open.delete(key);
  };

  while (p < end) {
    const [delta, afterDelta] = readVlq(b, p);
    p = afterDelta;
    tick += delta;
    if (p >= end) break;

    let status;
    if (b[p] & 0x80) {
      status = b[p++];
      running = status < 0xf0 ? status : 0; // a meta/sysex event cancels running status
    } else {
      status = running;
      if (!status) throw new Error('[midifile] a data byte appears before any status byte');
    }

    if (status === 0xff) {
      const type = b[p++];
      const [len, afterLen] = readVlq(b, p);
      p = afterLen;
      if (type === 0x03 && name === null && len) name = text(b, p, len);
      else if (type === 0x51 && len >= 3 && meta.bpm === null) {
        const usPerQuarter = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
        if (usPerQuarter > 0) meta.bpm = 60e6 / usPerQuarter;
      } else if (type === 0x58 && len >= 2 && meta.timeSig === null) {
        meta.timeSig = { num: b[p], den: 2 ** b[p + 1] };
      }
      p += len;
      if (type === 0x2f) break; // end of track
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const [len, afterLen] = readVlq(b, p);
      p = afterLen + len;
      continue;
    }

    const kind = status & 0xf0;
    const channel = status & 0x0f;
    if (kind === 0x90 || kind === 0x80) {
      const midi = b[p++];
      const vel = b[p++];
      if (kind === 0x90 && vel > 0) {
        const note = { midi, vel: vel / 127, channel, start: tick, end: tick };
        notes.push(note);
        const key = `${channel}:${midi}`;
        if (open.has(key)) open.get(key).push(note);
        else open.set(key, [note]);
      } else {
        noteOff(channel, midi, tick);
      }
    } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
      p += 2;
    } else if (kind === 0xc0 || kind === 0xd0) {
      p += 1;
    } else {
      throw new Error(`[midifile] unknown status byte 0x${status.toString(16)}`);
    }
  }

  // Notes the file never released ring until the track ends rather than vanishing.
  for (const pending of open.values()) for (const note of pending) note.end = tick;

  return { index, name, notes };
}

function text(b, p, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = b[p + i];
    if (c >= 0x20 || c === 0x09) out += String.fromCharCode(c);
  }
  return out.trim() || null;
}

// ---------------------------------------------------------------------------------------------
// File -> lanes
// ---------------------------------------------------------------------------------------------

/** GM's percussion channel (0-based). Its "pitches" are drum slots, not notes. */
const DRUM_CHANNEL = 9;

/**
 * Track names that mean "this is a kit", for the many exports that put drums on an ordinary
 * channel instead of 10. Getting this wrong in either direction is only ever a default the import
 * dialog can override, but getting it right matters a lot: a kit read as pitches is usually the
 * MOST played part in the file, so its slot numbers (kick 36, snare 38, hat 42 …) swamp the
 * pitch-class histogram and drag the detected key somewhere unrelated to the actual music.
 */
const DRUM_NAME_RE = /\b(drum|drums|perc|percussion|kit|beat|batterie|bateria|kick|snare|hat|hihat)\b/i;

const looksPercussive = (channel, name) => channel === DRUM_CHANNEL || DRUM_NAME_RE.test(name ?? '');

/**
 * A parsed file split into the lanes an editor should write: one per (track, channel) pair that
 * actually plays something, with note times in CYCLES and a name taken from the file where it has
 * one. Every lane shares one `cycles` length - they're separate tracks of one piece, and a lane
 * that stopped early still has to loop with the rest.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{
 *   bpm: number, timeSig: {num: number, den: number}, cycles: number, noteCount: number,
 *   lanes: Array<{ name: string|null, channel: number, drums: boolean,
 *     events: Array<{ note: number, vel: number, start: number, end: number }> }>
 * }}
 */
export function midiFileToLanes(data, { beatsPerCycle = BEATS_PER_CYCLE } = {}) {
  const file = parseMidiFile(data);
  const lanes = [];

  for (const track of file.tracks) {
    const byChannel = new Map();
    for (const nt of track.notes) {
      if (!byChannel.has(nt.channel)) byChannel.set(nt.channel, []);
      byChannel.get(nt.channel).push(nt);
    }
    const multi = byChannel.size > 1; // one track driving several channels: name them apart
    for (const [channel, notes] of [...byChannel.entries()].sort((a, b) => a[0] - b[0])) {
      const drums = looksPercussive(channel, track.name);
      const base = track.name ?? (drums ? 'drums' : null);
      lanes.push({
        name: multi && base ? `${base} ch${channel + 1}` : base,
        channel,
        drums,
        events: notes
          .map((nt) => ({
            note: nt.midi,
            vel: Math.round(Math.min(1, Math.max(0.01, nt.vel)) * 100) / 100,
            start: nt.start / beatsPerCycle,
            end: nt.end / beatsPerCycle,
          }))
          .sort((a, b) => a.start - b.start || a.note - b.note),
      });
    }
  }

  const ends = lanes.flatMap((l) => l.events.map((e) => Math.max(e.end, e.start)));
  const cycles = ends.length ? Math.max(1, Math.ceil(Math.max(...ends) - 1e-6)) : 1;
  const noteCount = lanes.reduce((n, l) => n + l.events.length, 0);
  if (!noteCount) throw new Error('[midifile] the file has no notes');

  return { bpm: file.bpm, timeSig: file.timeSig, cycles, noteCount, lanes };
}

// ---------------------------------------------------------------------------------------------
// What grid is this on?
// ---------------------------------------------------------------------------------------------

/**
 * Slots per cycle to try, in the order they're preferred: the coarsest grid that fits wins, so a
 * plain sixteenth-note part comes out as 16 readable tokens per cycle instead of 96 mostly-rests.
 * Straight divisions come before their triplet equivalents at the same fineness; the last few only
 * turn up when a part mixes the two. Nothing coarser than a quarter note - a grid is also what
 * note lengths round to, and half-cycle resolution would smear every part it was applied to.
 */
export const GRID_CANDIDATES = [4, 8, 16, 12, 32, 24, 48, 64];

/**
 * How far an onset may be shoved to reach a grid before that grid counts as wrong, as a fraction
 * of one slot. Measuring in slots rather than in absolute time is what keeps a finer grid from
 * winning by default: a triplet is a third of a slot off a 32nd grid however small that third is
 * in seconds, so 32 is rejected and 12 is found. A tenth of a slot still absorbs the tick rounding
 * in a DAW's export - but not a human performance, which is meant to come out unquantized.
 */
const GRID_TOLERANCE = 0.1;

/**
 * The coarsest candidate grid every onset in `starts` (cycle positions) sits on, or 0 when none
 * does - which is `recordingToMini`'s "unquantized" signal, and the honest answer for a part that
 * was played by hand rather than drawn.
 */
export function pickGrid(starts, { candidates = GRID_CANDIDATES, tolerance = GRID_TOLERANCE } = {}) {
  for (const R of candidates) {
    let worst = 0;
    for (const s of starts) worst = Math.max(worst, Math.abs(s * R - Math.round(s * R)));
    if (worst <= tolerance) return R;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Lanes -> code
// ---------------------------------------------------------------------------------------------

/**
 * Each lane as the ARGUMENTS of the roll that plays it - `"<notes>", { grid, len }`, which the
 * editor files under a name (`_roll("bass", …)`, folded into the definitions block at the bottom of
 * the buffer) and plays with a `pianoroll("bass")` after the lane's `label:`. Arguments rather than
 * a whole call because those are the two halves the editor needs separately; wrap them in
 * `pianoroll(…)` to get the inline form back.
 *
 * The notes stay absolute MIDI: a roll holds pitches, and the key only enters when the roll is
 * folded to one or converted to mini-notation, both of which are the roll's own business (and both
 * of which read the buffer's `setscale`). That also means percussion needs no special case here -
 * a GM slot number is just a lane of the roll.
 *
 * Cells are integers, so a lane that fits no grid is drawn on the same fine grid the recorder
 * falls back to (`UNQUANTIZED_GRID`) rather than losing its feel to a coarse one. The loop length
 * is the file's whole length in cells, so a multi-cycle file plays through and repeats as one roll
 * - `len` past `grid` is exactly what `<…>*grid` does over several cycles.
 *
 * @param {{lanes: Array, cycles: number}} parsed - straight from `midiFileToLanes`.
 * @param {object} [opts]
 * @param {'auto'|number} [opts.grid] - cells per cycle; 'auto' detects one per lane, 0 = keep the
 *   timing (the fine grid above).
 * @returns {{ entries: Array<{ name: string|null, drums: boolean, grid: number, len: number,
 *   quantized: boolean, notes: Array<{midi: number, index: number, start: number, len: number, vel: number,
 *   prob: number, mute: boolean}>, body: string }> }} - `quantized` is false for a lane that fit no grid and was
 *   drawn on the fine one, which is worth saying out loud to whoever dropped the file.
 */
export function midiLanesToPianoroll({ lanes, cycles }, { grid = 'auto' } = {}) {
  const fixed = grid === 'auto' ? null : Math.max(0, Math.round(Number(grid) || 0));
  const entries = lanes.map((lane) => {
    const detected = fixed ?? pickGrid(lane.events.map((e) => e.start));
    const R = detected > 0 ? detected : UNQUANTIZED_GRID;
    const len = Math.max(1, Math.round(cycles * R));
    const notes = laneToRollNotes(lane.events, R, len);
    const body = `"${serializePianoRoll(notes)}", { grid: ${R}, len: ${len} }`;
    return { name: lane.name, drums: lane.drums, grid: R, len, quantized: detected > 0, notes, body };
  });
  return { entries };
}

/**
 * A lane's events snapped onto an `R`-cell grid. One pitch can only start once in a cell (the roll
 * would otherwise stack two identical onsets and double-trigger the note), so a repeat that lands
 * in a cell already taken merges into it, keeping the stronger and longer of the two - the same
 * rule `recordingToMini` applies to a key retriggered inside one slot.
 */
function laneToRollNotes(events, R, len) {
  const byCell = new Map(); // `${cell}:${midi}` -> the note object drawn there
  const notes = [];
  for (const ev of events) {
    const start = Math.round(ev.start * R);
    if (start < 0 || start >= len) continue; // outside the loop window - it would never sound
    const midi = Math.min(127, Math.max(0, Math.round(ev.note)));
    const length = Math.max(1, Math.round((ev.end - ev.start) * R));
    const key = `${start}:${midi}`;
    const existing = byCell.get(key);
    if (existing) {
      existing.vel = Math.max(existing.vel, ev.vel);
      existing.len = Math.max(existing.len, length);
      continue;
    }
    // An imported note always plays, and picks the pack's first file: a MIDI file says nothing
    // about the sample-index channel, so it is left at its default like any other unset channel.
    // `nudge` is 0 for the same reason and one more: the onset above has just been ROUNDED onto a
    // cell, and how far it moved to get there is exactly what a nudge could hold. Writing the field
    // out (rather than leaving it off the object) keeps this note the same shape parsePianoRoll
    // returns, which is what lets the roll be re-read from the string it was written into.
    const note = { midi, index: PIANOROLL_DEFAULT_INDEX, start, len: length, vel: ev.vel, prob: 1, nudge: 0, mute: false };
    byCell.set(key, note);
    notes.push(note);
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// What key is this in?
// ---------------------------------------------------------------------------------------------

// Krumhansl-Kessler key profiles: how strongly each scale degree belongs to a major / minor key,
// from listeners rating probe tones against an established key. Correlating a piece's pitch-class
// weights against all 24 rotations is the standard way to guess a key from notes alone.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// How each tonic is spelled - the accidentals a musician would actually write for that key.
const MAJOR_ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** A long pad shouldn't outvote a whole melody, so each note's weight is capped at this. */
const MAX_NOTE_WEIGHT = 2;

/** …and a zero-length note still counts for something, so each is worth at least this. */
const MIN_NOTE_WEIGHT = 1 / 32;

/**
 * Guesses the key of a set of notes, ranked best-first.
 *
 * Notes are weighted purely by how long they sound - a passing sixteenth says less about the key
 * than a held root, and a chord held under a run says more than any one note of the run. The
 * weighting is deliberately NOT per-onset: counting onsets lets whichever part plays the most
 * notes decide the key on its own, which is how a sixteenth-note hi-hat (read as pitches, because
 * its track wasn't on channel 10) came out as the tonic of the whole file.
 *
 * Percussion has no pitch and must be filtered out by the caller - `midiFileToLanes` flags it.
 *
 * @param {Array<{note: number, start: number, end: number}>} events - times in cycles.
 * @returns {{ scale: string, score: number, ranked: Array<{scale: string, score: number}> }|null}
 *   `scale` is a name `setscale()` accepts, e.g. "F minor". Null when there's nothing to judge.
 */
export function detectKey(events) {
  if (!events?.length) return null;

  const weights = new Array(12).fill(0);
  for (const ev of events) {
    const dur = (ev.end ?? ev.start) - ev.start;
    const weight = Math.min(Math.max(dur, MIN_NOTE_WEIGHT), MAX_NOTE_WEIGHT);
    weights[((Math.round(ev.note) % 12) + 12) % 12] += weight;
  }
  if (!weights.some((w) => w > 0)) return null;

  const ranked = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = weights.map((_, i) => weights[(i + tonic) % 12]);
    ranked.push({ scale: `${MAJOR_ROOTS[tonic]} major`, score: correlate(rotated, MAJOR_PROFILE) });
    ranked.push({ scale: `${MINOR_ROOTS[tonic]} minor`, score: correlate(rotated, MINOR_PROFILE) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { scale: ranked[0].scale, score: ranked[0].score, ranked };
}

/** Pearson correlation - shape-only, so it doesn't matter how many notes the piece has. */
function correlate(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
