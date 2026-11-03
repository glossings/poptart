// A spring reverb tank: two springs, each a loop of dispersing allpasses for the main chirps and
// a second loop for the quieter full-band ones.
//
// Translated from web-engine/src/dsp/spring.mjs, which explains the model. The one difference is
// where the memory comes from: the browser allocates for the rate it finds itself at, and a
// server plugin cannot allocate on the audio thread, so the lines and the chain's state are fixed
// arrays sized for 96 kHz and sized down from there with the browser's arithmetic.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

#include "own/pd-own.h"

namespace pd_own {
namespace spring {

constexpr int kLfStages = 100;
constexpr int kHfStages = 80;
constexpr double kMinTransition = 100;
constexpr double kMaxTransition = 8000;
constexpr double kMaxFeedback = 1.5;
constexpr double kMaxLength = 0.12;

constexpr double kSpringRatios[2] = { 1, 1.127 };
constexpr double kHfRatios[2] = { 0.53, 0.61 };
constexpr double kWanderHz[2] = { 2.3, 1.7 };
constexpr uint32_t kSeeds[2] = { 0x9e3779b9u, 0x7f4a7c15u };

constexpr double kEchoAhead = 0.2;
constexpr double kEchoGain = 0.12;
constexpr double kHfLevel = 0.035;
constexpr double kMaxWander = 0.0015;
constexpr double kWetGain = 0.86;
constexpr double kGlide = 0.02;
constexpr double kMaxCoefficient = 0.9;
constexpr double kShakeThump = 0.008;
constexpr double kShakeFall = 0.012;
constexpr double kShakeThumpLevel = 1.4;
constexpr double kShakeNoiseLevel = 0.9;
constexpr double kShakeLength = 0.25;
constexpr uint32_t kShakeSeed = 0x2545f491u;
constexpr double kFloor = 1e-20;

constexpr double kButterworth8[4] = { 0.5097955791, 0.6013448869, 0.8999762231, 2.5629154477 };

/** The longest stretch, at 96 kHz and the lowest transition frequency. */
constexpr int kMaxStretchCapacity = 480;
/** The longest line, at 96 kHz: the right spring's longest trip and the deepest wander. */
constexpr int kLineCapacity = 16384;
/** The line that holds the chirps back behind their copies: a fifth of the longest. */
constexpr int kEchoCapacity = 4096;

/** A delay line of doubles, with a fractional read. */
template <int Capacity>
struct Line {
  double buffer[Capacity] = { 0 };
  int mask = Capacity - 1;
  int pos = 0;

  void init(int maxSamples) {
    int size = 16;
    while (size < maxSamples && size < Capacity) size *= 2;
    mask = size - 1;
    reset();
  }

  void reset() {
    std::memset(buffer, 0, sizeof(buffer));
    pos = 0;
  }

  void write(double v) {
    buffer[pos] = v;
    pos = (pos + 1) & mask;
  }

  double read(double delay) const {
    const int whole = static_cast<int>(std::floor(delay));
    const double frac = delay - whole;
    const double a = buffer[(pos - whole) & mask];
    const double b = buffer[(pos - whole - 1) & mask];
    return a + (b - a) * frac;
  }
};

/** A cascade of identical plain first-order allpasses. */
template <int Stages>
struct PlainChain {
  double state[Stages] = { 0 };

  void reset() { std::memset(state, 0, sizeof(state)); }

  double next(double x, double a) {
    double v = x;
    for (int m = 0; m < Stages; ++m) {
      const double old = state[m];
      const double w = v - a * old;
      state[m] = w;
      v = a * w + old;
    }
    return v;
  }
};

/**
 * A cascade of first-order allpasses with their delay stretched to a stretch that need not be
 * whole: `whole` samples of delay and a first-order allpass, coefficient `eta`, for the rest.
 */
template <int Stages, int MaxStretch>
struct StretchedChain {
  static constexpr int kSize = MaxStretch + 3;
  double state[Stages * kSize] = { 0 };
  double frac[Stages] = { 0 };
  int size = kSize;
  int pos = 0;

  void init(int maxStretch) {
    size = (maxStretch < MaxStretch ? maxStretch : MaxStretch) + 3;
    reset();
  }

  void reset() {
    std::memset(state, 0, sizeof(state));
    std::memset(frac, 0, sizeof(frac));
    pos = 0;
  }

  double next(double x, double a, int whole, double eta) {
    int r0 = pos - whole;
    if (r0 < 0) r0 += size;
    int r1 = r0 - 1;
    if (r1 < 0) r1 += size;
    double v = x;
    for (int m = 0, base = 0; m < Stages; ++m, base += size) {
      const double d = eta * state[base + r0] + state[base + r1] - eta * frac[m];
      frac[m] = d;
      const double w = v - a * d;
      state[base + pos] = w;
      v = a * w + d;
    }
    pos = pos + 1 == size ? 0 : pos + 1;
    return v;
  }
};

/** One biquad section, transposed direct form II. */
struct Section {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  double z1 = 0, z2 = 0;

  void reset() { z1 = 0; z2 = 0; }

  void lowpass(double hz, double q, double sampleRate) {
    const double w = (2 * M_PI * hz) / sampleRate;
    const double c = std::cos(w);
    const double alpha = std::sin(w) / (2 * q);
    const double a0 = 1 + alpha;
    b0 = (1 - c) / 2 / a0;
    b1 = (1 - c) / a0;
    b2 = b0;
    a1 = (-2 * c) / a0;
    a2 = (1 - alpha) / a0;
  }

  void highpass(double hz, double q, double sampleRate) {
    const double w = (2 * M_PI * hz) / sampleRate;
    const double c = std::cos(w);
    const double alpha = std::sin(w) / (2 * q);
    const double a0 = 1 + alpha;
    b0 = (1 + c) / 2 / a0;
    b1 = -(1 + c) / a0;
    b2 = b0;
    a1 = (-2 * c) / a0;
    a2 = (1 - alpha) / a0;
  }

  double next(double x) {
    const double y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
};

/** A slow random wander between -1 and 1, eased between targets. xorshift32, as the browser. */
struct Wander {
  int period = 1;
  uint32_t seed0 = 1;
  uint32_t seed = 1;
  double from = 0;
  double to = 0;
  int count = 0;

  void init(double sampleRate, double hz, uint32_t s) {
    period = static_cast<int>(jsRound(sampleRate / hz));
    if (period < 1) period = 1;
    seed0 = s;
    reset();
  }

  void reset() {
    seed = seed0;
    from = 0;
    to = random();
    count = 0;
  }

  double random() {
    uint32_t x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    seed = x;
    return (static_cast<double>(x) / 4294967296.0) * 2 - 1;
  }

  double next() {
    if (count >= period) {
      from = to;
      to = random();
      count = 0;
    }
    const double t = static_cast<double>(count) / period;
    ++count;
    return from + (to - from) * (t * t * (3 - 2 * t));
  }
};

/** What Tank::set hands each spring. */
struct Settings {
  double stretch;
  double aLf, aHf, length, decay, feedback, depth, dampCoef, lowCut;
};

struct Spring {
  double sampleRate = 48000;
  double ratio = 1;
  double hfRatio = 0.5;
  Line<kLineCapacity> lfLine;
  Line<kLineCapacity> hfLine;
  Line<kEchoCapacity> echoLine;
  StretchedChain<kLfStages, kMaxStretchCapacity> lf;
  PlainChain<kHfStages> hf;
  Wander wander;
  Section lowpass[4];
  Section outLowpass[4];
  Section lowcut;
  double lfDamp = 0, hfDamp = 0, lfBack = 0, hfBack = 0;
  double lfDelay = 1000, hfDelay = 500, lfGain = 0, hfGain = 0;
  double aLf = 0.5, aHf = -0.5, dampCoef = 0.5, depth = 0;

  void init(double sr, int maxStretch, int index) {
    sampleRate = sr;
    ratio = kSpringRatios[index];
    hfRatio = kHfRatios[index];
    const int longest = static_cast<int>(std::ceil(sr * (kMaxLength * ratio + kMaxWander))) + 8;
    lfLine.init(longest);
    hfLine.init(longest);
    echoLine.init(static_cast<int>(std::ceil(longest * kEchoAhead)) + 8);
    lf.init(maxStretch);
    hf.reset();
    wander.init(sr, kWanderHz[index], kSeeds[index]);
    for (auto& s : lowpass) s = Section();
    for (auto& s : outLowpass) s = Section();
    lowcut = Section();
    lfDamp = hfDamp = lfBack = hfBack = 0;
    lfDelay = 1000; hfDelay = 500; lfGain = 0; hfGain = 0;
    aLf = 0.5; aHf = -0.5; dampCoef = 0.5; depth = 0;
  }

  void reset() {
    lfLine.reset();
    hfLine.reset();
    echoLine.reset();
    lf.reset();
    hf.reset();
    wander.reset();
    for (auto& s : lowpass) s.reset();
    for (auto& s : outLowpass) s.reset();
    lowcut.reset();
    lfDamp = hfDamp = lfBack = hfBack = 0;
  }

  void set(const Settings& c) {
    const double sr = sampleRate;
    aLf = c.aLf;
    aHf = c.aHf;
    lfDelay = std::fmax(4.0, c.length * ratio * sr);
    hfDelay = std::fmax(4.0, c.length * hfRatio * sr);
    depth = c.depth;
    const double lfTrip = (lfDelay + c.stretch * kLfStages) / sr;
    const double hfTrip = (hfDelay + kHfStages) / sr;
    lfGain = std::fmax(c.feedback, std::fmin(0.9995, std::pow(10.0, (-3 * lfTrip) / c.decay)));
    hfGain = std::fmax(c.feedback, std::fmin(0.9995, std::pow(10.0, (-3 * hfTrip) / c.decay)));
    dampCoef = c.dampCoef;
    const double top = std::fmin(sr * 0.45, sr / (2 * c.stretch));
    for (int s = 0; s < 4; ++s) {
      lowpass[s].lowpass(top, kButterworth8[s], sr);
      outLowpass[s].lowpass(top, kButterworth8[s], sr);
    }
    lowcut.highpass(c.lowCut, M_SQRT1_2, sr);
  }

  double next(double x, int whole, double eta) {
    const double wobble = depth * wander.next();

    lfLine.write(x + lfBack + kFloor);
    const double arrived = lfLine.read(lfDelay + wobble);
    double l = lf.next(arrived, aLf, whole, eta);
    for (auto& s : lowpass) l = s.next(l);
    lfDamp += dampCoef * (l - lfDamp);
    lfBack = std::tanh(lfDamp * lfGain);

    hfLine.write(x + hfBack + kFloor);
    const double h = hf.next(hfLine.read(hfDelay + wobble * 0.5), aHf);
    hfDamp += dampCoef * (h - hfDamp);
    hfBack = std::tanh(hfDamp * hfGain);

    double low = l;
    for (auto& s : outLowpass) low = s.next(low);
    echoLine.write(low);
    const double main = echoLine.read(lfDelay * kEchoAhead) + kEchoGain * low;
    return lowcut.next(main + kHfLevel * h);
  }
};

struct Tank {
  double sampleRate = 48000;
  int maxStretch = 16;
  Spring springs[2];
  double glide = 0;
  int thump = 1;
  double fall = 1;
  int shakeLength = 1;
  double stretch = 0;
  double target = 2;
  int shakeAt = -1;
  double shakeLevel = 1;
  bool shakeThump = true;
  uint32_t shakeSeed = kShakeSeed;

  void init(double sr) {
    sampleRate = sr;
    maxStretch = static_cast<int>(std::ceil(sr / (2 * kMinTransition)));
    if (maxStretch > kMaxStretchCapacity) maxStretch = kMaxStretchCapacity;
    springs[0].init(sr, maxStretch, 0);
    springs[1].init(sr, maxStretch, 1);
    glide = 1 - std::exp(-1 / (kGlide * sr));
    thump = jsRoundInt(kShakeThump * sr);
    if (thump < 1) thump = 1;
    fall = kShakeFall * sr;
    shakeLength = jsRoundInt(kShakeLength * sr);
    reset();
  }

  void reset() {
    for (auto& s : springs) s.reset();
    stretch = 0;
    target = 2;
    shakeAt = -1;
    shakeLevel = 1;
    shakeThump = true;
    shakeSeed = kShakeSeed;
  }

  /** Glides to a new transition frequency now, rather than at the next set(). */
  void retune(double hz) { target = stretchFor(hz); }

  /** Knocks the tank from the next sample: the burst as loud as `level`, with the thump or not. */
  void knock(double level, bool thump) {
    shakeAt = 0;
    shakeLevel = level;
    shakeThump = thump;
  }

  double stretchFor(double hz) const {
    const double f = clamp(hz, kMinTransition, kMaxTransition);
    return std::fmax(2.0, std::fmin(static_cast<double>(maxStretch), sampleRate / (2 * f)));
  }

  void set(double decay, double length, double chirp, double transition, double modulation,
           double damping, double lowCut, double feedback) {
    const double sr = sampleRate;
    const double c = clamp(chirp, -1.0, 1.0);
    const double dampHz = std::fmin(sr * 0.45, std::fmax(200.0, damping));
    target = stretchFor(transition);
    if (stretch == 0) stretch = target;
    const Settings settings = {
      stretch,
      kMaxCoefficient * c,
      -(0.3 + 0.4 * std::fabs(c)),
      std::fmin(kMaxLength, std::fmax(0.01, length)),
      std::fmax(0.05, decay),
      std::fmin(kMaxFeedback, std::fmax(0.0, feedback)),
      clamp(modulation, 0.0, 1.0) * kMaxWander * sr,
      1 - std::exp((-2 * M_PI * dampHz) / sr),
      std::fmin(sr * 0.45, std::fmax(10.0, lowCut)),
    };
    for (auto& s : springs) s.set(settings);
  }

  double shakeNoise() {
    uint32_t x = shakeSeed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    shakeSeed = x;
    return (static_cast<double>(x) / 4294967296.0) * 2 - 1;
  }

  void next(double x, double drive, double* out) {
    double input = x;
    if (shakeAt >= 0) {
      const int t = shakeAt;
      input += shakeLevel * kShakeNoiseLevel * shakeNoise() * std::exp(-t / fall);
      if (shakeThump && t < thump) input += shakeLevel * kShakeThumpLevel * std::sin((M_PI * t) / thump);
      shakeAt = t + 1 >= shakeLength ? -1 : t + 1;
    }
    const double g = std::fmax(1.0, drive);
    const double driven = std::tanh(input * g) / g;

    stretch += glide * (target - stretch);
    const int whole = static_cast<int>(std::floor(stretch - 0.5));
    const double d = stretch - whole;
    const double eta = (1 - d) / (1 + d);
    out[0] = springs[0].next(driven, whole, eta) * kWetGain;
    out[1] = springs[1].next(driven, whole, eta) * kWetGain;
  }
};

}  // namespace spring
}  // namespace pd_own
