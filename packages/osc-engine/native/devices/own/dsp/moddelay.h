// A modulated delay line - the core the chorus and the flanger share.
//
// Translated from web-engine/src/dsp/moddelay.mjs. One line per channel read at a length an LFO
// moves, interpolated so the movement is a smooth pitch wobble rather than a series of steps,
// with signed feedback from the read back into the write for the flanger's resonance.
#pragma once

#include <cmath>

#include "own/dsp/reverb.h"
#include "own/pd-own.h"

namespace pd_own {

/** A sine or triangle LFO in 0..1, with a phase that can be offset per channel. */
inline double lfoValue(double phase, int shape) {
  const double q = phase - std::floor(phase);
  if (shape == 1) return q < 0.5 ? q * 2 : 2 - q * 2;
  return 0.5 + 0.5 * std::sin(2.0 * M_PI * q);
}

/**
 * `Capacity` is the line's own, as a power of two: the chorus asks for 80 ms and the flanger for
 * 30, and the longest either needs at 96 kHz is under eight thousand samples.
 */
template <int Capacity>
struct ModDelay {
  double sampleRate = 48000.0;
  int max = 0;
  DelayLine<Capacity> lines[2];
  double phase = 0;

  void init(double sr, double maxSec) {
    sampleRate = sr;
    max = static_cast<int>(std::ceil(sr * maxSec)) + 4;
    for (auto& l : lines) l.init(max);
    phase = 0;
  }

  void reset() { for (auto& l : lines) l.reset(); }

  /**
   * One sample for both channels. `spread` (0..1) is how far the right channel's LFO sits behind
   * the left's, `feedback` is signed, and `voices` adds further reads at offset phases.
   */
  void next(double inl, double inr, double* out, double baseSec, double depthSec, double rateHz,
            double spread, double feedback, int shape, int voices) {
    phase += rateHz / sampleRate;
    if (phase >= 1) phase -= 1;
    const double base = baseSec * sampleRate;
    const double depth = depthSec * sampleRate;
    const double cap = max - 2;
    double wetL = 0;
    double wetR = 0;
    for (int v = 0; v < voices; ++v) {
      const double offset = static_cast<double>(v) / voices;
      const double lenL = clamp(base + depth * lfoValue(phase + offset, shape), 1.0, cap);
      const double lenR = clamp(base + depth * lfoValue(phase + offset + spread * 0.5, shape), 1.0, cap);
      wetL += lines[0].readLinear(lenL);
      wetR += lines[1].readLinear(lenR);
    }
    wetL /= voices;
    wetR /= voices;
    // The feedback comes from the first read, soft-limited so a flanger at full resonance rings
    // rather than runs away.
    lines[0].write(inl + std::tanh(wetL * feedback));
    lines[1].write(inr + std::tanh(wetR * feedback));
    out[0] = wetL;
    out[1] = wetR;
  }
};

}  // namespace pd_own
