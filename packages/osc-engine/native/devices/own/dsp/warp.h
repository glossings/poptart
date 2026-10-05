// Wavetable warp: a pure phase -> phase function applied before the table is read.
//
// Translated from web-engine/src/dsp/warp.mjs. Two rules every mode keeps: amount 0 is the
// IDENTITY, so a warp amount is an honest modulation depth; and the result stays in 0..1 and
// stays periodic in the input phase, so the oscillator can go on treating one cycle as one cycle.
//
// Nothing here is random at run time - the modes that sound noisy are deterministic functions of
// the phase, so a note sounds the same every time it is played.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** How many phase warps there are, before the cross-modulation modes on the same switch. */
constexpr int kPhaseWarps = 18;

/** What a cross-modulation mode does, and with what. */
enum CrossKind { kCrossNone = 0, kCrossFm, kCrossPm, kCrossRing };
enum CrossSource { kSourceNone = 0, kSourceOsc, kSourceSub, kSourceNoise };

struct CrossMod {
  int kind = kCrossNone;
  int source = kSourceNone;
  bool is() const { return kind != kCrossNone; }
};

/** The cross-modulation modes, in the order they sit on the switch after the phase warps. */
inline CrossMod crossModOf(int mode) {
  static const CrossMod modes[7] = {
    { kCrossFm, kSourceOsc }, { kCrossPm, kSourceOsc },
    { kCrossFm, kSourceSub }, { kCrossPm, kSourceSub },
    { kCrossFm, kSourceNoise }, { kCrossPm, kSourceNoise },
    { kCrossRing, kSourceOsc },
  };
  const int i = mode - kPhaseWarps;
  if (i < 0 || i >= 7) return CrossMod();
  return modes[i];
}

/** The frequency multiple a full-scale modulator swings the carrier by, at a cross-mod amount. */
inline double fmDepth(double amount) {
  const double a = clamp(amount, 0.0, 1.0);
  return 12 * a * a;
}

/** The phase offset, in cycles, a full-scale modulator adds at a cross-mod amount. */
inline double pmDepth(double amount) {
  const double a = clamp(amount, 0.0, 1.0);
  return 4 * a * a;
}

/** Positive fractional part - the sign-keeping remainder wraps phase wrong. */
inline double frac(double x) { return x - std::floor(x); }

/** Blend from the dry phase to a warped one, for the modes with no neutral setting. */
inline double blendPhase(double phase, double warped, double amount) {
  return phase + amount * (warped - phase);
}

/** A deterministic smooth curve of period 1, in -1..1, used by `brownian`. */
inline double wander(double q) {
  return std::sin(2 * M_PI * (q + 0.1237)) * 0.5
       + std::sin(2 * M_PI * (2 * q + 0.6842)) * 0.3
       + std::sin(2 * M_PI * (5 * q + 0.3159)) * 0.2;
}

/** The first primes, for `primes`. */
constexpr int kPrimes[12] = { 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37 };

/** Warps one phase. An unknown mode is the identity rather than an error. */
inline double warpPhase(double phase, double amount, int mode) {
  const double q = frac(phase);
  const double a = clamp(amount, 0.0, 1.0);
  if (a == 0) return q;

  switch (mode) {
    case 1: {  // asym: two straight segments meeting at (b, 0.5)
      const double b = 0.5 * (1 - 0.98 * a);
      return q < b ? (0.5 * q) / b : 0.5 + (0.5 * (q - b)) / (1 - b);
    }
    case 2: {  // mirror: forward then backward inside one cycle
      const double skewed = warpPhase(q, a, 1);
      const double mirrored = skewed < 0.5 ? skewed * 2 : 2 - skewed * 2;
      return blendPhase(q, mirrored, a);
    }
    case 3: return std::pow(q, 1 + 3 * a);          // bend+ : dwell at the start
    case 4: return std::pow(q, 1 / (1 + 3 * a));    // bend- : dwell at the end
    case 5: {  // sync: the phase runs faster and wraps early
      const double ratio = std::pow(16.0, a * a);
      return frac(q * ratio);
    }
    case 6: {  // quantize: the table read at N points instead of continuously
      const double n = std::fmax(2.0, jsRound(std::pow(2.0, 7 - 6 * a)));
      return blendPhase(q, std::floor(q * n) / n, a);
    }
    case 7: {  // fold: the phase runs up and down k times per cycle
      const double k = 1 + 6 * a;
      return blendPhase(q, std::fabs(frac(k * q) - 0.5) * 2, a);
    }
    case 8: {  // flip: all the way up then all the way back down, the turn moving earlier
      const double t = 1 - 0.9 * a;
      if (q < t) return q / t;
      return 1 - (q - t) / (1 - t);
    }
    case 9:    // orbit: a sine ripple added to the phase
      return frac(q + 0.5 * a * std::sin(2 * M_PI * 3 * q));
    case 10: {  // spin: the same ripple, its harmonic ratio climbing with the amount
      const double n = 1 + std::floor(5 * a);
      return frac(q + 0.5 * a * std::sin(2 * M_PI * n * q));
    }
    case 11: {  // chaos: one step of the logistic map, blended in
      const double r = 3.7 + 0.3 * a;
      return blendPhase(q, clamp(r * q * (1 - q), 0.0, 1.0), a);
    }
    case 12: {  // reciprocal: a Moebius curve, monotonic and smooth
      const double k = 4 * a;
      return (q * (1 + k)) / (1 + k * q);
    }
    case 13: {  // sigmoid: an S-curve around the middle of the table
      const double s = 4 * a;
      if (s < 1e-4) return q;
      const double t = std::tanh(s * (2 * q - 1)) / std::tanh(s);
      return 0.5 + 0.5 * t;
    }
    case 14: {  // fractal: three octaves of ripple at once
      const double r = std::sin(2 * M_PI * 2 * q) * 0.5
                     + std::sin(2 * M_PI * 4 * q) * 0.25
                     + std::sin(2 * M_PI * 8 * q) * 0.125;
      return frac(q + 0.35 * a * r);
    }
    case 15:   // brownian: a fixed wandering offset
      return frac(q + 0.35 * a * wander(q));
    case 16: {  // primes: the cycle cut into a prime number of steps, permuted by another
      int index = static_cast<int>(std::floor(a * 12));
      if (index > 11) index = 11;
      const double n = kPrimes[index];
      const double step = std::floor(q * n);
      const double within = q * n - step;
      const double moved = std::fmod(step * 7 + 3, n);
      return blendPhase(q, (moved + within) / n, a);
    }
    case 17: {  // binary: the phase as a 12-bit integer, XORed with a widening mask
      const int scale = 1 << 12;
      int i = static_cast<int>(std::floor(q * scale));
      if (i > scale - 1) i = scale - 1;
      const int mask = static_cast<int>(std::floor(a * (scale - 1)));
      return blendPhase(q, static_cast<double>(i ^ mask) / scale, a);
    }
    default:
      return q;
  }
}

/**
 * How fast the table is being traversed right now, in table-cycles per sample: the number the
 * oscillator needs to pick a band limit. Measured across one real sample step, which also
 * catches the modes with corners, and with a wrap folded back rather than read as a huge jump.
 */
inline double warpSlope(double phase, double increment, double amount, int mode) {
  const double a = warpPhase(phase, amount, mode);
  const double b = warpPhase(phase + increment, amount, mode);
  double d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return std::fabs(d);
}

}  // namespace pd_own
