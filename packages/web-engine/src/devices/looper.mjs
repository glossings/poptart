// The Looper: records what is playing into a loop, plays it back, and layers more on top.
//
// Everything happens a whole pass at a time, on the Length grid: lines every Length bars from
// beat zero (every loop length, once there is a loop). A press of Record asks for a pass; the
// next line starts it and the line after ends it, so a recording starts and stops on the grid
// however long the press was. Held through a line, the next pass records too. A press that
// arrives within LATE_SEC after a line counts as on that line (a press a little late, or a
// control that reached the device a block late). The first pass is the first take, and sets the
// loop; every pass after it is an overdub. The loop is LOCKED to the grid: its playhead is worked
// out from the transport's beat every sample, so it stays on the bar across a relocate and
// follows a tempo change like tape, pitch and all.
//
// The seam is a crossfade (SEAM_SEC): the take records on past its end, and what it hears there
// is blended into the loop's start while the first pass plays it.
//
// Speed and Reverse move the playhead like tape. They bend an offset that accumulates beside the
// transport's beat, so changing either never jumps the playhead, and at speed 1 forwards the loop
// is exactly where the bar says it is.
//
// Mix crossfades the input against the loop, for what is heard and for what is recorded alike:
// 0 is the input alone, 1 the loop alone. A first take is the same crossfade with no loop yet, so
// Mix is how loud the input goes into it. An overdub writes where the playhead is, through a
// short punch-in ramp: at 0 it replaces the loop, at 1 it keeps the loop as it is, and between,
// the old layers fade by Mix on every pass while the new go in. With nothing recording, Mix only
// sets what is heard: the loop is never touched.
//
// The loop lives in chunks that are added as a first take runs. It lives until Clear, or until
// the device leaves its slot: an evaluation that keeps the same device in the slot keeps the
// device, and with it the loop. Length sets the next first take; a loop keeps the length it was
// taken at until it is cleared.
//
// The loop follows its track: it sounds while the track's pattern plays (setRunning, from the
// scheduler). Stopped, it plays out the pass it is on and goes quiet, keeping the loop - a stop
// rings out, as a sample's does; started, it comes back in where the bar says. A take can still
// be recorded while stopped, and plays once the track does.
//
// Record and Clear are never part of a saved state (`saved: false`): they are gestures.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';

/** Frames per chunk of loop memory, each chunk one array per channel. */
export const LOOPER_CHUNK = 65536;
/** How late after a line a press may arrive and still count as on that line. */
export const LOOPER_LATE_SEC = 0.03;
/** Samples of the overdub's punch ramp. */
const FADE = 64;
/**
 * Seconds of crossfade at the loop's seam. A take goes on recording this long past its end, and
 * that is blended into the loop's start: playing round the seam is then the take running on into
 * what followed it, fading into the loop's own start - no step at the wrap, and no dip either.
 */
const SEAM_SEC = 0.01;
/** How close under a whole sample the playhead may be and still write to it (see the overdub). */
const SNAP = 1e-6;
/** Seconds the loop takes to go quiet at the end of a played-out pass, and to come back in. */
const GATE_SEC = 0.005;

/** The choices on Length, in panel order: the index is what a saved state holds. */
export const LOOPER_LENGTHS = Object.freeze(['1 bar', '2 bars', '4 bars', '8 bars', '16 bars', '32 bars']);
/** Each Length in beats. */
const LENGTH_BEATS = Object.freeze([4, 8, 16, 32, 64, 128]);

/** A Length setting in beats. */
export function lengthBeats(index) {
  return LENGTH_BEATS[Math.round(index)] ?? LENGTH_BEATS[0];
}

/** What the looper is doing, as it reports it: the index is what the desktop's report carries. */
export const LOOPER_STATUS = Object.freeze(['empty', 'armed', 'recording', 'playing', 'overdub', 'stopped']);

export const LOOPER = defineDevice({
  id: 'Looper',
  kind: 'fx',
  version: 2,
  license: 'AGPL-3.0-only',
  processor: 'poptart-looper',
  description: 'A live looper: press Record for a pass on the Length grid, play it back, and overdub onto it, with tape-style speed and reverse.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'record', name: 'Record', min: 0, max: 1, default: 0, ui: 'button', saved: false,
      description: 'Records the next pass, from one Length line to the next. Held through a line, it records the pass after too. The first pass sets the loop; after that, it overdubs.' },
    { id: 'length', name: 'Length', default: 0, options: [...LOOPER_LENGTHS], rate: 'k',
      description: 'How long a pass is: recording starts and stops every this many bars. A loop keeps the length it was taken at until it is cleared.' },
    { id: 'speed', name: 'Speed', min: 0.25, max: 4, default: 1, curve: 'exp', unit: 'x',
      description: 'Playback speed, like tape: pitch moves with it.' },
    { id: 'reverse', name: 'Reverse', min: 0, max: 1, default: 0, ui: 'toggle',
      description: 'Plays the loop backwards.' },
    { id: 'clear', name: 'Clear', min: 0, max: 1, default: 0, ui: 'button', saved: false,
      description: 'Empties the loop.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5,
      description: 'The input against the loop, heard and recorded: 0 is the input alone, 1 the loop alone. While recording, the loop keeps this much of itself each pass.' },
  ],
  figures: [
    {
      id: 'loop',
      kind: 'loop',
      title: 'loop',
      description: 'The loop, a mark at every bar, and where it is playing. While a first take records, how far it has got.',
      params: { length: 'length' },
    },
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
    this.origin = 0;         // the loop's start, in beats
    this.loopBeats = 0;      // the loop's length, in beats
    this.offset = 0;         // beats the playhead is ahead of the transport, from speed and reverse
    // Recording, a pass at a time.
    this.state = false;      // recording this pass (a take, or an overdub)
    this.pending = false;    // a press waiting for the next line
    this.lastRecord = false; // Record as the last sample read it
    this.lastClear = false;
    this.taking = false;     // the first take is running
    this.count = 0;          // samples the first take has written
    this.lastLine = null;    // the line the last sample was on, or null
    this.lastGrid = null;    // the grid that line was on
    this.punch = 0;          // the overdub's gain, ramped
    this.lastWritten = -1;   // the index the overdub last wrote
    this.takeIn = 1;         // the input's level in the take's last sample, for its run-on
    // The seam: the first take's own start (the silence of a late press is not the loop's start),
    // and the stretch of the loop's start the run-on is still being blended into.
    this.headStart = 0;
    this.tailAt = 0;
    this.tailEnd = 0;
    // For the report: where the playhead was and the beat the last sample was on.
    this.pos = 0;
    this.beat = 0;
    // Following the track: whether it plays, the changes still to come (each at a time on the
    // audio clock, or at once), a pass being played out after a stop, and the loop's level as it
    // goes quiet at the end of that pass or comes back in.
    this.running = true;
    this.runQueue = [];
    this.coasting = false;
    this.coastPos = 0;
    this.lastP = 0;
    this.lastS = 1;
    this.gate = 1;
  }

  setTempo(bpm, anchorSec = null) {
    this.bpm = bpm;
    if (anchorSec != null) this.anchorSec = anchorSec;
  }

  /** The track plays or stops, from `atSec` on the audio clock - null for now. */
  setRunning(on, atSec = null) {
    this.runQueue.push({ on: !!on, at: Number.isFinite(atSec) ? atSec : -Infinity });
  }

  _run(on) {
    if (on === this.running) return;
    this.running = on;
    if (!on) {
      // Plays out the pass it is on, from the sample after the last one played - snapped onto a
      // whole sample when it is a hair from one (see SNAP), since where the pass ends is a
      // comparison against the loop's length that a rounding in the beat would tip either way.
      const L = this.length;
      const raw = this.lastP + this.lastS;
      const next = Math.abs(raw - Math.round(raw)) < SNAP ? Math.round(raw) : raw;
      this.coasting = L > 0 && this.gate > 0 && next >= 0 && next < L;
      this.coastPos = L > 0 ? next - Math.floor(next / L) * L : 0;
    } else {
      this.coasting = false;
    }
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

  /** Blends what followed the take into the loop's start at `k`, by where k is in the crossfade. */
  _blend(k, l, r) {
    const fade = Math.round(SEAM_SEC * this.sampleRate);
    // Equal power: the take and its run-on are two different stretches of sound, and a straight
    // line between them dips the level in the middle.
    const t = Math.min(1, Math.max(0, (k - this.headStart) / fade)) * Math.PI / 2;
    const g = Math.sin(t);
    const h = Math.cos(t);
    this._write(this.chunksL, k, this._read(this.chunksL, k) * g + l * h);
    this._write(this.chunksR, k, this._read(this.chunksR, k) * g + r * h);
  }

  /**
   * A line, `late` seconds ago: the pass that was recording ends, and the next one records if a
   * press asked for it or Record is still held.
   */
  _line(line, grid, late, held) {
    const want = this.pending || (this.state && held);
    this.pending = false;
    if (this.taking) this._close();
    if (!want) {
      this.state = false;
      return;
    }
    this.state = true;
    if (this.length > 0) return;   // an overdub: the punch ramp does the rest
    this.taking = true;
    this.origin = line * grid;
    this.loopBeats = grid;
    this.count = Math.round(late * this.sampleRate);
    // The part of the pass that went by before the press is silence.
    for (let k = 0; k < this.count; k++) this._writeTake(k, 0, 0);
    this.headStart = this.count;
    this.tailEnd = 0;
  }

  /** The first take has run its pass, and the loop plays. */
  _close() {
    this.taking = false;
    if (this.count > 0) this.length = this.count;
    // The seam's crossfade, over the loop's start: the silence of a late press, then SEAM_SEC
    // into the take.
    this.tailAt = 0;
    this.tailEnd = this.length > 0 ? Math.min(this.length, this.headStart + Math.round(SEAM_SEC * this.sampleRate)) : 0;
    this.offset = 0;
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
    const fixed = lengthBeats(at(params.length, 0));
    const gateStep = 1 / (GATE_SEC * sr);
    const clock = timeSec ?? this.frames / sr;
    const transportSec = clock - this.anchorSec;
    for (let i = 0; i < count; i++) {
      const rawL = inL ? inL[i] : 0;
      const rawR = inR ? inR[i] : 0;
      const l = Number.isFinite(rawL) ? rawL : 0;
      const r = Number.isFinite(rawR) ? rawR : 0;
      const beat = (transportSec + i / sr) * bpm / 60;

      // The track starting or stopping, on the sample it was meant for.
      while (this.runQueue.length && clock + i / sr >= this.runQueue[0].at) this._run(this.runQueue.shift().on);

      // Clear: the loop goes, and a take in progress with it.
      const clear = at(params.clear, i) >= 0.5;
      if (clear && !this.lastClear) {
        this.length = 0;
        this.taking = false;
        this.state = false;
        this.pending = false;
        this.punch = 0;
        this.lastWritten = -1;
        this.tailEnd = 0;
        this.coasting = false;
      }
      this.lastClear = clear;

      // Record, a pass at a time on the grid: the loop's length once there is one, Length before.
      const held = at(params.record, i) >= 0.5;
      const press = held && !this.lastRecord;
      this.lastRecord = held;
      const grid = this.length > 0 || this.taking ? this.loopBeats : fixed;
      const line = Math.floor(beat / grid + 1e-9);
      const late = (beat - line * grid) * 60 / bpm;
      // A line crossed. A grid that changed is not a crossing: the index means another line.
      if (this.lastGrid === grid && this.lastLine !== null && line !== this.lastLine) {
        this._line(line, grid, 0, held || press);
      }
      this.lastLine = line;
      this.lastGrid = grid;
      if (press && !this.state) {
        // A press just after a line counts as on it; any other waits for the next.
        this.pending = true;
        if (late < LOOPER_LATE_SEC) this._line(line, grid, late, held);
      }

      let wetL = 0;
      let wetR = 0;
      const mix = Math.min(1, Math.max(0, at(params.mix, i)));
      const speed = at(params.speed, i);
      const s = at(params.reverse, i) >= 0.5 ? -speed : speed;
      if (this.taking) {
        // The crossfade with no loop under it yet: the input, as loud as Mix lets it in.
        this.takeIn = 1 - mix;
        this._writeTake(this.count, l * this.takeIn, r * this.takeIn);
        this.count += 1;
      } else if (this.length > 0 && (this.running || this.coasting || this.gate > 0)) {
        const L = this.length;
        const live = this.running || this.coasting;
        // The take's run-on, into the seam's crossfade, before the loop is read there. It goes
        // in as the take did, at the level the take ended on.
        if (this.tailAt < this.tailEnd) {
          this._blend(this.tailAt, l * this.takeIn, r * this.takeIn);
          this.tailAt += 1;
        }
        let p;
        if (!this.running) {
          p = this.coastPos;
        } else {
          const x = beat - this.origin + this.offset;
          const phase = x - Math.floor(x / this.loopBeats) * this.loopBeats;
          p = (phase / this.loopBeats) * L;
        }
        if (p >= L) p -= L;
        if (p < 0) p = 0;
        this.pos = p / L;
        this.lastP = p;
        this.lastS = s;
        const a = Math.floor(p);
        const frac = p - a;
        const b = a + 1 >= L ? 0 : a + 1;
        const aL = this._read(this.chunksL, a);
        const aR = this._read(this.chunksR, a);
        // Up at once to playing, and down at the end of a played-out pass, over GATE_SEC.
        this.gate = live ? Math.min(1, this.gate + gateStep) : Math.max(0, this.gate - gateStep);
        wetL = (aL + (this._read(this.chunksL, b) - aL) * frac) * this.gate;
        wetR = (aR + (this._read(this.chunksR, b) - aR) * frac) * this.gate;

        // The overdub, read after the loop was: punched in and out over FADE samples, and each
        // index written once however slowly the playhead crosses it. A playhead a hair under a
        // whole sample is on it: the beat arithmetic rounds, and at speed 1 a sample read as
        // 128.9999999 would otherwise be written as 128 twice and leave 129 a hole.
        if (this.state) this.punch = Math.min(1, this.punch + 1 / FADE);
        else this.punch = Math.max(0, this.punch - 1 / FADE);
        let idx = Math.floor(p + SNAP);
        if (idx >= L) idx = 0;
        if (live && this.punch > 0 && idx !== this.lastWritten) {
          // Mix's crossfade, punched in: the loop keeps `mix` of itself, the input goes in at
          // the rest.
          const g = this.punch;
          const keep = 1 - g * (1 - mix);
          const add = g * (1 - mix);
          this._write(this.chunksL, idx, this._read(this.chunksL, idx) * keep + l * add);
          this._write(this.chunksR, idx, this._read(this.chunksR, idx) * keep + r * add);
          this.lastWritten = idx;
        }

        if (!this.running) {
          // A played-out pass ends where it wraps; the level is then let down past the seam.
          let pos = this.coastPos + s;
          if (this.coasting && (pos >= L || pos < 0)) this.coasting = false;
          pos -= Math.floor(pos / L) * L;
          this.coastPos = pos;
        }
      } else if (!this.running) {
        this.gate = 0;
      }
      this.offset += (s - 1) * bpm / (60 * sr);
      // Kept inside one loop length, where it means the same and keeps its precision.
      if (this.length > 0) this.offset -= Math.floor(this.offset / this.loopBeats) * this.loopBeats;

      outL[i] = rawL * (1 - mix) + wetL * mix;
      if (outR !== outL) outR[i] = rawR * (1 - mix) + wetR * mix;
      this.beat = beat;
    }
    this.frames += count;
  }

  /**
   * What the loop is doing, for the panel's picture: whether there is one and whether it is
   * recording (LOOPER_STATUS), how long it is in beats and seconds, where the playhead is through
   * it, and how far a first take has got.
   */
  report() {
    const sr = this.sampleRate;
    let status = 'empty';
    if (this.taking) status = 'recording';
    else if (this.length > 0) status = this.state ? 'overdub' : this.pending ? 'armed' : this.running || this.coasting ? 'playing' : 'stopped';
    else if (this.pending) status = 'armed';
    return {
      loop: {
        status,
        beats: this.length > 0 ? this.loopBeats : null,
        seconds: this.length > 0 ? this.length / sr : 0,
        position: this.length > 0 ? this.pos : 0,
        takenSec: this.taking ? this.count / sr : 0,
        takenBeats: this.taking ? Math.max(0, this.beat - this.origin) : 0,
      },
    };
  }
}
