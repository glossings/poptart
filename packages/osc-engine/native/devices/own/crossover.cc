// The Crossover: one Linkwitz-Riley split, what .bands() is built from.
//
// Translated from web-engine/src/devices/crossover.mjs, which says why it has three outputs and
// what each is for: the band below the frequency (the slot's own pair), the rest above it, and
// the key through the same pair's all-pass. The key is the second pair of its input, fed by the
// track's own wiring (see buildTrackDef in poptart.scd), never by a route somebody patches.

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "pd-own-ids.h"

namespace pd_Crossover {

namespace ids = pd_ids::Crossover;
using namespace pd_own;

// Four channels in (its own pair, then the key's) and six out (three pairs).
struct Device : pd_own::Device<ids::kCount, 4, 6> {
  Crossover main[2];
  Crossover key[2];
  double last = -1;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& x : main) x.init(sr);
    for (auto& x : key) x.init(sr);
    last = -1;
  }

  /** Moves the split to `hz` over `steps` samples; the first setting is taken outright. */
  void retune(double hz, int steps) {
    main[0].setFrequency(hz, last < 0 ? 0 : steps);
    main[1].follow(main[0]);
    key[0].follow(main[0]);
    key[1].follow(main[0]);
    last = hz;
  }

  // A frequency a signal moves is followed sample by sample; otherwise it glides across the call.
  void pd_process(int frames) {
    const bool moving = isMoving(ids::frequency);
    if (!moving) {
      const double hz = p[ids::frequency];
      if (hz != last) retune(hz, frames);
    }
    const float* in[2] = { inL(), inR() };
    const float* k[2] = { keyL(), keyR() };
    double parts[2];
    for (int i = 0; i < frames; ++i) {
      if (moving) {
        const double hz = ctl(ids::frequency, i);
        if (hz != last) retune(hz, 1);
      }
      for (int ch = 0; ch < 2; ++ch) {
        main[ch].split(in[ch][i], parts);
        out(ch)[i] = static_cast<float>(parts[0]);
        out(2 + ch)[i] = static_cast<float>(parts[1]);
        key[ch].split(k[ch][i], parts);
        out(4 + ch)[i] = static_cast<float>(parts[0] + parts[1]);
      }
    }
  }
};

}  // namespace pd_Crossover

extern "C" PdAny* pd_make_Crossover() { return new PdAdapter<pd_Crossover::Device>(); }
