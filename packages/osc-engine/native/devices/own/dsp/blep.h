// Band-limited steps, for any signal whose edges are jumps at known times.
//
// Translated from web-engine/src/dsp/blep.mjs, which says what it is and why. A jump is drawn as
// the integral of a Kaiser-windowed sinc at its exact fractional time, as a correction either side
// of the plain jump; the output is kBlepHalf samples late.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** Samples either side of a jump that its correction reaches. The output is this late. */
constexpr int kBlepHalf = 16;
/** Table points per sample, read with linear interpolation. */
constexpr int kBlepPhases = 128;
/** The Kaiser window's shape: about 80 dB of stopband. */
constexpr double kBlepBeta = 7.86;
constexpr int kBlepPoints = 2 * kBlepHalf * kBlepPhases + 1;
/** The latest a jump can be placed before the sample it is pushed with (blep.mjs's BLEP_LAST). */
constexpr double kBlepLast = 1 - 1e-9;
constexpr int kBlepRing = 64;
constexpr int kBlepMask = kBlepRing - 1;

/** The zeroth-order modified Bessel function, by its series. */
inline double besselI0(double x) {
  double sum = 1;
  double term = 1;
  const double q = (x * x) / 4;
  for (int k = 1; k < 32; ++k) {
    term *= q / (static_cast<double>(k) * k);
    sum += term;
  }
  return sum;
}

/** The windowed sinc, and the band-limited unit step that is its running integral. Built once. */
struct BlepTables {
  double kernelTable[kBlepPoints];
  double step[kBlepPoints];
  /** The band-limited ramp less the plain one, in samples (blep.mjs's ramp). */
  double ramp[kBlepPoints];

  /** The windowed sinc at table point `i`. */
  static double kernel(int i) {
    const double x = static_cast<double>(i) / kBlepPhases - kBlepHalf;
    const double r = x / kBlepHalf;
    const double w = besselI0(kBlepBeta * std::sqrt(std::fmax(0.0, 1 - r * r))) / besselI0(kBlepBeta);
    const double sinc = x == 0 ? 1.0 : std::sin(M_PI * x) / (M_PI * x);
    return sinc * w;
  }

  BlepTables() {
    const int n = kBlepPoints - 1;
    for (int i = 0; i <= n; ++i) kernelTable[i] = kernel(i);
    // By trapezoids, scaled to end at exactly one.
    step[0] = 0;
    for (int i = 1; i <= n; ++i) step[i] = step[i - 1] + (kernelTable[i - 1] + kernelTable[i]) * 0.5;
    const double total = step[n];
    for (int i = 0; i <= n; ++i) step[i] /= total;
    ramp[0] = 0;
    double area = 0;
    for (int i = 1; i <= n; ++i) {
      area += (step[i - 1] + step[i]) * (0.5 / kBlepPhases);
      const double x = static_cast<double>(i) / kBlepPhases - kBlepHalf;
      ramp[i] = area - (x > 0 ? x : 0);
    }
  }
};

/** The shared tables: built the first time a device is made, which is off the audio thread. */
inline const BlepTables& blepTables() {
  static const BlepTables tables;
  return tables;
}

/** A signal's band-limited output, kBlepHalf samples late (blep.mjs's BlepLine). */
struct BlepLine {
  const double* table = blepTables().step;
  const double* rampTable = blepTables().ramp;
  double ring[kBlepRing] = { 0 };
  long long n = 0;

  void reset() {
    for (double& v : ring) v = 0;
    n = 0;
  }

  /** A corner: the slope changes by `change` per sample, `ago` samples before the next push. */
  void kink(double ago, double change) {
    if (!(ago < kBlepLast)) ago = kBlepLast;
    else if (!(ago > 0)) ago = 0;
    for (int k = -kBlepHalf; k < kBlepHalf; ++k) {
      const double x = (k + ago + kBlepHalf) * kBlepPhases;
      const int i = static_cast<int>(std::floor(x));
      const double a = rampTable[i];
      ring[(n + k) & kBlepMask] += change * (a + (rampTable[i + 1] - a) * (x - i));
    }
  }

  /** A jump of `height`, `ago` samples before the sample about to be pushed. */
  void jump(double ago, double height) {
    if (!(ago < kBlepLast)) ago = kBlepLast;
    else if (!(ago > 0)) ago = 0;
    for (int k = -kBlepHalf; k < kBlepHalf; ++k) {
      const double x = (k + ago + kBlepHalf) * kBlepPhases;
      const int i = static_cast<int>(std::floor(x));
      const double a = table[i];
      const double s = a + (table[i + 1] - a) * (x - i);
      ring[(n + k) & kBlepMask] += height * (k >= 0 ? s - 1 : s);
    }
  }

  /** The plain signal at this sample in; the band-limited one, kBlepHalf samples ago, out. */
  double push(double value) {
    ring[n & kBlepMask] += value;
    const long long at = (n - kBlepHalf) & kBlepMask;
    const double out = ring[at];
    ring[at] = 0;
    n += 1;
    return out;
  }
};

/** A signal's recent past, read between its samples (blep.mjs's HistoryLine). */
struct HistoryLine {
  const double* kernel = blepTables().kernelTable;
  double ring[kBlepRing] = { 0 };
  long long n = 0;

  void reset() {
    for (double& v : ring) v = 0;
    n = 0;
  }

  void push(double x) {
    ring[n & kBlepMask] = x;
    n += 1;
  }

  /** The sample `delay` whole samples before the newest. */
  double at(int delay) const { return ring[(n - 1 - delay) & kBlepMask]; }

  /** The signal kBlepHalf + ago samples before the newest, 0 <= ago < 1. */
  double read(double ago) const {
    const long long newest = n - 1;
    double sum = 0;
    double weight = 0;
    for (int k = -kBlepHalf; k < kBlepHalf; ++k) {
      const double x = (kBlepHalf - ago - k) * kBlepPhases;
      const int i = static_cast<int>(std::floor(x));
      const double a = kernel[i];
      const double h = a + (kernel[i + 1 <= 2 * kBlepHalf * kBlepPhases ? i + 1 : i] - a) * (x - i);
      sum += ring[(newest - kBlepHalf + k) & kBlepMask] * h;
      weight += h;
    }
    return sum / weight;
  }
};

}  // namespace pd_own
