// The granular sample voice (.grain()) on the audio thread: one cloud per event.
//
// The browser's twin of the desktop's poptart_sample_grain_* defs, which run GrainBuf off an
// Impulse. A grain starts on every trigger, sample-accurately, and reads its size, position, pan
// and pitch as it starts, then keeps them. Each grain is a window over a stretch of the file,
// read with cubic interpolation and wrapped at the file's ends, as GrainBuf reads it.
//
// Pan is GrainBuf's equal-power pan, and a stereo file is two grains off one trigger, one per
// side, each panned on its own: at 0 the left side is hard left and the right hard right, so the
// file sounds as recorded, and the pan moves both together until they meet at an edge. A mono
// grain at center gets back the 3 dB the pan law takes from it.
//
// The files are held once per audio thread (GRAIN_FILES), not once per voice: the first voice of a
// file brings its samples, and every later one names it.

import { KeylockVoice } from '../dsp/keylock.mjs';

const GRAIN_FILES = new Map(); // id -> { channels: Float32Array[], frames }

/** Takes a file in, or lets one go: `{ id, channels }` or `{ drop: [ids] }`. */
export function grainFiles(message) {
  if (Array.isArray(message?.drop)) for (const id of message.drop) GRAIN_FILES.delete(id);
  if (message?.id != null && Array.isArray(message.channels) && message.channels.length) {
    GRAIN_FILES.set(message.id, { channels: message.channels, frames: message.channels[0].length });
  }
}

/** Whether a file is held, for a test to ask. */
export function grainFileHeld(id) {
  return GRAIN_FILES.has(id);
}

const GRAIN_HALF_PI = Math.PI / 2;
const GRAIN_LOG001 = Math.log(0.001);
/** How fast the cloud's level follows a change in its size or rate: the desktop's lag. */
const GRAIN_LEVEL_LAG_SEC = 0.05;

/** GrainBuf's pan for two outputs: -1 left, 1 right, equal power. */
function grainPanGains(pan) {
  const p = Math.min(1, Math.max(0, pan * 0.5 + 0.5)) * GRAIN_HALF_PI;
  return [Math.cos(p), Math.sin(p)];
}

const grainClip = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** SuperCollider's cubicinterp: four-point Hermite. */
function grainCubic(x, a, b, c, d) {
  const c1 = 0.5 * (c - a);
  const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
  const c3 = 0.5 * (d - a) + 1.5 * (b - c);
  return ((c3 * x + c2) * x + c1) * x + b;
}

/** One sample of a channel at a fractional frame, wrapping round the file as GrainBuf does. */
function grainRead(data, frames, phase) {
  const i = Math.floor(phase);
  const x = phase - i;
  const a = i - 1 < 0 ? i - 1 + frames : i - 1;
  const c = i + 1 >= frames ? i + 1 - frames : i + 1;
  const d = i + 2 >= frames ? i + 2 - frames : i + 2;
  return grainCubic(x, data[a], data[i], data[c], data[d]);
}

export class GrainCloud {
  /**
   * @param sampleRate the context's rate
   * @param options    `file` (an id in GRAIN_FILES), `begin` (0..1), `posLive` (read the position
   *                   control instead), `rate` (signed, in file frames per output frame at no
   *                   bend), `start`/`end` (context seconds), `table` (a window, or null for
   *                   GrainBuf's own Hann)
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.file = options.file ?? null;
    this.begin = Number(options.begin) || 0;
    this.posLive = !!options.posLive;
    this.rate = Number.isFinite(options.rate) ? options.rate : 1;
    this.startFrame = Math.round((Number(options.start) || 0) * sampleRate);
    this.endFrame = Number.isFinite(options.end) ? Math.round(options.end * sampleRate) : Infinity;
    this.shape = options.table && options.table.length > 1 ? options.table : null;
    this.phase = 1;            // the trigger's: a grain on the first sample, as Impulse gives
    this.level = null;         // the overlap leveling, lagged
    this.lagCoef = Math.exp(GRAIN_LOG001 / (GRAIN_LEVEL_LAG_SEC * sampleRate));
    this.grains = [];
    this.spare = [];
    this.done = false;
  }

  /** Ends the cloud at `time`: no grain starts after it, and the voice is over. */
  end(time) {
    const frame = Math.round(time * this.sampleRate);
    if (frame < this.endFrame) this.endFrame = frame;
  }

  /**
   * One block. `params` holds `size`, `density`, `pan`, `pos` and `detune` (cents), each one
   * value or one per frame. Returns false once the cloud is over.
   */
  process(outL, outR, frames, frameNow, params) {
    outL.fill(0);
    outR.fill(0);
    if (this.done) return false;
    const file = GRAIN_FILES.get(this.file);
    const sr = this.sampleRate;
    for (let i = 0; i < frames; i++) {
      const at = frameNow + i;
      if (at >= this.endFrame) { this.done = true; break; }
      if (at < this.startFrame) continue;
      const size = grainClip(grainParam(params.size, i), 0.002, 4);
      const density = grainClip(grainParam(params.density, i), 0.1, 1000);
      const target = 1 / Math.sqrt(Math.max(1, size * density * 0.5));
      this.level = this.level === null ? target : target + (this.level - target) * this.lagCoef;
      if (this.phase >= 1) {
        this.phase -= 1;
        if (file) this._start(file, size, i, params);
      }
      this.phase += density / sr;
      if (!this.grains.length) continue;
      let l = 0;
      let r = 0;
      for (let g = this.grains.length - 1; g >= 0; g--) {
        const grain = this.grains[g];
        const amp = this._amp(grain);
        const ch = file.channels;
        const s0 = grainRead(ch[0], file.frames, grain.phase) * amp;
        if (ch.length > 1) {
          const s1 = grainRead(ch[1], file.frames, grain.phase) * amp;
          l += s0 * grain.l0 + s1 * grain.l1;
          r += s0 * grain.r0 + s1 * grain.r1;
        } else {
          l += s0 * grain.l0;
          r += s0 * grain.r0;
        }
        grain.phase += grain.step;
        if (grain.phase >= file.frames) grain.phase -= file.frames;
        else if (grain.phase < 0) grain.phase += file.frames;
        if (++grain.n >= grain.count) {
          this.spare.push(grain);
          this.grains[g] = this.grains[this.grains.length - 1];
          this.grains.pop();
        }
      }
      outL[i] = l * this.level;
      outR[i] = r * this.level;
    }
    return !this.done;
  }

  _start(file, size, i, params) {
    const sr = this.sampleRate;
    const pos = grainClip(this.posLive ? grainParam(params.pos, i) : this.begin, 0, 1);
    const pan = grainClip(grainParam(params.pan, i), -1, 1);
    const step = this.rate * 2 ** ((grainParam(params.detune, i) || 0) / 1200);
    let phase = pos * file.frames;
    if (!Number.isFinite(phase) || !Number.isFinite(step)) return;
    if (phase >= file.frames) phase -= file.frames;
    const grain = this.spare.pop() ?? {};
    grain.phase = phase;
    grain.step = step;
    grain.n = 0;
    grain.count = Math.max(4, Math.floor(size * sr));
    // GrainBuf's Hann: sin^2 by a recurrence, from its first step.
    const w = Math.PI / grain.count;
    grain.b1 = 2 * Math.cos(w);
    grain.y1 = Math.sin(w);
    grain.y2 = 0;
    grain.winInc = this.shape ? this.shape.length / grain.count : 0;
    if (file.channels.length > 1) {
      [grain.l0, grain.r0] = grainPanGains(grainClip(2 * pan - 1, -1, 1));
      [grain.l1, grain.r1] = grainPanGains(grainClip(2 * pan + 1, -1, 1));
    } else {
      const [gl, gr] = grainPanGains(pan);
      grain.l0 = gl * Math.SQRT2;
      grain.r0 = gr * Math.SQRT2;
      grain.l1 = 0;
      grain.r1 = 0;
    }
    this.grains.push(grain);
  }

  /** The grain's window at its current sample, then one step on. */
  _amp(grain) {
    if (!this.shape) {
      const amp = grain.y1 * grain.y1;
      const y0 = grain.b1 * grain.y1 - grain.y2;
      grain.y2 = grain.y1;
      grain.y1 = y0;
      return amp;
    }
    const table = this.shape;
    const x = grain.n * grain.winInc;
    const k = Math.floor(x);
    const a = table[k < table.length ? k : table.length - 1];
    const b = table[k + 1 < table.length ? k + 1 : 0];
    return a + (b - a) * (x - k);
  }
}

function grainParam(param, i) {
  if (!param) return 0;
  return param.length > 1 ? param[i] : param[0];
}

// The warp voice (.stretch()): the desktop's Warp1 under a pointer. Each output channel lays its
// own grains, as Warp1 does: 100 ms Hann grains, each up to a tenth longer or shorter at random,
// the next starting an eighth of the last one's length later, read from where the pointer is
// and linearly interpolated. The pointer walks the event's window in its own time (or round the
// loop), so the pitch is the rate's and the length is the stretch's.

const WARP_SIZE_SEC = 0.1;
const WARP_OVERLAPS = 8;
const WARP_SIZE_RAND = 0.1;
// The desktop's level for these eight grains (see poptart.scd): sqrt(8 / (3 * 8)) for grains that
// add at unrelated phases, times 1.13 fitted to real files.
const WARP_LEVEL = 0.65;

function warpRead(data, frames, phase) {
  const i = Math.floor(phase);
  const x = phase - i;
  const c = i + 1 >= frames ? i + 1 - frames : i + 1;
  return data[i] + x * (data[c] - data[i]);
}

export class WarpCloud {
  /**
   * @param options `file`, `start`/`end` (context seconds), `rate` (file frames per output frame,
   *                unsigned), `speed` (signed, for the pointer's direction), `begin`/`end01`,
   *                `durSec`, and for a loop `loop`, `loopLo`, `loopHi`, `loopEntry`, `pingpong`
   */
  constructor(sampleRate, options = {}, random = Math.random) {
    this.sampleRate = sampleRate;
    this.o = options;
    this.file = options.file ?? null;
    this.rate = Math.abs(Number.isFinite(options.rate) ? options.rate : 1);
    this.random = random;
    this.startFrame = Math.round((Number(options.start) || 0) * sampleRate);
    this.endFrame = Number.isFinite(options.end) ? Math.round(options.end * sampleRate) : Infinity;
    const span = Math.max(1e-6, (options.end01 ?? 1) - (options.begin ?? 0));
    this.perSec = (span / Math.max(1e-6, options.durSec ?? 1)) * (options.speed < 0 ? -1 : 1);
    this.channels = [];         // per output channel: { next, grains }
    this.spare = [];
    this.done = false;
  }

  end(time) {
    const frame = Math.round(time * this.sampleRate);
    if (frame < this.endFrame) this.endFrame = frame;
  }

  /** Where the pointer is `sec` after the start, 0..1 of the file. */
  pointer(sec) {
    const o = this.o;
    const walked = sec * this.perSec;
    if (!o.loop) {
      const lo = Math.min(o.begin ?? 0, o.end01 ?? 1);
      const hi = Math.max(o.begin ?? 0, o.end01 ?? 1);
      return grainClip((o.speed < 0 ? o.end01 ?? 1 : o.begin ?? 0) + walked, lo, hi);
    }
    const lo = o.loopLo ?? 0;
    const width = Math.max(1e-6, (o.loopHi ?? 1) - lo);
    const from = (o.loopEntry ?? lo) - lo;
    if (o.pingpong) {
      const ph = (((from + walked) % (2 * width)) + 2 * width) % (2 * width);
      return lo + (width - Math.abs(ph - width));
    }
    return lo + ((((from + walked) % width) + width) % width);
  }

  process(outL, outR, frames, frameNow, params) {
    outL.fill(0);
    outR.fill(0);
    if (this.done) return false;
    const file = GRAIN_FILES.get(this.file);
    if (!file) {
      if (frameNow + frames >= this.endFrame) this.done = true;
      return !this.done;
    }
    const sr = this.sampleRate;
    const stereo = file.channels.length > 1;
    const outs = stereo ? [outL, outR] : [outL];
    while (this.channels.length < outs.length) this.channels.push({ next: 1, grains: [] });
    const level = WARP_LEVEL;
    for (let n = 0; n < outs.length; n++) {
      const out = outs[n];
      const data = file.channels[n];
      const ch = this.channels[n];
      for (let i = 0; i < frames; i++) {
        const at = frameNow + i;
        if (at >= this.endFrame) { this.done = true; break; }
        if (at < this.startFrame) continue;
        if (--ch.next === 0) {
          const c = WARP_SIZE_SEC * sr;
          const count = Math.max(4, Math.floor(c + c * (this.random() * 2 - 1) * WARP_SIZE_RAND));
          ch.next = Math.max(1, Math.floor(count / WARP_OVERLAPS));
          const step = this.rate * 2 ** ((grainParam(params.detune, i) || 0) / 1200);
          let phase = this.pointer((at - this.startFrame) / sr) * file.frames;
          if (phase >= file.frames) phase -= file.frames;
          const g = this.spare.pop() ?? {};
          const w = Math.PI / count;
          g.phase = phase; g.step = step; g.n = 0; g.count = count;
          g.b1 = 2 * Math.cos(w); g.y1 = Math.sin(w); g.y2 = 0;
          ch.grains.push(g);
        }
        let s = 0;
        for (let k = ch.grains.length - 1; k >= 0; k--) {
          const g = ch.grains[k];
          const amp = g.y1 * g.y1;
          const y0 = g.b1 * g.y1 - g.y2;
          g.y2 = g.y1;
          g.y1 = y0;
          s += warpRead(data, file.frames, g.phase) * amp;
          g.phase += g.step;
          if (g.phase >= file.frames) g.phase -= file.frames;
          if (++g.n >= g.count) {
            this.spare.push(g);
            ch.grains[k] = ch.grains[ch.grains.length - 1];
            ch.grains.pop();
          }
        }
        out[i] = s * level;
      }
    }
    // A mono file is heard in both sides, as the desktop's toStereo has it.
    if (!stereo) outR.set(outL);
    return !this.done;
  }
}

// The clean stretch voice (.stretch() under .stretchmode("clean"), the default): the desktop's
// poptart_sample_clean_* defs, which read the window through PoptartStretch - the same
// KeylockVoice (dsp/keylock.mjs), so the two engines play one algorithm. The playhead crosses
// begin..end in the event's own time and the pitch is the speed's, times the bend; a negative speed
// reads the audio backwards. A loop crossfades its corners over 5 ms, as a deck's loop does.
//
// A stretcher is a few hundred kilobytes of rings and tables, and voices come and go with every
// event: so they are pooled per audio thread, by rate and channel count, taken as a voice starts
// and handed back when it ends - only a voice past the most ever sounding at once allocates.

const STRETCH_POOL = new Map(); // `${sampleRate}:${channels}` -> KeylockVoice[]

function takeStretcher(sampleRate, channels) {
  const free = STRETCH_POOL.get(`${sampleRate}:${channels}`);
  return free?.pop() ?? new KeylockVoice(sampleRate, channels);
}

function giveStretcher(sampleRate, channels, voice) {
  const key = `${sampleRate}:${channels}`;
  if (!STRETCH_POOL.has(key)) STRETCH_POOL.set(key, []);
  STRETCH_POOL.get(key).push(voice);
}

export class StretchCloud {
  /**
   * @param options `file`, `start`/`end` (context seconds), `speed` (signed: |speed| is the pitch,
   *                its sign the direction), `fileRate` (the file's sample rate), `begin`/`end01`,
   *                `durSec`, and for a loop `loop`, `loopLo`, `loopHi`, `loopEntry`, `pingpong`
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.o = options;
    this.file = options.file ?? null;
    this.startFrame = Math.round((Number(options.start) || 0) * sampleRate);
    this.endFrame = Number.isFinite(options.end) ? Math.round(options.end * sampleRate) : Infinity;
    this.voice = null;
    this.rows = null;
    this.done = false;
  }

  end(time) {
    const frame = Math.round(time * this.sampleRate);
    if (frame < this.endFrame) this.endFrame = frame;
  }

  /** The stretcher, started on the file the first time there is one to read. */
  _start(file) {
    const o = this.o;
    const sr = this.sampleRate;
    const nc = Math.min(2, file.channels.length);
    const frames = file.frames;
    const fileRate = Number(o.fileRate) || sr;
    const begin = Number(o.begin) || 0;
    const end01 = o.end01 ?? 1;
    const back = o.speed < 0;
    // File seconds per second: the window over the event's own time, signed as the speed is.
    const rate = (((end01 - begin) * (frames / fileRate)) / Math.max(Number(o.durSec) || 0, 1e-6)) * (back ? -1 : 1);
    const voice = takeStretcher(sr, nc);
    voice.setSource(file.channels.slice(0, nc), frames, 1, fileRate / sr);
    if (o.loop) {
      const lo = (o.loopLo ?? 0) * frames;
      const hi = Math.max(lo + 1, (o.loopHi ?? 1) * frames);
      const from = Math.min(hi, Math.max(lo, (o.loopEntry ?? 0) * frames));
      voice.start({ pos: from, rate, loop: true, lo, hi, pingpong: !!o.pingpong });
    } else {
      const startF = begin * frames;
      const endF = Math.max(begin * frames, end01 * frames - 1);
      voice.start({ pos: back ? endF : startF, rate });
    }
    this.voice = voice;
    this.channels = nc;
  }

  _release() {
    if (this.voice) giveStretcher(this.sampleRate, this.channels, this.voice);
    this.voice = null;
  }

  process(outL, outR, frames, frameNow, params) {
    outL.fill(0);
    outR.fill(0);
    if (this.done) {
      this._release();
      return false;
    }
    const file = GRAIN_FILES.get(this.file);
    if (frameNow >= this.endFrame) {
      this.done = true;
      this._release();
      return false;
    }
    if (!file || frameNow + frames <= this.startFrame) return true;
    if (!this.voice) this._start(file);
    const from = Math.max(0, this.startFrame - frameNow);
    const n = Math.min(frames, this.endFrame - frameNow) - from;
    if (n <= 0) return true;
    if (!this.rows || this.rows[0].length < n) this.rows = [new Float64Array(frames), new Float64Array(frames)];
    // The bend once a block, as the desktop's control-rate pitch has it.
    const pitch = Math.abs(this.o.speed) * 2 ** ((grainParam(params.detune, 0) || 0) / 1200);
    this.voice.process(this.rows, n, pitch);
    const [l, r] = this.rows;
    const right = this.channels > 1 ? r : l;
    for (let i = 0; i < n; i++) {
      outL[from + i] = l[i];
      outR[from + i] = right[i];
    }
    return true;
  }
}
