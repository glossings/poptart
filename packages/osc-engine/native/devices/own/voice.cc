// The Voice effect: a pitch shifter for one voice at a time, by pitch-synchronous overlap-add.
//
// Translated from web-engine/src/devices/voice.mjs, where the method is written out. The pitch
// period is tracked on a four-to-one mono copy of the input (YIN), analysis marks step a period
// at a time and settle on the pulse nearest each step, and every output mark lays down a
// Hann-windowed grain two periods long, cut at the analysis mark nearest to it.

#include <algorithm>
#include <cstdint>

#include "own/pd-own.h"
#include "pd-own-ids.h"

namespace pd_Voice {

namespace ids = pd_ids::Voice;
using namespace pd_own;

/** How late the output is, in seconds - the descriptor's latencySec. */
constexpr double kLatencySec = 0.05;
constexpr int kDecimate = 4;
constexpr int64_t kHop = 256;
constexpr double kYinThreshold = 0.15;
constexpr double kYinVoiced = 0.35;
constexpr double kMaxPitchHz = 1000;
/** The rings at 192 kHz, the highest rate this is sized for. */
constexpr int kCapacity = 65536;
constexpr int kMaxLags = kCapacity / 64;

struct Device : pd_own::Device<ids::kCount> {
  double input[2][kCapacity] = {};
  double acc[2][kCapacity] = {};
  double ds[kCapacity / kDecimate] = {};
  double cm[kMaxLags + 1] = {};
  int64_t delay = 0;
  int64_t maxPeriod = 0;
  int64_t minPeriod = 0;
  int64_t unvoiced = 0;
  int64_t reach = 0;
  int64_t mask = 0;
  int64_t dsMask = 0;
  int64_t lags = 0;
  int64_t n = 0;
  int64_t m = 0;
  double dsSum = 0;
  double period = 0;
  double nextMark = 0;
  double anaMark = 0;
  bool anaStarted = false;

  void pd_init(double sr) {
    sampleRate = sr;
    delay = static_cast<int64_t>(std::floor(kLatencySec * sr + 0.5));
    maxPeriod = delay / 4;
    minPeriod = static_cast<int64_t>(std::ceil(sr / kMaxPitchHz));
    unvoiced = maxPeriod / 2;
    reach = 2 * maxPeriod;
    int64_t size = 1024;
    while (size < 4 * delay + 4 * maxPeriod + 1024) size *= 2;
    if (size > kCapacity) size = kCapacity;
    mask = size - 1;
    dsMask = size / kDecimate - 1;
    lags = maxPeriod / kDecimate;
    if (lags > kMaxLags) lags = kMaxLags;
    reset();
  }

  void reset() {
    std::memset(input, 0, sizeof(input));
    std::memset(acc, 0, sizeof(acc));
    std::memset(ds, 0, sizeof(ds));
    n = 0;
    m = 0;
    dsSum = 0;
    period = static_cast<double>(unvoiced);
    nextMark = 0;
    anaMark = 0;
    anaStarted = false;
  }

  void pd_process(int frames) {
    const double ratio = std::pow(2.0, p[ids::pitch] / 12.0);
    const double formant = std::pow(2.0, p[ids::formant] / 12.0);
    const double g = std::sqrt(formant / ratio);
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      write(inl[i], inr[i]);
      while (nextMark <= static_cast<double>(n + reach)) {
        grain(nextMark, formant);
        nextMark += period / ratio;
      }
      const int64_t k = n & mask;
      outl[i] = static_cast<float>(acc[0][k] * g);
      outr[i] = static_cast<float>(acc[1][k] * g);
      acc[0][k] = 0;
      acc[1][k] = 0;
      n += 1;
    }
    if (frames > 0 && !isPlayable(outl[frames - 1])) reset();
  }

  /** One input frame into the ring, and the pitch tracker's copy. */
  void write(double l, double r) {
    const int64_t k = n & mask;
    input[0][k] = l;
    input[1][k] = r;
    dsSum += (l + r) * 0.5;
    if (n % kDecimate == kDecimate - 1) {
      ds[m & dsMask] = dsSum / kDecimate;
      m += 1;
      dsSum = 0;
    }
    if (n % kHop == kHop - 1) detect();
  }

  /** The pitch period of the latest input, in samples, or the unpitched grain where there is none. */
  void detect() {
    const int64_t L = lags;
    const int64_t W = L;
    const int64_t base = m - 2 * L;
    double energy = 0;
    for (int64_t j = 0; j < 2 * L; ++j) {
      const double v = ds[(base + j) & dsMask];
      energy += v * v;
    }
    if (energy < 1e-8 * 2 * L) {
      period = static_cast<double>(unvoiced);
      return;
    }
    cm[0] = 1;
    double running = 0;
    for (int64_t tau = 1; tau <= L; ++tau) {
      double d = 0;
      for (int64_t j = 0; j < W; ++j) {
        const double diff = ds[(base + j) & dsMask] - ds[(base + j + tau) & dsMask];
        d += diff * diff;
      }
      running += d;
      cm[tau] = running > 0 ? (d * static_cast<double>(tau)) / running : 1;
    }
    const int64_t lo = std::max<int64_t>(2, static_cast<int64_t>(std::floor(static_cast<double>(minPeriod) / kDecimate)));
    int64_t tau = -1;
    for (int64_t t = lo; t <= L; ++t) {
      if (cm[t] < kYinThreshold) {
        while (t + 1 <= L && cm[t + 1] < cm[t]) t += 1;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      int64_t best = lo;
      for (int64_t t = lo + 1; t <= L; ++t) if (cm[t] < cm[best]) best = t;
      if (!(cm[best] < kYinVoiced)) {
        period = static_cast<double>(unvoiced);
        return;
      }
      tau = best;
    }
    // Between lags: the bottom of the parabola through the dip and its neighbors.
    double exact = static_cast<double>(tau);
    if (tau > 1 && tau < L) {
      const double a = cm[tau - 1];
      const double b = cm[tau];
      const double c = cm[tau + 1];
      const double den = a - 2 * b + c;
      if (den > 0) exact = static_cast<double>(tau) + std::max(-1.0, std::min(1.0, (0.5 * (a - c)) / den));
    }
    period = std::max(static_cast<double>(minPeriod), std::min(static_cast<double>(maxPeriod), exact * kDecimate));
  }

  /** The pitch pulse nearest `x0`: the highest point of the input within a quarter period of it. */
  double peak(double x0, double P) {
    const int64_t half = static_cast<int64_t>(std::floor(P / 4));
    const int64_t c = static_cast<int64_t>(std::floor(x0 + 0.5));
    int64_t best = c - half;
    double bestV = -INFINITY;
    for (int64_t i = c - half; i <= c + half; ++i) {
      const int64_t k = i & mask;
      const double v = input[0][k] + input[1][k];
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    return static_cast<double>(best);
  }

  /** One grain, for the output mark `s`, laid into the output ring. */
  void grain(double s, double formant) {
    const double P = period;
    const double target = s - static_cast<double>(delay);
    if (!anaStarted) {
      anaMark = peak(target, P);
      anaStarted = true;
    }
    double next = peak(anaMark + P, P);
    while (next <= target) {
      anaMark = next;
      next = peak(anaMark + P, P);
    }
    const double a = target - anaMark <= next - target ? anaMark : next;
    const double h = P / formant;
    const int64_t from = std::max(static_cast<int64_t>(std::ceil(s - h)), n);
    const int64_t to = static_cast<int64_t>(std::floor(s + h));
    for (int64_t k = from; k <= to; ++k) {
      const double ks = static_cast<double>(k) - s;
      const double w = 0.5 + 0.5 * std::cos((M_PI * ks) / h);
      const double x = a + ks * formant;
      const double fi = std::floor(x);
      const double frac = x - fi;
      const int64_t i0 = static_cast<int64_t>(fi);
      const int64_t j0 = i0 & mask;
      const int64_t j1 = (i0 + 1) & mask;
      const int64_t o = k & mask;
      acc[0][o] += w * (input[0][j0] + (input[0][j1] - input[0][j0]) * frac);
      acc[1][o] += w * (input[1][j0] + (input[1][j1] - input[1][j0]) * frac);
    }
  }
};

}  // namespace pd_Voice

extern "C" PdAny* pd_make_Voice() { return new PdAdapter<pd_Voice::Device>(); }
