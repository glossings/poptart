// The wavetable oscillator.
//
// Translated from web-engine/src/dsp/oscillator.mjs: a stack of unison copies of the same
// wavetable, detuned and panned around a center pitch, read through a warp and band-limited
// against the rate the warp actually traverses the table at.
//
// THE BAND LIMIT IS THE POINT, and the way it is chosen is measured rather than derived: the
// traversal rate is probed across the cycle through the warp, so the warp modes get band-limited
// for free and adding a mode needs no new analysis.
//
// WHAT IS NOT TRANSLATED. The browser reads every continuous control PER SAMPLE when a signal is
// moving it, which is what makes an lfo() on the position a sweep rather than a staircase. On
// this engine a control carries one value per block, as it does for every device here (see
// own/pd-own.h), so only the still paths exist - and the block is 128 frames at most.
#pragma once

#include <cmath>
#include <vector>

#include "own/dsp/tables.h"
#include "own/dsp/warp.h"
#include "own/pd-own.h"

namespace pd_own {

/** The most unison copies one oscillator will run. */
constexpr int kMaxUnison = 8;

/** How many points across the cycle the block's traversal rate is measured at. */
constexpr int kSlopeProbes = 8;

/** Where `n` unison copies sit: a frequency ratio and a pair of gains for each. */
inline void fillUnison(int n, double detuneCents, double panSpread, double* ratios,
                       double* gainsL, double* gainsR) {
  for (int i = 0; i < n; ++i) {
    // Evenly spaced across the detune, centered: one copy is exactly in tune, two straddle it.
    const double offset = n == 1 ? 0 : (static_cast<double>(i) / (n - 1)) * 2 - 1;
    ratios[i] = std::pow(2.0, (offset * detuneCents) / 1200.0);
    // Equal-power panning, so widening a unison does not make it louder in the middle.
    const double pan = n == 1 ? 0 : offset * panSpread;
    const double angle = ((pan + 1) * M_PI) / 4;
    // Each copy carries 1/sqrt(n) so that stacking copies does not raise the level.
    const double g = 1.0 / std::sqrt(static_cast<double>(n));
    gainsL[i] = std::cos(angle) * g * M_SQRT2;
    gainsR[i] = std::sin(angle) * g * M_SQRT2;
  }
}

/**
 * A small deterministic generator for unison start phases, seeded per note so that a song sounds
 * the same every time it is played.
 */
inline double hashPhase(unsigned int seed, int index) {
  // The first multiply in double, as the browser's is - see toUint32.
  unsigned int h = toUint32(static_cast<double>(seed) * 2654435761.0
                            + static_cast<double>(index) * 40503.0);
  h ^= h >> 15;
  h = static_cast<unsigned int>(h * 2246822519u);
  h ^= h >> 13;
  return static_cast<double>(h) / 4294967296.0;
}

/**
 * Reads one band-limited frame, wrapping at the end.
 *
 * Catmull-Rom rather than straight linear interpolation, and it earns its two extra taps: the
 * dull levels of the pyramid are stored SHORT, and linear interpolation's error on those lands
 * as sidebands around the read rate, which is the exact thing the band-limiting was for.
 */
inline double readMip(const std::vector<float>& mip, double phase) {
  const int n = static_cast<int>(mip.size());
  double x = phase * n;
  if (x < 0) x = 0;
  int i = static_cast<int>(x);
  if (i >= n) i = n - 1;
  const double f = x - i;
  const double a = mip[static_cast<size_t>(i == 0 ? n - 1 : i - 1)];
  const double b = mip[static_cast<size_t>(i)];
  const double c = mip[static_cast<size_t>(i + 1 >= n ? i + 1 - n : i + 1)];
  const double d = mip[static_cast<size_t>(i + 2 >= n ? i + 2 - n : i + 2)];
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
}

struct WavetableOscillator {
  double sampleRate = 48000.0;
  const Table* table = nullptr;

  double phases[kMaxUnison] = { 0 };
  double ratios[kMaxUnison] = { 0 };
  double gainsL[kMaxUnison] = { 0 };
  double gainsR[kMaxUnison] = { 0 };

  /** The note in Hz with the octave setting folded in. Set per block by the voice. */
  double frequency = 440;

  double level = 1;
  double phase = 0;          // in cycles
  double semis = 0;
  double cents = 0;
  double position = 0;       // 0..1 across the frame stack
  double warpAmount = 0;

  int warpMode = 0;
  double unison = 1;
  double detuneCents = 0;
  double panSpread = 0;
  double phaseRand = 0;
  unsigned int seed = 1;

  double lastLevel = 0;
  bool started = false;
  /** The last sample this oscillator made, at unit level - what a cross-modulation reads. */
  double last = 0;
  /** Set by the voice when another oscillator is listening, so a silent level still renders. */
  bool heard = false;

  // Where the block reads in the frame stack.
  const std::vector<std::vector<float>>* lowFrame = nullptr;
  const std::vector<std::vector<float>>* highFrame = nullptr;
  double frameMix = 0;
  int n = 1;
  int topLevel = 0;
  double baseInc = 0;
  double stillInc = 0;
  double levelStart = 0;
  double levelStep = 0;
  CrossMod cross;

  void init(double sr) {
    sampleRate = sr;
    reset();
  }

  void setTable(const Table* t) {
    table = t;
    lastLevel = 0;
  }

  /** Starts a note. At phaseRand 0 every copy starts together, which is the hard attack. */
  void start(unsigned int s) {
    seed = s;
    for (int i = 0; i < kMaxUnison; ++i) {
      phases[i] = phaseRand > 0 ? hashPhase(seed, i) * phaseRand : 0;
    }
    started = true;
    lastLevel = 0;
  }

  void reset() {
    for (int i = 0; i < kMaxUnison; ++i) phases[i] = 0;
    started = false;
    lastLevel = 0;
  }

  int prepare() {
    int copies = static_cast<int>(clamp(jsRound(unison), 1.0, static_cast<double>(kMaxUnison)));
    fillUnison(copies, detuneCents, panSpread, ratios, gainsL, gainsR);
    return copies;
  }

  /**
   * The mip level this block needs: the fastest the table will be traversed anywhere in the
   * cycle, measured through the warp. Probing across the cycle matters because most warps are
   * not uniform, and a level chosen from the slow part would alias through the fast part.
   */
  double bandLimit(double increment, double amount) {
    if (!table) return 0;
    double worst = std::fabs(increment);
    if (amount > 0) {
      for (int i = 0; i < kSlopeProbes; ++i) {
        const double s = warpSlope(static_cast<double>(i) / kSlopeProbes, increment, amount, warpMode);
        if (s > worst) worst = s;
      }
    }
    return mipLevelFor(worst, table->schedule);
  }

  /** Places a 0..1 position in the frame stack: the two frames it sits between and the blend. */
  void placeFrames(double where) {
    const int frameCount = table->frameCount;
    const double pos = clamp(where, 0.0, 1.0) * (frameCount - 1);
    int frameLow = static_cast<int>(pos);
    if (frameLow >= frameCount - 1) frameLow = frameCount - 2 > 0 ? frameCount - 2 : 0;
    lowFrame = &table->mips[static_cast<size_t>(frameCount == 1 ? 0 : frameLow)];
    highFrame = &table->mips[static_cast<size_t>(frameCount == 1 ? 0 : frameLow + 1)];
    frameMix = frameCount == 1 ? 0 : pos - frameLow;
  }

  /** Per-block setup: the unison spread, the band limit, and where the position reads. */
  bool begin(int count) {
    if (!table) return false;
    if (level == 0 && !heard) return false;

    n = prepare();
    topLevel = table->levels - 1;

    baseInc = frequency / sampleRate;
    stillInc = baseInc * std::pow(2.0, semis / 12.0 + cents / 1200.0);

    cross = crossModOf(warpMode);
    // A cross-modulation mode is not a phase warp: its amount is a depth the voice reads, and
    // the band limit allows for the extra traversal it costs.
    const double traversal = cross.is()
        ? stillInc * (1 + (cross.kind == kCrossFm ? fmDepth(warpAmount) : 0))
        : stillInc;
    const double levelEnd = bandLimit(traversal, cross.is() ? 0 : warpAmount);
    const double begun = started && lastLevel > 0 ? lastLevel : levelEnd;
    lastLevel = levelEnd;
    levelStart = begun;
    levelStep = count > 0 ? (levelEnd - begun) / count : 0;

    placeFrames(position);
    return true;
  }

  /**
   * One sample, added into `outL[s]` and `outR[s]`, and kept as `last` for whatever the voice
   * bends with it. `xpm` is a phase offset in cycles and `xinc` a multiplier on the increment -
   * the cross-modulation inputs - and `ring` multiplies the output.
   */
  void sample(int s, float* outL, float* outR, double xpm = 0, double xinc = 1, double ring = 1) {
    const double levelNow = levelStart + levelStep * s;
    int lo = static_cast<int>(levelNow);
    if (lo < 0) lo = 0;
    if (lo > topLevel) lo = topLevel;
    const int hi = lo == topLevel ? topLevel : lo + 1;
    const double levelMix = hi == lo ? 0 : levelNow - lo;

    const std::vector<float>& lowA = (*lowFrame)[static_cast<size_t>(lo)];
    const std::vector<float>& lowB = (*lowFrame)[static_cast<size_t>(hi)];
    const std::vector<float>& highA = (*highFrame)[static_cast<size_t>(lo)];
    const std::vector<float>& highB = (*highFrame)[static_cast<size_t>(hi)];

    const double pm = phase + xpm;
    const double amount = cross.is() ? 0 : warpAmount;
    const double gain = level;
    const double inc = stillInc * xinc;

    double sumL = 0;
    double sumR = 0;
    for (int v = 0; v < n; ++v) {
      double ph = phases[v] + pm;
      ph -= std::floor(ph);
      const double w = amount > 0 ? warpPhase(ph, amount, warpMode) : ph;

      // Two frames, two band limits, blended both ways. The fast paths matter: a single-frame
      // table and a settled band limit are both common, and each halves the reads.
      double value;
      if (levelMix == 0) {
        value = frameMix == 0 ? readMip(lowA, w)
                              : readMip(lowA, w) + (readMip(highA, w) - readMip(lowA, w)) * frameMix;
      } else if (frameMix == 0) {
        const double a = readMip(lowA, w);
        value = a + (readMip(lowB, w) - a) * levelMix;
      } else {
        const double a = readMip(lowA, w) + (readMip(highA, w) - readMip(lowA, w)) * frameMix;
        const double b = readMip(lowB, w) + (readMip(highB, w) - readMip(lowB, w)) * frameMix;
        value = a + (b - a) * levelMix;
      }

      sumL += value * gainsL[v];
      sumR += value * gainsR[v];

      // A negative increment is a real thing here: through-zero FM runs the table backwards.
      double next = phases[v] + inc * ratios[v];
      next -= std::floor(next);
      phases[v] = next;
    }

    // What another oscillator hears of this one: the unison sum at unit level, before the level
    // knob, so a modulator can be turned down without losing the modulation.
    last = (sumL + sumR) * 0.5 * ring;
    outL[s] = static_cast<float>(static_cast<double>(outL[s]) + sumL * gain * ring);
    outR[s] = static_cast<float>(static_cast<double>(outR[s]) + sumR * gain * ring);
  }

  /** Renders one block, with nothing bending this oscillator from outside. */
  void process(float* outL, float* outR, int count) {
    if (!begin(count)) return;
    for (int s = 0; s < count; ++s) sample(s, outL, outR);
  }
};

}  // namespace pd_own
