// The Chorus effect: up to three copies of the signal, each read at a delay an LFO moves.
//
// Translated from web-engine/src/devices/chorus.mjs. The rate follows the tempo when the sync is
// set to a division, which is what the transport hook is for.

#include "own/pd-own.h"
#include "own/dsp/moddelay.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Chorus {

namespace ids = pd_ids::Chorus;
using namespace pd_own;

struct Device : pd_own::Device<ids::kCount> {
  ModDelay<8192> delay;          // 80 ms at 96 kHz
  double bpm = 120;

  void pd_init(double sr) {
    sampleRate = sr;
    delay.init(sr, 0.08);
    bpm = 120;
  }

  void pd_transport(double tempo, double seconds) { (void)seconds; bpm = tempo; }

  void pd_process(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const int shape = jsRoundInt(p[ids::shape]);
    const int voices = static_cast<int>(clamp(jsRound(p[ids::voices]), 1.0, 3.0));
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
      delay.next(l, r, wet, baseSec, depthSec, rateHz, spread, 0.0, shape, voices);
      const double mix = ctl(ids::mix, i);
      outl[i] = static_cast<float>(l + (wet[0] - l) * mix);
      outr[i] = static_cast<float>(r + (wet[1] - r) * mix);
    }
    if (frames > 0 && !isPlayable(outl[frames - 1])) delay.reset();
  }
};

}  // namespace pd_Chorus

extern "C" PdAny* pd_make_Chorus() { return new PdAdapter<pd_Chorus::Device>(); }
