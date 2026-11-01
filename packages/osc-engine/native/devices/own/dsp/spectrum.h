// What an equalizer draws behind its curve: the spectrum of its own output.
//
// Translated from web-engine/src/engine/analysis.mjs's SpectrumTap, which reads an AnalyserNode
// on the device's output, so this does that node's arithmetic: the output summed to one channel
// as (L + R) / 2, the last 4096 samples of it under the Web Audio spec's Blackman window, a
// transform, each bin's magnitude over the transform's length, smoothed against the last read at
// 0.7, and per band the LOUDEST bin between its neighbors' geometric midpoints, in decibels with
// a floor at -120. The bands are the browser's SPECTRUM_BAND_FREQS. A read is one transform, done
// when the window asks, so a device nobody is looking at only copies samples into a ring.
#pragma once

#include <algorithm>
#include <cmath>

#include "own/dsp/tables.h"

namespace pd_own {

struct SpectrumTap {
  static constexpr int kSize = 4096;
  static constexpr int kHalf = kSize / 2;
  static constexpr int kMaxBands = 160;
  static constexpr double kSmoothing = 0.7;

  float ring[kSize];
  float window[kSize];
  double smoothed[kHalf];
  double re[kSize];
  double im[kSize];
  float hz[kMaxBands];
  int from[kMaxBands];
  int to[kMaxBands];
  int bands = 0;
  int write = 0;

  void init(double sampleRate) {
    for (float& x : ring) x = 0.f;
    for (double& x : smoothed) x = 0.0;
    write = 0;
    const double a0 = 0.42, a1 = 0.5, a2 = 0.08;
    for (int n = 0; n < kSize; ++n) {
      const double x = (double)n / kSize;
      window[n] = (float)(a0 - a1 * std::cos(2 * M_PI * x) + a2 * std::cos(4 * M_PI * x));
    }
    // Only the bands the transform can reach: one past Nyquist would read the last bin for ever.
    double all[kMaxBands];
    for (int i = 0; i < kMaxBands; ++i) all[i] = 20.0 * std::pow(1000.0, (double)i / (kMaxBands - 1));
    bands = 0;
    while (bands < kMaxBands && all[bands] < sampleRate * 0.5) ++bands;
    const double binHz = sampleRate / kSize;
    for (int i = 0; i < bands; ++i) {
      const double f = all[i];
      const double below = i == 0 ? f * (all[0] / all[1]) : all[i - 1];
      const double above = i == bands - 1 ? f * (all[i] / all[i - 1]) : all[i + 1];
      const int lo = std::max(0, (int)std::lround(std::sqrt(f * below) / binHz));
      const int hi = std::max(lo + 1, (int)std::lround(std::sqrt(f * above) / binHz));
      hz[i] = (float)f;
      from[i] = lo;
      to[i] = std::min(hi, kHalf);
    }
  }

  void push(float left, float right) {
    ring[write] = 0.5f * (left + right);
    write = (write + 1) & (kSize - 1);
  }

  /** [count, hz..., dB...] into `out`; how many floats that was, or 0 with no room. */
  int report(float* out, int capacity) {
    if (capacity < 1 + 2 * bands) return 0;
    for (int n = 0; n < kSize; ++n) {
      re[n] = (double)ring[(write + n) & (kSize - 1)] * window[n];
      im[n] = 0.0;
    }
    fft(re, im, kSize);
    for (int k = 0; k < kHalf; ++k) {
      const double mag = std::hypot(re[k], im[k]) / kSize;
      const double next = kSmoothing * smoothed[k] + (1.0 - kSmoothing) * mag;
      smoothed[k] = std::isfinite(next) ? next : 0.0;
    }
    out[0] = (float)bands;
    for (int b = 0; b < bands; ++b) {
      double peak = 0.0;
      for (int k = from[b]; k < to[b]; ++k) if (smoothed[k] > peak) peak = smoothed[k];
      const double db = peak > 0.0 ? 20.0 * std::log10(peak) : -120.0;
      out[1 + b] = hz[b];
      out[1 + bands + b] = (float)(db > -120.0 ? db : -120.0);
    }
    return 1 + 2 * bands;
  }
};

}  // namespace pd_own
