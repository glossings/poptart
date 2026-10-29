// A short memory of what a device has been doing, for the pictures that scroll.
//
// Translated from web-engine/src/dsp/history.mjs: a ring of one number per entry, each entry the
// fold of `per` blocks (their largest, their smallest, or the last), kept on the audio thread
// where the numbers are and copied out, oldest first, when the device is asked to report. The
// sizes are the browser's, so a lane drawn from either engine is the same picture.
#pragma once

#include <algorithm>

namespace pd_own {

/** How many entries a ring holds: about two thirds of a second of blocks at the usual rate. */
constexpr int kHistoryBlocks = 256;

/** How many blocks a dynamics lane folds into one entry: about four seconds on the lane. */
constexpr int kDynamicsBlocksPerEntry = 6;

struct History {
  enum Keep { kLast = 0, kMax = 1, kMin = 2 };

  float buf[kHistoryBlocks];
  int at = 0;
  int per = 1;
  int keep = kLast;
  int count = 0;
  double acc = 0;
  // How many entries have ever been written. A lane uses it to pin each entry to the same pixel
  // column for as long as it is on screen, so the picture moves in whole pixels as it scrolls.
  unsigned written = 0;

  History() { init(0.0f, 1, kLast); }

  void init(float fill, int per_, int keep_) {
    std::fill(buf, buf + kHistoryBlocks, fill);
    at = 0;
    per = per_ < 1 ? 1 : per_;
    keep = keep_;
    count = 0;
    acc = 0;
    written = 0;
  }

  void push(double v) {
    if (count == 0) acc = v;
    else if (keep == kMax) acc = std::max(acc, v);
    else if (keep == kMin) acc = std::min(acc, v);
    else acc = v;
    count += 1;
    if (count < per) return;
    count = 0;
    buf[at] = static_cast<float>(acc);
    at = (at + 1) % kHistoryBlocks;
    written += 1;
  }

  /** Oldest first, newest last, into `out`; how many were written there. */
  int snapshot(float* out, int capacity) const {
    const int n = capacity < kHistoryBlocks ? capacity : kHistoryBlocks;
    for (int i = 0; i < n; ++i) out[i] = buf[(at + i) % kHistoryBlocks];
    return n;
  }
};

/**
 * The report a dynamics lane is drawn from, as every device with a transfer curve lays it out:
 * the level in and the gain reduction right now, how many entries the rings have written, the
 * seconds one entry stands for, the ring length, then the level ring and the reduction ring.
 * osc-engine's native-devices.js (curveLane) reads exactly this.
 */
inline int reportCurveLane(float* out, int capacity, double inDb, double grDb, double blockSec,
                           const History& levels, const History& reductions) {
  const int n = kHistoryBlocks;
  if (capacity < 5 + 2 * n) return 0;
  out[0] = static_cast<float>(inDb);
  out[1] = static_cast<float>(grDb);
  out[2] = static_cast<float>(levels.written);
  out[3] = static_cast<float>(blockSec);
  out[4] = static_cast<float>(n);
  levels.snapshot(out + 5, n);
  reductions.snapshot(out + 5 + n, n);
  return 5 + 2 * n;
}

}  // namespace pd_own
