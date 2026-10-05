// Envelopes: the curve a stage takes, and the generator the synths play notes with.
//
// Translated from web-engine/src/dsp/adsr.mjs. Written one sample at a time and allocation-free,
// which is how it was written there too - the comment in that file says it was written the way
// it would have to be written to port to a server, and this is that port.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** Under this a curve is a straight line, and the exact expression divides by zero. */
constexpr double kCurveEpsilon = 1e-3;
/** A stage shorter than this is treated as instant. */
constexpr double kMinStageSec = 1e-5;

/**
 * One stage's shape: 0 at t=0 and 1 at t=1, bending by `curve`. Positive holds back and then
 * rushes; negative snaps away and levels off.
 */
inline double curveShape(double t, double curve) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (std::fabs(curve) < kCurveEpsilon) return t;
  return (1 - std::exp(t * curve)) / (1 - std::exp(curve));
}

enum AdsrStage { kAdsrIdle = 0, kAdsrAttack, kAdsrDecay, kAdsrSustain, kAdsrRelease };

/** A4, and the note it is: what turns a note number into a frequency (dsp/voice.mjs). */
constexpr double kA4Hz = 440.0;
constexpr double kA4Note = 69.0;
inline double midiToHz(double note) { return kA4Hz * std::pow(2.0, (note - kA4Note) / 12.0); }

/**
 * One envelope generator.
 *
 * The release always starts from wherever the envelope actually is, so a note released during
 * its attack fades from the level it reached rather than jumping to the sustain level first.
 */
struct Adsr {
  double sampleRate = 48000.0;
  double attack = 0.01;
  double decay = 0.1;
  double sustain = 0.7;
  double release = 0.2;
  double attackCurve = -4;
  double decayCurve = -4;
  double releaseCurve = -4;
  int stage = kAdsrIdle;
  double value = 0;
  double stagePos = 0;      // 0..1 through the current stage
  double stageFrom = 0;     // the level the current stage started at

  void init(double sr) { sampleRate = sr; reset(); }

  /** Every stage at once, as plain arguments: what a voice calls each block. */
  void setStages(double a, double d, double s, double r, double ac, double dc, double rc,
                 double scale = 1) {
    attack = std::fmax(0.0, a) * scale;
    decay = std::fmax(0.0, d) * scale;
    sustain = clamp(s, 0.0, 1.0);
    release = std::fmax(0.0, r) * scale;
    attackCurve = ac;
    decayCurve = dc;
    releaseCurve = rc;
  }

  /** Starts a note. `retrigger` keeps the current level so a restart does not click to zero. */
  void gateOn(bool retrigger = true) {
    stageFrom = retrigger ? value : 0;
    if (!retrigger) value = 0;
    stage = kAdsrAttack;
    stagePos = 0;
  }

  /** Releases a note from wherever the envelope currently is. */
  void gateOff() {
    if (stage == kAdsrIdle) return;
    stageFrom = value;
    stage = kAdsrRelease;
    stagePos = 0;
  }

  /** Silences the envelope outright - a voice being stolen, not a note ending. */
  void reset() {
    stage = kAdsrIdle;
    value = 0;
    stagePos = 0;
    stageFrom = 0;
  }

  bool active() const { return stage != kAdsrIdle; }

  /** One sample. Returns the envelope's level, 0..1. */
  double next() {
    switch (stage) {
      case kAdsrAttack: {
        if (attack < kMinStageSec) {
          value = 1;
          stage = kAdsrDecay;
          stagePos = 0;
          stageFrom = 1;
          break;
        }
        stagePos += 1.0 / (attack * sampleRate);
        if (stagePos >= 1) {
          value = 1;
          stage = kAdsrDecay;
          stagePos = 0;
          stageFrom = 1;
        } else {
          // An attack rises toward 1 from wherever it started, so a retrigger mid-note does not
          // drop the level first. The curve is NOT negated: one sign, one meaning.
          value = stageFrom + (1 - stageFrom) * curveShape(stagePos, attackCurve);
        }
        break;
      }
      case kAdsrDecay: {
        if (decay < kMinStageSec) {
          value = sustain;
          stage = kAdsrSustain;
          break;
        }
        stagePos += 1.0 / (decay * sampleRate);
        if (stagePos >= 1) {
          value = sustain;
          stage = kAdsrSustain;
        } else {
          value = stageFrom + (sustain - stageFrom) * curveShape(stagePos, decayCurve);
        }
        break;
      }
      case kAdsrSustain:
        value = sustain;
        break;
      case kAdsrRelease: {
        if (release < kMinStageSec) {
          value = 0;
          stage = kAdsrIdle;
          break;
        }
        stagePos += 1.0 / (release * sampleRate);
        if (stagePos >= 1) {
          value = 0;
          stage = kAdsrIdle;
        } else {
          value = stageFrom * (1 - curveShape(stagePos, releaseCurve));
        }
        break;
      }
      default:
        value = 0;
    }
    return value;
  }
};

}  // namespace pd_own
