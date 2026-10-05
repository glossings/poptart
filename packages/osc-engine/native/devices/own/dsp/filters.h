// The filters: a state-variable core, a four-pole ladder, a one-pole tone control, a DC blocker,
// and the multi-mode filter that fronts all of them.
//
// Translated from web-engine/src/dsp/filters.mjs. Both main filters are the topology-preserving
// form rather than the textbook one, for the reason given there: the naive forms' cutoff drifts
// from where it was asked for as it approaches a quarter of the sample rate.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/**
 * Every response the Filter device offers, in panel order. SLOPES ARE SEPARATE ENTRIES: a slope
 * only means anything on the pass modes, so a knob for it would do nothing most of the time.
 *
 * The names are in web-engine/src/dsp/filters.mjs (FILTER_MODES) and the ORDER IS THAT LIST'S -
 * an index here is what a song holds.
 */
enum FilterMode {
  kLowpass6 = 0, kLowpass12, kLowpass24,
  kHighpass6, kHighpass12, kHighpass24,
  kBandpass12, kBandpass24,
  kModeNotch, kModePeak,
  kLadder,
  kComb, kAllpassMode, kFormant,
};

/** The five vowels the formant mode sweeps through, as the first three resonances of each. */
constexpr double kFormants[5][3] = {
  { 270, 2290, 3010 },   // ee
  { 530, 1840, 2480 },   // eh
  { 730, 1090, 2440 },   // ah
  { 570, 840, 2410 },    // oh
  { 300, 870, 2240 },    // oo
};
constexpr int kFormantCount = 5;

constexpr double kMinCutoffHz = 20.0;

/**
 * A topology-preserving state-variable filter: lowpass, highpass, bandpass and notch off the
 * same two integrators, so switching mode costs nothing and never re-tunes the filter.
 */
struct Svf {
  double sampleRate = 48000.0;
  double ic1 = 0, ic2 = 0;
  double g = 0, k = 2, a1 = 0, a2 = 0, a3 = 0;

  void init(double sr) { sampleRate = sr; setCutoff(1000, 0); }
  void reset() { ic1 = 0; ic2 = 0; }

  /** `resonance` is 0..1, mapped so that 1 is just short of self-oscillation. */
  void setCutoff(double hz, double resonance) {
    const double nyquist = sampleRate * 0.5;
    const double f = std::fmin(nyquist * 0.99, std::fmax(kMinCutoffHz, hz));
    g = std::tan((M_PI * f) / sampleRate);
    k = 2.0 - 1.98 * clamp(resonance, 0.0, 1.0);
    a1 = 1.0 / (1.0 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  }

  /** Takes another filter's tuning, so a stereo pair costs one tangent a sample and not two. */
  void follow(const Svf& o) { g = o.g; k = o.k; a1 = o.a1; a2 = o.a2; a3 = o.a3; }

  /** One sample, in one of the core's four shapes (0 lowpass, 1 highpass, 2 bandpass, 3 notch). */
  double next(double input, int mode) {
    const double v3 = input - ic2;
    const double v1 = a1 * ic1 + a2 * v3;
    const double v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    switch (mode) {
      case 1: return input - k * v1 - v2;    // highpass
      case 2: return v1;                     // bandpass
      case 3: return input - k * v1;         // notch
      default: return v2;                    // lowpass
    }
  }
};

/** A cheap, well-behaved saturator for the ladder's feedback path. */
inline double softClip(double x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const double x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/**
 * A four-pole ladder lowpass with a saturated feedback path: the mode that is supposed to color
 * the sound rather than get out of its way. The feedback is solved at the loop's input rather
 * than taken a sample late, so the resonance peak lands on the number the cutoff says.
 */
struct Ladder {
  double sampleRate = 48000.0;
  double s[4] = { 0, 0, 0, 0 };
  double G = 0, G4 = 0, k = 0, drive = 1;

  void init(double sr) { sampleRate = sr; setCutoff(1000, 0); }
  void reset() { s[0] = s[1] = s[2] = s[3] = 0; }

  void setCutoff(double hz, double resonance) {
    const double nyquist = sampleRate * 0.5;
    const double f = std::fmin(nyquist * 0.49, std::fmax(kMinCutoffHz, hz));
    const double g = std::tan((M_PI * f) / sampleRate);
    G = g / (1 + g);
    G4 = G * G * G * G;
    // Four is where the linear loop self-oscillates; the top of the knob stops just short of it.
    k = 4.0 * clamp(resonance, 0.0, 1.0) * 0.98;
  }

  void follow(const Ladder& o) { G = o.G; G4 = o.G4; k = o.k; drive = o.drive; }

  double next(double input) {
    // What the four stages would output right now with nothing new at the input.
    const double settled = (1 - G) * (G * G * G * s[0] + G * G * s[1] + G * s[2] + s[3]);
    const double u = softClip((input * drive - k * settled) / (1 + k * G4));
    double x = u;
    for (int i = 0; i < 4; ++i) {
      const double v = (x - s[i]) * G;
      const double y = v + s[i];
      s[i] = y + v;
      x = y;
    }
    return x;
  }
};

/** A one-pole lowpass, used where a filter is a tone control rather than an instrument. */
struct OnePole {
  double sampleRate = 48000.0;
  double a = 1, target = 1, z = 0;
  int steps = 0;

  void init(double sr) { sampleRate = sr; setCutoff(20000); }
  void reset() { z = 0; }

  double coefficient(double hz) const {
    const double nyquist = sampleRate * 0.5;
    const double f = std::fmin(nyquist * 0.99, std::fmax(1.0, hz));
    return 1.0 - std::exp((-2.0 * M_PI * f) / sampleRate);
  }

  void setCutoff(double hz) { a = coefficient(hz); target = a; steps = 0; }

  /** Aims at a corner, reached over `steps` samples - a tone control inside a feedback path. */
  void glideTo(double hz, int inSteps) {
    target = coefficient(hz);
    steps = inSteps > 0 ? inSteps : 0;
    if (steps == 0) a = target;
  }

  double next(double input) {
    if (steps > 0) {
      a += (target - a) / steps;
      steps -= 1;
    }
    z += a * (input - z);
    return z;
  }
};

/**
 * A DC blocker. A waveshaper fed an asymmetric drive puts an offset on its output, and an offset
 * costs headroom on every later stage without being audible itself.
 */
struct DcBlocker {
  double r = 0, x1 = 0, y1 = 0;

  void init(double sampleRate, double cutoffHz = 20.0) {
    // The pole has to be placed in radians per sample, not cycles.
    r = std::fmax(0.0, 1.0 - (2.0 * M_PI * cutoffHz) / sampleRate);
  }
  void reset() { x1 = 0; y1 = 0; }

  double next(double input) {
    const double y = input - x1 + r * y1;
    x1 = input;
    y1 = y;
    return y;
  }
};

/** One first-order allpass: unity gain, a phase turn that sweeps with the coefficient. */
struct Allpass1 {
  double a = 0, x1 = 0, y1 = 0;
  void reset() { x1 = 0; y1 = 0; }
  double next(double x) {
    const double y = a * (x + y1) - x1;
    x1 = x;
    y1 = y;
    return y;
  }
};

/** How long the comb mode's delay line is, in seconds: the lowest note it can be tuned to. */
constexpr double kCombMaxSec = 0.05;
/** How many allpass sections the allpass mode runs. Four is two notches, which is the sound. */
constexpr int kAllpassStages = 4;
/** The comb line, sized for the highest rate a server is likely to run at. */
constexpr int kCombMax = static_cast<int>(kCombMaxSec * 192000.0) + 8;

/**
 * Every filter response behind one interface, so a device switching mode does not switch code.
 * A few hundred bytes of state per channel that is mostly asleep, against one filter that can be
 * any of these without the device knowing which.
 */
struct MultiFilter {
  double sampleRate = 48000.0;
  Svf svf[2];
  Ladder ladder;
  double one = 0;        // the one-pole's state, for the 6 dB slopes
  double oneA = 0;
  double apFb = 0;       // what the allpass chain last put out, for its feedback
  float comb[kCombMax] = { 0 };
  int combSize = 0;      // how much of the line this sample rate uses
  int combAt = 0;
  double combLen = 100;
  double combFb = 0;
  Allpass1 allpass[kAllpassStages];
  double apGain = 0;
  Svf formant[3];
  double formantGain[3] = { 0, 0, 0 };

  void init(double sr) {
    sampleRate = sr;
    for (auto& f : svf) f.init(sr);
    ladder.init(sr);
    for (auto& f : formant) f.init(sr);
    combSize = static_cast<int>(std::ceil(kCombMaxSec * sr)) + 4;
    if (combSize > kCombMax) combSize = kCombMax;
    reset();
  }

  void reset() {
    for (auto& f : svf) f.reset();
    ladder.reset();
    one = 0;
    apFb = 0;
    for (int i = 0; i < combSize; ++i) comb[i] = 0;
    combAt = 0;
    for (auto& a : allpass) a.reset();
    for (auto& f : formant) f.reset();
  }

  void setDrive(double value) { ladder.drive = value; }

  /** Tunes whichever structure the mode uses. Cheap for the ones it does not. */
  void setCutoff(double hz, double resonance, int mode) {
    const double nyquist = sampleRate * 0.5;
    const double f = std::fmin(nyquist * 0.49, std::fmax(kMinCutoffHz, hz));
    switch (mode) {
      case kLadder:
        ladder.setCutoff(f, resonance);
        return;
      case kLowpass6:
      case kHighpass6:
        oneA = 1.0 - std::exp((-2.0 * M_PI * f) / sampleRate);
        return;
      case kComb: {
        // The cutoff IS the comb's pitch: the delay is one period of it. Resonance is the
        // feedback, which is what makes it ring.
        combLen = std::fmin(combSize - 2, std::fmax(2.0, sampleRate / f));
        combFb = clamp(resonance, 0.0, 0.98) * 0.98;
        return;
      }
      case kAllpassMode: {
        const double t = std::tan((M_PI * f) / sampleRate);
        const double a = (t - 1) / (t + 1);
        for (auto& stage : allpass) stage.a = a;
        apGain = clamp(resonance, 0.0, 1.0) * 0.7;
        return;
      }
      case kFormant: {
        // The cutoff sweeps THROUGH the vowels rather than moving one of them.
        const double at = (std::log(f / kMinCutoffHz) / std::log((nyquist * 0.49) / kMinCutoffHz))
            * (kFormantCount - 1);
        int lo = static_cast<int>(std::floor(at));
        if (lo < 0) lo = 0;
        if (lo > kFormantCount - 1) lo = kFormantCount - 1;
        const int hi = lo + 1 > kFormantCount - 1 ? kFormantCount - 1 : lo + 1;
        const double mix = at - lo;
        // Narrower as the resonance goes up, which is what makes a vowel read as a vowel.
        const double q = 0.35 + 0.6 * clamp(resonance, 0.0, 1.0);
        for (int i = 0; i < 3; ++i) {
          const double center = kFormants[lo][i] + (kFormants[hi][i] - kFormants[lo][i]) * mix;
          formant[i].setCutoff(center, q);
          // The higher resonances are quieter in a real vowel, or the bank sounds like a whistle.
          formantGain[i] = i == 0 ? 1.0 : (i == 1 ? 0.5 : 0.25);
        }
        return;
      }
      default:
        svf[0].setCutoff(f, resonance);
        // THE SECOND SECTION OF A CASCADE TAKES NO RESONANCE: two resonant sections in series
        // multiply their peaks, which is not a filter with a lot of resonance.
        if (mode == kLowpass24 || mode == kHighpass24 || mode == kBandpass24) {
          svf[1].setCutoff(f, 0);
        }
        return;
    }
  }

  void follow(const MultiFilter& o) {
    svf[0].follow(o.svf[0]);
    svf[1].follow(o.svf[1]);
    ladder.follow(o.ladder);
    oneA = o.oneA;
    combLen = o.combLen;
    combFb = o.combFb;
    for (int i = 0; i < kAllpassStages; ++i) allpass[i].a = o.allpass[i].a;
    apGain = o.apGain;
    for (int i = 0; i < 3; ++i) { formant[i].follow(o.formant[i]); formantGain[i] = o.formantGain[i]; }
  }

  /** Reads the comb line `len` samples back, interpolated, so a swept pitch glides. */
  double combRead(double len) const {
    const double n = combSize;
    const double at = combAt - len;
    const double wrapped = at - std::floor(at / n) * n;
    const int i = static_cast<int>(std::floor(wrapped));
    const double frac = wrapped - i;
    const double a = comb[i];
    const double b = comb[(i + 1) % combSize];
    return a + (b - a) * frac;
  }

  double next(double x, int mode) {
    switch (mode) {
      case kLadder:
        return ladder.next(x);
      case kLowpass6:
        one += oneA * (x - one);
        return one;
      case kHighpass6:
        one += oneA * (x - one);
        return x - one;
      case kLowpass24:
        return svf[1].next(svf[0].next(x, 0), 0);
      case kHighpass24:
        return svf[1].next(svf[0].next(x, 1), 1);
      case kBandpass24:
        // Normalized at each stage - see the note on the bandpass below.
        return svf[1].next(svf[0].next(x, 2) * svf[0].k, 2) * svf[1].k;
      case kModePeak: {
        // The bandpass added back to the signal: a resonant lift at the cutoff that leaves
        // everything either side of it alone.
        const double band = svf[0].next(x, 2) * svf[0].k;
        return x + band * (2 - svf[0].k) * 4;
      }
      case kComb: {
        const double read = combRead(combLen);
        const double write = x + read * combFb;
        comb[combAt] = isPlayable(write) ? static_cast<float>(write) : 0.f;
        combAt = (combAt + 1) % combSize;
        // Summed rather than replaced: a comb is a signal against a copy of itself.
        return (x + read) * 0.5;
      }
      case kAllpassMode: {
        double y = x + apFb * apGain;
        for (auto& stage : allpass) y = stage.next(y);
        apFb = isPlayable(y) ? y : 0;
        return (x + y) * 0.5;
      }
      case kFormant: {
        double y = 0;
        for (int i = 0; i < 3; ++i) y += formant[i].next(x, 2) * formantGain[i];
        return y * 1.4;
      }
      case kHighpass12:
        return svf[0].next(x, 1);
      case kBandpass12:
        // NORMALIZED: the core's bandpass output has a gain of one over the damping at the
        // center, so turning the resonance up made the band louder as well as narrower.
        return svf[0].next(x, 2) * svf[0].k;
      case kModeNotch:
        return svf[0].next(x, 3);
      default:
        return svf[0].next(x, 0);
    }
  }
};

}  // namespace pd_own
