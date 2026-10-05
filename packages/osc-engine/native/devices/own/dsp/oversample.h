// Oversampling for the waveshapers.
//
// Translated from web-engine/src/dsp/oversample.mjs: a windowed-sinc half-band filter, run as
// polyphase branches, in one or two 2x stages. At 1x the curve is called straight through and
// this whole file is bypassed, which is what keeps the cheap setting cheap.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

constexpr int kTaps = 32;
constexpr int kHalfTaps = kTaps / 2;

/**
 * A windowed-sinc half-band lowpass, cutting at a quarter of the oversampled rate - which is
 * exactly the Nyquist rate of the signal underneath.
 *
 * Computed once, the first time one is asked for: the numbers are the same for every instance
 * and every sample rate, and a table built at startup in a server is a table built on the audio
 * thread the first time a device opens otherwise.
 */
inline const double* halfBandTaps() {
  static double taps[kTaps];
  static bool ready = false;
  if (!ready) {
    const double middle = (kTaps - 1) / 2.0;
    double sum = 0;
    for (int i = 0; i < kTaps; ++i) {
      const double n = i - middle;
      // sinc at a cutoff of a quarter of the sample rate
      const double sinc = n == 0 ? 0.5 : std::sin(M_PI * 0.5 * n) / (M_PI * n);
      // Blackman window - the stopband matters more here than the transition width
      const double w = 0.42 - 0.5 * std::cos((2 * M_PI * i) / (kTaps - 1))
          + 0.08 * std::cos((4 * M_PI * i) / (kTaps - 1));
      taps[i] = sinc * w;
      sum += taps[i];
    }
    for (int i = 0; i < kTaps; ++i) taps[i] /= sum;
    ready = true;
  }
  return taps;
}

/**
 * One 2x stage: `up` writes two samples for every one in, `down` reads two and returns one.
 *
 * Both directions run as POLYPHASE branches - the filter split into its even and odd taps - so
 * neither pays for multiplying by the zeros that zero-stuffing would otherwise insert.
 */
struct Stage2x {
  double even[kHalfTaps];
  double odd[kHalfTaps];
  double upLine[kHalfTaps] = { 0 };
  double downEven[kHalfTaps] = { 0 };
  double downOdd[kHalfTaps] = { 0 };

  Stage2x() {
    const double* taps = halfBandTaps();
    for (int k = 0; k < kHalfTaps; ++k) {
      // Gain of two on the way up, to make back what zero-stuffing halves.
      even[k] = taps[2 * k] * 2;
      odd[k] = taps[2 * k + 1] * 2;
    }
  }

  void reset() {
    for (int k = 0; k < kHalfTaps; ++k) { upLine[k] = 0; downEven[k] = 0; downOdd[k] = 0; }
  }

  /** Writes `count * 2` samples into `out` from `count` samples of `input`. */
  void up(const double* input, double* out, int count) {
    for (int i = 0; i < count; ++i) {
      // Shift in. The lines are short enough that moving them beats a ring buffer's wrapped
      // indexing in the inner loop.
      for (int k = kHalfTaps - 1; k > 0; --k) upLine[k] = upLine[k - 1];
      upLine[0] = input[i];
      double a = 0;
      double b = 0;
      for (int k = 0; k < kHalfTaps; ++k) {
        a += even[k] * upLine[k];
        b += odd[k] * upLine[k];
      }
      out[i * 2] = a;
      out[i * 2 + 1] = b;
    }
  }

  /** Reads `count * 2` samples from `input` and writes `count` samples into `out`. */
  void down(const double* input, double* out, int count) {
    for (int i = 0; i < count; ++i) {
      for (int k = kHalfTaps - 1; k > 0; --k) { downEven[k] = downEven[k - 1]; downOdd[k] = downOdd[k - 1]; }
      downEven[0] = input[i * 2];
      downOdd[0] = input[i * 2 + 1];
      double acc = 0;
      for (int k = 0; k < kHalfTaps; ++k) acc += even[k] * downEven[k] + odd[k] * downOdd[k];
      // The gain of two belongs to the upsampler only; undo it here.
      out[i] = acc * 0.5;
    }
  }
};

/**
 * A 1x, 2x or 4x oversampled section, over at most `kBlock` input frames.
 *
 * `Curve` is anything callable as `(double value, int index)` - the index is into the ORIGINAL
 * block, so a per-sample control can still be read without being resampled itself.
 */
struct Oversampler {
  Stage2x stageA;
  Stage2x stageB;
  double bufA[kBlock * 2] = { 0 };
  double bufB[kBlock * 4] = { 0 };
  int factor = 1;

  void reset() { stageA.reset(); stageB.reset(); }

  int setFactor(int f) {
    const int want = f >= 4 ? 4 : (f >= 2 ? 2 : 1);
    if (want != factor) {
      factor = want;
      reset();
    }
    return factor;
  }

  template <class Curve>
  void process(const double* input, double* output, int count, Curve curve) {
    if (factor == 1) {
      for (int i = 0; i < count; ++i) output[i] = curve(input[i], i);
      return;
    }
    stageA.up(input, bufA, count);
    if (factor == 2) {
      for (int i = 0; i < count * 2; ++i) bufA[i] = curve(bufA[i], i >> 1);
      stageA.down(bufA, output, count);
      return;
    }
    stageB.up(bufA, bufB, count * 2);
    for (int i = 0; i < count * 4; ++i) bufB[i] = curve(bufB[i], i >> 2);
    stageB.down(bufB, bufA, count * 2);
    stageA.down(bufA, output, count);
  }
};

}  // namespace pd_own
