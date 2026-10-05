// A biquad, with the cookbook coefficients every equalizer band is made of.
//
// Translated from web-engine/src/dsp/biquad.mjs - the same formulas, the same glide, the same
// transposed direct form II. The figure-drawing half (biquadMagnitude) is not here: a picture is
// the panel's business, and the panel is the browser's.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** The responses a band can take, in panel order. The index is what a descriptor's enum stores. */
enum BiquadType {
  kPeak = 0, kLowShelf, kHighShelf, kLowPass, kHighPass, kBandPass, kNotch, kAllPass,
};

/**
 * Coefficients for one response at `hz`, with `gainDb` (read by the peak and shelf types) and
 * `q`. Five numbers, normalized by a0.
 */
inline void biquadCoefficients(int type, double hz, double gainDb, double q, double sampleRate,
                               double* out) {
  const double f = std::fmin(sampleRate * 0.49, std::fmax(1.0, hz));
  const double w0 = (2.0 * M_PI * f) / sampleRate;
  const double cosw = std::cos(w0);
  const double sinw = std::sin(w0);
  const double Q = std::fmax(0.05, q);
  const double alpha = sinw / (2.0 * Q);
  const double A = std::pow(10.0, gainDb / 40.0);
  double b0, b1, b2, a0, a1, a2;
  switch (type) {
    case kLowPass:
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case kHighPass:
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case kBandPass:
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case kNotch:
      b0 = 1; b1 = -2 * cosw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case kAllPass:
      b0 = 1 - alpha; b1 = -2 * cosw; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case kLowShelf: {
      const double s = 2 * std::sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosw + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
      b2 = A * ((A + 1) - (A - 1) * cosw - s);
      a0 = (A + 1) + (A - 1) * cosw + s;
      a1 = -2 * ((A - 1) + (A + 1) * cosw);
      a2 = (A + 1) + (A - 1) * cosw - s;
      break;
    }
    case kHighShelf: {
      const double s = 2 * std::sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosw + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      b2 = A * ((A + 1) + (A - 1) * cosw - s);
      a0 = (A + 1) - (A - 1) * cosw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cosw);
      a2 = (A + 1) - (A - 1) * cosw - s;
      break;
    }
    default:  // peak, which is also what an index outside the list means
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A;
  }
  out[0] = b0 / a0; out[1] = b1 / a0; out[2] = b2 / a0; out[3] = a1 / a0; out[4] = a2 / a0;
}

/** One biquad section, transposed direct form II, for one channel. */
struct Biquad {
  double c[5] = { 1, 0, 0, 0, 0 };
  // Where the coefficients are HEADING, and how far through the glide they are. A filter that
  // jumped straight to a new set on every block is the zipper noise that turns up wherever a
  // frequency is swept - see glideTo.
  double target[5] = { 1, 0, 0, 0, 0 };
  int steps = 0;
  double z1 = 0;
  double z2 = 0;

  void reset() { z1 = 0; z2 = 0; }

  /** Jumps the coefficients, with no glide: a fresh filter, or one whose settings never move. */
  void set(int type, double hz, double gainDb, double q, double sampleRate) {
    biquadCoefficients(type, hz, gainDb, q, sampleRate, c);
    for (int i = 0; i < 5; ++i) target[i] = c[i];
    steps = 0;
  }

  /**
   * Aims the coefficients at a new setting, to be reached over `steps` samples. THIS IS WHAT
   * STOPS A SWEPT FILTER ZIPPERING: the coefficients are computed once a block and walked there
   * across it, which is inaudible and costs five additions a sample.
   */
  void glideTo(int type, double hz, double gainDb, double q, double sampleRate, int inSteps) {
    biquadCoefficients(type, hz, gainDb, q, sampleRate, target);
    steps = inSteps > 0 ? inSteps : 0;
    if (steps == 0) for (int i = 0; i < 5; ++i) c[i] = target[i];
  }

  /** Takes another section's coefficients and its glide, for the other channel of a pair. */
  void follow(const Biquad& other) {
    for (int i = 0; i < 5; ++i) { c[i] = other.c[i]; target[i] = other.target[i]; }
    steps = other.steps;
  }

  double next(double x) {
    if (steps > 0) {
      const double k = 1.0 / steps;
      for (int i = 0; i < 5; ++i) c[i] += (target[i] - c[i]) * k;
      steps -= 1;
    }
    const double y = c[0] * x + z1;
    z1 = c[1] * x - c[3] * y + z2;
    z2 = c[2] * x - c[4] * y;
    return y;
  }
};

/**
 * A Linkwitz-Riley crossover of fourth order: two Butterworth biquads in cascade each way, so
 * the low and high halves sum back to flat. Used wherever a signal is split into bands.
 */
struct Crossover {
  double sampleRate = 48000.0;
  Biquad lo[2];
  Biquad hi[2];

  void init(double sr) { sampleRate = sr; setFrequency(1000.0, 0); }

  void setFrequency(double hz, int steps = 0) {
    const double q = M_SQRT1_2;
    for (auto& b : lo) b.glideTo(kLowPass, hz, 0, q, sampleRate, steps);
    for (auto& b : hi) b.glideTo(kHighPass, hz, 0, q, sampleRate, steps);
  }

  void follow(const Crossover& other) {
    for (int i = 0; i < 2; ++i) { lo[i].follow(other.lo[i]); hi[i].follow(other.hi[i]); }
  }

  void reset() {
    for (auto& b : lo) b.reset();
    for (auto& b : hi) b.reset();
  }

  /** Splits one sample into its low and high halves. */
  void split(double x, double* out) {
    out[0] = lo[1].next(lo[0].next(x));
    out[1] = hi[1].next(hi[0].next(x));
  }
};

}  // namespace pd_own
