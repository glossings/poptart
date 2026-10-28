// The Compressor effect: a feed-forward compressor with a soft knee and a parallel mix.
//
// Translated from web-engine/src/devices/compressor.mjs. It takes a sidechain, so it asks the
// host for four input channels: its own pair and the key's. The browser's half also keeps a
// second of history for the lane the panel scrolls; a meter is the panel's business and there is
// no panel here, so the history is not translated.

#include "own/pd-own.h"
#include "own/dsp/dynamics.h"
#include "pd-own-ids.h"

namespace pd_Compressor {

namespace ids = pd_ids::Compressor;
using namespace pd_own;

struct Device : pd_own::Device<ids::kCount, 4> {
  Detector detector;
  double lastAttack = -1, lastRelease = -1;
  bool keyed = false;

  void pd_init(double sr) {
    sampleRate = sr;
    detector.init(sr);
    lastAttack = -1;
    lastRelease = -1;
  }

  /**
   * Whether anything is routed into the key input.
   *
   * It matters for more than whether to listen to the key: with nothing routed in the browser's
   * processor listens to its LEFT channel on both sides (`keyR = sidechain?.[1] ?? keyL`), and
   * with a key it listens to both of the key's. So an unkeyed compressor here has to do the
   * same, or a mono-summed key would duck a stereo track differently on the two engines.
   */
  void pd_key_patched(bool on) { keyed = on; }

  void pd_process(int frames) {
    const double attack = p[ids::attack];
    const double release = p[ids::release];
    if (attack != lastAttack || release != lastRelease) {
      detector.setTimes(attack, release);
      lastAttack = attack;
      lastRelease = release;
    }

    const float* inl = inL();
    const float* inr = inR();
    const float* keyl = keyL();
    const float* keyr = keyR();
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      // The two channels are linked on the louder of the key's, so the image does not lean.
      const double key = keyed ? std::fmax(std::fabs(keyl[i]), std::fabs(keyr[i]))
                                : std::fabs(keyl[i]);
      const double env = detector.next(key);
      const double gr = gainComputer(dbOf(env), ctl(ids::threshold, i), ctl(ids::ratio, i),
                                     ctl(ids::knee, i));
      const double g = dbToGain(gr + ctl(ids::makeup, i));
      const double mix = ctl(ids::mix, i);
      outl[i] = static_cast<float>(l + (l * g - l) * mix);
      outr[i] = static_cast<float>(r + (r * g - r) * mix);
    }
    // A NaN compares false against the envelope and is then added into it, and from there on
    // every sample's gain is NaN: the detector starts again from silence instead.
    if (!isPlayable(detector.env)) detector.reset();
  }
};

}  // namespace pd_Compressor

extern "C" PdAny* pd_make_Compressor() { return new PdAdapter<pd_Compressor::Device>(); }
