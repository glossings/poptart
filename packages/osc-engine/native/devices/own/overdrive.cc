// The Overdrive effect: distortion applied to one region of the spectrum and nothing else.
//
// Translated from web-engine/src/devices/overdrive.mjs. The signal is split at two corners and
// only what lies between is driven; what lies outside passes clean and is added back, which is
// what keeps a driven bass from turning to mud below and fizz above.

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "own/dsp/dynamics.h"
#include "own/dsp/filters.h"
#include "pd-own-ids.h"

namespace pd_Overdrive {

namespace ids = pd_ids::Overdrive;
using namespace pd_own;

/** One channel: the region's two corners, the level detector, the tone. */
struct DriveChannel {
  Biquad hp;
  Biquad lp;
  OnePole tone;
  Detector detector;

  void init(double sr) {
    hp = Biquad();
    lp = Biquad();
    tone.init(sr);
    detector.init(sr);
    detector.setTimes(5, 80);
  }

  void reset() { hp.reset(); lp.reset(); tone.reset(); detector.reset(); }
};

struct Device : pd_own::Device<ids::kCount> {
  DriveChannel channels[2];
  double lastLow = -1, lastHigh = -1, lastTone = -1;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& c : channels) c.init(sr);
    lastLow = -1;
    lastHigh = -1;
    lastTone = -1;
  }

  void pd_process(int frames) {
    const double low = p[ids::low];
    const double high = std::fmax(low, p[ids::high]);
    const double tone = p[ids::tone];
    if (low != lastLow || high != lastHigh || tone != lastTone) {
      for (auto& c : channels) {
        // Glided across the block: the driven region is what this device is FOR, so its two
        // corners are dragged about constantly and a per-block jump is heard on every drag.
        c.hp.glideTo(kHighPass, low, 0, M_SQRT1_2, sampleRate, frames);
        c.lp.glideTo(kLowPass, high, 0, M_SQRT1_2, sampleRate, frames);
        c.tone.glideTo(tone, frames);
      }
      lastLow = low;
      lastHigh = high;
      lastTone = tone;
    }
    for (int ch = 0; ch < 2; ++ch) {
      const float* input = ch == 0 ? inL() : inR();
      float* out = ch == 0 ? outL() : outR();
      DriveChannel& c = channels[ch];
      for (int i = 0; i < frames; ++i) {
        const double x = input[i];
        const double region = c.lp.next(c.hp.next(x));
        const double rest = x - region;
        // The dynamics: a gentle upward lift on the region toward a fixed level.
        const double dyn = ctl(ids::dynamics, i);
        const double env = c.detector.next(std::fabs(region));
        const double lift = dyn > 0 ? std::pow(std::fmax(1e-4, env) / 0.25, -0.7 * dyn) : 1.0;
        const double drive = dbToGain(ctl(ids::drive, i));
        const double driven = std::tanh(region * std::fmin(lift, 16.0) * drive) / std::tanh(std::fmin(drive, 4.0) * 0.5 + 0.5);
        const double wet = c.tone.next(driven) * 0.7 + rest;
        const double mix = ctl(ids::mix, i);
        out[i] = static_cast<float>(x + (wet - x) * mix);
      }
      if (frames > 0 && (!isPlayable(out[frames - 1]) || !isPlayable(c.detector.env))) c.reset();
    }
  }
};

}  // namespace pd_Overdrive

extern "C" PdAny* pd_make_Overdrive() { return new PdAdapter<pd_Overdrive::Device>(); }
