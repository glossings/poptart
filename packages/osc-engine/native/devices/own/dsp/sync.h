// Tempo sync, for every effect with a rate or a time.
//
// Translated from web-engine/src/dsp/sync.mjs. `free` reads the device's own time or rate
// control; anything else is a length in beats, and the tempo the engine tells the device turns
// it into seconds. The ORDER of the options is that file's, since an index is what a song holds.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** The length of each sync option in beats (quarter notes); a negative means free. */
constexpr double kSyncBeats[19] = {
  -1, 1.0 / 8, 1.0 / 12, 3.0 / 16, 1.0 / 4, 1.0 / 6, 3.0 / 8, 1.0 / 2, 1.0 / 3, 3.0 / 4, 1, 2.0 / 3, 1.5,
  2, 4.0 / 3, 3, 4, 8, 16,
};
constexpr int kSyncOptions = 19;

inline double syncBeats(int index) {
  if (index < 0 || index >= kSyncOptions) return -1;
  return kSyncBeats[index];
}

/** The seconds a sync setting lasts at a tempo, or `fallbackSec` when it is free. */
inline double syncedSeconds(int index, double bpm, double fallbackSec) {
  const double beats = syncBeats(index);
  if (beats < 0) return fallbackSec;
  return (beats * 60.0) / std::fmax(1.0, bpm);
}

/** The rate in Hz a sync setting cycles at, or `fallbackHz` when it is free. */
inline double syncedHz(int index, double bpm, double fallbackHz) {
  const double beats = syncBeats(index);
  if (beats < 0) return fallbackHz;
  return std::fmax(1.0, bpm) / (beats * 60.0);
}

}  // namespace pd_own
