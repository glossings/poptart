// The recorder tap: what a track's record panel meters, and what a bounce captures.
//
// One per track that is being watched or recorded, hung off the track's output. It does two
// things, each switched on by a message: METER posts the loudest sample and the average power
// about twenty times a second, which is the panel's live waveform; RECORD copies every frame
// between two times on the context's clock and posts them back in chunks, then says it is done.
// The window is kept to the sample - a frame's time is its index on the context's own counter -
// so a bounce is exactly as long as the cycles it was asked for, and needs no trimming for time.

/** How often a meter reading is posted, in frames: about twenty a second at 48 kHz. */
const METER_FRAMES = 2400;

/** How much is copied before a chunk is posted back: about half a second. */
const CHUNK_FRAMES = 24000;

export class RecorderTap {
  constructor(sampleRate, post) {
    this.sampleRate = sampleRate;
    this.post = post;
    this.metering = false;
    this.peak = 0;
    this.sum = 0;
    this.count = 0;
    this.take = null;       // { id, from, to (frames), l, r, filled, written }
  }

  receive(message) {
    if (message?.kind === 'meter') {
      this.metering = !!message.on;
      this.peak = 0; this.sum = 0; this.count = 0;
    } else if (message?.kind === 'record') {
      const from = Math.round(message.start * this.sampleRate);
      const to = Math.round(message.end * this.sampleRate);
      this.take = { id: message.id, from, to, l: new Float32Array(CHUNK_FRAMES), r: new Float32Array(CHUNK_FRAMES), filled: 0, written: 0 };
    } else if (message?.kind === 'cancel') {
      this.take = null;
    }
  }

  /** One block. `frame` is the context's frame count at the block's first sample. */
  process(inL, inR, count, frame) {
    if (this.metering) {
      for (let i = 0; i < count; i++) {
        const a = Math.max(Math.abs(inL ? inL[i] : 0), Math.abs(inR ? inR[i] : 0));
        if (a > this.peak) this.peak = a;
        const m = ((inL ? inL[i] : 0) + (inR ? inR[i] : 0)) * 0.5;
        this.sum += m * m;
      }
      this.count += count;
      if (this.count >= METER_FRAMES) {
        this.post({ kind: 'level', peak: this.peak, rms: Math.sqrt(this.sum / this.count) });
        this.peak = 0; this.sum = 0; this.count = 0;
      }
    }
    const take = this.take;
    if (!take) return;
    for (let i = 0; i < count; i++) {
      const f = frame + i;
      if (f < take.from) continue;
      if (f >= take.to) { this._flush(); this.post({ kind: 'done', id: take.id, frames: take.written }); this.take = null; return; }
      take.l[take.filled] = inL ? inL[i] : 0;
      take.r[take.filled] = inR ? inR[i] : (inL ? inL[i] : 0);
      take.filled += 1;
      if (take.filled === take.l.length) this._flush();
    }
  }

  _flush() {
    const take = this.take;
    if (!take || !take.filled) return;
    const l = take.l.slice(0, take.filled);
    const r = take.r.slice(0, take.filled);
    this.post({ kind: 'chunk', id: take.id, l, r }, [l.buffer, r.buffer]);
    take.written += take.filled;
    take.filled = 0;
  }
}
