// What the mixer's meters and plots read.
//
// One TAP per strip being shown: the signal split into left and right, and mid and side built
// from them with a pair of gains, each of the four going into an analyser. Four rather than two
// because mid and side are what make the stereo image a real one - the analysers report
// MAGNITUDES, and magnitudes cannot be added back into a sum and a difference after the fact.
//
// A tap exists only while the mixer is open, and there is a budget on how many: see MIX_TRACK_MAX.
// On the desktop that budget is real DSP on the thread the song runs on; here an AnalyserNode is
// native and costs little, and the cap is kept anyway so the two builds show the same thing at
// the same point - a ten-track song where the plots move to the master is not a different song
// because of which build is playing it.

/** How many bands the plots draw, and the range they are spread across, lowest first. */
export const MIX_BAND_COUNT = 96;
const MIX_BAND_LO = 30;
const MIX_BAND_HI = 17000;

/** The band centers, log-spaced: equal steps along this array are equal steps in pitch. */
export const MIX_BAND_FREQS = Object.freeze(Array.from({ length: MIX_BAND_COUNT }, (_, i) =>
  Math.round(MIX_BAND_LO * (MIX_BAND_HI / MIX_BAND_LO) ** (i / (MIX_BAND_COUNT - 1)))));

/** Values each band reports, in order: left, right, mid (L+R), side (L-R). */
export const MIX_BAND_VALUES = 4;

/** The most tracks that get an analyzer of their own at once. Past it, only the master is drawn. */
export const MIX_TRACK_MAX = 8;

/**
 * The transform's size. Four thousand points is about twelve Hertz a bin at the usual rate:
 * coarse against the lowest bands, which sit two Hertz apart, and the finest that is worth
 * paying for - the bands down there are closer together than any window this short can separate,
 * so they share a bin and the curve is smooth rather than wrong.
 */
const FFT_SIZE = 4096;

/** Where each band reads in the transform: the bins between its neighbors' geometric midpoints. */
function bandBins(sampleRate) {
  const binHz = sampleRate / FFT_SIZE;
  const bins = MIX_BAND_FREQS.length;
  const out = new Array(bins);
  for (let i = 0; i < bins; i++) {
    const hz = MIX_BAND_FREQS[i];
    const below = i === 0 ? hz * (MIX_BAND_FREQS[0] / MIX_BAND_FREQS[1]) : MIX_BAND_FREQS[i - 1];
    const above = i === bins - 1 ? hz * (MIX_BAND_FREQS[bins - 1] / MIX_BAND_FREQS[bins - 2]) : MIX_BAND_FREQS[i + 1];
    const lo = Math.sqrt(hz * below);
    const hi = Math.sqrt(hz * above);
    // At least one bin, even where a band is narrower than the transform can resolve.
    const from = Math.max(0, Math.round(lo / binHz));
    const to = Math.max(from + 1, Math.round(hi / binHz));
    out[i] = [from, Math.min(to, FFT_SIZE / 2)];
  }
  return out;
}

/** One strip's four analysers and the nodes that feed them. */
class Tap {
  constructor(ctx, source) {
    this.ctx = ctx;
    this.source = source;
    this.splitter = ctx.createChannelSplitter(2);
    // A mono source still fills both sides: a splitter fed one channel leaves the second silent,
    // which would draw every mono track hard left and its side channel as loud as its mid.
    this.merge = ctx.createGain();
    this.merge.channelCount = 2;
    this.merge.channelCountMode = 'explicit';
    this.merge.channelInterpretation = 'speakers';
    source.connect(this.merge);
    this.merge.connect(this.splitter);

    const analyser = () => {
      const node = ctx.createAnalyser();
      node.fftSize = FFT_SIZE;
      // No smoothing here: the panel does its own, with an attack and a release it can explain.
      node.smoothingTimeConstant = 0;
      return node;
    };
    this.left = analyser();
    this.right = analyser();
    this.mid = analyser();
    this.side = analyser();
    this.splitter.connect(this.left, 0);
    this.splitter.connect(this.right, 1);

    // mid = (L + R) / 2, side = (L - R) / 2.
    const gain = (value) => {
      const node = ctx.createGain();
      node.gain.value = value;
      return node;
    };
    this.midL = gain(0.5);
    this.midR = gain(0.5);
    this.sideL = gain(0.5);
    this.sideR = gain(-0.5);
    this.splitter.connect(this.midL, 0).connect(this.mid);
    this.splitter.connect(this.midR, 1).connect(this.mid);
    this.splitter.connect(this.sideL, 0).connect(this.side);
    this.splitter.connect(this.sideR, 1).connect(this.side);

    this.time = new Float32Array(FFT_SIZE);
    this.freq = new Float32Array(FFT_SIZE / 2);
  }

  /** The loudest sample and the average power since the last read, per side. */
  levels() {
    const read = (node) => {
      node.getFloatTimeDomainData(this.time);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < this.time.length; i++) {
        const v = this.time[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
      return { peak, rms: Math.sqrt(sum / this.time.length) };
    };
    const l = read(this.left);
    const r = read(this.right);
    return { peakL: l.peak, rmsL: l.rms, peakR: r.peak, rmsR: r.rms };
  }

  /** One band frame: an amplitude per band per channel, in the panel's own order. */
  bands(bins) {
    const of = (node) => {
      node.getFloatFrequencyData(this.freq);
      const out = new Array(bins.length);
      for (let b = 0; b < bins.length; b++) {
        const [from, to] = bins[b];
        let sum = 0;
        for (let i = from; i < to; i++) sum += 10 ** (this.freq[i] / 20);
        out[b] = sum / (to - from);
      }
      return out;
    };
    const l = of(this.left);
    const r = of(this.right);
    const mid = of(this.mid);
    const side = of(this.side);
    const frame = new Array(bins.length);
    for (let b = 0; b < bins.length; b++) frame[b] = [l[b], r[b], mid[b], side[b]];
    return frame;
  }

  dispose() {
    for (const node of [this.merge, this.splitter, this.left, this.right, this.mid, this.side, this.midL, this.midR, this.sideL, this.sideR]) {
      try { node.disconnect(); } catch { /* already detached */ }
    }
    try { this.source.disconnect(this.merge); } catch { /* already detached */ }
  }
}

/**
 * The analysis the mixer reads, for as long as it is open.
 *
 * `want` is the strips the panel is showing, as engine track ids; the master is always analyzed
 * and is keyed '*'. A tap is built the first time a strip is asked for and thrown away when it
 * stops being asked for, so folding a group really does hand its share back.
 */
export class MixAnalysis {
  constructor(ctx, master) {
    this.ctx = ctx;
    this.master = master;
    this.taps = new Map();          // key -> Tap
    this.on = false;
    this.bins = bandBins(ctx.sampleRate);
  }

  /** Turns the analysis on or off. Off throws every tap away rather than leaving them running. */
  setMonitor(on) {
    this.on = !!on;
    if (!this.on) this.clear();
    return this.on;
  }

  clear() {
    for (const tap of this.taps.values()) tap.dispose();
    this.taps.clear();
  }

  /**
   * Reads every wanted strip. `sources` is `key -> node`, already cut to the budget by the
   * caller, which is the only one that knows which tracks are playing.
   */
  read(sources) {
    if (!this.on) return { levels: {}, spec: {} };
    for (const [key, tap] of [...this.taps]) {
      if (sources.has(key)) continue;
      tap.dispose();
      this.taps.delete(key);
    }
    const levels = {};
    const spec = {};
    for (const [key, node] of sources) {
      let tap = this.taps.get(key);
      if (!tap) {
        // A tap's analysers hold nothing yet, so its first read is silence however loud the
        // track is. One poll later it is right, which is a tenth of a second nobody sees.
        tap = new Tap(this.ctx, node);
        this.taps.set(key, tap);
      }
      levels[key] = [tap.levels()];
      spec[key] = tap.bands(this.bins);
    }
    return { levels, spec };
  }
}
