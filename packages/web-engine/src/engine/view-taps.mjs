// What the editor's inline audio displays read - `.scope()`, `.spectrum()`, `.waveform()`,
// `.imager()` and `.meter()` - in the browser engine.
//
// One VIEW TAP per track a display is drawing (or the master): the output split into left and
// right, each into an AnalyserNode for its samples, and - when a spectrum is drawn - a third on
// the mono sum for its transform. The desktop engine keeps the same three things in scsynth (see
// osc-engine/view-taps.js) and both hand the editor frames of one shape, at one resolution: the
// scope's samples kept one in VIEW_DECIM, the spectrum a 2048-point transform scaled so a
// full-scale sine reads 0 dB. A display is then the same picture whichever engine is playing.
//
// A tap exists only while the editor is asking for frames (the host arms and disarms them).

/** How many of the AnalyserNode samples the scope keeps: one in this many. */
export const VIEW_DECIM = 2;

const FFT_SIZE = 2048;

// An AnalyserNode reports 20*log10(|X| / N) through a Blackman window, whose coherent gain is 0.42, so
// a unit sine reads 20*log10(0.42 / 2). Adding this puts it at 0 dB, the desktop's scale.
const DB_OFFSET = 20 * Math.log10(2 / 0.42);

const round4 = (x) => Math.round(x * 1e4) / 1e4;
// A scope sample needs no more: the tallest display is a few hundred pixels.
const round3 = (x) => Math.round(x * 1e3) / 1e3;

class Tap {
  constructor(ctx, source, fft) {
    this.ctx = ctx;
    this.source = source;
    // A mono source fills both sides, as the mixer's taps do (see analysis.mjs).
    this.merge = ctx.createGain();
    this.merge.channelCount = 2;
    this.merge.channelCountMode = 'explicit';
    this.merge.channelInterpretation = 'speakers';
    this.splitter = ctx.createChannelSplitter(2);
    source.connect(this.merge);
    this.merge.connect(this.splitter);
    const analyser = () => {
      const node = ctx.createAnalyser();
      node.fftSize = FFT_SIZE;
      node.smoothingTimeConstant = 0;
      return node;
    };
    this.left = analyser();
    this.right = analyser();
    this.splitter.connect(this.left, 0);
    this.splitter.connect(this.right, 1);
    this.fft = !!fft;
    this.mono = null;
    if (this.fft) {
      this.mono = analyser();
      this.monoGain = ctx.createGain();
      this.monoGain.channelCount = 1;
      this.monoGain.channelCountMode = 'explicit';
      this.monoGain.channelInterpretation = 'speakers';
      this.merge.connect(this.monoGain);
      this.monoGain.connect(this.mono);
    }
    this.lBuf = new Float32Array(FFT_SIZE);
    this.rBuf = new Float32Array(FFT_SIZE);
    this.fBuf = this.fft ? new Float32Array(FFT_SIZE / 2) : null;
  }

  read() {
    this.left.getFloatTimeDomainData(this.lBuf);
    this.right.getFloatTimeDomainData(this.rBuf);
    const frames = FFT_SIZE / VIEW_DECIM;
    const l = new Array(frames);
    const r = new Array(frames);
    let pl = 0;
    let pr = 0;
    let sl = 0;
    let sr = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const a = this.lBuf[i];
      const b = this.rBuf[i];
      const aa = a < 0 ? -a : a;
      const bb = b < 0 ? -b : b;
      if (aa > pl) pl = aa;
      if (bb > pr) pr = bb;
      sl += a * a;
      sr += b * b;
      if (i % VIEW_DECIM === 0) {
        l[i / VIEW_DECIM] = round3(a);
        r[i / VIEW_DECIM] = round3(b);
      }
    }
    const frame = {
      scope: { rate: this.ctx.sampleRate / VIEW_DECIM, l, r },
      level: { pl: round4(pl), rl: round4(Math.sqrt(sl / FFT_SIZE)), pr: round4(pr), rr: round4(Math.sqrt(sr / FFT_SIZE)) },
    };
    if (this.fft) {
      this.mono.getFloatFrequencyData(this.fBuf);
      const db = new Array(this.fBuf.length);
      for (let k = 0; k < this.fBuf.length; k++) {
        const v = this.fBuf[k] + DB_OFFSET;
        db[k] = Number.isFinite(v) ? Math.round(Math.max(-140, v) * 10) / 10 : -140;
      }
      frame.spec = { binHz: this.ctx.sampleRate / FFT_SIZE, db };
    }
    return frame;
  }

  dispose() {
    for (const node of [this.merge, this.splitter, this.left, this.right, this.mono, this.monoGain]) {
      if (!node) continue;
      try { node.disconnect(); } catch { /* already detached */ }
    }
    try { this.source.disconnect(this.merge); } catch { /* already detached */ }
  }
}

/**
 * The taps the displays read. `sourceOf(id)` is the node a track id (or '*', the master) is
 * heard from, or null for one that does not exist yet.
 */
export class ViewTaps {
  constructor(ctx, sourceOf) {
    this.ctx = ctx;
    this.sourceOf = sourceOf;
    this.wanted = [];
    this.taps = new Map(); // id -> Tap
  }

  /**
   * Arm a tap on each of `list` - `[{ id, fft }]` - and drop every other. Every track asked for gets one.
   * Returns `{ armed, over }`; `over` is always empty (kept for callers).
   */
  arm(list = []) {
    const seen = new Set();
    const armed = [];
    const over = [];
    const wanted = [];
    for (const want of list) {
      const id = String(want.id);
      if (seen.has(id)) continue;
      seen.add(id);
      armed.push(id);
      wanted.push({ id, fft: !!want.fft });
    }
    this.wanted = wanted;
    for (const [id, tap] of [...this.taps]) {
      const w = wanted.find((x) => x.id === id);
      if (!w || w.fft !== tap.fft) {
        tap.dispose();
        this.taps.delete(id);
      }
    }
    return { armed, over };
  }

  /** The latest frame of every armed tap, built the first time it is asked for. */
  read() {
    const out = {};
    for (const { id, fft } of this.wanted) {
      let tap = this.taps.get(id);
      const source = this.sourceOf(id);
      // A track rebuilt under the same id is a new strip: the tap follows it rather than go on
      // reading the one that was torn down.
      if (tap && tap.source !== source) {
        tap.dispose();
        this.taps.delete(id);
        tap = null;
      }
      if (!tap) {
        if (!source) continue; // a track the next evaluation will build
        tap = new Tap(this.ctx, source, fft);
        this.taps.set(id, tap);
      }
      out[id] = tap.read();
    }
    return out;
  }

  clear() {
    for (const tap of this.taps.values()) tap.dispose();
    this.taps.clear();
    this.wanted = [];
  }
}
