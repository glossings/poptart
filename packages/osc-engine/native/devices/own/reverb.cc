// The Reverb effect: the feedback delay network, with a mix and an output trim.
//
// Translated from web-engine/src/devices/reverb.mjs. The network's geometry is set per block:
// these are room controls, not modulation targets, and moving a delay length per sample is a
// pitch shift rather than a change of room.

#include "own/pd-own.h"
#include "own/dsp/reverb.h"
#include "pd-own-ids.h"

namespace pd_Reverb {

namespace ids = pd_ids::Reverb;
using namespace pd_own;

struct Device : pd_own::Device<ids::kCount> {
  Reverb reverb;
  // Float, as the browser's scratch buffers are: the wet signal is rounded to a float there, so
  // rounding it anywhere else here would be a difference of its own.
  float wetL[kBlock] = { 0 };
  float wetR[kBlock] = { 0 };
  bool haveLast = false;
  double last[6] = { 0, 0, 0, 0, 0, 0 };

  void pd_init(double sr) {
    sampleRate = sr;
    reverb.init(sr);
    haveLast = false;
  }

  void pd_process(int frames) {
    const double want[6] = {
      p[ids::decay], p[ids::size], p[ids::damping],
      p[ids::predelay], p[ids::lowcut], p[ids::modulation],
    };
    bool changed = !haveLast;
    for (int k = 0; k < 6 && !changed; ++k) if (last[k] != want[k]) changed = true;
    if (changed) {
      reverb.set(want[0], want[1], want[2], want[3], want[4], want[5]);
      for (int k = 0; k < 6; ++k) last[k] = want[k];
      haveLast = true;
    }

    const float* inl = inL();
    const float* inr = inR();
    reverb.process(inl, inr, wetL, wetR, frames);

    const double mix = clamp(p[ids::mix], 0.0, 1.0);
    const double gain = dbToGain(p[ids::output]);
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      outl[i] = static_cast<float>((inl[i] * (1 - mix) + wetL[i] * mix) * gain);
      outr[i] = static_cast<float>((inr[i] * (1 - mix) + wetR[i] * mix) * gain);
    }
  }
};

}  // namespace pd_Reverb

extern "C" PdAny* pd_make_Reverb() { return new PdAdapter<pd_Reverb::Device>(); }
