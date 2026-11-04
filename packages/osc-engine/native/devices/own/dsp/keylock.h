// Keylock: a song read at any rate with its pitch held, for the DJ decks.
//
// Translated from web-engine/src/dsp/keylock.mjs, which explains the method: a phase vocoder on
// the band below 1.9 kHz (decimated by 8, a 256-point frame, phase locking and per-band phase
// resets on hits) and WSOLA on the band above it, the two split complementarily, then a ceiling at
// -0.1 dBFS: the stretcher runs 63 samples ahead of what is heard and a 64-sample lookahead
// limiter takes it back to the moment heard. The reader owns its playhead and reads the song
// itself, so it adds no latency.
//
// The song is read from interleaved float frames (a scsynth buffer), `stride` floats apart; the
// browser reads 16-bit planes, which is the same arithmetic on the same values once scaled.
// native-device-parity.test.mjs holds the two implementations to the same output.
//
// Everything is double, as the JavaScript is, and laid out in the same order. Every buffer is
// allocated by the constructor; process() allocates nothing.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace pd_own {

namespace keylock_detail {

constexpr double kTwoPi = 6.283185307179586;
constexpr int kFrame = 256;
constexpr int kHop = 64;
constexpr double kSplitHz = 1900;
constexpr int kSplitTaps = 16;
constexpr double kGrainSec = 0.01;
constexpr int kSearchStride = 2;
constexpr double kSearchPull = 0.1;
constexpr double kHitRise = 4;
constexpr double kNoEnergy = 1e300;
constexpr int kResetBands = 4;
constexpr double kResetEdgesHz[kResetBands - 1] = { 143, 300, 780 };
constexpr double kResetRise = 2.0;
constexpr double kCeiling = 0.989;
constexpr int kLimitLen = 64;
constexpr int kLimitAhead = kLimitLen - 1;
constexpr double kLimitReleaseSec = 0.06;
constexpr double kLimitSnap = 1e-9;
constexpr int kStretchBlock = 128;

/** JavaScript's Math.round (half up), which std::round is not. */
inline double jsRound(double x) { return std::floor(x + 0.5); }

/** A phase wrapped into [-pi, pi]. */
inline double princarg(double x) { return x - kTwoPi * std::floor(x / kTwoPi + 0.5); }

/** a / b rounded down and up, for b > 0. */
inline int64_t floorDiv(int64_t a, int64_t b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
inline int64_t ceilDiv(int64_t a, int64_t b) { return -floorDiv(-a, b); }

/** Whether a song position is a whole multiple of 2^-16, which the sums of positions hold exactly. */
inline bool onGrid(double p) { const double q = p * 65536; return std::floor(q) == q; }

/** The split filter `h` (2*M + 1 taps) over x[s0..s0 + 2M], each symmetric pair of reads summed first. */
template <typename T>
inline double fir(const double* h, int M, const T* x, int64_t s0) {
  const int64_t s1 = s0 + 2 * M;
  double acc = h[M] * (double)x[s0 + M];
  for (int m = 0; m < M; m++) acc += h[m] * ((double)x[s0 + m] + (double)x[s1 - m]);
  return acc;
}

}  // namespace keylock_detail

/** Decimation for a sample rate: the analysis runs near 5.5-6 kHz whatever the device rate. */
inline int keylockDecimation(double sampleRate) { return sampleRate >= 66000 ? 16 : 8; }

class Keylock {
 public:
  Keylock(double sampleRate, int channels) : sampleRate_(sampleRate), channels_(channels) {
    using namespace keylock_detail;
    const int N = kFrame;
    D = keylockDecimation(sampleRate);
    M = kSplitTaps * D;
    // The split filter: a Blackman-Harris windowed sinc, 2*16*D + 1 taps, unity at DC, and
    // symmetric - each tap past the center is the one as far before it (fir()).
    const int L = 2 * M + 1;
    const double fc = kSplitHz / sampleRate;
    h.assign(L, 0.0);
    for (int k = 0; k <= M; k++) {
      const int m = k - M;
      const double sinc = m == 0 ? 2 * fc : std::sin(kTwoPi * fc * m) / (M_PI * m);
      const double x = (kTwoPi * k) / (L - 1);
      const double w = 0.35875 - 0.48829 * std::cos(x) + 0.14128 * std::cos(2 * x) - 0.01168 * std::cos(3 * x);
      h[k] = sinc * w;
      h[L - 1 - k] = h[k];
    }
    double sum = 0;
    for (int k = 0; k < L; k++) sum += h[k];
    for (int k = 0; k < L; k++) h[k] /= sum;

    Hs = kHop * D;
    Hw = (int)jsRound(kGrainSec * sampleRate);
    W = 2 * Hw;
    tol = Hw >> 1;

    win.assign(N, 0.0);
    for (int i = 0; i < N; i++) win[i] = 0.5 - 0.5 * std::cos((kTwoPi * i) / N);
    gwin.assign(W, 0.0);
    for (int i = 0; i < W; i++) gwin[i] = 0.5 - 0.5 * std::cos((kTwoPi * i) / W);
    twc.assign(N / 2, 0.0);
    tws.assign(N / 2, 0.0);
    for (int k = 0; k < N / 2; k++) { twc[k] = std::cos((kTwoPi * k) / N); tws[k] = -std::sin((kTwoPi * k) / N); }

    bins = N / 2 + 1;
    const double binHz = sampleRate / D / N;
    band.assign(bins, 0);
    for (int b = 0; b < bins; b++) {
      int k = 0;
      while (k < kResetBands - 1 && b * binHz >= kResetEdgesHz[k]) k++;
      band[b] = k;
    }
    re.assign(N, 0.0); im.assign(N, 0.0);
    const size_t perCh = (size_t)channels * bins;
    mag.assign(perCh, 0.0); ph.assign(perCh, 0.0); magPrev.assign(perCh, 0.0);
    cre.assign(perCh, 0.0); cim.assign(perCh, 0.0); pre.assign(perCh, 0.0); pim.assign(perCh, 0.0);
    syn.assign(bins, 0.0);
    dphase.assign(bins, 0.0);
    midPh.assign(bins, 0.0); midPrev.assign(bins, 0.0); midMag.assign(bins, 0.0);
    peakOf.assign(bins, 0);

    frameSpan = N * D + 2 * M + Hs + 1;
    frameView.assign(frameSpan, 0.0);
    // Each channel's decimated frame, and the frame before's: a frame on the same grid of song
    // samples as the one before takes the samples the two share from it.
    dec.assign((size_t)channels * N, 0.0);
    decWas.assign((size_t)channels * N, 0.0);
    dec1.assign(N, 0.0);
    // The high band of each channel at whole song positions, read at the song's own speed, on a
    // fixed grid of decimation: every grain and search region over the same samples shares it.
    hbSize = 1 << (int)std::ceil(std::log2((double)(2 * (W + 2 * tol))));
    hdSize = 1 << (int)std::ceil(std::log2((double)hbSize / D + (4.0 * M) / D + 8));
    hb.assign((size_t)channels * hbSize, 0.0);
    hd.assign((size_t)channels * hdSize, 0.0);
    const int grainSpan = W + 2 * tol + 4 * M + 2 * D + 2;
    grainView.assign(grainSpan, 0.0);
    grainDec.assign((grainSpan + D - 1) / D + 2, 0.0);
    region.assign(W + 2 * tol, 0.0);
    target.assign(W, 0.0);

    lowSize = 1 << (int)std::ceil(std::log2((double)(N * 2) + (4.0 * M) / D + 64));
    low.assign((size_t)channels * lowSize, 0.0);
    highSize = 1 << (int)std::ceil(std::log2((double)(W * 4 + 8192)));
    high.assign((size_t)channels * highSize, 0.0);

    stretched.assign((size_t)channels * (kLimitAhead + kStretchBlock), 0.0);
    for (int c = 0; c < channels && c < 2; c++) stretchedRows[c] = &stretched[(size_t)c * (kLimitAhead + kStretchBlock)];
    ahead.assign((size_t)channels * kLimitLen, 0.0);
    need.assign(kLimitLen, 1.0);
    minG.assign(kLimitLen, 1.0);
    release = 1 - std::exp(-1 / (kLimitReleaseSec * sampleRate));
    seek(0);
  }

  /** The song: interleaved frames, `stride` floats apart, `scale` per sample, at `bufRateScale`. */
  void setSource(const float* data, int64_t frames, int stride, double scale = 1, double bufRateScale = 1) {
    data_ = data;
    frames_ = frames;
    stride_ = stride;
    scale_ = scale;
    brs = bufRateScale;
    decStep = 0;
    hbWin = Window{};
    hdWin = Window{};
  }

  /** As if new: the output clock back to 0 and the playhead at `p`, with nothing sounding. */
  void restart(double p) {
    time = 0;
    head = 0;
    dir = 1;
    seek(p);
  }

  /** Puts the playhead at `p` (song frames); the next output starts there at full level. */
  void seek(double p) {
    using namespace keylock_detail;
    const int N = kFrame;
    pos = p;
    primed = false;
    std::fill(ahead.begin(), ahead.end(), 0.0);
    std::fill(need.begin(), need.end(), 1.0);
    std::fill(minG.begin(), minG.end(), 1.0);
    minSum = kLimitLen;
    limited = 0;
    gain = 1;
    clock = 0;
    std::fill(low.begin(), low.end(), 0.0);
    std::fill(high.begin(), high.end(), 0.0);
    const double firstDec = std::ceil((double)(time - M) / D);
    nextFrame = (int64_t)std::floor(((firstDec - N / 2) * D) / Hs) + 1;
    nextGrain = (int64_t)std::floor((double)(time - W) / Hw) + 1;
    lowDone = (int64_t)firstDec - 1;
    freshFrame = true;
    freshGrain = true;
    prevStart = 0;
    prevEnergy = kNoEnergy;
    stale = true;
  }

  /**
   * `n` samples of each channel into `out[c]`, the playhead moving `rate` song seconds a second,
   * transposed by `pitch`: every frame and grain reads the song `pitch` times faster than the
   * record's own speed. At 1 the record's pitch is held.
   */
  template <typename Sample>
  void process(Sample* const* out, int n, double rate, double pitch = 1) {
    using namespace keylock_detail;
    const double step = rate * brs;
    for (int at = 0; at < n; at += kStretchBlock) {
      const int len = std::min(kStretchBlock, n - at);
      // The stretcher makes what will be heard kLimitAhead samples from now, from where the
      // playhead will be then; its first run after a seek also makes the kLimitAhead before that.
      const int lead = primed ? 0 : kLimitAhead;
      primed = true;
      head = pos + step * (kLimitAhead - lead);
      stretch(stretchedRows, lead + len, rate, pitch);
      for (int s = 0; s < lead + len; s++) {
        const int from = limit(s);
        if (s < lead) continue;
        const double g = gain;
        for (int c = 0; c < channels_; c++) out[c][at + s - lead] = (Sample)(ahead[(size_t)c * kLimitLen + from] * g);
      }
      pos += step * len;
    }
  }

  /** The playhead heard, in song frames. */
  double position() const { return pos; }

 private:
  /**
   * The ceiling, for sample `s` of the stretcher's run: the gain each sample needs, its minimum
   * over the lookahead, box-averaged over the same span, with a 60 ms release. Returns the slot
   * of `ahead` heard now, which `gain` applies to.
   */
  int limit(int s) {
    using namespace keylock_detail;
    const int at = (int)(clock & (kLimitLen - 1));
    double peak = 0;
    for (int c = 0; c < channels_; c++) {
      const double x = stretchedRows[c][s];
      ahead[(size_t)c * kLimitLen + at] = x;
      const double a = std::fabs(x);
      if (a > peak) peak = a;
    }
    need[at] = peak > kCeiling ? kCeiling / peak : 1;
    double mn = 1;
    for (int j = 0; j < kLimitLen; j++) if (need[j] < mn) mn = need[j];
    if (minG[at] < 1) limited--;
    if (mn < 1) limited++;
    // With no window below 1 the sum is exactly kLimitLen again, not that plus rounding.
    minSum = limited ? minSum + (mn - minG[at]) : kLimitLen;
    minG[at] = mn;
    const double avg = minSum / kLimitLen;
    const double g = gain;
    double next = avg < g ? avg : std::min(avg, g + (1 - g) * release);
    if (avg == 1 && next > 1 - kLimitSnap) next = 1;
    gain = next;
    clock++;
    return (int)(clock & (kLimitLen - 1));  // the slot written kLimitAhead samples ago
  }

  /** The stretcher: `n` samples into `out` from its own time and playhead, which it moves on. */
  void stretch(double* const* out, int n, double rate, double pitch) {
    using namespace keylock_detail;
    const int N = kFrame;
    if (rate > 0) dir = 1; else if (rate < 0) dir = -1;
    const double step = rate * brs;
    const double vstep = dir * brs * pitch;
    const int64_t T = time;
    const double P = head;
    const bool exact = rate == 1 && brs == 1 && pitch == 1;

    const int64_t needDec = (int64_t)std::floor((double)(T + n - 1 + M) / D);
    while ((double)nextFrame * Hs <= (double)(needDec + N / 2) * D) {
      frame(nextFrame, P + step * (double)(nextFrame * Hs - T), vstep, exact);
      nextFrame++;
    }
    while (nextGrain * Hw <= T + n - 1) {
      double q = P + step * (double)(nextGrain * Hw + Hw - T) - vstep * Hw;
      if (brs == 1) q = std::floor(q + 0.5);
      grain(nextGrain, q, vstep, exact);
      nextGrain++;
    }
    // The first frames and grains after a seek reach back before it, into slots of the rings
    // nothing will read until they come round again: emptied, or they would be heard then.
    if (stale) {
      stale = false;
      const int64_t firstDec = (int64_t)std::ceil((double)(T - M) / D);
      for (int c = 0; c < channels_; c++) {
        for (int64_t t = T - W; t < T; t++) high[(size_t)c * highSize + (size_t)(t & (highSize - 1))] = 0;
        for (int64_t i = firstDec - N - 1; i < firstDec; i++) low[(size_t)c * lowSize + (size_t)(i & (lowSize - 1))] = 0;
      }
    }

    const int64_t lm = lowSize - 1;
    const int64_t hm = highSize - 1;
    for (int c = 0; c < channels_; c++) {
      double* o = out[c];
      const double* lowC = &low[(size_t)c * lowSize];
      double* highC = &high[(size_t)c * highSize];
      for (int s = 0; s < n; s++) {
        const int64_t t = T + s;
        double y = 0;
        const int64_t i0 = (int64_t)std::ceil((double)(t - M) / D);
        const int64_t i1 = (int64_t)std::floor((double)(t + M) / D);
        for (int64_t i = i0; i <= i1; i++) y += lowC[i & lm] * h[(size_t)(t - i * D + M)];
        o[s] = y * D + highC[t & hm];
        highC[t & hm] = 0;
      }
    }
    const int64_t keepFrom = (int64_t)std::ceil((double)(T + n - M) / D);
    for (int64_t i = lowDone + 1; i < keepFrom; i++)
      for (int c = 0; c < channels_; c++) low[(size_t)c * lowSize + (size_t)(i & lm)] = 0;
    if (keepFrom - 1 > lowDone) lowDone = keepFrom - 1;

    time = T + n;
    head = P + step * n;
  }

  double sample(int c, double p) const {
    const double fi = std::floor(p);
    const double t = p - fi;
    const int64_t i = (int64_t)fi;
    const int64_t n = frames_;
    const float* x = data_ + c;
    const int64_t st = stride_;
    if (t == 0) return i >= 0 && i < n ? (double)x[i * st] * scale_ : 0;
    const double y0 = i - 1 >= 0 && i - 1 < n ? (double)x[(i - 1) * st] : 0;
    const double y1 = i >= 0 && i < n ? (double)x[i * st] : 0;
    const double y2 = i + 1 >= 0 && i + 1 < n ? (double)x[(i + 1) * st] : 0;
    const double y3 = i + 2 >= 0 && i + 2 < n ? (double)x[(i + 2) * st] : 0;
    const double c1 = 0.5 * (y2 - y0);
    const double c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const double c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return (((c3 * t + c2) * t + c1) * t + y1) * scale_;
  }

  void fft(bool inverse) {
    const int n = (int)re.size();
    for (int i = 1, j = 0; i < n; i++) {
      int bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        double t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const double sign = inverse ? -1 : 1;
    for (int len = 2; len <= n; len <<= 1) {
      const int half = len >> 1;
      const int stride = n / len;
      for (int i = 0; i < n; i += len) {
        for (int k = 0; k < half; k++) {
          const double c = twc[k * stride];
          const double s = sign * tws[k * stride];
          const int a = i + k;
          const int b = a + half;
          const double tr = re[b] * c - im[b] * s;
          const double ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (int i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /**
   * Decimated samples j0..j1 of channel `c`'s frame view at song position `p` into `dst`, the
   * view starting `off` samples in - 0 for the frame a hop before, Hs for the frame itself.
   */
  void decimate(int c, double p, double vstep, int off, int j0, int j1, double* dst) {
    using namespace keylock_detail;
    if (j1 <= j0) return;
    const double base = -(double)(kFrame / 2) * D - M - Hs;
    const int s0 = off + j0 * D, e = off + (j1 - 1) * D + 2 * M + 1;
    const double qa = p + vstep * (base + s0), qb = p + vstep * (base + e - 1);
    if (std::min(qa, qb) >= 1 && std::max(qa, qb) < (double)(frames_ - 3)) {
      // Inside the song: sample()'s arithmetic, without its edges.
      const float* x = data_ + c;
      const int64_t st = stride_;
      for (int s = s0; s < e; s++) {
        const double q = p + vstep * (base + s);
        const double fi = std::floor(q);
        const double t = q - fi;
        const int64_t i = (int64_t)fi;
        if (t == 0) { frameView[s] = (double)x[i * st] * scale_; continue; }
        const double y0 = x[(i - 1) * st], y1 = x[i * st], y2 = x[(i + 1) * st], y3 = x[(i + 2) * st];
        const double c1 = 0.5 * (y2 - y0);
        const double c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const double c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        frameView[s] = (((c3 * t + c2) * t + c1) * t + y1) * scale_;
      }
    } else {
      for (int s = s0; s < e; s++) frameView[s] = sample(c, p + vstep * (base + s));
    }
    for (int j = j0; j < j1; j++) dst[j] = fir(h.data(), M, frameView.data(), off + j * D);
  }

  void frame(int64_t k, double p, double vstep, bool exact) {
    using namespace keylock_detail;
    const int N = kFrame;
    const int hop = kHop;
    const bool fresh = freshFrame;
    freshFrame = false;
    // The frame a hop before is read only to follow each bin's frequency and to find hits.
    const bool track = !fresh && !exact;
    // Decimated sample j of the frame is decWas[j + shift] when this frame is read on the grid
    // of song samples the one before was, every read landing on the same song position.
    int64_t shift = 0;
    int jLo = 0, jHi = 0;
    if (decStep == vstep && (vstep == 1 || vstep == -1) && onGrid(p) && onGrid(decAt)) {
      const double d = (p - decAt) * vstep;
      if (std::floor(d) == d && (int64_t)d % D == 0) {
        shift = (int64_t)d / D;
        jLo = (int)std::min<int64_t>(N, std::max<int64_t>(0, -shift));
        jHi = (int)std::max<int64_t>(jLo, std::min<int64_t>(N, N - shift));
      }
    }
    for (int c = 0; c < channels_; c++) {
      double* dc = &dec[(size_t)c * N];
      const double* dw = &decWas[(size_t)c * N];
      // Decimate the frame (which starts a hop into the view), window, transform.
      decimate(c, p, vstep, Hs, 0, jLo, dc);
      decimate(c, p, vstep, Hs, jHi, N, dc);
      for (int j = jLo; j < jHi; j++) dc[j] = dw[j + shift];
      for (int j = 0; j < N; j++) { re[j] = dc[j] * win[j]; im[j] = 0; }
      fft(false);
      double* cr = &cre[(size_t)c * bins];
      double* ci = &cim[(size_t)c * bins];
      double* mg = &mag[(size_t)c * bins];
      double* pc = &ph[(size_t)c * bins];
      for (int b = 0; b < bins; b++) {
        cr[b] = re[b];
        ci[b] = im[b];
        mg[b] = std::sqrt(re[b] * re[b] + im[b] * im[b]);
      }
      for (int b = 0; b < bins; b++) pc[b] = std::atan2(im[b], re[b]);
      if (!track) continue;
      // The frame a hop before, which starts the view: past its first hop it is this frame's
      // own samples, a hop along.
      decimate(c, p, vstep, 0, 0, hop, dec1.data());
      for (int j = hop; j < N; j++) dec1[j] = dc[j - hop];
      for (int j = 0; j < N; j++) { re[j] = dec1[j] * win[j]; im[j] = 0; }
      fft(false);
      double* pr = &pre[(size_t)c * bins];
      double* pi = &pim[(size_t)c * bins];
      double* mp = &magPrev[(size_t)c * bins];
      for (int b = 0; b < bins; b++) {
        pr[b] = re[b];
        pi[b] = im[b];
        mp[b] = std::sqrt(re[b] * re[b] + im[b] * im[b]);
      }
    }
    dec.swap(decWas);
    decAt = p;
    decStep = vstep;
    double now[kResetBands], was[kResetBands];
    bool reset[kResetBands];
    for (int r = 0; r < kResetBands; r++) { now[r] = 0; was[r] = 0; reset[r] = false; }
    if (track) for (int c = 0; c < channels_; c++) {
      const double* mg = &mag[(size_t)c * bins];
      const double* pv = &magPrev[(size_t)c * bins];
      for (int b = 1; b < bins; b++) {
        now[band[b]] += mg[b] * mg[b];
        was[band[b]] += pv[b] * pv[b];
      }
    }
    double total = 0;
    for (int r = 0; r < kResetBands; r++) total += now[r];
    for (int r = 0; r < kResetBands; r++) if (now[r] > kResetRise * was[r] && now[r] > 1e-4 * total + 1e-12) reset[r] = true;
    for (int b = 0; b < bins; b++) {
      double r = 0, i = 0, r2 = 0, i2 = 0;
      for (int c = 0; c < channels_; c++) {
        r += cre[(size_t)c * bins + b]; i += cim[(size_t)c * bins + b];
        r2 += pre[(size_t)c * bins + b]; i2 += pim[(size_t)c * bins + b];
      }
      midMag[b] = std::sqrt(r * r + i * i);
      midPh[b] = std::atan2(i, r);
      if (track) midPrev[b] = std::atan2(i2, r2);
    }
    if (fresh || exact) {
      for (int b = 0; b < bins; b++) syn[b] = midPh[b];
    } else {
      for (int b = 0; b < bins; b++) {
        const double w = ((kTwoPi * b) / N) * hop;
        dphase[b] = w + princarg(midPh[b] - midPrev[b] - w);
      }
      int last = -1;
      for (int b = 0; b < bins; b++) {
        const bool isPeak = (b == 0 || midMag[b] > midMag[b - 1]) && (b == bins - 1 || midMag[b] >= midMag[b + 1]);
        if (isPeak) {
          if (last < 0) for (int q = 0; q < b; q++) peakOf[q] = b;
          else for (int q = last + 1; q < b; q++) peakOf[q] = q - last <= b - q ? last : b;
          peakOf[b] = b;
          last = b;
        }
      }
      if (last < 0) last = 0;
      for (int q = last + 1; q < bins; q++) peakOf[q] = last;
      for (int b = 0; b < bins; b++) if (peakOf[b] == b) syn[b] += dphase[b];
      for (int b = 0; b < bins; b++) {
        const int pk = peakOf[b];
        if (pk != b) syn[b] = syn[pk] + midPh[b] - midPh[pk];
      }
      for (int b = 0; b < bins; b++) if (reset[band[b]]) syn[b] = midPh[b];
      for (int b = 0; b < bins; b++) syn[b] = princarg(syn[b]);
    }
    const int64_t lm = lowSize - 1;
    const int64_t start = k * hop - N / 2;
    for (int c = 0; c < channels_; c++) {
      const double* mg = &mag[(size_t)c * bins];
      const double* pc = &ph[(size_t)c * bins];
      for (int b = 0; b < bins; b++) {
        const double th = pc[b] + syn[b] - midPh[b];
        re[b] = mg[b] * std::cos(th);
        im[b] = mg[b] * std::sin(th);
      }
      for (int b = 1; b < N / 2; b++) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      im[0] = 0; im[N / 2] = 0;
      fft(true);
      double* lowC = &low[(size_t)c * lowSize];
      for (int j = 0; j < N; j++) lowC[(start + j) & lm] += (re[j] * win[j]) / 1.5;
    }
  }

  /** A span of song positions, or of decimated samples, that a ring holds: lo..hi-1. */
  struct Window {
    int64_t lo = 0, hi = 0;
  };

  /**
   * Makes `w` hold a..b-1, a span no longer than its ring, `R`: a window it overlaps or touches
   * grows by what it lacks, giving up its far end past R; any other is read afresh. `high` picks
   * the high band's window or its decimation's.
   */
  void cover(Window& w, int64_t a, int64_t b, int64_t R, bool high) {
    if (w.hi > w.lo && a >= w.lo && b <= w.hi) return;
    if (w.hi > w.lo && b >= w.lo && a <= w.hi) {
      int64_t lo = std::min(a, w.lo), hi = std::max(b, w.hi);
      if (hi - lo > R) { if (a < w.lo) hi = lo + R; else lo = hi - R; }
      if (lo < w.lo) fill(lo, w.lo, high);
      if (hi > w.hi) fill(w.hi, hi, high);
      w.lo = lo; w.hi = hi;
    } else {
      fill(a, b, high);
      w.lo = a; w.hi = b;
    }
  }

  /**
   * Fills the high band's ring at song positions x0..x1-1 (`high`), or its decimation's at
   * decimated samples x0..x1-1: the song low-passed at position i*D, on a grid fixed to the song.
   */
  void fill(int64_t x0, int64_t x1, bool high) {
    using namespace keylock_detail;
    const double* hp = h.data();
    if (high) {
      cover(hdWin, ceilDiv(x0 - M, D), floorDiv(x1 - 1 + M, D) + 1, hdSize, false);
      const int64_t bm = hbSize - 1, dm = hdSize - 1;
      for (int c = 0; c < channels_; c++) {
        double* hbC = &hb[(size_t)c * hbSize];
        const double* hdC = &hd[(size_t)c * hdSize];
        for (int64_t x = x0; x < x1; x++) {
          double y = 0;
          const int64_t i1 = floorDiv(x + M, D);
          for (int64_t i = ceilDiv(x - M, D); i <= i1; i++) y += hdC[i & dm] * hp[x - i * D + M];
          hbC[x & bm] = sample(c, (double)x) - y * D;
        }
      }
      return;
    }
    const int64_t dm = hdSize - 1;
    for (int c = 0; c < channels_; c++) {
      double* hdC = &hd[(size_t)c * hdSize];
      const float* src = data_ + c;
      for (int64_t i = x0; i < x1; i++) {
        const int64_t k0 = i * D - M;
        double acc;
        if (k0 >= 0 && k0 + 2 * M < frames_) {
          if (stride_ == 1) acc = fir(hp, M, src, k0) * scale_;
          else {
            const int64_t st = stride_;
            const int64_t k1 = k0 + 2 * M;
            acc = hp[M] * (double)src[(k0 + M) * st];
            for (int m = 0; m < M; m++) acc += hp[m] * ((double)src[(k0 + m) * st] + (double)src[(k1 - m) * st]);
            acc *= scale_;
          }
        } else {
          const int64_t k1 = k0 + 2 * M;
          acc = hp[M] * sample(c, (double)(k0 + M));
          for (int m = 0; m < M; m++) acc += hp[m] * (sample(c, (double)(k0 + m)) + sample(c, (double)(k1 - m)));
        }
        hdC[i & dm] = acc;
      }
    }
  }

  void highBand(int c, double p, double vstep, int len, double* dst) {
    // Read at the song's own speed from a whole sample, the band is the shared one's.
    if (std::floor(p) == p && (vstep == 1 || vstep == -1)) {
      const int64_t ip = (int64_t)p;
      const int64_t a = vstep > 0 ? ip : ip - (len - 1);
      cover(hbWin, a, a + len, hbSize, true);
      const int64_t bm = hbSize - 1;
      const int64_t v = vstep > 0 ? 1 : -1;
      if (c >= 0) {
        const double* hbC = &hb[(size_t)c * hbSize];
        for (int s = 0; s < len; s++) dst[s] = hbC[(ip + v * s) & bm];
      } else {
        for (int s = 0; s < len; s++) {
          const int64_t x = (ip + v * s) & bm;
          double sum = 0;
          for (int ch = 0; ch < channels_; ch++) sum += hb[(size_t)ch * hbSize + x];
          dst[s] = sum;
        }
      }
      return;
    }
    const int pad = 2 * M + D;
    // Decimate on a grid of D from the span's start, restore, subtract: the decimated samples the
    // band over [pad, pad + len) is restored from, iFirst..iLast, and only the reads under them.
    const int iFirst = (int)keylock_detail::ceilDiv(pad - M, D);
    const int iLast = (int)keylock_detail::floorDiv(pad + len - 1 + M, D);
    for (int s = iFirst * D - M, e = iLast * D + M; s <= e; s++) {
      const double q = p + vstep * (s - pad);
      if (c >= 0) grainView[s] = sample(c, q);
      else {
        double v = 0;
        for (int ch = 0; ch < channels_; ch++) v += sample(ch, q);
        grainView[s] = v;
      }
    }
    for (int i = iFirst; i <= iLast; i++) grainDec[i] = keylock_detail::fir(h.data(), M, grainView.data(), i * D - M);
    for (int s = 0; s < len; s++) {
      const int t = s + pad;
      double y = 0;
      const int i1 = (int)keylock_detail::floorDiv(t + M, D);
      for (int i = (int)keylock_detail::ceilDiv(t - M, D); i <= i1; i++) y += grainDec[i] * h[t - i * D + M];
      dst[s] = grainView[t] - y * D;
    }
  }

  double fit(int d) const {
    double xy = 0;
    for (int i = 0; i < W; i += 2) xy += target[i] * region[d + i] * gwin[i];
    return xy;
  }

  void grain(int64_t g, double q, double vstep, bool exact) {
    using namespace keylock_detail;
    double start = q;
    if (!freshGrain) {
      const double tgt = prevStart + vstep * Hw;
      if (exact) start = tgt;
      else {
        highBand(-1, tgt, vstep, W, target.data());
        highBand(-1, q - vstep * tol, vstep, W + 2 * tol, region.data());
        double energy = 1e-12;
        double nominal = 0;
        for (int i = 0; i < W; i += 2) {
          energy += target[i] * target[i];
          nominal += region[tol + i] * region[tol + i];
        }
        int best = tol;
        if (!(nominal > kHitRise * prevEnergy)) {
          const double pull = (kSearchPull * energy) / tol;
          double bestScore = -kNoEnergy;
          for (int d = 0; d <= 2 * tol; d += kSearchStride) {
            const double sc = fit(d) - pull * std::abs(d - tol);
            if (sc > bestScore) { bestScore = sc; best = d; }
          }
          const int lo = std::max(0, best - kSearchStride + 1);
          const int hi = std::min(2 * tol, best + kSearchStride - 1);
          for (int d = lo; d <= hi; d++) {
            const double sc = fit(d) - pull * std::abs(d - tol);
            if (sc > bestScore) { bestScore = sc; best = d; }
          }
        }
        double played = 1e-12;
        for (int i = 0; i < W; i += 2) played += region[best + i] * region[best + i];
        prevEnergy = played;
        start = q + vstep * (best - tol);
      }
    }
    if (freshGrain || exact) prevEnergy = kNoEnergy;
    freshGrain = false;
    prevStart = start;
    const int64_t hm = highSize - 1;
    const int64_t s0 = g * Hw;
    for (int c = 0; c < channels_; c++) {
      highBand(c, start, vstep, W, target.data());
      double* highC = &high[(size_t)c * highSize];
      for (int i = 0; i < W; i++) highC[(s0 + i) & hm] += target[i] * gwin[i];
    }
  }

  double sampleRate_;
  int channels_;
  int D = 8, M = 0, Hs = 0, Hw = 0, W = 0, tol = 0, bins = 0;
  std::vector<double> h, win, gwin, twc, tws;
  std::vector<int> band, peakOf;
  std::vector<double> re, im, mag, ph, magPrev, cre, cim, pre, pim;
  std::vector<double> syn, dphase, midPh, midPrev, midMag;
  int frameSpan = 0;
  std::vector<double> frameView, grainView, grainDec, region, target;
  std::vector<double> dec, decWas, dec1;
  double decAt = 0;    // the song position the frame before was read from
  double decStep = 0;  // and the read's step (0: no frame to share with)
  int64_t hbSize = 0, hdSize = 0;
  std::vector<double> hb, hd;
  Window hbWin, hdWin;
  int64_t lowSize = 0, highSize = 0;
  std::vector<double> low, high;

  const float* data_ = nullptr;
  int64_t frames_ = 0;
  int stride_ = 1;
  double scale_ = 1;
  double brs = 1;
  int64_t time = 0;   // the stretcher's output samples so far
  double head = 0;    // the stretcher's playhead at `time`
  double pos = 0;     // the playhead heard
  std::vector<double> stretched, ahead, need, minG;
  double* stretchedRows[2] = { nullptr, nullptr };
  double minSum = keylock_detail::kLimitLen;
  int limited = 0;
  double gain = 1, release = 0;
  int64_t clock = 0;
  bool primed = false;
  int dir = 1;
  int64_t nextFrame = 0, nextGrain = 0, lowDone = 0;
  bool freshFrame = true, freshGrain = true, stale = true;
  double prevStart = 0;
  double prevEnergy = keylock_detail::kNoEnergy;
};

/** How many positions can sound at once: a seek's new one, and the old ones fading under it. */
constexpr int kKeylockVoices = 3;

/**
 * A keylocked song with seeks that crossfade (keylock.mjs's KeylockPlayer): each position is its
 * own Keylock, and a seek fades the old ones out under the new one over `fade` samples, linearly.
 * A start drops whatever was sounding and plays the new position at full level. Every position
 * is held under the ceiling by its own Keylock; the crossfade's gains sum to at most 1, so the mix
 * stays under it too.
 */
class KeylockPlayer {
 public:
  static constexpr int kBlock = 128;

  KeylockPlayer(double sampleRate, int channels, int fade)
      : channels_(channels), fade_(std::max(1, fade)) {
    voices_.reserve(kKeylockVoices);
    for (int i = 0; i < kKeylockVoices; i++) voices_.emplace_back(sampleRate, channels);
    scratch_.assign((size_t)channels * kBlock, 0.0);
    for (int c = 0; c < channels; c++) rows_[c] = &scratch_[(size_t)c * kBlock];
  }

  void setSource(const float* data, int64_t frames, int stride, double scale = 1, double bufRateScale = 1) {
    for (auto& v : voices_) v.kl.setSource(data, frames, stride, scale, bufRateScale);
  }

  bool playing() const {
    for (const auto& v : voices_) if (v.live) return true;
    return false;
  }

  /** The newest position's playhead, in song frames. */
  double pos() const { return newest_ >= 0 ? voices_[newest_].kl.position() : 0; }

  /** `dir` (1 or -1) multiplies the rate this position is played at, from now on. */
  void start(double p, int dir = 1) {
    for (auto& v : voices_) v.live = false;
    Voice& v = voices_[0];
    v.kl.seek(p);
    v.dir = dir;
    v.gain = 1;
    v.step = 0;
    v.live = true;
    v.order = ++count_;
    newest_ = 0;
  }

  /** start(), with every position as if new - so a player reused plays as a new one would. */
  void restart(double p, int dir = 1) {
    for (auto& v : voices_) { v.kl.restart(p); v.live = false; v.gain = 0; v.step = 0; v.order = 0; v.dir = 1; }
    count_ = 0;
    newest_ = -1;
    start(p, dir);
  }

  void seek(double p, int dir = 1) {
    if (!playing()) { start(p, dir); return; }
    int free = -1;
    for (int i = 0; i < kKeylockVoices; i++) {
      Voice& v = voices_[i];
      if (v.live) v.step = -std::max(v.gain, 1e-6) / fade_;
      else if (free < 0) free = i;
    }
    if (free < 0) for (int i = 0; i < kKeylockVoices; i++) if (free < 0 || voices_[i].order < voices_[free].order) free = i;
    Voice& v = voices_[free];
    v.kl.seek(p);
    v.dir = dir;
    v.gain = 0;
    v.step = 1.0 / fade_;
    v.live = true;
    v.order = ++count_;
    newest_ = free;
  }

  /** `rate` times each position's `dir`, transposed by `pitch` (see Keylock::process). */
  template <typename Sample>
  void process(Sample* const* out, int n, double rate, double pitch = 1) {
    for (int c = 0; c < channels_; c++) for (int s = 0; s < n; s++) out[c][s] = 0;
    for (int at = 0; at < n; at += kBlock) {
      const int len = std::min(kBlock, n - at);
      for (auto& v : voices_) {
        if (!v.live) continue;
        v.kl.process(rows_, len, rate * v.dir, pitch);
        double g = v.gain;
        for (int s = 0; s < len; s++) {
          for (int c = 0; c < channels_; c++) out[c][at + s] = (Sample)((double)out[c][at + s] + rows_[c][s] * g);
          g += v.step;
          if (g >= 1) { g = 1; v.step = 0; } else if (g <= 0 && v.step < 0) { g = 0; v.step = 0; }
        }
        v.gain = g;
        if (g <= 0) v.live = false;
      }
    }
  }

 private:
  struct Voice {
    Voice(double sampleRate, int channels) : kl(sampleRate, channels) {}
    Keylock kl;
    double gain = 0, step = 0;
    bool live = false;
    int64_t order = 0;
    int dir = 1;
  };
  int channels_;
  int fade_;
  std::vector<Voice> voices_;
  std::vector<double> scratch_;
  double* rows_[2] = { nullptr, nullptr };
  int newest_ = -1;
  int64_t count_ = 0;
};


/** The crossfade a sampler voice turns a loop's corner with (seconds): the song reader's. */
constexpr double kKeylockVoiceFadeSec = 0.005;

/**
 * A sampler voice's stretch (keylock.mjs's KeylockVoice): the file read from a position at a rate,
 * transposed by the pitch each block asks for. A one-shot reads on past its window; a loop turns
 * each corner of lo..hi as the DJ deck's loop does, crossfading the position it leaves out under
 * the new one, wrapping with the overshoot carried over or, ping-pong, bouncing the new position
 * round at the edge. Corners land on their sample, wherever they fall in a block.
 */
class KeylockVoice {
 public:
  KeylockVoice(double sampleRate, int channels)
      : channels_(channels),
        player_(sampleRate, channels, (int)keylock_detail::jsRound(kKeylockVoiceFadeSec * sampleRate)) {}

  void setSource(const float* data, int64_t frames, int stride, double scale = 1, double bufRateScale = 1) {
    brs_ = bufRateScale;
    player_.setSource(data, frames, stride, scale, bufRateScale);
  }

  /** The playhead heard, in file frames. */
  double pos() const { return player_.pos(); }

  /** Starts at `p` (frames) at `rate`; a loop runs round lo..hi (at least a frame apart). */
  void start(double p, double rate, bool loop = false, double lo = 0, double hi = 0, bool pingpong = false) {
    speed_ = std::fabs(rate);
    dir_ = rate < 0 ? -1 : 1;
    loop_ = loop;
    lo_ = lo;
    hi_ = std::max(lo + 1, hi);
    pingpong_ = pingpong;
    // Restarted, so a voice taken from a pool plays exactly as a new one does.
    player_.restart(loop_ ? std::min(hi_, std::max(lo_, p)) : p, dir_);
  }

  template <typename Sample>
  void process(Sample* const* out, int n, double pitch = 1) {
    constexpr int kBlock = KeylockPlayer::kBlock;
    for (int at = 0; at < n;) {
      int len = std::min(kBlock, n - at);
      if (loop_) {
        const double step = speed_ * brs_;
        const double left = dir_ > 0 ? hi_ - player_.pos() : player_.pos() - lo_;
        if (step > 0) len = (int)std::min((double)len, std::max(1.0, std::ceil(left / step)));
      }
      Sample* rows[2] = { out[0] + at, channels_ > 1 ? out[1] + at : nullptr };
      player_.process(rows, len, speed_, pitch);
      at += len;
      if (loop_) corner();
    }
  }

 private:
  void corner() {
    const double p = player_.pos();
    const double width = hi_ - lo_;
    if (dir_ > 0 && p >= hi_) {
      const double over = std::fmod(p - hi_, width);
      if (pingpong_) { dir_ = -1; player_.seek(hi_ - over, -1); }
      else player_.seek(lo_ + over, 1);
    } else if (dir_ < 0 && p <= lo_) {
      const double over = std::fmod(lo_ - p, width);
      if (pingpong_) { dir_ = 1; player_.seek(lo_ + over, 1); }
      else player_.seek(hi_ - over, -1);
    }
  }

  int channels_;
  KeylockPlayer player_;
  double brs_ = 1, speed_ = 0, lo_ = 0, hi_ = 0;
  int dir_ = 1;
  bool loop_ = false, pingpong_ = false;
};

}  // namespace pd_own
