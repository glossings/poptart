// Keylock: a song read at any rate with its pitch held, for the DJ decks.
//
// Two bands, each stretched the way it stretches best:
//
//  - Below about 1.9 kHz, a phase vocoder. The band is decimated by D (8 at 44.1/48 kHz) and
//    analyzed there with a 256-point Hann frame and a quarter-frame hop - about 46 ms of window,
//    long enough to resolve a bass line or a vocal's fundamental, and cheap because it runs at an
//    eighth of the rate. Phases are propagated from each bin's measured frequency, locked to the
//    nearest spectral peak (so a partial's neighbors move with it rather than smearing), and
//    reset to the analyzed phase in any of four bands where a hit arrives, so a kick lands as a
//    kick instead of a phasey swell.
//  - Above it, WSOLA: the high band is cut into 20 ms grains, 10 ms apart, played at the record's
//    own speed, and each grain is taken from wherever, within 5 ms of where the playhead says, it
//    best continues the one before. Consonants, hats and the upper harmonics of a voice stay
//    crisp and single-pitched - the place a whole-band phase vocoder gets phasey.
//
// The split is complementary: the high band is the read minus the low band's decimated-and-
// restored copy, through the very filters the low band goes through, so at rate 1 the two sum
// back to the read.
//
// The reader owns its playhead and reads the song itself, so nothing is late: every frame and
// grain is placed by predicting where the playhead will be when it is heard, from the rate now.
// A seek starts both bands from the new position at full level; the song reader crossfades an
// old position into a new one by running two of these side by side.
//
// A ceiling holds keylocked audio at -0.1 dBFS. A mastered track peaks just under 0 dBFS with its
// phases lined up by a limiter; the stretcher changes those phases and the peaks grow - up to
// +4.5 dB, clipping the interface where plain playback did not. The stretcher runs 63 samples
// ahead of what is heard (its playhead predicted from the rate now, as its frames and grains
// are) and a 64-sample lookahead limiter takes it back to the moment heard, so the ceiling adds
// no latency. Below the ceiling the limiter's gain is exactly 1 and the audio passes bit for bit.
// A seek empties the lookahead and starts it again at the new position.
//
// A grain starts on a whole song frame when the song is at the output rate, so the high band is
// read sample for sample: an interpolated read is a gentle low-pass, and 20 ms grains starting
// at fractional positions dull everything above 3 kHz by a measurable amount.
//
// keylock.h in osc-engine/native/devices/own/dsp is this file in C++, for the desktop's
// PoptartKeylock UGen; native-device-parity.test.mjs holds the two to the same output.

const TWO_PI = 2 * Math.PI;

/** The analysis frame and hop, in decimated samples. */
export const KEYLOCK_FRAME = 256;
export const KEYLOCK_HOP = 64;
/** Where the bands split (Hz). */
export const KEYLOCK_SPLIT_HZ = 1900;
/** The split filter's half length, in decimated samples: 16*D taps each side of the center. */
const SPLIT_TAPS = 16;
/** The grain hop (seconds); a grain is two hops long and may move half a hop each way to fit. */
const GRAIN_SEC = 0.01;
/** The fit is scored on every other candidate first, then on the ones beside the best. */
const SEARCH_STRIDE = 2;
/** How hard the fit leans toward the playhead's own position, against the match's energy. */
const SEARCH_PULL = 0.1;
/** A grain whose nominal read holds this much more energy than the grain before it holds a hit. */
const HIT_RISE = 4;
/**
 * "Nothing to compare with": no grain before this one. Finite, because the C++ is built with
 * -ffast-math, which assumes there are no infinities.
 */
const NO_ENERGY = 1e300;
/** The ceiling: -0.1 dBFS. */
export const KEYLOCK_CEILING = 0.989;
/** The limiter's window, in samples; the stretcher runs one less than this ahead of the output. */
const LIMIT_LEN = 64;
const LIMIT_AHEAD = LIMIT_LEN - 1;
/** The limiter's release (seconds). */
const LIMIT_RELEASE_SEC = 0.06;
/** A gain this close to 1 with nothing to limit is 1. */
const LIMIT_SNAP = 1e-9;
/** The longest run the stretcher makes at a time. */
const STRETCH_BLOCK = 128;
/** The phase-reset bands' upper edges (Hz); the last band runs to the split. */
const RESET_EDGES_HZ = [143, 300, 780];
/** How sharply a band's energy has to rise between frames to count as a hit there. */
const RESET_RISE = 2.0;

/** Decimation for a sample rate: the analysis runs near 5.5-6 kHz whatever the device rate. */
export function keylockDecimation(sampleRate) {
  return sampleRate >= 66000 ? 16 : 8;
}

/**
 * The split filter: a Blackman-Harris windowed sinc, 2*16*D + 1 taps, unity at DC. It is
 * symmetric - each tap past the center is the one as far before it - so a decimation adds each
 * pair of reads first and multiplies once (fir()).
 */
export function keylockFilter(sampleRate, D) {
  const M = SPLIT_TAPS * D;
  const L = 2 * M + 1;
  const fc = KEYLOCK_SPLIT_HZ / sampleRate;
  const h = new Float64Array(L);
  for (let k = 0; k <= M; k++) {
    const m = k - M;
    const sinc = m === 0 ? 2 * fc : Math.sin(TWO_PI * fc * m) / (Math.PI * m);
    const x = (TWO_PI * k) / (L - 1);
    const w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    h[k] = sinc * w;
    h[L - 1 - k] = h[k];
  }
  let sum = 0;
  for (let k = 0; k < L; k++) sum += h[k];
  for (let k = 0; k < L; k++) h[k] /= sum;
  return h;
}

/** The split filter `h` (2*M + 1 taps) over x[s0..s0 + 2M], each symmetric pair of reads summed first. */
function fir(h, M, x, s0) {
  const s1 = s0 + 2 * M;
  let acc = h[M] * x[s0 + M];
  for (let m = 0; m < M; m++) acc += h[m] * (x[s0 + m] + x[s1 - m]);
  return acc;
}

/** In-place radix-2 complex FFT; `inverse` scales by 1/n. `tw` holds cos/sin of -2*pi*k/n. */
function fft(re, im, inverse, twc, tws) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const c = twc[k * stride];
        const s = sign * tws[k * stride];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** A phase wrapped into [-pi, pi]. */
function princarg(x) {
  return x - TWO_PI * Math.floor(x / TWO_PI + 0.5);
}

export class Keylock {
  /**
   * @param sampleRate the output rate
   * @param channels   how many channels the song has (1 or 2)
   */
  constructor(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    const D = (this.D = keylockDecimation(sampleRate));
    this.h = keylockFilter(sampleRate, D);
    this.M = SPLIT_TAPS * D;
    const N = KEYLOCK_FRAME;
    this.Hs = KEYLOCK_HOP * D;                            // the frame hop, in output samples
    this.Hw = Math.round(GRAIN_SEC * sampleRate);         // the grain hop
    this.W = 2 * this.Hw;                                 // the grain length
    this.tol = this.Hw >> 1;                              // how far a grain may move to fit (each way)

    const win = (this.win = new Float64Array(N));
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
    const gw = (this.gwin = new Float64Array(this.W));
    for (let i = 0; i < this.W; i++) gw[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / this.W);
    this.twc = new Float64Array(N / 2);
    this.tws = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) { this.twc[k] = Math.cos((TWO_PI * k) / N); this.tws[k] = -Math.sin((TWO_PI * k) / N); }

    const bins = N / 2 + 1;
    const binHz = sampleRate / D / N;
    const bands = RESET_EDGES_HZ.length + 1;
    this.band = new Int32Array(bins); // which reset band each bin is in
    for (let b = 0; b < bins; b++) {
      let k = 0;
      while (k < RESET_EDGES_HZ.length && b * binHz >= RESET_EDGES_HZ[k]) k++;
      this.band[b] = k;
    }
    const perCh = () => Array.from({ length: channels }, () => new Float64Array(bins));
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.mag = perCh(); this.ph = perCh(); this.magPrev = perCh();
    this.cre = perCh(); this.cim = perCh(); this.pre = perCh(); this.pim = perCh();
    this.syn = new Float64Array(bins);
    this.dphase = new Float64Array(bins);
    this.midPh = new Float64Array(bins); this.midPrev = new Float64Array(bins); this.midMag = new Float64Array(bins);
    this.peakOf = new Int32Array(bins);
    this.reset = new Uint8Array(bands);
    this.now = new Float64Array(bands);
    this.was = new Float64Array(bands);

    // Scratch reads: a frame (and its predecessor, a hop earlier) and a grain's search region.
    this.frameSpan = N * D + 2 * this.M + this.Hs + 1;
    this.frameView = new Float64Array(this.frameSpan);
    // Each channel's decimated frame, and the frame before's: a frame on the same grid of song
    // samples as the one before takes the samples the two share from it.
    const rows = (len) => Array.from({ length: channels }, () => new Float64Array(len));
    this.dec = rows(N);
    this.decWas = rows(N);
    this.decAt = 0;       // the song position the frame before was read from
    this.decStep = 0;     // and the read's step (0: no frame to share with)
    this.dec1 = new Float64Array(N);
    // The high band of each channel at whole song positions, read at the song's own speed, on a
    // fixed grid of decimation: every grain and search region over the same samples shares it.
    // `hb` holds positions hbWin.lo..hi, `hd` the decimated samples hdWin.lo..hi under them.
    this.hbSize = 1 << Math.ceil(Math.log2(2 * (this.W + 2 * this.tol)));
    this.hdSize = 1 << Math.ceil(Math.log2(this.hbSize / D + (4 * this.M) / D + 8));
    this.hb = rows(this.hbSize);
    this.hd = rows(this.hdSize);
    this.hbWin = { lo: 0, hi: 0 };
    this.hdWin = { lo: 0, hi: 0 };
    const grainSpan = this.W + 2 * this.tol + 4 * this.M + 2 * D + 2;
    this.grainView = new Float64Array(grainSpan);
    this.grainDec = new Float64Array(Math.ceil(grainSpan / D) + 2);
    this.region = new Float64Array(this.W + 2 * this.tol);
    this.target = new Float64Array(this.W);

    // Output rings, indexed by absolute time: the low band at the decimated rate, the high band
    // at the output rate.
    this.lowSize = 1 << Math.ceil(Math.log2(N * 2 + (4 * this.M) / D + 64));
    this.low = Array.from({ length: channels }, () => new Float64Array(this.lowSize));
    this.highSize = 1 << Math.ceil(Math.log2(this.W * 4 + 8192));
    this.high = Array.from({ length: channels }, () => new Float64Array(this.highSize));

    // The limiter: the stretcher's output waiting to be heard, the gain each of those samples
    // needs, the minimum of that over each window, and the gain.
    this.stretched = Array.from({ length: channels }, () => new Float64Array(LIMIT_AHEAD + STRETCH_BLOCK));
    this.ahead = Array.from({ length: channels }, () => new Float64Array(LIMIT_LEN));
    this.need = new Float64Array(LIMIT_LEN);
    this.minG = new Float64Array(LIMIT_LEN);
    this.release = 1 - Math.exp(-1 / (LIMIT_RELEASE_SEC * sampleRate));

    this.planes = null;
    this.frames = 0;
    this.scale = 1;
    this.brs = 1;
    this.time = 0;      // the stretcher's output samples so far (absolute)
    this.head = 0;      // the stretcher's playhead, in song frames, at `time`
    this.pos = 0;       // the playhead heard, in song frames
    this.dir = 1;
    this.seek(0);
  }

  /**
   * The song: one typed array per channel, `scale` turning a stored sample into a float, and
   * `bufRateScale` the song's rate over the output's.
   */
  setSource(planes, frames, scale = 1, bufRateScale = 1) {
    this.planes = planes;
    this.frames = frames;
    this.scale = scale;
    this.brs = bufRateScale;
    this.decStep = 0;
    this.hbWin.lo = this.hbWin.hi = 0;
    this.hdWin.lo = this.hdWin.hi = 0;
  }

  /** As if new: the output clock back to 0 and the playhead at `pos`, with nothing sounding. */
  restart(pos) {
    this.time = 0;
    this.head = 0;
    this.dir = 1;
    this.seek(pos);
  }

  /** Puts the playhead at `pos` (song frames); the next output starts there at full level. */
  seek(pos) {
    this.pos = pos;
    this.primed = false;
    for (const r of this.ahead) r.fill(0);
    this.need.fill(1);
    this.minG.fill(1);
    this.minSum = LIMIT_LEN;
    this.limited = 0;   // how many of minG are below 1
    this.gain = 1;
    this.clock = 0;
    const { D, M, Hs, Hw, W } = this;
    const N = KEYLOCK_FRAME;
    for (const r of this.low) r.fill(0);
    for (const r of this.high) r.fill(0);
    // The frames whose decimated span reaches the first sample heard, and the grains under it.
    const firstDec = Math.ceil((this.time - M) / D);
    this.nextFrame = Math.floor(((firstDec - N / 2) * D) / Hs) + 1;
    this.nextGrain = Math.floor((this.time - W) / Hw) + 1;
    this.lowDone = firstDec - 1; // decimated samples below this have been read out
    this.freshFrame = true;
    this.freshGrain = true;
    this.prevStart = 0;
    this.prevEnergy = NO_ENERGY;
    this.stale = true;
  }

  /** A sample of channel `c` at song position `p` (Hermite), zero outside the song. */
  sample(c, p) {
    const i = Math.floor(p);
    const t = p - i;
    const x = this.planes[c];
    const n = this.frames;
    if (t === 0) return i >= 0 && i < n ? x[i] * this.scale : 0;
    const y0 = i - 1 >= 0 && i - 1 < n ? x[i - 1] : 0;
    const y1 = i >= 0 && i < n ? x[i] : 0;
    const y2 = i + 1 >= 0 && i + 1 < n ? x[i + 1] : 0;
    const y3 = i + 2 >= 0 && i + 2 < n ? x[i + 2] : 0;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return (((c3 * t + c2) * t + c1) * t + y1) * this.scale;
  }

  /**
   * `n` samples into `out` (one array per channel), the playhead moving `rate` song seconds per
   * second (negative plays backwards). `pos` is the playhead afterwards. `pitch` transposes by
   * that ratio: every frame and grain reads the song `pitch` times faster than the record's own
   * speed, wherever the playhead goes; at 1 the record's pitch is held.
   */
  process(out, n, rate, pitch = 1) {
    const step = rate * this.brs;
    const st = this.stretched;
    for (let at = 0; at < n; at += STRETCH_BLOCK) {
      const len = Math.min(STRETCH_BLOCK, n - at);
      // The stretcher makes what will be heard LIMIT_AHEAD samples from now, from where the
      // playhead will be then. Its first run after a seek also makes the LIMIT_AHEAD samples
      // heard before that, from the seek's own position.
      const lead = this.primed ? 0 : LIMIT_AHEAD;
      this.primed = true;
      this.head = this.pos + step * (LIMIT_AHEAD - lead);
      this.stretch(st, lead + len, rate, pitch);
      for (let s = 0; s < lead + len; s++) {
        const from = this.limit(st, s);
        if (s < lead) continue;
        const g = this.gain;
        for (let c = 0; c < this.channels; c++) out[c][at + s - lead] = this.ahead[c][from] * g;
      }
      this.pos += step * len;
    }
  }

  /**
   * The ceiling, for sample `s` of the stretcher's run: the gain each sample needs, its minimum
   * over the lookahead, box-averaged over the same span - a ramp that reaches the minimum exactly
   * when the peak comes out - with a 60 ms release. Returns the slot of `ahead` heard now, which
   * `gain` applies to.
   */
  limit(st, s) {
    const at = this.clock & (LIMIT_LEN - 1);
    let peak = 0;
    for (let c = 0; c < this.channels; c++) {
      const x = st[c][s];
      this.ahead[c][at] = x;
      const a = Math.abs(x);
      if (a > peak) peak = a;
    }
    const need = this.need;
    need[at] = peak > KEYLOCK_CEILING ? KEYLOCK_CEILING / peak : 1;
    let mn = 1;
    for (let j = 0; j < LIMIT_LEN; j++) if (need[j] < mn) mn = need[j];
    if (this.minG[at] < 1) this.limited--;
    if (mn < 1) this.limited++;
    // With no window below 1 the sum is exactly LIMIT_LEN again, not that plus rounding.
    this.minSum = this.limited ? this.minSum + (mn - this.minG[at]) : LIMIT_LEN;
    this.minG[at] = mn;
    const avg = this.minSum / LIMIT_LEN;
    const g = this.gain;
    let next = avg < g ? avg : Math.min(avg, g + (1 - g) * this.release);
    if (avg === 1 && next > 1 - LIMIT_SNAP) next = 1;
    this.gain = next;
    this.clock++;
    return this.clock & (LIMIT_LEN - 1); // the slot written LIMIT_AHEAD samples ago
  }

  /** The stretcher: `n` samples into `out` from its own time and playhead, which it moves on. */
  stretch(out, n, rate, pitch) {
    if (rate > 0) this.dir = 1; else if (rate < 0) this.dir = -1;
    const step = rate * this.brs;          // song frames per output sample
    const vstep = this.dir * this.brs * pitch; // a grain's own read: the record's speed, transposed
    const T = this.time;
    const P = this.head;
    const { D, M, Hs, Hw } = this;
    const N = KEYLOCK_FRAME;
    const exact = rate === 1 && this.brs === 1 && pitch === 1;

    const needDec = Math.floor((T + n - 1 + M) / D);
    while (this.nextFrame * Hs <= (needDec + N / 2) * D) {
      this.frame(this.nextFrame, P + step * (this.nextFrame * Hs - T), vstep, exact);
      this.nextFrame++;
    }
    while (this.nextGrain * Hw <= T + n - 1) {
      let q = P + step * (this.nextGrain * Hw + Hw - T) - vstep * Hw;
      if (this.brs === 1) q = Math.floor(q + 0.5);
      this.grain(this.nextGrain, q, vstep, exact);
      this.nextGrain++;
    }
    // The first frames and grains after a seek reach back before it, into slots of the rings
    // nothing will read until they come round again: emptied, or they would be heard then.
    if (this.stale) {
      this.stale = false;
      const hm0 = this.highSize - 1;
      const lm0 = this.lowSize - 1;
      const firstDec = Math.ceil((T - M) / D);
      for (let c = 0; c < this.channels; c++) {
        for (let t = T - this.W; t < T; t++) this.high[c][t & hm0] = 0;
        for (let i = firstDec - N - 1; i < firstDec; i++) this.low[c][i & lm0] = 0;
      }
    }

    const h = this.h;
    const lm = this.lowSize - 1;
    const hm = this.highSize - 1;
    for (let c = 0; c < this.channels; c++) {
      const o = out[c];
      const low = this.low[c];
      const high = this.high[c];
      for (let s = 0; s < n; s++) {
        const t = T + s;
        // The low band, back up to the output rate: D*h, centered, over the decimated samples.
        let y = 0;
        const i0 = Math.ceil((t - M) / D);
        const i1 = Math.floor((t + M) / D);
        for (let i = i0; i <= i1; i++) y += low[i & lm] * h[t - i * D + M];
        o[s] = y * D + high[t & hm];
        high[t & hm] = 0;
      }
    }
    // Decimated samples no later output can reach are cleared for the frames that reuse them.
    const keepFrom = Math.ceil((T + n - M) / D);
    for (let i = this.lowDone + 1; i < keepFrom; i++) for (let c = 0; c < this.channels; c++) this.low[c][i & lm] = 0;
    if (keepFrom - 1 > this.lowDone) this.lowDone = keepFrom - 1;

    this.time = T + n;
    this.head = P + step * n;
  }

  /**
   * Decimated samples j0..j1 of channel `c`'s frame view at song position `p` into `dst`, the
   * view starting `off` samples in - 0 for the frame a hop before, Hs for the frame itself.
   */
  decimate(c, p, vstep, off, j0, j1, dst) {
    if (j1 <= j0) return;
    const { D, M, h, frameView } = this;
    const base = -(KEYLOCK_FRAME / 2) * D - M - this.Hs;
    const s0 = off + j0 * D, e = off + (j1 - 1) * D + 2 * M + 1;
    const qa = p + vstep * (base + s0), qb = p + vstep * (base + e - 1);
    if (Math.min(qa, qb) >= 1 && Math.max(qa, qb) < this.frames - 3) {
      // Inside the song: sample()'s arithmetic, without its edges.
      const x = this.planes[c], scale = this.scale;
      for (let s = s0; s < e; s++) {
        const q = p + vstep * (base + s);
        const i = Math.floor(q);
        const t = q - i;
        if (t === 0) { frameView[s] = x[i] * scale; continue; }
        const y0 = x[i - 1], y1 = x[i], y2 = x[i + 1], y3 = x[i + 2];
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        frameView[s] = (((c3 * t + c2) * t + c1) * t + y1) * scale;
      }
    } else for (let s = s0; s < e; s++) frameView[s] = this.sample(c, p + vstep * (base + s));
    for (let j = j0; j < j1; j++) dst[j] = fir(h, M, frameView, off + j * D);
  }

  /** One phase-vocoder frame of the low band, centered at output time k*Hs and song position p. */
  frame(k, p, vstep, exact) {
    const { D, Hs, win, re, im } = this;
    const N = KEYLOCK_FRAME;
    const bins = N / 2 + 1;
    const hop = KEYLOCK_HOP;
    const fresh = this.freshFrame;
    this.freshFrame = false;
    // The frame a hop before is read only to follow each bin's frequency and to find hits.
    const track = !fresh && !exact;
    // Decimated sample j of the frame is decWas[j + shift] when this frame is read on the grid
    // of song samples the one before was, every read landing on the same song position (a whole
    // multiple of 2^-16, which the sums hold exactly) - the same samples through the same sums.
    let shift = 0, jLo = 0, jHi = 0;
    if (this.decStep === vstep && (vstep === 1 || vstep === -1)
      && Number.isInteger(p * 65536) && Number.isInteger(this.decAt * 65536)) {
      const d = (p - this.decAt) * vstep;
      if (d % D === 0) {
        shift = d / D;
        jLo = Math.min(N, Math.max(0, -shift));
        jHi = Math.max(jLo, Math.min(N, N - shift));
      }
    }
    for (let c = 0; c < this.channels; c++) {
      const dec = this.dec[c];
      const decWas = this.decWas[c];
      // Decimate the frame (which starts a hop into the view), window, transform.
      this.decimate(c, p, vstep, Hs, 0, jLo, dec);
      this.decimate(c, p, vstep, Hs, jHi, N, dec);
      for (let j = jLo; j < jHi; j++) dec[j] = decWas[j + shift];
      for (let j = 0; j < N; j++) { re[j] = dec[j] * win[j]; im[j] = 0; }
      fft(re, im, false, this.twc, this.tws);
      const cre = this.cre[c], cim = this.cim[c], mag = this.mag[c], ph = this.ph[c];
      for (let b = 0; b < bins; b++) {
        cre[b] = re[b];
        cim[b] = im[b];
        mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      }
      for (let b = 0; b < bins; b++) ph[b] = Math.atan2(im[b], re[b]);
      if (!track) continue;
      // The frame a hop before, which starts the view: past its first hop it is this frame's
      // own samples, a hop along.
      const dec1 = this.dec1;
      this.decimate(c, p, vstep, 0, 0, hop, dec1);
      for (let j = hop; j < N; j++) dec1[j] = dec[j - hop];
      for (let j = 0; j < N; j++) { re[j] = dec1[j] * win[j]; im[j] = 0; }
      fft(re, im, false, this.twc, this.tws);
      const pre = this.pre[c], pim = this.pim[c], magPrev = this.magPrev[c];
      for (let b = 0; b < bins; b++) {
        pre[b] = re[b];
        pim[b] = im[b];
        magPrev[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      }
    }
    const decNow = this.dec;
    this.dec = this.decWas;
    this.decWas = decNow;
    this.decAt = p;
    this.decStep = vstep;
    // Hits, per reset band, on the channels summed: the energy now against a hop ago.
    const { reset, now, was, band } = this;
    const bands = reset.length;
    for (let r = 0; r < bands; r++) { now[r] = 0; was[r] = 0; reset[r] = 0; }
    if (track) for (let c = 0; c < this.channels; c++) {
      const mag = this.mag[c];
      const prev = this.magPrev[c];
      for (let b = 1; b < bins; b++) {
        now[band[b]] += mag[b] * mag[b];
        was[band[b]] += prev[b] * prev[b];
      }
    }
    let total = 0;
    for (let r = 0; r < bands; r++) total += now[r];
    for (let r = 0; r < bands; r++) if (now[r] > RESET_RISE * was[r] && now[r] > 1e-4 * total + 1e-12) reset[r] = 1;
    // The phases move once, for the channels summed, and every channel keeps its own offset
    // from that sum: left and right stay in the phase relation they were recorded with, so the
    // image holds still and a mono sum doesn't comb.
    const { midMag, midPh, midPrev, syn } = this;
    for (let b = 0; b < bins; b++) {
      let r = 0, i = 0, r2 = 0, i2 = 0;
      for (let c = 0; c < this.channels; c++) {
        r += this.cre[c][b]; i += this.cim[c][b];
        r2 += this.pre[c][b]; i2 += this.pim[c][b];
      }
      midMag[b] = Math.sqrt(r * r + i * i);
      midPh[b] = Math.atan2(i, r);
      if (track) midPrev[b] = Math.atan2(i2, r2);
    }
    if (fresh || exact) {
      for (let b = 0; b < bins; b++) syn[b] = midPh[b];
    } else {
      // Each bin's own frequency, from how far its phase moved over the hop.
      const dph = this.dphase;
      for (let b = 0; b < bins; b++) {
        const w = ((TWO_PI * b) / N) * hop;
        dph[b] = w + princarg(midPh[b] - midPrev[b] - w);
      }
      // Peaks, and each bin's nearest one: a bin moves with the partial it belongs to.
      const peakOf = this.peakOf;
      let last = -1;
      for (let b = 0; b < bins; b++) {
        const isPeak = (b === 0 || midMag[b] > midMag[b - 1]) && (b === bins - 1 || midMag[b] >= midMag[b + 1]);
        if (isPeak) {
          if (last < 0) for (let q = 0; q < b; q++) peakOf[q] = b;
          else for (let q = last + 1; q < b; q++) peakOf[q] = q - last <= b - q ? last : b;
          peakOf[b] = b;
          last = b;
        }
      }
      if (last < 0) last = 0;
      for (let q = last + 1; q < bins; q++) peakOf[q] = last;
      for (let b = 0; b < bins; b++) if (peakOf[b] === b) syn[b] += dph[b];
      for (let b = 0; b < bins; b++) {
        const pk = peakOf[b];
        if (pk !== b) syn[b] = syn[pk] + midPh[b] - midPh[pk];
      }
      for (let b = 0; b < bins; b++) if (reset[band[b]]) syn[b] = midPh[b];
      for (let b = 0; b < bins; b++) syn[b] = princarg(syn[b]);
    }
    const lm = this.lowSize - 1;
    const start = k * hop - N / 2;
    for (let c = 0; c < this.channels; c++) {
      const mag = this.mag[c];
      const ph = this.ph[c];
      // Back to time, windowed again, overlap-added (Hann^2 at a quarter-frame hop sums to 1.5).
      for (let b = 0; b < bins; b++) {
        const th = ph[b] + syn[b] - midPh[b];
        re[b] = mag[b] * Math.cos(th);
        im[b] = mag[b] * Math.sin(th);
      }
      for (let b = 1; b < N / 2; b++) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      im[0] = 0; im[N / 2] = 0;
      fft(re, im, true, this.twc, this.tws);
      const low = this.low[c];
      for (let j = 0; j < N; j++) low[(start + j) & lm] += (re[j] * win[j]) / 1.5;
    }
  }

  /**
   * Makes `w` (a window of song positions, or of decimated samples) hold a..b-1, a span no longer
   * than its ring, `R`: a window it overlaps or touches grows by what it lacks, giving up its far
   * end past R; any other is read afresh. `high` picks the high band's window or its decimation's.
   */
  cover(w, a, b, R, high) {
    if (w.hi > w.lo && a >= w.lo && b <= w.hi) return;
    if (w.hi > w.lo && b >= w.lo && a <= w.hi) {
      let lo = Math.min(a, w.lo), hi = Math.max(b, w.hi);
      if (hi - lo > R) { if (a < w.lo) hi = lo + R; else lo = hi - R; }
      if (lo < w.lo) this.fill(lo, w.lo, high);
      if (hi > w.hi) this.fill(w.hi, hi, high);
      w.lo = lo; w.hi = hi;
    } else {
      this.fill(a, b, high);
      w.lo = a; w.hi = b;
    }
  }

  /**
   * Fills the high band's ring at song positions x0..x1-1 (`high`), or its decimation's at
   * decimated samples x0..x1-1: the song low-passed at position i*D, on a grid fixed to the song.
   */
  fill(x0, x1, high) {
    const { D, M, h } = this;
    if (high) {
      this.cover(this.hdWin, Math.ceil((x0 - M) / D), Math.floor((x1 - 1 + M) / D) + 1, this.hdSize, false);
      const bm = this.hbSize - 1, dm = this.hdSize - 1;
      for (let c = 0; c < this.channels; c++) {
        const hb = this.hb[c], hd = this.hd[c];
        for (let x = x0; x < x1; x++) {
          let y = 0;
          const i1 = Math.floor((x + M) / D);
          for (let i = Math.ceil((x - M) / D); i <= i1; i++) y += hd[i & dm] * h[x - i * D + M];
          hb[x & bm] = this.sample(c, x) - y * D;
        }
      }
      return;
    }
    const dm = this.hdSize - 1;
    const n = this.frames, scale = this.scale;
    for (let c = 0; c < this.channels; c++) {
      const hd = this.hd[c], src = this.planes[c];
      for (let i = x0; i < x1; i++) {
        const k0 = i * D - M;
        if (k0 >= 0 && k0 + 2 * M < n) hd[i & dm] = fir(h, M, src, k0) * scale;
        else {
          const k1 = k0 + 2 * M;
          let acc = h[M] * this.sample(c, k0 + M);
          for (let m = 0; m < M; m++) acc += h[m] * (this.sample(c, k0 + m) + this.sample(c, k1 - m));
          hd[i & dm] = acc;
        }
      }
    }
  }

  /** The high band of channel `c` (or the channels summed, c < 0) over [p, p + len) read at vstep. */
  highBand(c, p, vstep, len, dst) {
    const { D, M, h, grainView, grainDec } = this;
    // Read at the song's own speed from a whole sample, the band is the shared one's.
    if (Number.isInteger(p) && (vstep === 1 || vstep === -1)) {
      const a = vstep > 0 ? p : p - (len - 1);
      this.cover(this.hbWin, a, a + len, this.hbSize, true);
      const bm = this.hbSize - 1;
      if (c >= 0) {
        const hb = this.hb[c];
        for (let s = 0; s < len; s++) dst[s] = hb[(p + vstep * s) & bm];
      } else {
        for (let s = 0; s < len; s++) {
          const x = (p + vstep * s) & bm;
          let v = 0;
          for (let ch = 0; ch < this.channels; ch++) v += this.hb[ch][x];
          dst[s] = v;
        }
      }
      return;
    }
    const pad = 2 * M + D;
    // Decimate on a grid of D from the span's start, restore, subtract: the decimated samples the
    // band over [pad, pad + len) is restored from, iFirst..iLast, and only the reads under them.
    const iFirst = Math.ceil((pad - M) / D);
    const iLast = Math.floor((pad + len - 1 + M) / D);
    for (let s = iFirst * D - M, e = iLast * D + M; s <= e; s++) {
      const q = p + vstep * (s - pad);
      if (c >= 0) grainView[s] = this.sample(c, q);
      else {
        let v = 0;
        for (let ch = 0; ch < this.channels; ch++) v += this.sample(ch, q);
        grainView[s] = v;
      }
    }
    for (let i = iFirst; i <= iLast; i++) grainDec[i] = fir(h, M, grainView, i * D - M);
    for (let s = 0; s < len; s++) {
      const t = s + pad;
      let y = 0;
      const i1 = Math.floor((t + M) / D);
      for (let i = Math.ceil((t - M) / D); i <= i1; i++) y += grainDec[i] * h[t - i * D + M];
      dst[s] = grainView[t] - y * D;
    }
  }

  /** How well the region at offset `d` continues the target: Hann-weighted correlation. */
  fit(d) {
    const { W, gwin, target, region } = this;
    let xy = 0;
    for (let i = 0; i < W; i += 2) xy += target[i] * region[d + i] * gwin[i];
    return xy;
  }

  /** One WSOLA grain of the high band, heard from output time g*Hw, nominally from song position q. */
  grain(g, q, vstep, exact) {
    const { Hw, W, tol, gwin } = this;
    let start = q;
    if (!this.freshGrain) {
      const target = this.prevStart + vstep * Hw;
      if (exact) start = target;
      else {
        // Where, within tol of the nominal read, the grain best carries on from the last one,
        // leaning toward the playhead's own position.
        this.highBand(-1, target, vstep, W, this.target);
        this.highBand(-1, q - vstep * tol, vstep, W + 2 * tol, this.region);
        let energy = 1e-12;
        let nominal = 0;
        for (let i = 0; i < W; i += 2) {
          energy += this.target[i] * this.target[i];
          nominal += this.region[tol + i] * this.region[tol + i];
        }
        // A hit arriving in this grain - far louder at the playhead than the grain played before
        // it - is read from where the playhead says. Matched to what came before, it would land
        // early or late by as much as the search reaches: below rate 1 the continuation runs
        // ahead of the playhead and already holds the hit.
        let best = tol;
        if (!(nominal > HIT_RISE * this.prevEnergy)) {
          const pull = (SEARCH_PULL * energy) / tol;
          let bestScore = -NO_ENERGY;
          for (let d = 0; d <= 2 * tol; d += SEARCH_STRIDE) {
            const sc = this.fit(d) - pull * Math.abs(d - tol);
            if (sc > bestScore) { bestScore = sc; best = d; }
          }
          const lo = Math.max(0, best - SEARCH_STRIDE + 1);
          const hi = Math.min(2 * tol, best + SEARCH_STRIDE - 1);
          for (let d = lo; d <= hi; d++) {
            const sc = this.fit(d) - pull * Math.abs(d - tol);
            if (sc > bestScore) { bestScore = sc; best = d; }
          }
        }
        let played = 1e-12;
        for (let i = 0; i < W; i += 2) played += this.region[best + i] * this.region[best + i];
        this.prevEnergy = played;
        start = q + vstep * (best - tol);
      }
    }
    if (this.freshGrain || exact) this.prevEnergy = NO_ENERGY;
    this.freshGrain = false;
    this.prevStart = start;
    const hm = this.highSize - 1;
    const s0 = g * Hw;
    for (let c = 0; c < this.channels; c++) {
      this.highBand(c, start, vstep, W, this.target);
      const high = this.high[c];
      for (let i = 0; i < W; i++) high[(s0 + i) & hm] += this.target[i] * gwin[i];
    }
  }
}

/** How many positions can sound at once: a seek's new one, and the old ones fading under it. */
export const KEYLOCK_VOICES = 3;
/** The longest run process() hands each voice at a time. */
const PLAYER_BLOCK = 128;

/**
 * A keylocked song with seeks that crossfade: each position is its own Keylock, and a seek fades
 * the old ones out under the new one over `fade` samples, linearly - the song reader's crossfade.
 * A start drops whatever was sounding and plays the new position at full level.
 *
 * Every position is held under the ceiling by its own Keylock, so a seek primes only its own
 * lookahead and lands on time; the crossfade's gains sum to at most 1, so the mix stays under the
 * ceiling as well.
 *
 * Seeks closer together than the fade can pile up past KEYLOCK_VOICES; the oldest fading voice
 * then makes room.
 */
export class KeylockPlayer {
  constructor(sampleRate, channels, fade) {
    this.channels = channels;
    this.fade = Math.max(1, fade);
    this.voices = Array.from({ length: KEYLOCK_VOICES }, () => ({ kl: new Keylock(sampleRate, channels), gain: 0, step: 0, live: false, order: 0, dir: 1 }));
    this.scratch = Array.from({ length: channels }, () => new Float64Array(PLAYER_BLOCK));
    this.newest = null;
    this.count = 0;
  }

  setSource(planes, frames, scale = 1, bufRateScale = 1) {
    for (const v of this.voices) v.kl.setSource(planes, frames, scale, bufRateScale);
  }

  /** Whether anything is sounding. */
  get playing() {
    return this.voices.some((v) => v.live);
  }

  /** The newest position's playhead, in song frames. */
  get pos() {
    return this.newest ? this.newest.kl.pos : 0;
  }

  /**
   * Plays `pos` at full level, dropping everything else. `dir` (1 or -1) multiplies the rate this
   * position is played at, from now on: a sampler voice's bounce turns the new position round
   * while the old one fades out the way it was going.
   */
  start(pos, dir = 1) {
    for (const v of this.voices) v.live = false;
    const v = this.voices[0];
    v.kl.seek(pos);
    v.dir = dir;
    v.gain = 1;
    v.step = 0;
    v.live = true;
    v.order = ++this.count;
    this.newest = v;
  }

  /** start(), with every position as if new - so a player reused plays as a new one would. */
  restart(pos, dir = 1) {
    for (const v of this.voices) { v.kl.restart(pos); v.live = false; v.gain = 0; v.step = 0; v.order = 0; v.dir = 1; }
    this.count = 0;
    this.newest = null;
    this.start(pos, dir);
  }

  /** Fades in `pos` over whatever is sounding, which fades out under it; a start if nothing is. */
  seek(pos, dir = 1) {
    if (!this.playing) { this.start(pos, dir); return; }
    let free = null;
    for (const v of this.voices) {
      if (v.live) v.step = -Math.max(v.gain, 1e-6) / this.fade;
      else if (!free) free = v;
    }
    if (!free) for (const v of this.voices) if (!free || v.order < free.order) free = v;
    free.kl.seek(pos);
    free.dir = dir;
    free.gain = 0;
    free.step = 1 / this.fade;
    free.live = true;
    free.order = ++this.count;
    this.newest = free;
  }

  /**
   * `n` samples into `out` (one array per channel) at `rate` (times each position's `dir`), every
   * sounding position mixed, transposed by `pitch` (see Keylock#process).
   */
  process(out, n, rate, pitch = 1) {
    for (let c = 0; c < this.channels; c++) out[c].fill(0, 0, n);
    for (let at = 0; at < n; at += PLAYER_BLOCK) {
      const len = Math.min(PLAYER_BLOCK, n - at);
      for (const v of this.voices) {
        if (!v.live) continue;
        v.kl.process(this.scratch, len, rate * v.dir, pitch);
        let g = v.gain;
        for (let s = 0; s < len; s++) {
          for (let c = 0; c < this.channels; c++) out[c][at + s] += this.scratch[c][s] * g;
          g += v.step;
          if (g >= 1) { g = 1; v.step = 0; } else if (g <= 0 && v.step < 0) { g = 0; v.step = 0; }
        }
        v.gain = g;
        if (g <= 0) v.live = false;
      }
    }
  }
}

/** The crossfade a sampler voice turns a loop's corner with (seconds): the song reader's. */
export const KEYLOCK_VOICE_FADE_SEC = 0.005;

/**
 * A sampler voice's stretch (.stretch(), .fit()/.splice() in "stretch" mode, .stretchmode("clean")):
 * the file read from `pos` at `rate` song seconds per second, transposed by the pitch each block
 * asks for. A one-shot reads on past its window, as the plain sampler voice does - only a release
 * tail is ever out there. A loop turns each corner of lo..hi (frames) as the DJ deck's loop does:
 * the playhead is moved, the position it leaves fading out under the new one over 5 ms. A wrap
 * carries the overshoot over to the other edge; a ping-pong bounce turns the new position round
 * at the edge it reached, while the old one fades out the way it was going. Corners land on their
 * sample, wherever they fall in a block.
 */
export class KeylockVoice {
  constructor(sampleRate, channels) {
    this.channels = channels;
    this.player = new KeylockPlayer(sampleRate, channels, Math.round(KEYLOCK_VOICE_FADE_SEC * sampleRate));
    this.rows = Array.from({ length: channels }, () => new Float64Array(PLAYER_BLOCK));
    this.brs = 1;
    this.speed = 0;
    this.dir = 1;
    this.loop = false;
    this.lo = 0;
    this.hi = 0;
    this.pingpong = false;
  }

  setSource(planes, frames, scale = 1, bufRateScale = 1) {
    this.brs = bufRateScale;
    this.player.setSource(planes, frames, scale, bufRateScale);
  }

  /** The playhead heard, in file frames. */
  get pos() {
    return this.player.pos;
  }

  /**
   * Starts at `pos` (frames) at `rate` (signed song seconds per second); a loop, when `loop` is
   * set, runs round lo..hi (frames, at least one apart) and bounces off its edges with `pingpong`.
   */
  start({ pos, rate, loop = false, lo = 0, hi = 0, pingpong = false }) {
    this.speed = Math.abs(rate);
    this.dir = rate < 0 ? -1 : 1;
    this.loop = !!loop;
    this.lo = lo;
    this.hi = Math.max(lo + 1, hi);
    this.pingpong = !!pingpong;
    // Restarted, so a voice taken from a pool plays exactly as a new one does.
    this.player.restart(this.loop ? Math.min(this.hi, Math.max(this.lo, pos)) : pos, this.dir);
  }

  /** `n` samples into `out` (one array per channel), transposed by `pitch`. */
  process(out, n, pitch = 1) {
    const rows = this.rows;
    for (let at = 0; at < n;) {
      let len = Math.min(PLAYER_BLOCK, n - at);
      if (this.loop) {
        // As far as the next corner, and no further.
        const step = this.speed * this.brs;
        const left = this.dir > 0 ? this.hi - this.player.pos : this.player.pos - this.lo;
        if (step > 0) len = Math.min(len, Math.max(1, Math.ceil(left / step)));
      }
      this.player.process(rows, len, this.speed, pitch);
      for (let c = 0; c < this.channels; c++) {
        const o = out[c];
        const r = rows[c];
        for (let s = 0; s < len; s++) o[at + s] = r[s];
      }
      at += len;
      if (this.loop) this.corner();
    }
  }

  /** Turns the corner the playhead has reached, if it has reached one. */
  corner() {
    const pos = this.player.pos;
    const width = this.hi - this.lo;
    if (this.dir > 0 && pos >= this.hi) {
      const over = (pos - this.hi) % width;
      if (this.pingpong) { this.dir = -1; this.player.seek(this.hi - over, -1); }
      else this.player.seek(this.lo + over, 1);
    } else if (this.dir < 0 && pos <= this.lo) {
      const over = (this.lo - pos) % width;
      if (this.pingpong) { this.dir = 1; this.player.seek(this.lo + over, 1); }
      else this.player.seek(this.hi - over, -1);
    }
  }
}
