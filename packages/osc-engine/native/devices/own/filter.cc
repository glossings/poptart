// The Filter effect: the state-variable and ladder filters, on the chain.
//
// Translated from web-engine/src/devices/filter.mjs. One filter for every instrument rather than
// one inside each: a synth's own filter is a worse copy of this, and an `env()` on this cutoff is
// the filter envelope any of them wants.
//
// The browser's version reads the cutoff PER SAMPLE when a signal is moving it, which is what
// makes an envelope on it a sweep rather than a staircase. Here a control carries one value for
// the block, as it does for every device on this engine - 128 frames at most, so 2.7 ms a step -
// and the tuning is done once at the top of the block.

#include "own/pd-own.h"
#include "own/dsp/filters.h"
#include "pd-own-ids.h"

namespace pd_Filter {

namespace ids = pd_ids::Filter;
using namespace pd_own;

struct Device : pd_own::Device<ids::kCount> {
  MultiFilter filters[2];
  int lastMode = -1;
  double lastCutoff = -1, lastRes = -1, lastDrive = -1;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& f : filters) f.init(sr);
    lastMode = -1;
    lastCutoff = -1;
    lastRes = -1;
    lastDrive = -1;
  }

  void reset() { for (auto& f : filters) f.reset(); }

  void tune(int mode, double hz, double q, double drive) {
    filters[0].setDrive(drive);
    filters[0].setCutoff(hz, q, mode);
    filters[1].follow(filters[0]);
  }

  void pd_process(int frames) {
    const int mode = jsRoundInt(p[ids::mode]);
    // A mode change is a different filter, so its state goes with it: carrying the old one's
    // integrators into a new shape is a click at best and a blow-up at worst. The tuning goes
    // with it too - each mode reads the cutoff into a structure of its own.
    if (mode != lastMode) { reset(); lastMode = mode; lastCutoff = -1; }
    const double hz = p[ids::cutoff];
    const double q = p[ids::resonance];
    const double drive = p[ids::drive];
    // Drive is in the comparison because the ladder reads it at tuning time: a stepped drive
    // change over a still cutoff is a change this filter has to hear.
    if (hz != lastCutoff || q != lastRes || drive != lastDrive) tune(mode, hz, q, drive);
    lastCutoff = hz;
    lastRes = q;
    lastDrive = drive;

    const double mix = p[ids::mix];
    const double gain = dbToGain(p[ids::output]);
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    // BOTH CHANNELS IN ONE LOOP, which is not a tidiness choice: a channel at a time meant the
    // right one ran on whatever tuning the left one's last sample left behind.
    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      const double wetL = filters[0].next(l, mode);
      const double wetR = filters[1].next(r, mode);
      outl[i] = static_cast<float>((l + (wetL - l) * mix) * gain);
      outr[i] = static_cast<float>((r + (wetR - r) * mix) * gain);
    }
    if (frames > 0 && (!isPlayable(outl[frames - 1]) || !isPlayable(outr[frames - 1]))) reset();
  }
};

}  // namespace pd_Filter

extern "C" PdAny* pd_make_Filter() { return new PdAdapter<pd_Filter::Device>(); }
