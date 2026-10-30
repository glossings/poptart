// The FreqShift effect: single-sideband frequency shifting through a Hilbert pair.
//
// Translated from web-engine/src/devices/freqshift.mjs. Two chains of second-order allpasses
// whose outputs stay 90 degrees apart across the band; the first chain is read one sample late.

#include "own/pd-own.h"
#include "pd-own-ids.h"

namespace pd_FreqShift {

namespace ids = pd_ids::FreqShift;
using namespace pd_own;

constexpr int kStages = 4;

/** The chains' coefficients, already squared, exactly as the browser squares them. */
constexpr double kChainIRaw[kStages] = { 0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737 };
constexpr double kChainQRaw[kStages] = { 0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278 };

struct AllpassChain {
  double k[kStages] = { 0 };
  double x1[kStages] = { 0 };
  double x2[kStages] = { 0 };
  double y1[kStages] = { 0 };
  double y2[kStages] = { 0 };

  void init(const double* raw) { for (int s = 0; s < kStages; ++s) k[s] = raw[s] * raw[s]; }
  void reset() {
    for (int s = 0; s < kStages; ++s) { x1[s] = 0; x2[s] = 0; y1[s] = 0; y2[s] = 0; }
  }

  double next(double x) {
    double v = x;
    for (int s = 0; s < kStages; ++s) {
      const double y = k[s] * (v + y2[s]) - x2[s];
      x2[s] = x1[s]; x1[s] = v;
      y2[s] = y1[s]; y1[s] = y;
      v = y;
    }
    return v;
  }
};

/** One channel's Hilbert pair: a sample in, its in-phase and quadrature copies out. */
struct Hilbert {
  AllpassChain i;
  AllpassChain q;
  double iLate = 0;

  void init() { i.init(kChainIRaw); q.init(kChainQRaw); iLate = 0; }
  void reset() { i.reset(); q.reset(); iLate = 0; }

  void next(double x, double* out) {
    out[0] = iLate;
    out[1] = q.next(x);
    iLate = i.next(x);
  }
};

struct Device : pd_own::Device<ids::kCount> {
  Hilbert pairs[2];
  double fb[2] = { 0, 0 };
  double phase = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& h : pairs) h.init();
    fb[0] = 0;
    fb[1] = 0;
    phase = 0;
  }

  /** One channel, one sample: the single sideband of `x` at the oscillator. */
  double shift(int ch, double x, double c, double s, double feedback) {
    double iq[2];
    pairs[ch].next(x + fb[ch] * feedback, iq);
    const double y = iq[0] * c + iq[1] * s;
    fb[ch] = std::tanh(y);
    return y;
  }

  void pd_process(int frames) {
    // The sign of the frequency is the direction: the oscillator runs backwards for a shift
    // down, which keeps the lower sideband. Wide runs the right channel's the other way.
    const double signR = p[ids::wide] >= 0.5f ? -1 : 1;
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      phase += ctl(ids::freq, i) / sampleRate;
      phase -= std::floor(phase);
      const double w = 2 * M_PI * phase;
      const double c = std::cos(w);
      const double s = std::sin(w);
      const double feedback = ctl(ids::feedback, i);
      const double mix = ctl(ids::mix, i);
      const double l = inl[i];
      const double r = inr[i];
      const double wetL = shift(0, l, c, s, feedback);
      const double wetR = shift(1, r, c, s * signR, feedback);
      outl[i] = static_cast<float>(l + (wetL - l) * mix);
      outr[i] = static_cast<float>(r + (wetR - r) * mix);
    }
    if (frames > 0 && !isPlayable(outl[frames - 1])) {
      for (auto& h : pairs) h.reset();
      fb[0] = 0;
      fb[1] = 0;
    }
  }
};

}  // namespace pd_FreqShift

extern "C" PdAny* pd_make_FreqShift() { return new PdAdapter<pd_FreqShift::Device>(); }
