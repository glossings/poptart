// The Flanger effect: one short modulated delay with resonance.
//
// Translated from web-engine/src/devices/flanger.mjs. The chorus and the flanger differ in their
// ranges and in nothing else, which is why they share a delay line (own/dsp/moddelay.h).

#include "own/pd-own.h"
#include "own/dsp/moddelay.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Flanger {

namespace ids = pd_ids::Flanger;
using namespace pd_own;

struct Device : pd_own::Device<ids::kCount> {
  ModDelay<4096> delay;          // 30 ms at 96 kHz
  double bpm = 120;

  void pd_init(double sr) {
    sampleRate = sr;
    delay.init(sr, 0.03);
    bpm = 120;
  }

  void pd_transport(double tempo, double seconds) { (void)seconds; bpm = tempo; }

  void pd_process(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const int shape = jsRoundInt(p[ids::shape]);
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    double wet[2];
    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      const double baseSec = ctl(ids::delay, i) * 0.001;
      const double depthSec = ctl(ids::depth, i) * 0.001;
      const double rateHz = syncedHz(sync, bpm, ctl(ids::rate, i));
      const double spread = ctl(ids::spread, i);
      const double feedback = ctl(ids::feedback, i);
      delay.next(l, r, wet, baseSec, depthSec, rateHz, spread, feedback, shape, 1);
      const double mix = ctl(ids::mix, i);
      outl[i] = static_cast<float>(l + (wet[0] - l) * mix);
      outr[i] = static_cast<float>(r + (wet[1] - r) * mix);
    }
    if (frames > 0 && !isPlayable(outl[frames - 1])) delay.reset();
  }
};

}  // namespace pd_Flanger

extern "C" PdAny* pd_make_Flanger() { return new PdAdapter<pd_Flanger::Device>(); }
