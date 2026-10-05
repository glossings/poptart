// A feedback delay network reverb, and the delay line every echo here is built on.
//
// Translated from web-engine/src/dsp/reverb.mjs: a short predelay, a diffusing chain of
// allpasses, then eight delay lines with a Householder feedback matrix between them, damped so
// the tail gets darker as it decays.
//
// The one difference from the browser's is where the memory comes from. A page allocates each
// line for the sample rate it finds itself at; a server plugin cannot allocate on the audio
// thread, so the lines are fixed arrays sized for 96 kHz - twice the rate anything here is
// expected to run at, and the sizing is otherwise the same arithmetic. Above 96 kHz the lines
// stop growing, which shortens the room rather than failing.
#pragma once

#include <cmath>
#include <cstring>

#include "own/pd-own.h"

namespace pd_own {

/** Delay-line lengths in samples at 48 kHz, scaled for other rates. Primes, spread over ~80 ms. */
constexpr int kLinePrimes[8] = { 1289, 1499, 1747, 1999, 2281, 2543, 2801, 3079 };
/** Allpass lengths for the diffuser, also prime and much shorter. */
constexpr int kAllpassPrimes[4] = { 223, 337, 457, 587 };
constexpr double kReferenceRate = 48000.0;

/** How much of the input each delay line takes, and how much of each line the output takes. */
constexpr double kInputGain = 0.5;
constexpr double kOutputGain = 0.75;

/**
 * Added to every value written back into the loop: a float that gets close enough to zero is a
 * denormal, which the processor handles many times slower - on a thread with a deadline.
 */
constexpr double kFloor = 1e-20;

/**
 * A delay line with a movable read point, sized once and never reallocated.
 *
 * A power-of-two buffer turns the wrap into a mask, which matters in a loop that runs eight
 * times per sample per channel.
 */
template <int Capacity>
struct DelayLine {
  float buffer[Capacity] = { 0 };
  int mask = Capacity - 1;
  int pos = 0;

  /** Sized exactly as the browser sizes it: the next power of two at or above `maxSamples`. */
  void init(int maxSamples) {
    int size = 16;
    while (size < maxSamples && size < Capacity) size *= 2;
    mask = size - 1;
    pos = 0;
    reset();
  }

  void reset() {
    std::memset(buffer, 0, sizeof(buffer));
    pos = 0;
  }

  void write(double v) {
    buffer[pos] = static_cast<float>(v);
    pos = (pos + 1) & mask;
  }

  double read(int delay) const { return buffer[(pos - delay) & mask]; }

  /**
   * Reads at a FRACTIONAL delay. The modulation moves the delay lengths slowly to break up the
   * ringing a still network develops, and rounding that movement to whole samples defeats it.
   */
  double readLinear(double delay) const {
    const int whole = static_cast<int>(std::floor(delay));
    const double frac = delay - whole;
    const double a = buffer[(pos - whole) & mask];
    const double b = buffer[(pos - whole - 1) & mask];
    return a + (b - a) * frac;
  }
};

/** A Schroeder allpass: passes everything at equal level but smears it in time. */
template <int Capacity>
struct Allpass {
  DelayLine<Capacity> line;
  int length = 4;
  double gain = 0.6;

  void init(int n) { length = n; line.init(n + 4); }
  void reset() { line.reset(); }

  double next(double x) {
    const double delayed = line.read(length);
    const double v = x + delayed * -gain;
    line.write(v);
    return delayed + v * gain;
  }
};

/** The network. The capacities are the 96 kHz sizes of the longest line and the predelay. */
struct Reverb {
  static constexpr int kLineCapacity = 8192;      // 3079 * 2 + 8, rounded up
  static constexpr int kAllpassCapacity = 2048;   // 587 * 1.17 * 2 + 4, rounded up
  static constexpr int kPreCapacity = 32768;      // a quarter of a second at 96 kHz

  double sampleRate = 48000.0;
  int lineLengths[8] = { 0 };
  DelayLine<kLineCapacity> lines[8];
  // One diffuser per side, with the right side's lengths nudged so the two channels decorrelate.
  Allpass<kAllpassCapacity> diffuseL[4];
  Allpass<kAllpassCapacity> diffuseR[4];

  double feedback[8] = { 0 };
  double damp[8] = { 0 };         // one-pole state per line
  DelayLine<kPreCapacity> preDelay;
  int preDelaySamples = 0;

  double size = 1;
  double decayGain = 0.8;
  double dampCoef = 0.3;
  double modPhase = 0;
  double modDepth = 0;
  double lowCutState = 0;
  double lowCutCoef = 0;

  void init(double sr) {
    sampleRate = sr;
    const double scale = sr / kReferenceRate;
    for (int k = 0; k < 8; ++k) {
      lineLengths[k] = static_cast<int>(jsRound(kLinePrimes[k] * scale));
      if (lineLengths[k] < 8) lineLengths[k] = 8;
      lines[k].init(lineLengths[k] + 8);
    }
    for (int k = 0; k < 4; ++k) {
      int l = static_cast<int>(jsRound(kAllpassPrimes[k] * scale));
      if (l < 4) l = 4;
      diffuseL[k].init(l);
      int r = static_cast<int>(jsRound(kAllpassPrimes[k] * 1.17 * scale));
      if (r < 4) r = 4;
      diffuseR[k].init(r);
    }
    preDelay.init(static_cast<int>(std::ceil(sr * 0.25)) + 8);
    preDelaySamples = 0;
    size = 1;
    decayGain = 0.8;
    dampCoef = 0.3;
    modPhase = 0;
    modDepth = 0;
    lowCutState = 0;
    lowCutCoef = 0;
  }

  void reset() {
    for (auto& l : lines) l.reset();
    for (auto& a : diffuseL) a.reset();
    for (auto& a : diffuseR) a.reset();
    for (int k = 0; k < 8; ++k) { feedback[k] = 0; damp[k] = 0; }
    preDelay.reset();
    lowCutState = 0;
  }

  /** `decay` is the RT60 in seconds: how long the tail takes to fall by sixty decibels. */
  void set(double decay, double sizeWant, double damping, double preDelaySec, double lowCut,
           double modulation) {
    size = clamp(sizeWant, 0.05, 1.0);
    const double seconds = std::fmax(0.05, decay);
    // The mean loop time of the network, which is what a round trip costs.
    double sum = 0;
    for (int k = 0; k < 8; ++k) sum += lineLengths[k];
    const double meanDelay = (sum / 8.0) * size / sampleRate;
    decayGain = std::fmin(0.9999, std::pow(10.0, (-3.0 * meanDelay) / seconds));
    const double dampHz = clamp(damping, 200.0, sampleRate * 0.49);
    dampCoef = 1.0 - std::exp((-2.0 * M_PI * dampHz) / sampleRate);
    int pre = static_cast<int>(jsRound(preDelaySec * sampleRate));
    if (pre < 0) pre = 0;
    if (pre > preDelay.mask - 4) pre = preDelay.mask - 4;
    preDelaySamples = pre;
    const double cutHz = clamp(lowCut, 10.0, 2000.0);
    lowCutCoef = 1.0 - std::exp((-2.0 * M_PI * cutHz) / sampleRate);
    modDepth = std::fmax(0.0, modulation) * 12.0;
  }

  /**
   * Renders one block. The feedback matrix is a Householder reflection: each line gets back the
   * sum of all of them minus twice its own share, written as one sum and eight subtractions.
   */
  void process(const float* inl, const float* inr, float* wetOutL, float* wetOutR, int count) {
    const double modRate = (2.0 * M_PI * 0.7) / sampleRate;
    for (int i = 0; i < count; ++i) {
      const double dry = (inl[i] + inr[i]) * 0.5;
      preDelay.write(dry);
      const double x = preDelaySamples > 0 ? preDelay.read(preDelaySamples) : dry;

      double l = x;
      double r = x;
      for (auto& a : diffuseL) l = a.next(l);
      for (auto& a : diffuseR) r = a.next(r);

      modPhase += modRate;
      if (modPhase > M_PI * 2) modPhase -= M_PI * 2;

      // Read every line, damp it, and sum for the matrix.
      double sum = 0;
      for (int k = 0; k < 8; ++k) {
        const double wobble = modDepth > 0 ? modDepth * std::sin(modPhase + k) : 0;
        const double want = lineLengths[k] * size + wobble;
        const double delay = clamp(want, 2.0, static_cast<double>(lines[k].mask - 2));
        double v = modDepth > 0 ? lines[k].readLinear(delay)
                                : lines[k].read(static_cast<int>(jsRound(delay)));
        // A one-pole in each loop: the tail loses its top as it goes round, which is what stops
        // an algorithmic reverb sounding like a metal pipe.
        damp[k] += dampCoef * (v - damp[k]);
        v = damp[k];
        feedback[k] = v;
        sum += v;
      }
      const double share = (2.0 / 8.0) * sum;

      for (int k = 0; k < 8; ++k) {
        const double routed = (feedback[k] - share) * decayGain;
        // The input goes in on alternate lines from each side, so the channels stay apart.
        lines[k].write(routed + (k % 2 == 0 ? l : r) * kInputGain + kFloor);
      }

      // Two different sums for the two outputs, so the result is genuinely stereo.
      double wl = 0;
      double wr = 0;
      for (int k = 0; k < 8; ++k) {
        if (k % 2 == 0) wl += feedback[k];
        else wr += feedback[k];
      }
      wl *= kOutputGain;
      wr *= kOutputGain;

      // A reverb with a DC or sub-bass build-up gets muddy and never stops, so the tail is
      // high-passed on the way out rather than being left to accumulate in the loop.
      const double mono = (wl + wr) * 0.5;
      lowCutState += lowCutCoef * (mono - lowCutState);
      wetOutL[i] = static_cast<float>(wl - lowCutState);
      wetOutR[i] = static_cast<float>(wr - lowCutState);
    }
  }
};

}  // namespace pd_own
