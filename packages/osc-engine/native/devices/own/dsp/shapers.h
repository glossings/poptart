// The waveshapers behind the one Distort device.
//
// Translated from web-engine/src/dsp/shapers.mjs. Every curve is a PURE function of one sample,
// which is what lets the device oversample it. The order of the modes is that file's, and an
// index is what a saved song holds - so nothing here is ever reordered.
//
// A mode past the named ones is a curve somebody DREW, which arrives as a table over a message
// port in the browser. There is no path for one on this engine yet, so a drawn mode behaves
// exactly as the browser's does when its table has not arrived: a straight clip.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

enum ShaperMode {
  kSoft = 0, kHard, kFold, kSine, kAsym, kTube, kDiode, kWestcoast, kCheby,
  kRectify, kStairs, kHarmonics, kWrap, kBitflip, kChaos,
};
constexpr int kShaperModes = 15;

/** Which modes put an offset on their output by their own shape. */
inline bool shaperAsymmetric(int mode) {
  switch (mode) {
    case kAsym: case kTube: case kDiode: case kRectify:
    case kHarmonics: case kBitflip: case kChaos: return true;
    default: return mode >= kShaperModes;   // a drawn curve may not pass through zero
  }
}

inline double clamp1(double x) { return x < -1 ? -1 : (x > 1 ? 1 : x); }

/**
 * Triangle wavefolding: past full scale the signal turns round instead of clipping. A triangle
 * of period 4 that is the IDENTITY on -1..1.
 */
inline double foldTriangle(double x) {
  double q = (x + 1) * 0.25;
  q -= std::floor(q);
  return 1 - std::fabs(q * 4 - 2);
}

/** Which harmonic cheby adds at a character: the 2nd at 0.5, the 8th at 1. */
inline int chebyHarmonic(double c) {
  return 1 + static_cast<int>(jsRound(7.0 * std::pow(clamp(c, 0.0, 1.0), 2.5)));
}

/**
 * The whole-number setting a character picks on the curves where it moves in steps - cheby's
 * harmonic, bitflip's mask - or -1 where it moves smoothly. A change in it is a change of curve,
 * and the device crossfades it like one rather than cutting over mid-wave.
 */
inline int characterStep(int mode, double c) {
  const double k = clamp(isPlayable(c) ? c : 0.5, 0.0, 1.0);
  if (mode == kCheby) return chebyHarmonic(k);
  if (mode == kBitflip) return static_cast<int>(jsRound(k * 126));
  return -1;
}

/** Chebyshev polynomial T_n at t, for t in -1..1. */
inline double chebyshev(int n, double t) {
  double a = 1;
  double b = t;
  if (n == 0) return a;
  for (int k = 2; k <= n; ++k) { const double c = 2 * t * b - a; a = b; b = c; }
  return b;
}

/** A soft clip with a knee as hard as `p`: 2 is close to tanh, 8 nearly a straight cut. */
inline double knee(double v, double q) {
  return v / std::pow(1 + std::pow(std::fabs(v), q), 1.0 / q);
}

/** How many stairs a side the staircase has, at full scale. */
constexpr double kStairCount = 4;

/** JavaScript's Math.clz32. */
inline int clz32(unsigned int x) {
  if (x == 0) return 32;
  int n = 0;
  while ((x & 0x80000000u) == 0) { x <<= 1; ++n; }
  return n;
}

/** JavaScript's Math.sign. */
inline double jsSign(double x) { return x > 0 ? 1.0 : (x < 0 ? -1.0 : 0.0); }

/**
 * One sample through one curve.
 *
 * `drive` is a linear gain (the device converts its dB knob before calling), `bias` shifts the
 * input before shaping, `character` is the shared 0..1 knob.
 */
inline double shape(double x, int mode, double drive, double bias, double character) {
  const double c = clamp(isPlayable(character) ? character : 0.5, 0.0, 1.0);
  const double v = x * drive + bias;
  switch (mode) {
    // The workhorse, with a knee as soft or as hard as the character asks: tanh at 0.5, a gentle
    // rational curve at 0, nearly a straight cut at 1.
    case kSoft:
      return c <= 0.5
        ? v / (1 + std::fabs(v)) + (std::tanh(v) - v / (1 + std::fabs(v))) * (c * 2)
        : std::tanh(v) + (knee(v, 8) - std::tanh(v)) * ((c - 0.5) * 2);

    case kHard: return clamp1(v);
    case kFold: return foldTriangle(v);
    case kSine: return std::sin(v * M_PI * 0.5);

    // Soft clipping squashed harder one way than the other, which walks from odd harmonics
    // towards a half-wave's even ones.
    case kAsym:
      return v >= 0 ? std::tanh(v) : std::tanh(v * (1 - 0.8 * c)) * (1 - 0.4 * c);

    // A valve-ish curve: a long shoulder one way and a harder knee the other.
    case kTube:
      return v >= 0 ? 1 - std::exp(-v) : -1 + std::exp(v * (1 - 0.6 * c));

    // One silicon diode one way and a stack the other.
    case kDiode: {
      const double ceiling = v >= 0 ? 1 - 0.76 * c : 1;
      return v / std::pow(1 + std::pow(std::fabs(v) / ceiling, 6), 1.0 / 6.0);
    }

    // Two folds in series; the character is the gain between them, 1 to 2.
    case kWestcoast: {
      const double g = 1 + c;
      return foldTriangle(foldTriangle(v * g) * g + bias * 0.5);
    }

    // One chosen harmonic, less its value at silence - left in, turning the knob across
    // harmonics jumped the output by that much, which a DC blocker passes straight through.
    case kCheby: {
      const int n = chebyHarmonic(c);
      return std::cos(n * std::acos(clamp1(v))) - std::cos(n * M_PI / 2);
    }

    // Rectification, from none through a half-wave to a full-wave.
    case kRectify: {
      const double u = std::tanh(v);
      if (u >= 0) return u;
      return c <= 0.5 ? u * (1 - 2 * c) : -u * (2 * c - 1);
    }

    // A staircase, four stairs a side; the character is the shape of each stair.
    case kStairs: {
      const double t = clamp1(v) * kStairCount;
      const double hard = jsRound(t);
      const double diagonal = hard + (t - hard) * 0.5;
      const double smooth = t - std::sin(2 * M_PI * t) / (2 * M_PI);
      const double y = c <= 0.5 ? smooth + (hard - smooth) * (c * 2)
                                : hard + (diagonal - hard) * ((c - 0.5) * 2);
      return y / kStairCount;
    }

    // A blend of Chebyshev harmonics that the drive walks through, one more per six decibels.
    case kHarmonics: {
      const double t = clamp1(x + bias);
      const double reach = std::log2(std::fmax(1.0, drive));
      const double tilt = 2 - 2 * c;
      double y = t;
      double norm = 1;
      for (int k = 2; k <= 8; ++k) {
        const double w = clamp(reach - (k - 2), 0.0, 1.0) / std::pow(static_cast<double>(k), tilt);
        if (w == 0) break;
        y += w * (chebyshev(k, t) - chebyshev(k, 0));
        // An even term less its value at silence swings twice as far - it counts double.
        norm += k % 2 == 0 ? 2 * w : w;
      }
      return y / norm;
    }

    // Integer overflow: past full scale the signal comes back in from the other side - a tear,
    // not a fold.
    case kWrap: {
      const double edge = 0.5 - 0.49 * c;
      const double m = std::fmod(std::fmod(v + 1, 2.0) + 2.0, 2.0) - 1;
      const double top = 1 - edge;
      if (m >= -top && m <= top) return m;
      const double along = m > 0 ? m - top : m + 2 - top;
      return top - along * (top / edge);
    }

    // The signal's magnitude as seven bits, exclusive-ored with a mask the character sets, but
    // only below its own top bit - so each level is scrambled within its own octave of loudness.
    case kBitflip: {
      const int m = static_cast<int>(jsRound(std::fabs(clamp1(v)) * 127));
      if (m == 0) return 0;
      const int below = (1 << (31 - clz32(static_cast<unsigned int>(m)))) - 1;
      const int mask = static_cast<int>(jsRound(c * 126)) & below;
      return jsSign(v) * (static_cast<double>(m ^ mask) / 127.0);
    }

    // The logistic map, iterated: the saturated signal is the seed, the character the growth rate.
    case kChaos: {
      const double r = 3 + c;
      double u = (std::tanh(v) + 1) / 2;
      for (int k = 0; k < 4; ++k) u = r * u * (1 - u);
      return u * 2 - 1;
    }

    default:
      // A drawn curve with no table, which is every drawn curve here.
      return clamp1(v);
  }
}

/**
 * How much a curve at this setting changes the level, measured rather than derived: the curve is
 * probed with a sine and the ratio of what went in to what came out is the correction. Measured
 * on the part you hear, so the probe's average comes off first.
 */
inline double autoGainFor(int mode, double drive, double bias, double character) {
  constexpr int kProbes = 256;
  const double amplitude = 0.5;
  double ys[kProbes];
  double sum = 0;
  for (int i = 0; i < kProbes; ++i) {
    ys[i] = shape(std::sin((static_cast<double>(i) / kProbes) * M_PI * 2) * amplitude,
                  mode, drive, bias, character);
    sum += ys[i];
  }
  const double mean = sum / kProbes;
  double variance = 0;
  for (int i = 0; i < kProbes; ++i) variance += (ys[i] - mean) * (ys[i] - mean);
  const double out = std::sqrt(variance / kProbes);
  const double inRms = amplitude / M_SQRT2;
  if (!(out > 1e-6)) return 1;
  return clamp(inRms / out, 0.05, 8.0);
}

}  // namespace pd_own
