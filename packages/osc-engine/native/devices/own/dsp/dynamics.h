// The parts every dynamics processor here is made of: a level in decibels, a peak detector with
// separate attack and release, and the gain a threshold with a knee asks for.
//
// Translated from the exported half of web-engine/src/devices/compressor.mjs, which is where the
// browser keeps them for the same reason - the compressor, the multiband's three bands, the
// limiter and the overdrive's dynamics control all want the same detector.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** A linear level in decibels, floored so silence is a number. */
inline double dbOf(double x) { return 20.0 * std::log10(std::fmax(1e-9, x)); }

/** The gain reduction in decibels for a level in decibels, above a threshold with a knee. */
inline double gainComputer(double levelDb, double thresholdDb, double ratio, double kneeDb) {
  const double over = levelDb - thresholdDb;
  if (kneeDb <= 0 || over <= -kneeDb / 2) return over <= 0 ? 0.0 : over * (1.0 / ratio - 1.0);
  if (over >= kneeDb / 2) return over * (1.0 / ratio - 1.0);
  const double t = over + kneeDb / 2;
  return (1.0 / ratio - 1.0) * (t * t) / (2.0 * kneeDb);
}

/** A peak detector in decibels with one time constant up and another down. */
struct Detector {
  double sampleRate = 48000.0;
  double env = 0;
  double up = 0;
  double down = 0;

  void init(double sr) { sampleRate = sr; env = 0; setTimes(10, 100); }

  void setTimes(double attackMs, double releaseMs) {
    up = 1.0 - std::exp(-1.0 / (std::fmax(0.01, attackMs) * 0.001 * sampleRate));
    down = 1.0 - std::exp(-1.0 / (std::fmax(0.01, releaseMs) * 0.001 * sampleRate));
  }

  /** Back to silence - for a detector a number that cannot be played has got into. */
  void reset() { env = 0; }

  /** Feeds a rectified sample and returns the envelope, both linear. */
  double next(double x) {
    const double k = x > env ? up : down;
    env += (x - env) * k;
    return env;
  }
};

}  // namespace pd_own
