// The song player: a whole decoded song under a playhead, for a DJ deck.
//
// The browser build's twin of the desktop's poptart_song_* synths. The song is held as 16-bit
// planes - one Int16Array per channel - rather than as the AudioBuffer the browser decoded it
// into: a ten-minute stereo track is about 230 MB of 32-bit floats and half that as 16 bits, and
// a desk holds two of them. The planes are handed to the audio thread whole (transferred, not
// copied), so after a load the page itself holds none of the song.
//
// Everything that moves the playhead is a timestamped message - a start, a seek, a rate change,
// a pause, a release - applied on the sample its time names, so a quantized start lands on the
// beat and a loop's wrap on the bar however late the message was posted (as long as it was posted
// before its time). This runs on the same clock the notes are scheduled on, so unlike the
// desktop's player there is no drift between the two to servo away.
//
// A start or a seek while something is already sounding is a crossfade: the old read fades out
// under the new one over a few milliseconds, which is what makes a seek click-free and a cue
// press while playing a jump rather than a stop and a start.
//
// With KEYLOCK on, the song is read by the keylock (dsp/keylock.mjs) instead: the same playhead
// at the same rate, with the pitch held. It reads the song itself and adds no latency, so a
// keylocked deck is heard exactly where a plain one would be; its seeks crossfade the same way,
// inside its KeylockPlayer, and a pause or a stop fades it as it fades the plain reads. Switching
// keylock is a crossfade between the two at the playhead. The desktop's PoptartKeylock UGen runs
// the same keylock (native-device-parity.test.mjs).
//
// Every time is when the moment is HEARD.

import { KeylockPlayer } from '../dsp/keylock.mjs';

/** The fade a start or a seek comes in over, and the old read goes out under. */
export const SONG_FADE_SEC = 0.005;
/** A pause: the read slews to a halt and fades with it - the little turntable stop. */
export const SONG_HALT_SEC = 0.02;
/** The end of the file's release: over by the last sample, so nothing clicks or wraps there. */
export const SONG_RELEASE_SEC = 0.05;

const SCALE = 1 / 32768;

/** Four-point Hermite between y1 and y2, `t` of the way across. */
function hermite(y0, y1, y2, y3, t) {
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

export class SongReader {
  constructor(sampleRate, post = () => {}) {
    this.sampleRate = sampleRate;
    this.post = post;
    this.planes = null;
    this.frames = 0;
    this.rate = 1;
    this.voices = [];   // { pos (frames), gain, step, halt (rate multiplier) | null, haltStep }
    this.events = [];   // { frame, ...message }, soonest first
    this.fade = Math.max(1, Math.round(SONG_FADE_SEC * sampleRate));
    // The keylocked read, made the first time keylock is wanted: its level, slewed as a voice's
    // is, and its pause.
    this.keylock = false;
    this.kl = null;
    this.kv = { gain: 0, step: 0, halt: null, haltStep: 0 };
    this.klOut = [new Float64Array(128), new Float64Array(128)];
  }

  /** The keylocked read, made on first use. */
  keylocked() {
    if (!this.kl) {
      this.kl = new KeylockPlayer(this.sampleRate, 2, this.fade);
      if (this.planes) this.kl.setSource([this.planes[0], this.planes[1] ?? this.planes[0]], this.frames, SCALE, 1);
    }
    return this.kl;
  }

  /** Where the song is heard, in frames, or null when nothing is playing on. */
  heardPos() {
    if (this.keylock) {
      const k = this.kv;
      return this.kl && k.gain + k.step > 0 && k.step >= 0 && k.halt == null ? this.kl.pos : null;
    }
    const main = this.voices.find((v) => v.step >= 0 && v.halt == null) ?? null;
    return main ? main.pos : null;
  }

  /** The plain reads fade out, and a new one at `pos` fades in. */
  plainFrom(pos) {
    for (const v of this.voices) v.step = -Math.max(v.gain, 1e-6) / this.fade;
    this.voices.push({ pos, gain: 0, step: 1 / this.fade, halt: null, haltStep: 0 });
  }

  /** The keylocked read goes to `pos`: fading in from silence, or crossfading if it is sounding. */
  keylockFrom(pos) {
    const kl = this.keylocked();
    const k = this.kv;
    if (k.gain > 0 && k.halt == null) kl.seek(pos);
    else { kl.start(pos); k.gain = 0; }
    k.step = (1 - k.gain) / this.fade;
    k.halt = null;
    k.haltStep = 0;
  }

  /** The keylocked read fades out over `len` frames. */
  keylockOut(len) {
    const k = this.kv;
    if (k.gain > 0 || k.step > 0) k.step = -Math.max(k.gain, 1e-6) / len;
  }

  receive(message) {
    if (!message) return;
    if (message.kind === 'load') {
      this.planes = message.planes;
      this.frames = message.frames;
      this.voices = [];
      this.events = [];
      this.kv.gain = 0;
      this.kv.step = 0;
      this.kl?.setSource([this.planes[0], this.planes[1] ?? this.planes[0]], this.frames, SCALE, 1);
      return;
    }
    if (message.kind === 'free') {
      this.planes = null;
      this.frames = 0;
      this.voices = [];
      this.events = [];
      this.kv.gain = 0;
      this.kv.step = 0;
      this.kl = null;
      return;
    }
    if (message.kind === 'query') {
      const pos = this.heardPos();
      this.post({ kind: 'pos', id: message.id, pos: pos == null ? null : pos / this.sampleRate, rate: this.rate });
      return;
    }
    const frame = Number.isFinite(message.time) ? Math.round(message.time * this.sampleRate) : -Infinity;
    const at = this.events.findIndex((e) => e.frame > frame);
    const event = { ...message, frame };
    if (at < 0) this.events.push(event);
    else this.events.splice(at, 0, event);
  }

  /**
   * Applies one timed message, on the sample it was timed for. `late` is how many frames after
   * that it arrived: a start or a seek begins that much further on, so it keeps time.
   */
  apply(event, late = 0) {
    const sr = this.sampleRate;
    switch (event.kind) {
      case 'start':
      case 'seek': {
        if (event.kind === 'start' && Number.isFinite(event.rate)) this.rate = event.rate;
        if (event.kind === 'start' && event.keylock != null) this.keylock = !!event.keylock;
        const pos = Number(event.pos) * sr + (Number.isFinite(late) && late > 0 ? late * this.rate : 0);
        if (this.keylock) {
          for (const v of this.voices) v.step = -Math.max(v.gain, 1e-6) / this.fade;
          this.keylockFrom(pos);
        } else {
          this.keylockOut(this.fade);
          this.plainFrom(pos);
        }
        break;
      }
      case 'keylock': {
        const on = !!event.on;
        if (on === this.keylock) break;
        const pos = this.heardPos();
        this.keylock = on;
        if (pos == null) break;
        if (on) {
          for (const v of this.voices) v.step = -Math.max(v.gain, 1e-6) / this.fade;
          this.keylockFrom(pos);
        } else {
          this.keylockOut(this.fade);
          this.plainFrom(pos);
        }
        break;
      }
      case 'rate':
        if (Number.isFinite(event.rate)) this.rate = event.rate;
        break;
      case 'pause': {
        const len = Math.max(1, Math.round(SONG_HALT_SEC * sr));
        for (const v of this.voices) {
          v.halt = v.halt ?? 1;
          v.haltStep = -1 / len;
          v.step = -Math.max(v.gain, 1e-6) / len;
        }
        const k = this.kv;
        if (k.gain > 0 || k.step > 0) {
          k.halt = k.halt ?? 1;
          k.haltStep = -1 / len;
          k.step = -Math.max(k.gain, 1e-6) / len;
        }
        break;
      }
      case 'stop': {
        const len = Math.max(1, Math.round((Number.isFinite(event.release) ? event.release : SONG_RELEASE_SEC) * sr));
        for (const v of this.voices) v.step = -Math.max(v.gain, 1e-6) / len;
        this.keylockOut(len);
        break;
      }
      default:
        break;
    }
  }

  /** One block into `outL`/`outR`. `frameNow` is the context's frame count at its first sample. */
  process(outL, outR, frames, frameNow) {
    outL.fill(0);
    outR?.fill(0);
    const heard = frameNow;
    let at = 0;
    while (at < frames) {
      while (this.events.length && this.events[0].frame <= heard + at) {
        const event = this.events.shift();
        this.apply(event, heard + at - event.frame);
      }
      const next = this.events.length ? this.events[0].frame - heard : Infinity;
      const until = Math.min(frames, Math.max(at + 1, next));
      if (this.planes && this.voices.length) this.render(outL, outR, at, until);
      if (this.planes && this.kl && (this.kv.gain > 0 || this.kv.step > 0)) this.renderKeylock(outL, outR, at, until);
      at = until;
    }
  }

  render(outL, outR, from, to) {
    const left = this.planes[0];
    const right = this.planes[1] ?? left;
    const last = this.frames - 1;
    for (const v of this.voices) {
      for (let i = from; i < to; i++) {
        const p = v.pos;
        if (p >= 0 && p < last) {
          const n = Math.floor(p);
          const t = p - n;
          const a = n > 0 ? n - 1 : 0;
          const c = n + 1;
          const d = n + 2 <= last ? n + 2 : last;
          const g = v.gain * SCALE;
          outL[i] += hermite(left[a], left[n], left[c], left[d], t) * g;
          if (outR) outR[i] += hermite(right[a], right[n], right[c], right[d], t) * g;
        }
        v.pos += this.rate * (v.halt ?? 1);
        if (v.halt != null) v.halt = Math.max(0, v.halt + v.haltStep);
        v.gain += v.step;
        if (v.gain >= 1) { v.gain = 1; v.step = 0; } else if (v.gain <= 0 && v.step < 0) { v.gain = 0; v.step = 0; }
      }
    }
    // A voice that has faded out, or has run off the end of the file, is done.
    this.voices = this.voices.filter((v) => v.gain > 0 && v.pos < last);
  }

  /**
   * The keylocked read over [from, to), at the rate the pause has slowed it to by the start of
   * the run, at its level, which slews per sample as a plain voice's does.
   */
  renderKeylock(outL, outR, from, to) {
    const k = this.kv;
    const n = to - from;
    if (n > this.klOut[0].length) this.klOut = [new Float64Array(n), new Float64Array(n)];
    this.kl.process(this.klOut, n, this.rate * (k.halt ?? 1));
    const [l, r] = this.klOut;
    for (let i = 0; i < n; i++) {
      outL[from + i] += l[i] * k.gain;
      if (outR) outR[from + i] += r[i] * k.gain;
      if (k.halt != null) k.halt = Math.max(0, k.halt + k.haltStep);
      k.gain += k.step;
      if (k.gain >= 1) { k.gain = 1; k.step = 0; } else if (k.gain <= 0 && k.step < 0) { k.gain = 0; k.step = 0; }
    }
  }
}
