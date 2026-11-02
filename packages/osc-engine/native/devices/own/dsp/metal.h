// A metallic source: six square waves at inharmonic frequencies, summed, every edge band-limited.
//
// Translated from web-engine/src/dsp/metal.mjs, which says what it is and why. The output is
// kBlepHalf samples late.
#pragma once

#include "own/dsp/blep.h"

namespace pd_own {

constexpr int kMetalCount = 6;
constexpr double kMetalFoldTurns = 1.37;

/** metal.mjs's metalFold: a sine fold and a square law, from straight (0) to full (1). */
inline double metalFold(double x, double warp) {
  return x + warp * (std::sin(kMetalFoldTurns * M_PI * x) + x * x - x);
}

/** The six frequencies, in hertz, at middle C. */
constexpr double kMetalHz[kMetalCount] = { 205.3, 304.4, 369.6, 522.7, 540, 800 };

struct MetalSource {
  double sampleRate = 48000.0;
  double hz[kMetalCount] = { 0 };
  double width = 0.5;
  double phase[kMetalCount] = { 0 };
  BlepLine line;
  double edgeAgo[3 * kMetalCount] = { 0 };
  double edgeStep[3 * kMetalCount] = { 0 };

  /** `freqs`: the six frequencies at a ratio of one; `w`: how much of each cycle is high. */
  void init(double sr, const double* freqs = kMetalHz, double w = 0.5) {
    sampleRate = sr;
    for (int k = 0; k < kMetalCount; ++k) hz[k] = freqs[k];
    width = w;
    reset();
  }

  void reset() {
    for (double& p : phase) p = 0;
    line.reset();
  }

  /** The next sample: every square at `ratio` times its frequency, each at its level in `levels`. */
  double next(double ratio, const double* levels) {
    double value = 0;
    for (int k = 0; k < kMetalCount; ++k) {
      const double dt = (hz[k] * ratio) / sampleRate;
      const double level = levels[k];
      if (dt >= 0.5 || dt <= 0) continue;
      const double w = width;
      const double from = phase[k];
      double t = from + dt;
      if (from < w && t >= w) line.jump((t - w) / dt, -2 * level);
      if (t >= 1) {
        t -= 1;
        line.jump(t / dt, 2 * level);
        if (t >= w) line.jump((t - w) / dt, -2 * level);
      }
      phase[k] = t;
      value += t < w ? level : -level;
    }
    return line.push(value);
  }

  /** As next(), with the sum folded by `warp` before it is drawn (metal.mjs's nextFolded). */
  double nextFolded(double ratio, const double* levels, double warp) {
    if (!(warp > 0)) return next(ratio, levels);
    const double w = width;
    double before = 0;
    double value = 0;
    int n = 0;
    for (int k = 0; k < kMetalCount; ++k) {
      const double dt = (hz[k] * ratio) / sampleRate;
      const double level = levels[k];
      if (dt >= 0.5 || dt <= 0) continue;
      const double from = phase[k];
      before += from < w ? level : -level;
      double t = from + dt;
      if (from < w && t >= w) { edgeAgo[n] = (t - w) / dt; edgeStep[n] = -2 * level; n++; }
      if (t >= 1) {
        t -= 1;
        edgeAgo[n] = t / dt; edgeStep[n] = 2 * level; n++;
        if (t >= w) { edgeAgo[n] = (t - w) / dt; edgeStep[n] = -2 * level; n++; }
      }
      phase[k] = t;
      value += t < w ? level : -level;
    }
    for (int i = 1; i < n; ++i) {
      const double a = edgeAgo[i];
      const double d = edgeStep[i];
      int j = i - 1;
      while (j >= 0 && edgeAgo[j] < a) { edgeAgo[j + 1] = edgeAgo[j]; edgeStep[j + 1] = edgeStep[j]; j--; }
      edgeAgo[j + 1] = a;
      edgeStep[j + 1] = d;
    }
    double sum = before;
    double folded = metalFold(sum, warp);
    for (int i = 0; i < n; ++i) {
      sum += edgeStep[i];
      const double nx = metalFold(sum, warp);
      line.jump(edgeAgo[i], nx - folded);
      folded = nx;
    }
    return line.push(metalFold(value, warp));
  }
};

}  // namespace pd_own
