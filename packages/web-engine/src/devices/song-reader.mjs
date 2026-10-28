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
// Every time is when the moment is HEARD. A reader with a `lead` reads that far ahead of it:
// the keylock's read, which its shifter then delays by the same amount (see aheadBy).

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
    this.lead = 0;      // frames this reader reads ahead of the time it is heard
  }

  /**
   * A copy of this reader, run on `lead` frames past `frameNow` and reading that far ahead from
   * then on - so that whatever delays it by `lead` is heard exactly in step with this one.
   */
  aheadBy(lead, frameNow) {
    const ahead = new SongReader(this.sampleRate);
    ahead.planes = this.planes;
    ahead.frames = this.frames;
    ahead.rate = this.rate;
    ahead.voices = this.voices.map((v) => ({ ...v }));
    ahead.events = this.events.map((e) => ({ ...e }));
    ahead.lead = this.lead;
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let done = 0; done < lead; done += 128) ahead.process(l, r, Math.min(128, lead - done), frameNow + done);
    ahead.lead = this.lead + lead;
    return ahead;
  }

  receive(message) {
    if (!message) return;
    if (message.kind === 'load') {
      this.planes = message.planes;
      this.frames = message.frames;
      this.voices = [];
      this.events = [];
      return;
    }
    if (message.kind === 'free') {
      this.planes = null;
      this.frames = 0;
      this.voices = [];
      this.events = [];
      return;
    }
    if (message.kind === 'query') {
      const main = this.voices.find((v) => v.step >= 0 && v.halt == null) ?? null;
      this.post({ kind: 'pos', id: message.id, pos: main ? main.pos / this.sampleRate : null, rate: this.rate });
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
        const fade = Math.max(1, Math.round(SONG_FADE_SEC * sr));
        for (const v of this.voices) v.step = -Math.max(v.gain, 1e-6) / fade;
        this.voices.push({ pos: Number(event.pos) * sr + (Number.isFinite(late) && late > 0 ? late * this.rate : 0), gain: 0, step: 1 / fade, halt: null, haltStep: 0 });
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
        break;
      }
      case 'stop': {
        const len = Math.max(1, Math.round((Number.isFinite(event.release) ? event.release : SONG_RELEASE_SEC) * sr));
        for (const v of this.voices) v.step = -Math.max(v.gain, 1e-6) / len;
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
    const heard = frameNow + this.lead;
    let at = 0;
    while (at < frames) {
      while (this.events.length && this.events[0].frame <= heard + at) {
        const event = this.events.shift();
        this.apply(event, heard + at - event.frame);
      }
      const next = this.events.length ? this.events[0].frame - heard : Infinity;
      const until = Math.min(frames, Math.max(at + 1, next));
      if (this.planes && this.voices.length) this.render(outL, outR, at, until);
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
}
