// The Crush effect: bit depth and sample rate, thrown away on purpose.
//
// Translated from web-engine/src/devices/crush.mjs. Nothing here is oversampled and there is no
// DC blocker, both on purpose: folding IS the effect, and a blocker would turn the flat held
// steps into slopes.

#include "own/pd-own.h"
#include "own/dsp/filters.h"
#include "pd-own-ids.h"

namespace pd_Crush {

namespace ids = pd_ids::Crush;
using namespace pd_own;

/** The top of the rate control, where the hold is switched off rather than run at this rate. */
constexpr double kRateTop = 24000.0;

/** One channel: what it is holding, how far through the hold it is, and the tone filter after. */
struct CrushChannel {
  OnePole tone;
  double hold = 0;
  double phase = 0;
  unsigned int seed = 2463534242u;

  void init(double sr) { tone.init(sr); hold = 0; phase = 0; seed = 2463534242u; }
  void reset() { tone.reset(); hold = 0; phase = 0; }

  /** The jitter's random walk. Per channel, so the two sides decorrelate and it reads as noise. */
  double random() {
    unsigned int x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    seed = x;
    return static_cast<double>(x) / 4294967296.0;
  }
};

struct Device : pd_own::Device<ids::kCount> {
  CrushChannel channels[2];
  double lastTone = -1;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& c : channels) c.init(sr);
    lastTone = -1;
  }

  void pd_process(int frames) {
    const double toneHz = p[ids::tone];
    if (toneHz != lastTone) {
      for (auto& c : channels) c.tone.glideTo(toneHz, frames);
      lastTone = toneHz;
    }
    for (int ch = 0; ch < 2; ++ch) {
      const float* input = ch == 0 ? inL() : inR();
      float* out = ch == 0 ? outL() : outR();
      CrushChannel& c = channels[ch];
      for (int i = 0; i < frames; ++i) {
        const double dry = input[i];
        // Sample and hold. The phase carries across blocks, so the held rate is steady rather
        // than restarting every block. At the top of the range, or at a rate the engine already
        // runs at, every sample is taken as it comes and only the bit depth is applied.
        const double target = std::fmax(1.0, ctl(ids::rate, i));
        bool take = true;
        if (target < kRateTop && target < sampleRate) {
          const double jitter = clamp(ctl(ids::jitter, i), 0.0, 1.0);
          c.phase += (target * (1.0 - jitter * 0.5 * c.random())) / sampleRate;
          take = c.phase >= 1.0;
          if (take) c.phase -= std::floor(c.phase);
        }
        if (take) {
          // Levels either side of zero: 2^bits - 1 steps would overshoot full scale by half a
          // step at the very top, which is a quiet click on every peak.
          const double bits = clamp(ctl(ids::bits, i), 1.0, 16.0);
          const double levels = std::pow(2.0, bits - 1.0);
          const double clamped = dry < -1 ? -1 : (dry > 1 ? 1 : dry);
          c.hold = jsRound(clamped * levels) / levels;
        }
        double wet = c.hold;
        if (toneHz < 19999) wet = c.tone.next(wet);
        const double mix = clamp(ctl(ids::mix, i), 0.0, 1.0);
        out[i] = static_cast<float>((dry * (1 - mix) + wet * mix) * dbToGain(ctl(ids::output, i)));
      }
      if (frames > 0 && !isPlayable(out[frames - 1])) c.reset();
    }
  }
};

}  // namespace pd_Crush

extern "C" PdAny* pd_make_Crush() { return new PdAdapter<pd_Crush::Device>(); }
