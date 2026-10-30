// The Looper: records what is playing into a loop, plays it back, and layers more on top.
//
// Record on starts a take, record off ends it, and the first take sets the loop's length. With a
// loop there, record overdubs into it instead. Both edges land on the Quantize grid: an edge that
// arrives within LATE_SEC after a grid line counts as on that line (a press a little late, or a
// control that reached the device a block late), and any other waits for the next line. A loop
// taken on the grid is LOCKED to it: its length is a whole number of grid steps in beats, and its
// playhead is worked out from the transport's beat every sample, so the loop stays on the bar
// across a relocate and follows a tempo change like tape, pitch and all. On `free` a take starts
// and stops on the spot and the loop runs at its own length, the way a tape loop would.
//
// Speed and Reverse move the playhead like tape. On a locked loop they bend an offset that
// accumulates beside the transport's beat, so changing either never jumps the playhead, and at
// speed 1 forwards the loop is exactly where the bar says it is.
//
// An overdub writes where the playhead is, through a short punch-in ramp: Feedback is how much of
// what was there an overdub keeps - 1 layers the new on the old, 0 replaces it.
//
// There is no length cap. The loop lives in chunks that are added as a first take runs, so a take
// is as long as somebody holds Record. It lives until Clear, or until the device leaves its slot:
// an evaluation that keeps the same device in the slot keeps the device, and with it the loop.
//
// Record and Clear are never part of a saved state (`saved: false`): they are gestures, and a song
// saved while recording would otherwise start recording the moment it is opened.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { SYNC_OPTIONS, syncBeats, migrateSyncLists } from '../dsp/sync.mjs';

/** Frames per chunk of loop memory, each chunk one array per channel. */
export const LOOPER_CHUNK = 65536;
/** How late after a grid line an edge may arrive and still count as on that line. */
export const LOOPER_LATE_SEC = 0.03;
/** Samples of fade at the loop's seam, and of the overdub's punch ramp. */
const FADE = 64;
/** How close under a whole sample the playhead may be and still write to it (see the overdub). */
const SNAP = 1e-6;

export const LOOPER = defineDevice({
  id: 'Looper',
  kind: 'fx',
  version: 2,
  // Version 2 inserted 1/32T and 1/32. into the sync list (see dsp/sync.mjs).
  migrate: migrateSyncLists(['quantize']),
  license: 'AGPL-3.0-only',
  processor: 'poptart-looper',
  description: 'A live looper: record a take on the grid, play it back, and overdub onto it, with tape-style speed and reverse.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'record', name: 'Record', min: 0, max: 1, default: 0, ui: 'toggle', saved: false,
      description: 'While on, records. The first take sets the loop length; with a loop there, it overdubs.' },
    { id: 'quantize', name: 'Quantize', default: SYNC_OPTIONS.indexOf('1 bar'), options: [...SYNC_OPTIONS], rate: 'k',
      description: 'The grid recording starts and stops on, and the loop locks to. Free starts and stops on the spot, and the loop runs at its own length.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: 1, default: 1,
      description: 'How much of the loop an overdub keeps where it writes: 1 layers, 0 replaces.' },
    { id: 'speed', name: 'Speed', min: 0.25, max: 4, default: 1, curve: 'exp', unit: 'x',
      description: 'Playback speed, like tape: pitch moves with it.' },
    { id: 'reverse', name: 'Reverse', min: 0, max: 1, default: 0, ui: 'toggle',
      description: 'Plays the loop backwards.' },
    { id: 'clear', name: 'Clear', min: 0, max: 1, default: 0, ui: 'button', saved: false,
      description: 'Empties the loop.' },
    { id: 'dry', name: 'Dry', min: 0, max: 1, default: 1,
      description: 'The level of the input.' },
    { id: 'wet', name: 'Wet', min: 0, max: 1, default: 1,
      description: 'The level of the loop.' },
  ],
});

export class LooperProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.bpm = 120;
    this.anchorSec = 0;
    this.frames = 0;
    // The loop's memory: chunks of LOOPER_CHUNK frames, added as a take needs them.
    this.chunksL = [];
    this.chunksR = [];
    this.length = 0;         // the loop, in samples; 0 = no loop
    this.locked = false;     // locked to the grid, or running at its own length
    this.origin = 0;         // a locked loop's start, in beats
    this.loopBeats = 0;      // a locked loop's length, in beats
    this.offset = 0;         // beats the playhead is ahead of the transport, from speed and reverse
    this.freePos = 0;        // a free loop's playhead, in samples
    // Recording.
    this.state = false;      // recording now (a take, or an overdub)
    this.lastRecord = false; // Record as the last sample read it
    this.lastClear = false;
    this.taking = false;     // the first take is running
    this.takeLocked = false;
    this.count = 0;          // samples the first take has written
    this.countAtLine = 0;    // ... as of the last grid line it crossed
    this.lastLine = null;    // the grid line the last sample was on, or null
    this.lastGrid = null;    // the grid that line was on
    this.punch = 0;          // the overdub's gain, ramped
    this.lastWritten = -1;   // the index the overdub last wrote
  }

  setTempo(bpm, anchorSec = null) {
    this.bpm = bpm;
    if (anchorSec != null) this.anchorSec = anchorSec;
  }

  /** Writes one frame of a first take, making room for it. */
  _writeTake(index, l, r) {
    const c = Math.floor(index / LOOPER_CHUNK);
    while (this.chunksL.length <= c) {
      this.chunksL.push(new Float32Array(LOOPER_CHUNK));
      this.chunksR.push(new Float32Array(LOOPER_CHUNK));
    }
    const k = index - c * LOOPER_CHUNK;
    this.chunksL[c][k] = l;
    this.chunksR[c][k] = r;
  }

  _read(chunks, index) {
    const c = Math.floor(index / LOOPER_CHUNK);
    return c < chunks.length ? chunks[c][index - c * LOOPER_CHUNK] : 0;
  }

  _write(chunks, index, value) {
    const c = Math.floor(index / LOOPER_CHUNK);
    if (c < chunks.length) chunks[c][index - c * LOOPER_CHUNK] = value;
  }

  /** Record turns on or off, `late` seconds after the grid line it counts as on. */
  _apply(on, late, free, beat, line, grid) {
    this.state = on;
    if (on) {
      if (this.length > 0 || this.taking) return;   // an overdub: the punch ramp does the rest
      this.taking = true;
      this.takeLocked = !free;
      this.origin = free ? 0 : line * grid;
      this.count = free ? 0 : Math.round(late * this.sampleRate);
      // The part of the first grid step that went by before the press is silence.
      for (let k = 0; k < this.count; k++) this._writeTake(k, 0, 0);
      this.countAtLine = this.count;
      return;
    }
    if (!this.taking) return;
    this.taking = false;
    // A take that ends on a line is as long as it was AT that line: a late release is cut back.
    const length = free ? this.count : this.countAtLine;
    if (this.takeLocked) {
      const beats = (free ? beat : line * grid) - this.origin;
      if (beats > 0 && length > 0) {
        this.length = length;
        this.loopBeats = beats;
        this.locked = true;
      }
    } else if (length > 0) {
      this.length = length;
      this.locked = false;
    }
    this.offset = 0;
    this.freePos = 0;
    this.punch = 0;
    this.lastWritten = -1;
  }

  process(inputs, outputs, count, params, sidechain, timeSec = null) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sr = this.sampleRate;
    const bpm = this.bpm;
    const grid = syncBeats(Math.round(at(params.quantize, 0)));
    const free = grid == null;
    const transportSec = (timeSec ?? this.frames / sr) - this.anchorSec;
    for (let i = 0; i < count; i++) {
      const rawL = inL ? inL[i] : 0;
      const rawR = inR ? inR[i] : 0;
      const l = Number.isFinite(rawL) ? rawL : 0;
      const r = Number.isFinite(rawR) ? rawR : 0;
      const beat = (transportSec + i / sr) * bpm / 60;

      // Clear: the loop goes, and a take in progress with it. Record still held starts over.
      const clear = at(params.clear, i) >= 0.5;
      if (clear && !this.lastClear) {
        this.length = 0;
        this.taking = false;
        this.state = false;
        this.punch = 0;
        this.lastWritten = -1;
      }
      this.lastClear = clear;

      // Record, on the grid.
      const record = at(params.record, i) >= 0.5;
      const edge = record !== this.lastRecord;
      this.lastRecord = record;
      if (free) {
        this.lastLine = null;
        if (record !== this.state) this._apply(record, 0, true, beat, 0, 0);
      } else {
        const line = Math.floor(beat / grid + 1e-9);
        const late = (beat - line * grid) * 60 / bpm;
        // A line crossed. A grid that changed is not a crossing: the index means another line.
        if (this.lastGrid === grid && this.lastLine !== null && line !== this.lastLine) {
          if (this.taking) this.countAtLine = this.count;
          if (record !== this.state) this._apply(record, 0, false, beat, line, grid);
        }
        this.lastLine = line;
        this.lastGrid = grid;
        if (edge && record !== this.state && late < LOOPER_LATE_SEC) this._apply(record, late, false, beat, line, grid);
      }

      let wetL = 0;
      let wetR = 0;
      const speed = at(params.speed, i);
      const s = at(params.reverse, i) >= 0.5 ? -speed : speed;
      if (this.taking) {
        this._writeTake(this.count, l, r);
        this.count += 1;
      } else if (this.length > 0) {
        const L = this.length;
        let p;
        if (this.locked) {
          const x = beat - this.origin + this.offset;
          const phase = x - Math.floor(x / this.loopBeats) * this.loopBeats;
          p = (phase / this.loopBeats) * L;
        } else {
          p = this.freePos;
        }
        if (p >= L) p -= L;
        if (p < 0) p = 0;
        const a = Math.floor(p);
        const frac = p - a;
        const b = a + 1 >= L ? 0 : a + 1;
        const seam = Math.min(1, Math.min(p, L - p) / FADE);
        const aL = this._read(this.chunksL, a);
        const aR = this._read(this.chunksR, a);
        wetL = (aL + (this._read(this.chunksL, b) - aL) * frac) * seam;
        wetR = (aR + (this._read(this.chunksR, b) - aR) * frac) * seam;

        // The overdub, read after the loop was: punched in and out over FADE samples, and each
        // index written once however slowly the playhead crosses it. A playhead a hair under a
        // whole sample is on it: the beat arithmetic rounds, and at speed 1 a sample read as
        // 128.9999999 would otherwise be written as 128 twice and leave 129 a hole.
        if (this.state) this.punch = Math.min(1, this.punch + 1 / FADE);
        else this.punch = Math.max(0, this.punch - 1 / FADE);
        let idx = Math.floor(p + SNAP);
        if (idx >= L) idx = 0;
        if (this.punch > 0 && idx !== this.lastWritten) {
          const g = this.punch;
          const keep = 1 - g * (1 - at(params.feedback, i));
          this._write(this.chunksL, idx, this._read(this.chunksL, idx) * keep + l * g);
          this._write(this.chunksR, idx, this._read(this.chunksR, idx) * keep + r * g);
          this.lastWritten = idx;
        }

        if (!this.locked) {
          let pos = this.freePos + s;
          pos -= Math.floor(pos / L) * L;
          this.freePos = pos;
        }
      }
      this.offset += (s - 1) * bpm / (60 * sr);
      // Kept inside one loop length, where it means the same and keeps its precision.
      if (this.length > 0 && this.locked) this.offset -= Math.floor(this.offset / this.loopBeats) * this.loopBeats;

      const dry = at(params.dry, i);
      const wet = at(params.wet, i);
      outL[i] = rawL * dry + wetL * wet;
      if (outR !== outL) outR[i] = rawR * dry + wetR * wet;
    }
    this.frames += count;
  }
}
